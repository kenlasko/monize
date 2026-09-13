'use client';

import { ReactNode, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Cog6ToothIcon } from '@heroicons/react/24/outline';
import { WidgetIconPuck, WidgetTitle } from './widget-meta';
import type { DashboardWidgetId } from './widget-registry';
import { useWidgetConfig } from '@/hooks/useWidgetConfig';
import {
  WidgetIdentityConfig,
  WIDGET_DISPLAY_NAME_MAX,
  WIDGET_DESCRIPTION_MAX,
} from './widget-config';

// Stable module-level defaults: useWidgetConfig memoizes on this reference.
const IDENTITY_DEFAULTS: WidgetIdentityConfig = {};

interface WidgetCardProps {
  /** Widget heading (the built-in, translated title). */
  title: string;
  /**
   * Route the title links to: the report or section showing the same figures in
   * full. Omit for a widget with no fuller view.
   */
  titleHref?: string;
  /**
   * Widget id. When provided, the settings gear also lets the user set a custom
   * display name (overriding {@link title}) and an optional description, stored
   * alongside the widget's other settings.
   */
  widgetId?: string;
  /** Optional right-aligned header content (subtitle, inline toggle, etc.). */
  headerRight?: ReactNode;
  /**
   * When provided, the settings modal renders these controls above the shared
   * name/description fields. Each control persists on change, so the modal only
   * needs a Done button to dismiss.
   */
  configControls?: ReactNode;
  /** Title shown in the settings modal. Defaults to the widget title. */
  configTitle?: string;
  /** Card body (chart, skeleton, or empty state). */
  children: ReactNode;
  /** Tailwind min-height for the card. Charts default to a tall card. */
  minHeightClass?: string;
  className?: string;
}

/**
 * Shared shell for the report-derived dashboard widgets: the standard white/dark
 * card, a header with the title and an optional settings gear, and a settings
 * modal that hosts the widget's per-instance controls plus the shared
 * name/description overrides. Keeping the gear in the header (rather than inline
 * controls) keeps the compact widgets uncluttered and works the same on mobile
 * and desktop.
 */
