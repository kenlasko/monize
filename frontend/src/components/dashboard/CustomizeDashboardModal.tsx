'use client';

import { type ReactNode, useState } from 'react';
import { useTranslations } from 'next-intl';
import toast from 'react-hot-toast';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { usePreferencesStore } from '@/store/preferencesStore';
import { userSettingsApi } from '@/lib/user-settings';
import { getErrorMessage } from '@/lib/errors';
import { useDragReorder, DropIndicatorLine } from '@/hooks/useDragReorder';
import { ToggleSwitch } from '@/components/ui/ToggleSwitch';
import {
  SEGMENTED_GROUP_CLASS,
  SEGMENTED_TOOLBAR_GROUP_CLASS,
  segmentClass,
  toolbarSegmentClass,
} from '@/components/ui/segmented-control';
import { DateRangeSelector } from '@/components/ui/DateRangeSelector';
import { ReportAccountMultiSelect } from '@/components/reports/ReportAccountMultiSelect';
import { PORTFOLIO_CHART_RANGES } from '@/components/investments/portfolio-range-window';
import type { Account } from '@/types/account';
import {
  DASHBOARD_HERO_DEFAULT,
  DASHBOARD_HERO_PORTFOLIO_METRICS,
  DASHBOARD_HERO_SET_CHOICES,
  DASHBOARD_HERO_WIDGET_ID,
  DashboardHeroConfig,
  NET_WORTH_RANGES,
  resolveDashboardHeroConfig,
} from './widget-config';
import { ChevronDownIcon, XMarkIcon, ChevronLeftIcon, ChevronRightIcon, ChevronUpIcon, PlusIcon } from '@heroicons/react/24/outline';
import {
  DASHBOARD_WIDGETS,
  DEFAULT_DASHBOARD_WIDGET_IDS,
  DashboardWidgetId,
  WidgetIconType,
  resolveDashboardWidgets,
} from './widget-registry';
import { widgetTintClass } from './widget-meta';

interface CustomizeDashboardModalProps {
  isOpen: boolean;
  onClose: () => void;
  /** The accounts the hero's portfolio set can cover. */
  investmentAccounts?: Account[];
}

/** A widget's glyph on its domain's colour, the one its puck wears on the dashboard. */
function WidgetTint({ id, children }: { id: DashboardWidgetId; children: ReactNode }) {
  return (
    <span
      data-testid={`widget-tint-${id}`}
      className={`flex h-5 w-5 flex-shrink-0 items-center justify-center rounded ${widgetTintClass(id)}`}
    >
      {children}
    </span>
  );
}

/**
 * Small glyph hinting at the kind of visualization a widget renders (bar, line,
 * pie, table, or list), so users can tell widgets apart at a glance in the
 * layout picker.
 */
