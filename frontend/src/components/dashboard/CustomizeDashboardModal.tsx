'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import toast from 'react-hot-toast';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { usePreferencesStore } from '@/store/preferencesStore';
import { userSettingsApi } from '@/lib/user-settings';
import { getErrorMessage } from '@/lib/errors';
import { useDragReorder, DropIndicatorLine } from '@/hooks/useDragReorder';
import {
  DASHBOARD_WIDGETS,
  DEFAULT_DASHBOARD_WIDGET_IDS,
  DashboardWidgetId,
  WidgetIconType,
  resolveDashboardWidgets,
} from './widget-registry';

interface CustomizeDashboardModalProps {
  isOpen: boolean;
  onClose: () => void;
}

/**
 * Small glyph hinting at the kind of visualization a widget renders (bar, line,
 * pie, table, or list), so users can tell widgets apart at a glance in the
 * layout picker.
 */
function WidgetTypeIcon({ type }: { type: WidgetIconType }) {
  const common = {
    className: 'h-4 w-4 text-gray-400 dark:text-gray-500 flex-shrink-0',
    fill: 'none',
    viewBox: '0 0 24 24',
    stroke: 'currentColor',
    strokeWidth: 2,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    'aria-hidden': true,
    'data-testid': `widget-type-icon-${type}`,
  };
  switch (type) {
    case 'bar':
      return (
        <svg {...common}>
          <path d="M3 21h18" />
          <path d="M6 21v-7" />
          <path d="M12 21V5" />
          <path d="M18 21v-11" />
        </svg>
      );
    case 'line':
      return (
        <svg {...common}>
          <path d="M3 21h18" />
          <path d="M4 15l5-5 4 3 7-8" />
        </svg>
      );
    case 'pie':
      return (
        <svg {...common}>
          <path d="M10.5 6a7.5 7.5 0 107.5 7.5h-7.5V6Z" />
          <path d="M13.5 10.5H21A7.5 7.5 0 0013.5 3v7.5Z" />
        </svg>
      );
    case 'table':
      return (
        <svg {...common}>
          <rect x="3.5" y="5.5" width="17" height="13" rx="1.5" />
          <path d="M3.5 10.5h17" />
          <path d="M3.5 14.5h17" />
          <path d="M9.5 5.5v13" />
        </svg>
      );
    case 'list':
    default:
      return (
        <svg {...common}>
          <path d="M8 6.5h12" />
          <path d="M8 12h12" />
          <path d="M8 17.5h12" />
          <path d="M4 6.5h.01" />
          <path d="M4 12h.01" />
          <path d="M4 17.5h.01" />
        </svg>
      );
  }
}

