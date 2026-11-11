'use client';

import { type ReactNode, useState } from 'react';
import { useTranslations } from 'next-intl';
import toast from 'react-hot-toast';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { usePreferencesStore } from '@/store/preferencesStore';
import { userSettingsApi } from '@/lib/user-settings';
import { getErrorMessage } from '@/lib/errors';
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

interface DashboardHeroSettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
  /** The accounts the hero's portfolio set can cover. */
  investmentAccounts?: Account[];
}

/** One labelled setting: the label above on a phone, beside it wider. */
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

/**
 * One set's settings. On Auto both sets' rows are shown, so each group carries
 * the set's name and its own rule, and a reader can tell which chart a range
 * belongs to; with one set chosen its rows stand alone.
 */
function HeroSetGroup({
  id,
  title,
  labelled,
  children,
}: {
  id: string;
  title: string;
  labelled: boolean;
  children: ReactNode;
}) {
  if (!labelled) return <>{children}</>;
  return (
    <div
      role="group"
      aria-labelledby={id}
      data-testid={id}
      className="flex flex-col gap-3 border-l-2 border-gray-200 pl-3 dark:border-gray-700"
    >
      <h3 id={id} className="text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
        {title}
      </h3>
      {children}
    </div>
  );
}

/**
 * The dashboard hero's settings. The hero is not in the layout (DASH-10), so
 * it is set here, from edit mode's Hero settings, and saved on its own: only
 * `dashboardWidgetConfig['dashboard-hero']` changes, merged into the map read
 * at save time, and `dashboardWidgets` is never sent.
 */
export function DashboardHeroSettingsModal({
  isOpen,
  onClose,
  investmentAccounts = [],
}: DashboardHeroSettingsModalProps) {
  const t = useTranslations('dashboard');
  const tc = useTranslations('common');
  const storedHero = usePreferencesStore(
    (s) => s.preferences?.dashboardWidgetConfig?.[DASHBOARD_HERO_WIDGET_ID],
  );
  const [hero, setHero] = useState<DashboardHeroConfig>(DASHBOARD_HERO_DEFAULT);
  const [isSaving, setIsSaving] = useState(false);

  // Re-seed each time the dialog opens ("info from previous render" pattern),
  // keeping only the settings the hero has, so a stale key never rides along.
  const [prevOpen, setPrevOpen] = useState(false);
  if (isOpen !== prevOpen) {
    setPrevOpen(isOpen);
    if (isOpen) setHero(resolveDashboardHeroConfig(storedHero));
  }

  const handleSave = async () => {
    setIsSaving(true);
    try {
      const allBefore = usePreferencesStore.getState().preferences?.dashboardWidgetConfig ?? {};
      const saved = await userSettingsApi.updatePreferences({
        dashboardWidgetConfig: { ...allBefore, [DASHBOARD_HERO_WIDGET_ID]: { ...hero } },
      });
      usePreferencesStore.getState().updatePreferences({
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
      // Not closed mid-save (Escape, the backdrop, Back): edit mode's Done
      // sits under this dialog, and run before the answer lands it would
      // store the settings map without the hero's new slice.
      onBeforeClose={() => !isSaving}
      maxWidth="2xl"
      className="p-6"
      pushHistory
      title={t('customize.hero.title')}
      description={t('customize.hero.description')}
    >
      <div data-testid="hero-settings" className="flex flex-col gap-3">
        <ToggleSwitch
          checked={hero.enabled}
          onChange={(enabled) => setHero((prev) => ({ ...prev, enabled }))}
          label={t('customize.hero.show')}
        />
        {hero.enabled && (
          <>
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
              <HeroSetGroup
                id="customize-hero-group-netWorth"
                title={t('customize.hero.sets.netWorth')}
                labelled={hero.set === 'auto'}
              >
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
              </HeroSetGroup>
            )}
            {hero.set !== 'netWorth' && (
              <HeroSetGroup
                id="customize-hero-group-portfolio"
                title={t('customize.hero.sets.portfolio')}
                labelled={hero.set === 'auto'}
              >
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
              </HeroSetGroup>
            )}
          </>
        )}
      </div>

      <div className="mt-6 flex flex-wrap items-center justify-between gap-3">
        <Button variant="ghost" onClick={() => setHero(DASHBOARD_HERO_DEFAULT)} disabled={isSaving}>
          {t('customize.reset')}
        </Button>
        <div className="flex items-center gap-3">
          <Button variant="outline" onClick={onClose} disabled={isSaving}>
            {tc('cancel')}
          </Button>
          <Button onClick={handleSave} isLoading={isSaving}>
            {tc('save')}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