function WidgetTypeIcon({ type }: { type: WidgetIconType }) {
  const common = {
    className: 'h-3.5 w-3.5 flex-shrink-0',
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

/** One labelled setting in the hero section: the label above on a phone, beside it wider. */
function HeroRow({ label, id, children }: { label: string; id: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5 sm:flex-row sm:items-center sm:gap-3">
      <span id={id} className="text-sm text-gray-700 dark:text-gray-300 sm:w-28 sm:flex-shrink-0">
        {label}
      </span>
      {children}
    </div>
  );
}

export function CustomizeDashboardModal({
  isOpen,
  onClose,
  investmentAccounts = [],
}: CustomizeDashboardModalProps) {
  const t = useTranslations('dashboard');
  const tc = useTranslations('common');
  const dashboardWidgets = usePreferencesStore((s) => s.preferences?.dashboardWidgets);
  const updateStorePreferences = usePreferencesStore((s) => s.updatePreferences);
  const widgetConfig = usePreferencesStore((s) => s.preferences?.dashboardWidgetConfig);
  // The hero's working settings, saved with the layout.
  const [hero, setHero] = useState<DashboardHeroConfig>(DASHBOARD_HERO_DEFAULT);
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
      // Only the settings the hero has, so a stale key never rides along.
      setHero(resolveDashboardHeroConfig(widgetConfig?.[DASHBOARD_HERO_WIDGET_ID]));
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
    setHero(DASHBOARD_HERO_DEFAULT);
  };

  const handleSave = async () => {
    // A layout identical to the default is stored as "not customized" so the
    // user keeps following default-layout improvements in future versions.
    const isDefault =
      visible.length === DEFAULT_DASHBOARD_WIDGET_IDS.length &&
      visible.every((id, i) => id === DEFAULT_DASHBOARD_WIDGET_IDS[i]);
    setIsSaving(true);
    try {
      // Merge into the stored settings map so every widget keeps its own
      // settings; the modal covers the widgets, so none changes while it is open.
      const allBefore = widgetConfig ?? {};
      const saved = await userSettingsApi.updatePreferences({
        dashboardWidgets: isDefault ? [] : visible,
        dashboardWidgetConfig: { ...allBefore, [DASHBOARD_HERO_WIDGET_ID]: { ...hero } },
      });
      updateStorePreferences({
        dashboardWidgets: saved.dashboardWidgets,
        dashboardWidgetConfig: saved.dashboardWidgetConfig,
      });
      onClose();
    } catch (error) {
      toast.error(getErrorMessage(error, t('customize.toasts.saveFailed')));
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      maxWidth="4xl"
      className="p-6"
      pushHistory
      title={t('customize.title')}
      description={t('customize.description')}
    >

      {/* The hero sits above the grid and spans it, so it is set here rather
          than dragged among the widgets. */}
      <section
        aria-labelledby="customize-hero-heading"
        data-testid="customize-hero"
        className="rounded-lg border border-gray-200 dark:border-gray-700 p-3 mb-3"
      >
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h4 id="customize-hero-heading" className="text-sm font-medium text-gray-900 dark:text-gray-100">
              {t('customize.hero.title')}
            </h4>
            <p className="text-xs text-gray-500 dark:text-gray-400">{t('customize.hero.description')}</p>
          </div>
          <ToggleSwitch
            checked={hero.enabled}
            onChange={(enabled) => setHero((prev) => ({ ...prev, enabled }))}
            label={t('customize.hero.show')}
          />
        </div>
        {hero.enabled && (
          <div className="mt-3 flex flex-col gap-3">
            <HeroRow label={t('customize.hero.set')} id="customize-hero-set">
              <div className={SEGMENTED_TOOLBAR_GROUP_CLASS} role="group" aria-labelledby="customize-hero-set">
                {DASHBOARD_HERO_SET_CHOICES.map((set) => (
                  <button
                    key={set}
                    type="button"
                    aria-pressed={hero.set === set}
                    onClick={() => setHero((prev) => ({ ...prev, set }))}
                    className={toolbarSegmentClass(hero.set === set)}
                  >
                    {t(`customize.hero.sets.${set}`)}
                  </button>
                ))}
              </div>
            </HeroRow>
            {hero.set !== 'portfolio' && (
              <HeroRow label={t('customize.hero.range')} id="customize-hero-range">
                <div className={SEGMENTED_GROUP_CLASS} role="group" aria-labelledby="customize-hero-range">
                  {NET_WORTH_RANGES.map((range) => (
                    <button
                      key={range}
                      type="button"
                      aria-pressed={hero.range === range}
                      onClick={() => setHero((prev) => ({ ...prev, range }))}
                      className={segmentClass(hero.range === range)}
                    >
                      {t(`widgets.rangeLabels.${range}` as Parameters<typeof t>[0])}
                    </button>
                  ))}
                </div>
              </HeroRow>
            )}
            {hero.set !== 'netWorth' && (
              <>
                <HeroRow label={t('widgets.accounts')} id="customize-hero-accounts">
                  <ReportAccountMultiSelect
                    accounts={investmentAccounts}
                    value={hero.portfolioAccountIds}
                    onChange={(portfolioAccountIds) => setHero((prev) => ({ ...prev, portfolioAccountIds }))}
                    mode="portfolio"
                    className="w-full sm:w-72"
                  />
                </HeroRow>
                <HeroRow label={t('widgets.timeframe')} id="customize-hero-portfolio-range">
                  <div role="group" aria-labelledby="customize-hero-portfolio-range">
                    <DateRangeSelector
                      ranges={PORTFOLIO_CHART_RANGES}
                      labels={Object.fromEntries(
                        PORTFOLIO_CHART_RANGES.map((r) => [r, t(`widgets.rangeLabels.${r}` as Parameters<typeof t>[0])]),
                      )}
                      value={hero.portfolioRange}
                      onChange={(r) =>
                        setHero((prev) => ({ ...prev, portfolioRange: r as DashboardHeroConfig['portfolioRange'] }))
                      }
                      size="sm"
                    />
                  </div>
                </HeroRow>
                <HeroRow label={t('customize.hero.metric')} id="customize-hero-metric">
                  <div className={`${SEGMENTED_GROUP_CLASS} flex-wrap`} role="group" aria-labelledby="customize-hero-metric">
                    {DASHBOARD_HERO_PORTFOLIO_METRICS.map((metric) => (
                      <button
                        key={metric}
                        type="button"
                        aria-pressed={hero.portfolioMetric === metric}
                        onClick={() => setHero((prev) => ({ ...prev, portfolioMetric: metric }))}
                        className={segmentClass(hero.portfolioMetric === metric)}
                      >
                        {t(`customize.hero.metrics.${metric}`)}
                      </button>
                    ))}
                  </div>
                </HeroRow>
              </>
            )}
          </div>
        )}
      </section>

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
              <WidgetTint id={id}>
                <WidgetTypeIcon type={widgetIcon(id)} />
              </WidgetTint>
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
                <ChevronUpIcon className="h-3.5 w-3.5 sm:hidden" aria-hidden="true" />
                <ChevronLeftIcon className="h-3.5 w-3.5 hidden sm:block" aria-hidden="true" />
              </button>
              <button
                type="button"
                onClick={() => moveWidget(index, index + 1)}
                disabled={index === visible.length - 1}
                aria-label={t('customize.moveLater', { name: widgetName(id) })}
                className="p-0.5 rounded text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 disabled:opacity-30 disabled:cursor-not-allowed flex-shrink-0"
              >
                {/* Down on mobile (single-column stack), right on wider screens (two-column grid). */}
                <ChevronDownIcon className="h-3.5 w-3.5 sm:hidden" aria-hidden="true" />
                <ChevronRightIcon className="h-3.5 w-3.5 hidden sm:block" aria-hidden="true" />
              </button>
              <button
                type="button"
                onClick={() => hide(id)}
                aria-label={t('customize.hide', { name: widgetName(id) })}
                className="p-0.5 ml-1.5 sm:ml-0 rounded text-gray-400 hover:text-red-600 dark:hover:text-red-400 hover:bg-gray-100 dark:hover:bg-gray-700 flex-shrink-0"
              >
                <XMarkIcon className="h-3.5 w-3.5" aria-hidden="true" />
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
                <PlusIcon className="h-3.5 w-3.5" aria-hidden="true" />
                <WidgetTint id={id}>
                  <WidgetTypeIcon type={widgetIcon(id)} />
                </WidgetTint>
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