export function WidgetCard({
  title,
  titleHref,
  widgetId,
  headerRight,
  configControls,
  configTitle,
  children,
  minHeightClass = 'lg:min-h-[540px]',
  className = '',
}: WidgetCardProps) {
  const t = useTranslations('dashboard');
  const [showConfig, setShowConfig] = useState(false);
  // Identity lives under the same widget-config slice; a widget without an id
  // (rare) simply reads an empty slice and never persists anything.
  const { config: identity, updateConfig: updateIdentity } =
    useWidgetConfig<WidgetIdentityConfig>(widgetId ?? '', IDENTITY_DEFAULTS);

  const identityEnabled = !!widgetId;
  const displayTitle = (identityEnabled && identity.displayName?.trim()) || title;
  const description = identityEnabled ? identity.description?.trim() : undefined;
  const hasGear = !!configControls || identityEnabled;

  return (
    <Card
      padding="md"
      className={`${minHeightClass} flex flex-col h-full ${className}`}
    >
      {/* The header wraps rather than squeezing the title: a widget whose
          header-right carries a figure, a range and a button needs more width
          than a phone has beside a title, and a truncated title names no
          widget. Above the wrap the row is unchanged. */}
      <div className="flex flex-wrap items-start justify-between gap-2 mb-4">
        <div className="flex min-w-0 items-start gap-2.5">
          {widgetId && <WidgetIconPuck id={widgetId as DashboardWidgetId} />}
          <div className="min-w-0">
            <WidgetTitle href={titleHref}>{displayTitle}</WidgetTitle>
            {description && (
              <p className="mt-0.5 text-xs text-gray-500 dark:text-gray-400 line-clamp-2">
                {description}
              </p>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2 flex-shrink-0 ml-auto">
          {headerRight}
          {hasGear && (
            <button
              type="button"
              onClick={() => setShowConfig(true)}
              aria-label={t('widgets.configure', { name: title })}
              className="p-1.5 rounded-md text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors"
            >
              <Cog6ToothIcon aria-hidden className="h-4 w-4" />
            </button>
          )}
        </div>
      </div>

      <div className="flex-1 min-h-0 flex flex-col">{children}</div>

      {hasGear && (
        <Modal
          isOpen={showConfig}
          onClose={() => setShowConfig(false)}
          maxWidth="md"
          className="p-4 sm:p-6"
          pushHistory
        >
          <h3 className="text-lg font-medium text-gray-900 dark:text-gray-100 mb-4">
            {configTitle ?? title}
          </h3>
          <div className="space-y-4">
            {configControls}
            {identityEnabled && (
              <WidgetIdentityEditor
                displayName={identity.displayName}
                description={identity.description}
                placeholder={title}
                withDivider={!!configControls}
                onCommit={updateIdentity}
              />
            )}
          </div>
          <div className="mt-6 flex justify-end">
            <Button onClick={() => setShowConfig(false)}>{t('widgets.done')}</Button>
          </div>
        </Modal>
      )}
    </Card>
  );
}

/** A labelled row inside a widget settings modal. */
export function WidgetConfigRow({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">
        {label}
      </label>
      {children}
    </div>
  );
}

/**
 * Name + description fields shared by every configurable widget. Edits are held
 * locally and committed on blur so we persist once per edit (not per keystroke).
 * An empty value clears the override, falling back to the built-in title.
 */
function WidgetIdentityEditor({
  displayName,
  description,
  placeholder,
  withDivider,
  onCommit,
}: {
  displayName?: string;
  description?: string;
  placeholder: string;
  withDivider: boolean;
  onCommit: (patch: Partial<WidgetIdentityConfig>) => void;
}) {
  const t = useTranslations('dashboard');
  const [nameDraft, setNameDraft] = useState(displayName ?? '');
  const [descDraft, setDescDraft] = useState(description ?? '');
  // Adopt external changes (e.g. a reset from another device) without a
  // setState-in-effect: track the committed values and reseed during render.
  const [seed, setSeed] = useState({ displayName, description });
  if (seed.displayName !== displayName || seed.description !== description) {
    setSeed({ displayName, description });
    setNameDraft(displayName ?? '');
    setDescDraft(description ?? '');
  }

  const commitName = () => {
    const next = nameDraft.trim();
    if ((displayName ?? '') !== next) {
      onCommit({ displayName: next || undefined });
    }
  };
  const commitDescription = () => {
    const next = descDraft.trim();
    if ((description ?? '') !== next) {
      onCommit({ description: next || undefined });
    }
  };

  return (
    <div className={withDivider ? 'space-y-4 border-t border-gray-200 dark:border-gray-700 pt-4' : 'space-y-4'}>
      <WidgetConfigRow label={t('widgets.displayName')}>
        <input
          type="text"
          value={nameDraft}
          onChange={(e) => setNameDraft(e.target.value)}
          onBlur={commitName}
          maxLength={WIDGET_DISPLAY_NAME_MAX}
          placeholder={placeholder}
          className="w-full rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 px-3 py-1.5 text-sm text-gray-900 dark:text-gray-100 placeholder-gray-400 dark:placeholder-gray-500 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
        />
      </WidgetConfigRow>
      <WidgetConfigRow label={t('widgets.description')}>
        <textarea
          value={descDraft}
          onChange={(e) => setDescDraft(e.target.value)}
          onBlur={commitDescription}
          maxLength={WIDGET_DESCRIPTION_MAX}
          rows={2}
          placeholder={t('widgets.descriptionPlaceholder')}
          className="w-full resize-none rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 px-3 py-1.5 text-sm text-gray-900 dark:text-gray-100 placeholder-gray-400 dark:placeholder-gray-500 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
        />
      </WidgetConfigRow>
    </div>
  );
}

/** Centered placeholder used for widget loading/empty bodies. */
export function WidgetMessage({ children }: { children: ReactNode }) {
  return (
    <div className="flex-1 flex items-center justify-center py-8">
      <p className="text-sm text-gray-500 dark:text-gray-400 text-center">{children}</p>
    </div>
  );
}
