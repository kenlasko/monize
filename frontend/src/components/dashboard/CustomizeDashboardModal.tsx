'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import toast from 'react-hot-toast';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { usePreferencesStore } from '@/store/preferencesStore';
import { userSettingsApi } from '@/lib/user-settings';
import { getErrorMessage } from '@/lib/errors';
import {
  DASHBOARD_WIDGETS,
  DEFAULT_DASHBOARD_WIDGET_IDS,
  DashboardWidgetId,
  resolveDashboardWidgets,
} from './widget-registry';

interface CustomizeDashboardModalProps {
  isOpen: boolean;
  onClose: () => void;
}

interface WidgetRow {
  id: DashboardWidgetId;
  enabled: boolean;
}

/** Current layout first (in stored order), then the hidden widgets. */
function buildRows(preferredIds: string[] | null | undefined): WidgetRow[] {
  const enabled = resolveDashboardWidgets(preferredIds);
  const enabledIds = new Set(enabled.map((w) => w.id));
  return [
    ...enabled.map((w) => ({ id: w.id, enabled: true })),
    ...DASHBOARD_WIDGETS.filter((w) => !enabledIds.has(w.id)).map((w) => ({
      id: w.id,
      enabled: false,
    })),
  ];
}

export function CustomizeDashboardModal({ isOpen, onClose }: CustomizeDashboardModalProps) {
  const t = useTranslations('dashboard');
  const tc = useTranslations('common');
  const dashboardWidgets = usePreferencesStore((s) => s.preferences?.dashboardWidgets);
  const updateStorePreferences = usePreferencesStore((s) => s.updatePreferences);
  const [rows, setRows] = useState<WidgetRow[]>([]);
  const [isSaving, setIsSaving] = useState(false);
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [overIndex, setOverIndex] = useState<number | null>(null);

  // Re-seed the working list each time the modal opens ("info from previous
  // render" pattern -- state updates during render, not in an effect).
  const [prevOpen, setPrevOpen] = useState(false);
  if (isOpen !== prevOpen) {
    setPrevOpen(isOpen);
    if (isOpen) {
      setRows(buildRows(dashboardWidgets));
    }
  }

  const widgetName = (id: DashboardWidgetId): string => {
    const section = DASHBOARD_WIDGETS.find((w) => w.id === id)!.titleSection;
    return t(`${section}.title` as Parameters<typeof t>[0]);
  };

  const toggle = (id: DashboardWidgetId) => {
    setRows((prev) => prev.map((r) => (r.id === id ? { ...r, enabled: !r.enabled } : r)));
  };

  const move = (index: number, delta: -1 | 1) => {
    setRows((prev) => {
      const target = index + delta;
      if (target < 0 || target >= prev.length) return prev;
      const next = [...prev];
      const [row] = next.splice(index, 1);
      next.splice(target, 0, row);
      return next;
    });
  };

  const handleDrop = (targetIndex: number) => {
    setOverIndex(null);
    const from = dragIndex;
    setDragIndex(null);
    if (from === null || from === targetIndex) return;
    setRows((prev) => {
      const next = [...prev];
      const [row] = next.splice(from, 1);
      next.splice(targetIndex, 0, row);
      return next;
    });
  };

  const reset = () => {
    setRows(buildRows([]));
  };

  const enabledCount = rows.filter((r) => r.enabled).length;

  const handleSave = async () => {
    const enabledIds = rows.filter((r) => r.enabled).map((r) => r.id);
    // A layout identical to the default is stored as "not customized" so the
    // user keeps following default-layout improvements in future versions.
    const isDefault =
      enabledIds.length === DEFAULT_DASHBOARD_WIDGET_IDS.length &&
      enabledIds.every((id, i) => id === DEFAULT_DASHBOARD_WIDGET_IDS[i]);
    setIsSaving(true);
    try {
      const saved = await userSettingsApi.updatePreferences({
        dashboardWidgets: isDefault ? [] : enabledIds,
      });
      updateStorePreferences({ dashboardWidgets: saved.dashboardWidgets });
      onClose();
    } catch (error) {
      toast.error(getErrorMessage(error, t('customize.toasts.saveFailed')));
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <Modal isOpen={isOpen} onClose={onClose} maxWidth="md" className="p-6" pushHistory>
      <h3 className="text-lg font-medium text-gray-900 dark:text-gray-100 mb-2">
        {t('customize.title')}
      </h3>
      <p className="text-sm text-gray-600 dark:text-gray-400 mb-4">
        {t('customize.description')}
      </p>

      <ul className="divide-y divide-gray-100 dark:divide-gray-700 border border-gray-200 dark:border-gray-700 rounded-lg mb-2">
        {rows.map((row, index) => (
          <li
            key={row.id}
            data-testid={`widget-row-${row.id}`}
            draggable
            onDragStart={() => setDragIndex(index)}
            onDragOver={(e) => {
              e.preventDefault();
              if (overIndex !== index) setOverIndex(index);
            }}
            onDrop={(e) => {
              e.preventDefault();
              handleDrop(index);
            }}
            onDragEnd={() => {
              setDragIndex(null);
              setOverIndex(null);
            }}
            className={`flex items-center gap-3 px-3 py-2 cursor-grab ${
              dragIndex === index ? 'opacity-50' : ''
            } ${
              overIndex === index && dragIndex !== null && dragIndex !== index
                ? 'bg-blue-100 dark:bg-blue-500/20 ring-2 ring-inset ring-blue-500 dark:ring-blue-400'
                : ''
            }`}
          >
            <span aria-hidden="true" className="select-none text-gray-400">
              ⠿
            </span>
            <input
              id={`widget-toggle-${row.id}`}
              type="checkbox"
              checked={row.enabled}
              onChange={() => toggle(row.id)}
              className="h-4 w-4 rounded border-gray-300 dark:border-gray-600 text-blue-600 focus:ring-blue-500"
            />
            <label
              htmlFor={`widget-toggle-${row.id}`}
              className={`flex-1 min-w-0 truncate text-sm ${
                row.enabled
                  ? 'text-gray-900 dark:text-gray-100'
                  : 'text-gray-400 dark:text-gray-500'
              }`}
            >
              {widgetName(row.id)}
            </label>
            <button
              type="button"
              onClick={() => move(index, -1)}
              disabled={index === 0}
              aria-label={t('customize.moveUp', { name: widgetName(row.id) })}
              className="p-1 rounded text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700 disabled:opacity-30 disabled:cursor-not-allowed"
            >
              <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 15l7-7 7 7" />
              </svg>
            </button>
            <button
              type="button"
              onClick={() => move(index, 1)}
              disabled={index === rows.length - 1}
              aria-label={t('customize.moveDown', { name: widgetName(row.id) })}
              className="p-1 rounded text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700 disabled:opacity-30 disabled:cursor-not-allowed"
            >
              <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
              </svg>
            </button>
          </li>
        ))}
      </ul>
      <p className="text-xs text-gray-500 dark:text-gray-400 mb-2">
        {t('customize.dragToReorder')}
      </p>

      {enabledCount === 0 && (
        <p className="text-sm text-amber-600 dark:text-amber-400 mb-2">
          {t('customize.atLeastOne')}
        </p>
      )}

      <div className="mt-4 flex items-center justify-between gap-3">
        <Button variant="ghost" onClick={reset} disabled={isSaving}>
          {t('customize.reset')}
        </Button>
        <div className="flex items-center gap-3">
          <Button variant="outline" onClick={onClose} disabled={isSaving}>
            {tc('cancel')}
          </Button>
          <Button onClick={handleSave} disabled={isSaving || enabledCount === 0}>
            {tc('save')}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