export function CustomizeDashboardModal({ isOpen, onClose }: CustomizeDashboardModalProps) {
  const t = useTranslations('dashboard');
  const tc = useTranslations('common');
  const dashboardWidgets = usePreferencesStore((s) => s.preferences?.dashboardWidgets);
  const updateStorePreferences = usePreferencesStore((s) => s.updatePreferences);
  // Ordered ids of the widgets currently shown; everything else is hidden.
  const [visible, setVisible] = useState<DashboardWidgetId[]>([]);
  const [isSaving, setIsSaving] = useState(false);

  // Re-seed the working layout each time the modal opens ("info from previous
  // render" pattern -- state updates during render, not in an effect).
  const [prevOpen, setPrevOpen] = useState(false);
  if (isOpen !== prevOpen) {
    setPrevOpen(isOpen);
    if (isOpen) {
      setVisible(resolveDashboardWidgets(dashboardWidgets).map((w) => w.id));
    }
  }

  const hidden = DASHBOARD_WIDGETS.map((w) => w.id).filter((id) => !visible.includes(id));

  const widgetName = (id: DashboardWidgetId): string => {
    const section = DASHBOARD_WIDGETS.find((w) => w.id === id)!.titleSection;
    return t(`${section}.title` as Parameters<typeof t>[0]);
  };

  const widgetIcon = (id: DashboardWidgetId): WidgetIconType =>
    DASHBOARD_WIDGETS.find((w) => w.id === id)!.iconType;

  const moveWidget = (from: number, to: number) => {
    setVisible((prev) => {
      if (to < 0 || to >= prev.length) return prev;
      const next = [...prev];
      const [id] = next.splice(from, 1);
      next.splice(to, 0, id);
      return next;
    });
  };

  const { dragIndex, rowProps, dropIndicator } = useDragReorder(moveWidget, 'x');

  const hide = (id: DashboardWidgetId) => {
    setVisible((prev) => prev.filter((v) => v !== id));
  };

  const show = (id: DashboardWidgetId) => {
    setVisible((prev) => [...prev, id]);
  };

  const reset = () => {
    setVisible(DEFAULT_DASHBOARD_WIDGET_IDS);
  };

  const handleSave = async () => {
    // A layout identical to the default is stored as "not customized" so the
    // user keeps following default-layout improvements in future versions.
    const isDefault =
      visible.length === DEFAULT_DASHBOARD_WIDGET_IDS.length &&
      visible.every((id, i) => id === DEFAULT_DASHBOARD_WIDGET_IDS[i]);
    setIsSaving(true);
    try {
      const saved = await userSettingsApi.updatePreferences({
        dashboardWidgets: isDefault ? [] : visible,
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
    <Modal isOpen={isOpen} onClose={onClose} maxWidth="4xl" className="p-4 sm:p-8" pushHistory>
      <h3 className="text-lg font-medium text-gray-900 dark:text-gray-100 mb-2">
        {t('customize.title')}
      </h3>
      <p className="text-sm text-gray-600 dark:text-gray-400 mb-4">
        {t('customize.description')}
      </p>

      {/* Mockup of the dashboard grid: single column on mobile, two columns on
          larger screens -- exactly like the real page. */}
      <div className="rounded-lg border border-gray-200 dark:border-gray-700 bg-gray-100 dark:bg-gray-900/40 p-2 sm:p-3 mb-2">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 sm:gap-3">
          {visible.map((id, index) => (
            <div
              key={id}
              data-testid={`widget-tile-${id}`}
              {...rowProps(index)}
              className={`relative flex items-center gap-1.5 rounded-md border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-800 shadow-sm px-2 py-3 cursor-grab ${
                dragIndex === index ? 'opacity-50' : ''
              }`}
            >
              <DropIndicatorLine position={dropIndicator(index, visible.length)} axis="x" />
              <span aria-hidden="true" className="select-none text-gray-400 flex-shrink-0">
                ⠿
              </span>
              <WidgetTypeIcon type={widgetIcon(id)} />
              <span className="flex-1 min-w-0 truncate text-sm text-gray-900 dark:text-gray-100">
                {widgetName(id)}
              </span>
              <button
                type="button"
                onClick={() => moveWidget(index, index - 1)}
                disabled={index === 0}
                aria-label={t('customize.moveEarlier', { name: widgetName(id) })}
                className="p-0.5 rounded text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 disabled:opacity-30 disabled:cursor-not-allowed flex-shrink-0"
              >
                {/* Up on mobile (single-column stack), left on wider screens (two-column grid). */}
                <svg className="h-3.5 w-3.5 sm:hidden" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 15l7-7 7 7" />
                </svg>
                <svg className="h-3.5 w-3.5 hidden sm:block" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
                </svg>
              </button>
              <button
                type="button"
                onClick={() => moveWidget(index, index + 1)}
                disabled={index === visible.length - 1}
                aria-label={t('customize.moveLater', { name: widgetName(id) })}
                className="p-0.5 rounded text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 disabled:opacity-30 disabled:cursor-not-allowed flex-shrink-0"
              >
                {/* Down on mobile (single-column stack), right on wider screens (two-column grid). */}
                <svg className="h-3.5 w-3.5 sm:hidden" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                </svg>
                <svg className="h-3.5 w-3.5 hidden sm:block" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                </svg>
              </button>
              <button
                type="button"
                onClick={() => hide(id)}
                aria-label={t('customize.hide', { name: widgetName(id) })}
                className="p-0.5 ml-1.5 sm:ml-0 rounded text-gray-400 hover:text-red-600 dark:hover:text-red-400 hover:bg-gray-100 dark:hover:bg-gray-700 flex-shrink-0"
              >
                <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
          ))}
          {visible.length === 0 && (
            <p className="col-span-full text-sm text-amber-600 dark:text-amber-400 text-center py-4">
              {t('customize.atLeastOne')}
            </p>
          )}
        </div>
      </div>
      <p className="text-xs text-gray-500 dark:text-gray-400 mb-4">
        {t('customize.dragToReorder')}
      </p>

      {hidden.length > 0 && (
        <>
          <h4 className="text-xs font-medium uppercase tracking-wider text-gray-500 dark:text-gray-400 mb-2">
            {t('customize.hiddenWidgets')}
          </h4>
          <div className="flex flex-wrap gap-2 mb-2">
            {hidden.map((id) => (
              <button
                key={id}
                type="button"
                data-testid={`widget-hidden-${id}`}
                onClick={() => show(id)}
                aria-label={t('customize.show', { name: widgetName(id) })}
                className="inline-flex items-center gap-1.5 rounded-full border border-dashed border-gray-300 dark:border-gray-600 px-3 py-1 text-sm text-gray-600 dark:text-gray-300 hover:border-blue-500 hover:text-blue-600 dark:hover:border-blue-400 dark:hover:text-blue-400 transition-colors"
              >
                <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
                </svg>
                <WidgetTypeIcon type={widgetIcon(id)} />
                {widgetName(id)}
              </button>
            ))}
          </div>
        </>
      )}

      <div className="mt-4 flex items-center justify-between gap-3">
        <Button variant="ghost" onClick={reset} disabled={isSaving}>
          {t('customize.reset')}
        </Button>
        <div className="flex items-center gap-3">
          <Button variant="outline" onClick={onClose} disabled={isSaving}>
            {tc('cancel')}
          </Button>
          <Button onClick={handleSave} disabled={isSaving || visible.length === 0}>
            {tc('save')}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
