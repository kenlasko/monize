'use client';

import { type ReactNode, useMemo } from 'react';
import { useTranslations } from 'next-intl';
import { netWorthApi } from '@/lib/net-worth';
import { resolveRangePreset } from '@/lib/date-range';
import { partialTotalFor } from '@/lib/net-worth-completeness';
import { moneyDecimalsForCurrency } from '@/lib/format';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import { useChartDateFormat } from '@/hooks/useChartDateFormat';
import { useReportData } from '@/hooks/useReportData';
import { PartialTotal } from '@/components/ui/PartialTotal';
import { UnknownAmount } from '@/components/ui/UnknownAmount';
import type { PortfolioSummary } from '@/types/investment';
import type { DashboardHeroConfig } from './widget-config';
import { heroMonthChange, heroSnapshot } from './dashboard-hero-figures';
import {
  HeroAreaChart,
  HeroCaption,
  HeroHeadline,
  HeroLayout,
  HeroMessage,
  HeroPill,
  HeroPillUnknown,
  HeroSkeleton,
  HeroSubFigures,
  heroStrong,
} from './hero-parts';

interface NetWorthHeroProps {
  config: DashboardHeroConfig;
  header: ReactNode;
  /** The dashboard's portfolio summary; `null` until loaded or when it failed. */
  portfolioSummary: PortfolioSummary | null;
  hasInvestments: boolean;
  isLoading: boolean;
}

/**
 * The net worth set: net worth with its change this month, assets,
 * liabilities and invested under it, and a net worth chart over the chosen
 * window. The newest month is the current one (`dashboard-hero-figures.ts`).
 */
export function NetWorthHero({ config, header, portfolioSummary, hasInvestments, isLoading }: NetWorthHeroProps) {
  const t = useTranslations('dashboard');
  const { formatCurrency, formatPercent, defaultCurrency } = useNumberFormat();
  const formatChartDate = useChartDateFormat();

  // The hero's own window, so a 10-year chart does not hold up the widgets.
  const { data, isLoading: dataLoading, error } = useReportData(
    () => {
      const { start, end } = resolveRangePreset(config.range, { alignment: 'month' });
      return netWorthApi.getMonthly({ startDate: start || undefined, endDate: end });
    },
    [config.range],
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
  if (isLoading || dataLoading || (data === null && !error)) {
    return <HeroSkeleton header={header} label={label} />;
  }
  if (error) return <HeroMessage header={header}>{t('netWorth.loadFailed')}</HeroMessage>;
  if (!snapshot) return <>{header}</>;

  // The securities alone: the cash beside them is not invested.
  const invested =
    hasInvestments && portfolioSummary
      ? {
          value: portfolioSummary.totalHoldingsValue,
          total: partialTotalFor(
            portfolioSummary.totalHoldingsValue,
            portfolioSummary.valuationComplete,
            portfolioSummary.missingRatePairs,
          ),
          // A gap from an unpriced holding is not a missing rate, so it says so
          // and names the holdings, with where a price comes from.
          explanation:
            portfolioSummary.pricesComplete === false
              ? t('hero.investedUnpriced', {
                  symbols: (portfolioSummary.unpricedSecurityIds ?? [])
                    .map(
                      (id) =>
                        portfolioSummary.holdings.find((h) => h.securityId === id)?.symbol ?? id,
                    )
                    .join(', '),
                })
              : undefined,
        }
      : null;

  const changeUp = change !== null && change.amount >= 0;
  const dir = (chunks: ReactNode) => <span className="sr-only">{chunks}</span>;
  const pill =
    change === null ? null : change.known ? (
      <HeroPill up={changeUp}>
        {/* The arrow is decoration; the direction is said in words to a
            screen reader, inside the catalog's own sentence. */}
        {change.percent === null
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
            })}
      </HeroPill>
    ) : (
      <HeroPillUnknown>
        <UnknownAmount reason="displayFx" />
      </HeroPillUnknown>
    );

  return (
    <HeroLayout
      header={header}
      label={label}
      figures={
        <>
          <HeroCaption>{t('hero.netWorth')}</HeroCaption>
          <div className="flex flex-wrap items-baseline gap-x-4 gap-y-2">
            <HeroHeadline negative={snapshot.netWorth.value < 0}>
              <PartialTotal total={snapshot.netWorth} displayCurrency={defaultCurrency}>
                {formatCurrency(snapshot.netWorth.value)}
              </PartialTotal>
            </HeroHeadline>
            {pill}
          </div>
          <HeroSubFigures>
            <span>
              {t.rich('hero.assets', {
                value: () => (
                  <PartialTotal total={snapshot.assets} displayCurrency={defaultCurrency}>
                    {formatCurrency(snapshot.assets.value)}
                  </PartialTotal>
                ),
                strong: heroStrong,
              })}
            </span>
            <span>
              {t.rich('hero.liabilities', {
                value: () => (
                  <PartialTotal total={snapshot.liabilities} displayCurrency={defaultCurrency}>
                    {formatCurrency(snapshot.liabilities.value)}
                  </PartialTotal>
                ),
                strong: heroStrong,
              })}
            </span>
            {invested && (
              <span>
                {t.rich('hero.invested', {
                  value: () => (
                    <PartialTotal
                      total={invested.total}
                      displayCurrency={defaultCurrency}
                      explanation={invested.explanation}
                    >
                      {formatCurrency(invested.value)}
                    </PartialTotal>
                  ),
                  strong: heroStrong,
                })}
              </span>
            )}
          </HeroSubFigures>
        </>
      }
      chart={
        <HeroAreaChart
          points={points}
          currency={defaultCurrency}
          gradientId="dashboardHeroNetWorth"
          formatTick={(m) => formatChartDate(`${m}-01`, points.length > 18 ? 'MMM yy' : 'MMM')}
          formatTooltipKey={(m) => formatChartDate(`${m}-01`, 'MMMM yyyy')}
        />
      }
    />
  );
}
