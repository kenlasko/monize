'use client';

import { type ReactNode, useMemo } from 'react';
import { useTranslations } from 'next-intl';
import { differenceInDays, startOfDay } from 'date-fns';
import { renderForStyle, useUiStyle, type StyleVariants } from '@/hooks/useUiStyle';
import { parseLocalDate } from '@/lib/utils';
import {
  nextOccurrenceAutoPosts,
  nextOccurrenceDueDate,
  nextOccurrenceEffectiveAmount,
} from '@/lib/scheduled-effective-amount';
import { occurrenceKind } from '@/lib/scheduled-kind';
import type { ScheduledTransaction } from '@/types/scheduled-transaction';
import { usePreferencesStore } from '@/store/preferencesStore';
import type { PortfolioValuation } from '@/types/investment';
import type { Account } from '@/types/account';
import { DASHBOARD_HERO_WIDGET_ID, resolveDashboardHeroConfig, type DashboardHeroSet } from './widget-config';
import { HeroPanelActiveContext } from './hero-parts';
import { NetWorthHero } from './NetWorthHero';
import { PortfolioHero } from './PortfolioHero';
import { useElementSize } from './useElementSize';
import { useHeroCycle } from './useHeroCycle';
import { upcomingOccurrences } from './upcoming-occurrences';
import type { DashboardHeroFrameProps, HeroNextUp } from './variants/dashboard-hero-view';
import { DashboardHeroFrameStandard } from './variants/DashboardHeroFrameStandard';
import { DashboardHeroFrameFolio } from './variants/DashboardHeroFrameFolio';
import { DashboardHeroFramePebble } from './variants/DashboardHeroFramePebble';

const HERO_FRAME_VARIANTS: StyleVariants<DashboardHeroFrameProps> = {
  standard: DashboardHeroFrameStandard,
  folio: DashboardHeroFrameFolio,
  pebble: DashboardHeroFramePebble,
};

interface DashboardHeroProps {
  /** The dashboard's portfolio valuation; `null` until loaded or when it failed. */
  portfolioValuation: PortfolioValuation | null;
  hasInvestments: boolean;
  /**
   * The accounts request failed, so `hasInvestments` is unknown rather than
   * false: the portfolio set stays in the cycle and says it could not load.
   */
  accountsFailed?: boolean;
  /** The dashboard's own first load, before which no figure is known. */
  isLoading: boolean;
  /**
   * Whether the portfolio valuation behind the net worth set's "invested"
   * figure is still loading, separately from `isLoading`: it fetches after the
   * rest of the dashboard's first load so it never blocks it. `NetWorthHero`
   * holds a placeholder in that one figure's place meanwhile.
   */
  investmentSummaryLoading: boolean;
  /** The investment accounts the portfolio set can cover. */
  investmentAccounts: Account[];
  /** Bumped when a price refresh wrote new prices; both sets re-ask. */
  priceRefreshKey?: number;
  /**
   * The page header (greeting, date, Customize gear). Drawn once, above the
   * track, so it stays still while the sets slide under it; switched off, the
   * hero renders the header alone, so the page never loses its heading.
   */
  header: ReactNode;
  /**
   * The dashboard's scheduled transactions, the same list the Upcoming Bills
   * widget reads. The Pebble style shows the next occurrence beside the sets.
   */
  scheduledTransactions?: ScheduledTransaction[];
}

/**
 * The dashboard's opening figures, in the set chosen in Hero Settings:
 * net worth (`NetWorthHero`), the portfolio (`PortfolioHero`), or Auto, which
 * alternates between them. Both sit side by side on a track, and the one not
 * showing is inert. Switched off, the page keeps its greeting and date and
 * asks for nothing.
 */
