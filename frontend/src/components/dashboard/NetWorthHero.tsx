'use client';

import { type ReactNode, useMemo } from 'react';
import { useTranslations } from 'next-intl';
import { netWorthApi } from '@/lib/net-worth';
import { resolveRangePreset } from '@/lib/date-range';
import { useFinancialToday } from '@/hooks/useFinancialToday';
import { partialTotalFor, totalOrSubtotal } from '@/lib/net-worth-completeness';
import { isComplete } from '@/lib/currency-total';
import { moneyDecimalsForCurrency } from '@/lib/format';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import { useChartDateFormat } from '@/hooks/useChartDateFormat';
import { useReportData } from '@/hooks/useReportData';
import { renderForStyle, useUiStyle, type StyleVariants } from '@/hooks/useUiStyle';
import type { PortfolioValuation } from '@/types/investment';
import type { DashboardHeroConfig } from './widget-config';
import { heroMonthChange, heroSnapshot } from './dashboard-hero-figures';
import { HeroMessage, HeroSkeleton } from './hero-parts';
import type { NetWorthHeroViewProps } from './variants/net-worth-hero-view';
import { NetWorthHeroStandard } from './variants/NetWorthHeroStandard';
import { NetWorthHeroFolio } from './variants/NetWorthHeroFolio';
import { NetWorthHeroPebble } from './variants/NetWorthHeroPebble';

const NET_WORTH_HERO_VARIANTS: StyleVariants<NetWorthHeroViewProps> = {
  standard: NetWorthHeroStandard,
  folio: NetWorthHeroFolio,
  pebble: NetWorthHeroPebble,
};

interface NetWorthHeroProps {
  config: DashboardHeroConfig;
  /** The dashboard's portfolio valuation; `null` until loaded or when it failed. */
  portfolioValuation: PortfolioValuation | null;
  hasInvestments: boolean;
  isLoading: boolean;
  /** Whether `portfolioValuation` is still on its way: "invested" keeps a
   *  placeholder meanwhile, and nothing else in the hero waits for it. */
  investmentSummaryLoading: boolean;
  /**
   * Bumped by the dashboard when a price refresh wrote new prices: the
   * investment accounts' share of every month is valued from them, so the
   * net worth is asked again.
   */
  refreshKey?: number;
}

/**
 * The net worth set: net worth with its change this month, assets,
 * liabilities and invested under it, and a net worth chart over the chosen
 * window. The newest month is the current one (`dashboard-hero-figures.ts`).
 */
export function NetWorthHero({
  config,
  portfolioValuation,
  hasInvestments,
  isLoading,
  investmentSummaryLoading,
  refreshKey = 0,
}: NetWorthHeroProps) {
  const t = useTranslations('dashboard');
  const uiStyle = useUiStyle();
  const { formatCurrency, formatPercent, defaultCurrency } = useNumberFormat();
  const formatChartDate = useChartDateFormat();

  // The hero's own window, so a 10-year chart does not hold up the widgets.
  // A reload after a price refresh asks the same question again, so the
  // figures already drawn stay until the new ones land.
  const today = useFinancialToday();
  const { data, dataKey, isLoading: dataLoading, error } = useReportData(
    () => {
      const { start, end } = resolveRangePreset(config.range, { alignment: 'month', today });
      return netWorthApi.getMonthly({ startDate: start || undefined, endDate: end });
    },
    [config.range, refreshKey, today],
    { requestKey: config.range },
  );

  const snapshot = useMemo(() => heroSnapshot(data ?? []), [data]);
  const change = useMemo(
    () => heroMonthChange(data ?? [], moneyDecimalsForCurrency(defaultCurrency)),
    [data, defaultCurrency],
  );
  // A month that did not fully convert is a gap, never a measured dip.
  const points = useMemo(
    () =>
      (data ?? []).map((d) => ({
        key: d.month,
        value: d.fxComplete === false ? null : d.netWorth,
      })),
    [data],
  );

  const label = t('hero.label');
  // The valuation behind "invested" is deliberately not part of this: it is
  // the slowest request here and one figure needs it, so that figure alone
  // keeps a placeholder below.
  if (isLoading || (dataLoading && dataKey !== config.range) || (data === null && !error)) {
    return <HeroSkeleton label={label} />;
  }
  if (error) return <HeroMessage>{t('netWorth.loadFailed')}</HeroMessage>;
  if (!snapshot) return null;

  // The securities alone: the cash beside them is not invested.
  const invested =
    hasInvestments && portfolioValuation
      ? {
          value: totalOrSubtotal(
            portfolioValuation.totalHoldingsValue,
            portfolioValuation.knownHoldingsValueSubtotal,
          ),
          total: partialTotalFor(
            totalOrSubtotal(
              portfolioValuation.totalHoldingsValue,
              portfolioValuation.knownHoldingsValueSubtotal,
            ),
            portfolioValuation.valuationComplete,
            portfolioValuation.missingRatePairs,
          ),
          // A gap from an unpriced holding is not a missing rate, so it says so
          // and names the holdings, with where a price comes from.
          explanation:
            portfolioValuation.pricesComplete === false
              ? t('hero.investedUnpriced', {
                  symbols: (portfolioValuation.unpricedSecurityIds ?? [])
                    .map(
                      (id) =>
                        portfolioValuation.holdings.find((h) => h.securityId === id)?.symbol ?? id,
                    )
                    .join(', '),
                })
              : undefined,
        }
      : null;

  const changeUp = change !== null && change.amount >= 0;
  const dir = (chunks: ReactNode) => <span className="sr-only">{chunks}</span>;
  // The arrow a style draws is decoration; the direction is said in words to
  // a screen reader, inside the catalog's own sentence.
  const changeText =
    change === null || !change.known
      ? null
      : change.percent === null
        ? t.rich('hero.changeThisMonth', {
            direction: changeUp ? 'up' : 'down',
            amount: formatCurrency(Math.abs(change.amount)),
            dir,
          })
        : t.rich('hero.changeThisMonthWithPercent', {
            direction: changeUp ? 'up' : 'down',
            amount: formatCurrency(Math.abs(change.amount)),
            percent: formatPercent(Math.abs(change.percent), 1),
            dir,
          });

  return renderForStyle(uiStyle, NET_WORTH_HERO_VARIANTS, {
    label,
    currency: defaultCurrency,
    netWorth: snapshot.netWorth,
    assets: snapshot.assets,
    liabilities: snapshot.liabilities,
    provisional: snapshot.provisional,
    // Held back while the valuation is loading: the skeleton stands in its place.
    invested: investmentSummaryLoading ? null : invested,
    investedLoading: hasInvestments && investmentSummaryLoading,
    collapsed: {
      title: t('hero.netWorth'),
      figure: formatCurrency(snapshot.netWorth.value),
      figurePartial: !isComplete(snapshot.netWorth),
      change:
        change !== null && change.known
          ? {
              up: changeUp,
              text:
                change.percent === null
                  ? formatCurrency(Math.abs(change.amount))
                  : formatPercent(Math.abs(change.percent), 1),
            }
          : undefined,
    },
    change: change === null ? null : changeText === null ? { known: false } : { known: true, up: changeUp, text: changeText },
    points,
    formatTick: (m) => formatChartDate(`${m}-01`, points.length > 18 ? 'MMM yy' : 'MMM'),
    formatTooltipKey: (m) => formatChartDate(`${m}-01`, 'MMMM yyyy'),
    formatNarrowMonth: (m) => formatChartDate(`${m}-01`, 'MMMMM'),
  });
}