export function DashboardHero({
  portfolioValuation,
  hasInvestments,
  accountsFailed = false,
  isLoading,
  investmentSummaryLoading,
  investmentAccounts,
  priceRefreshKey = 0,
  header,
  scheduledTransactions,
}: DashboardHeroProps) {
  const t = useTranslations('dashboard');
  const uiStyle = useUiStyle();
  const stored = usePreferencesStore((s) => s.preferences?.dashboardWidgetConfig?.[DASHBOARD_HERO_WIDGET_ID]);
  const config = resolveDashboardHeroConfig(stored);
  // The greeting row, measured: the chart rises beside it, and the figures are
  // never narrower than it, as when the greeting sat in their column.
  const [headRef, head] = useElementSize<HTMLDivElement>();
  const { sets, active, mounted, animate, goTo } = useHeroCycle({
    choice: config.set,
    hasInvestments: hasInvestments || accountsFailed,
    settled: !isLoading && !investmentSummaryLoading,
  });
  const nextUp = useMemo(
    () => (scheduledTransactions ? heroNextUp(scheduledTransactions, startOfDay(new Date())) : null),
    [scheduledTransactions],
  );

  if (!config.enabled) return <>{header}</>;

  const setName = (set: DashboardHeroSet) => t(`customize.hero.sets.${set}`);
  const activeIndex = sets.indexOf(active);

  const cycleControls =
    sets.length > 1 ? (
      <div role="group" aria-label={t('hero.cycleControls')} className="mt-1 flex flex-shrink-0 sm:mt-1.5">
        {sets.map((set) => (
          <button
            key={set}
            type="button"
            aria-pressed={set === active}
            aria-label={t('hero.showSet', { name: setName(set) })}
            title={setName(set)}
            onClick={() => goTo(set)}
            className="flex h-6 w-6 items-center justify-center rounded-full focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
          >
            <span
              aria-hidden="true"
              className={`h-2 w-2 rounded-full transition-colors motion-reduce:transition-none ${
                set === active ? 'bg-blue-600 dark:bg-blue-400' : 'bg-gray-300 dark:bg-gray-600'
              }`}
            />
          </button>
        ))}
      </div>
    ) : null;

  const track = (
    // Clipped sideways only: a clip on both axes would cut off the figures'
    // popovers below the track.
    <div className="overflow-x-clip">
      <div
        data-testid="dashboard-hero-track"
        className={`flex ${animate ? 'transition-transform duration-500 ease-in-out motion-reduce:transition-none' : ''}`}
        style={{ transform: `translateX(-${activeIndex * 100}%)` }}
      >
        {sets.map((set) => (
          <div key={set} className="w-full min-w-0 flex-shrink-0" inert={set !== active}>
            <HeroPanelActiveContext.Provider value={set === active}>
              {mounted.has(set) &&
                (set === 'portfolio' ? (
                  <PortfolioHero
                    config={config}
                    investmentAccounts={investmentAccounts}
                    hasInvestments={hasInvestments}
                    accountsFailed={accountsFailed}
                    isLoading={isLoading}
                    refreshKey={priceRefreshKey}
                  />
                ) : (
                  <NetWorthHero
                    config={config}
                    portfolioValuation={portfolioValuation}
                    hasInvestments={hasInvestments}
                    isLoading={isLoading}
                    investmentSummaryLoading={investmentSummaryLoading}
                    refreshKey={priceRefreshKey}
                  />
                ))}
            </HeroPanelActiveContext.Provider>
          </div>
        ))}
      </div>
    </div>
  );

  return renderForStyle(uiStyle, HERO_FRAME_VARIANTS, {
    header,
    headRef,
    headSize: head,
    cycleControls,
    track,
    nextUp,
  });
}

/**
 * The next scheduled occurrence across every active schedule, as the Upcoming
 * Bills widget orders them (`upcomingOccurrences`), with when it falls.
 */
function heroNextUp(scheduledTransactions: readonly ScheduledTransaction[], today: Date): HeroNextUp | null {
  const [next] = upcomingOccurrences(scheduledTransactions, today, true);
  if (!next) return null;
  const dueDate = nextOccurrenceDueDate(next);
  const days = differenceInDays(parseLocalDate(dueDate), today);
  const effective = nextOccurrenceEffectiveAmount(next);
  return {
    id: next.id,
    name: next.name,
    payee: next.payeeName || next.payee?.name || null,
    manual: !nextOccurrenceAutoPosts(next),
    kind: occurrenceKind(effective, next),
    amount: effective.amount,
    currencyCode: effective.currencyCode,
    when: days < 0 ? 'overdue' : days === 0 ? 'today' : days === 1 ? 'tomorrow' : 'later',
    dueDate,
  };
}
