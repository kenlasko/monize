'use client';

import { type ReactNode, useMemo } from 'react';
import { useTranslations } from 'next-intl';
import { parseISO } from 'date-fns';
import { investmentsApi } from '@/lib/investments';
import { resolveRangePreset } from '@/lib/date-range';
import { useFinancialToday } from '@/hooks/useFinancialToday';
import { summaryFigure } from '@/lib/portfolio-headline';
import { useWithheldReason } from '@/hooks/useWithheldReason';
import { isComplete } from '@/lib/currency-total';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import { useChartDateFormat } from '@/hooks/useChartDateFormat';
import { renderForStyle, useUiStyle, type StyleVariants } from '@/hooks/useUiStyle';
import { useReportData } from '@/hooks/useReportData';
import { usePortfolioRangeWindow } from '@/hooks/usePortfolioRangeWindow';
import { usePortfolioPeriodResult } from '@/hooks/usePortfolioPeriodResult';
import { periodResultUnknownReason } from '@/components/investments/portfolio-period-result';
import {
  PORTFOLIO_DAILY_RANGES,
  loadPortfolioValueSeries,
} from '@/components/investments/portfolio-value-series';
import { PartialTotal } from '@/components/ui/PartialTotal';
import { UnknownAmount } from '@/components/ui/UnknownAmount';
import type { DashboardHeroConfig } from './widget-config';
import type { Account } from '@/types/account';
import { buildAccountFilterLabel } from '@/lib/account-utils';
import { useMainAccountName } from '@/hooks/useMainAccountName';
import {
  HeroAreaChart,
  HeroChartSkeleton,
  HeroFigureSkeleton,
  HeroMessage,
  HeroSkeleton,
} from './hero-parts';
import type { PortfolioHeroChange, PortfolioHeroViewProps } from './variants/portfolio-hero-view';
import { PortfolioHeroStandard } from './variants/PortfolioHeroStandard';
import { PortfolioHeroFolio } from './variants/PortfolioHeroFolio';
import { PortfolioHeroPebble } from './variants/PortfolioHeroPebble';

const PORTFOLIO_HERO_VARIANTS: StyleVariants<PortfolioHeroViewProps> = {
  standard: PortfolioHeroStandard,
  folio: PortfolioHeroFolio,
  pebble: PortfolioHeroPebble,
};

interface PortfolioHeroProps {
  config: DashboardHeroConfig;
  /** The investment accounts, for naming the ones the set covers. */
  investmentAccounts: Account[];
  hasInvestments: boolean;
  /** The accounts request failed: "no investment accounts" is unknown, not known. */
  accountsFailed?: boolean;
  isLoading: boolean;
  /**
   * Bumped by the dashboard when a price refresh wrote new prices: every figure
   * here is valued from them, so each request is asked again.
   */
  refreshKey?: number;
}

/**
 * The portfolio set: the chosen investment accounts' total value with its
 * change over the chosen window, the holdings and cash under it beside one
 * chosen figure, and the value chart. Every figure is the Investments page's
 * own: the value, holdings, cash and simple return are the portfolio
 * valuation's, TWR, MWR and CAGR are the portfolio summary's (since inception),
 * the change is the period result's for the window, and the chart plots the
 * securities alone, as the page's Portfolio Value over Time chart does.
 *
 * The figures draw as soon as the valuation answers. The chart, the change and
 * a since-inception return each cost far more, so each keeps a placeholder in
 * its own place rather than holding the rest of the hero.
 */
export function PortfolioHero({
  config,
  investmentAccounts,
  hasInvestments,
  accountsFailed = false,
  isLoading,
  refreshKey = 0,
}: PortfolioHeroProps) {
  const t = useTranslations('dashboard');
  const tc = useTranslations('common');
  // An unknown figure is a withheld figure, said as the investments card says it,
  // with that figure's own causes.
  const tInvestments = useTranslations('investments');
  const withheldReason = useWithheldReason();
  const uiStyle = useUiStyle();
  const mainAccountName = useMainAccountName();
  const { formatCurrency, formatSignedPercent, defaultCurrency } = useNumberFormat();
  const formatChartDate = useChartDateFormat();
  const range = config.portfolioRange;
  const accountIdsCsv =
    config.portfolioAccountIds.length > 0 ? config.portfolioAccountIds.join(',') : undefined;

  // The window as the Investments page value chart resolves it.
  const today = useFinancialToday();
  const base = useMemo(() => resolveRangePreset(range, { alignment: 'month', today }), [range, today]);
  const { start, periodStart, end } = usePortfolioRangeWindow({ range, base });

  // What each request asks for, without the refresh key: a reload after a
  // price refresh asks the same question again, so the figures already drawn
  // stay on screen until the new ones land rather than dropping back to a
  // placeholder seconds after the page opened.
  const seriesKey = JSON.stringify([hasInvestments, range, start, end, accountIdsCsv ?? null]);
  const summaryKey = JSON.stringify([hasInvestments, accountIdsCsv ?? null]);

  const {
    data: series,
    dataKey: seriesDataKey,
    isLoading: seriesLoading,
    error: seriesError,
  } = useReportData(
    () =>
      hasInvestments
        ? loadPortfolioValueSeries({ range, start, end, accountIds: accountIdsCsv })
        : Promise.resolve({ points: [], intradayUnavailable: false }),
    [hasInvestments, range, start, end, accountIdsCsv, refreshKey],
    { requestKey: seriesKey },
  );

  const {
    data: summary,
    dataKey: summaryDataKey,
    isLoading: summaryLoading,
    error: summaryError,
  } = useReportData(
    () =>
      hasInvestments
        ? investmentsApi.getPortfolioValuation(config.portfolioAccountIds)
        : Promise.resolve(null),
    [hasInvestments, accountIdsCsv, refreshKey],
    { requestKey: summaryKey },
  );

  // Only a since-inception return needs the summary's walk; the simple return
  // is the valuation's own.
  const needsReturns = config.portfolioMetric !== 'simpleReturn';
  const returnsKey = JSON.stringify([hasInvestments, needsReturns, accountIdsCsv ?? null]);
  const {
    data: returns,
    dataKey: returnsDataKey,
    isLoading: returnsLoading,
    error: returnsError,
  } = useReportData(
    () =>
      hasInvestments && needsReturns
        ? investmentsApi.getPortfolioSummary(config.portfolioAccountIds)
        : Promise.resolve(null),
    [hasInvestments, needsReturns, accountIdsCsv, refreshKey],
    { requestKey: returnsKey },
  );

  const { periodResult, failed: periodFailed } = usePortfolioPeriodResult({
    range,
    startDate: start,
    periodStartDate: periodStart,
    endDate: end,
    hasSeries: (series?.points.length ?? 0) > 0,
    accountIds: accountIdsCsv,
    displayCurrency: defaultCurrency,
    reloadKey: refreshKey,
    skip: !hasInvestments,
  });

  // The accounts covered, named as the Investments page's Portfolio Summary
  // header names them: the selectable accounts there are the brokerage ones
  // and the standalone investment accounts, a brokerage by its main name.
  const accountsLabel = useMemo(
    () =>
      buildAccountFilterLabel(
        config.portfolioAccountIds,
        investmentAccounts
          .filter((a) => a.accountSubType === 'INVESTMENT_BROKERAGE' || !a.accountSubType)
          .sort((a, b) => a.name.localeCompare(b.name)),
        (a) => {
          const account = a as Account;
          return account.accountSubType === 'INVESTMENT_BROKERAGE'
            ? mainAccountName(account.name)
            : account.name;
        },
        tc,
      ),
    [config.portfolioAccountIds, investmentAccounts, mainAccountName, tc],
  );

  const points = useMemo(
    () => (series?.points ?? []).map((p) => ({ key: p.at, value: p.value })),
    [series],
  );
  const intraday = series?.points[0]?.intraday ?? false;
  const sampled = !intraday && !PORTFOLIO_DAILY_RANGES.has(range);

  const label = t('hero.portfolioLabel');
  // Also on a reload: `investmentAccounts` is then empty while the old valuation
  // would still be drawn under "All accounts".
  if (accountsFailed && !isLoading) {
    return <HeroMessage>{t('hero.portfolioLoadFailed')}</HeroMessage>;
  }
  if (!hasInvestments && !isLoading) {
    return <HeroMessage>{t('hero.portfolioEmpty')}</HeroMessage>;
  }
  if (isLoading || (summaryLoading && summaryDataKey !== summaryKey) || (summary === null && !summaryError)) {
    return <HeroSkeleton label={label} />;
  }
  if (summaryError || !summary) {
    return <HeroMessage>{t('hero.portfolioLoadFailed')}</HeroMessage>;
  }

  const seriesPending = (seriesLoading && seriesDataKey !== seriesKey) || (series === null && !seriesError);

  const windowLabel = t(`widgets.rangeLabels.${range}` as Parameters<typeof t>[0]);
  const dir = (chunks: ReactNode) => <span className="sr-only">{chunks}</span>;

  // The whole scope's change over the window, deposits and withdrawals
  // included: the headline is the whole scope's value, so this is what moved
  // it. A change, never a return -- the returns are the figure further down.
  // A request that has not answered holds the pill's place, or nothing once
  // there is no series for it to measure; a withheld figure names its cause.
  const totalChange = periodResult?.valueChange ?? null;
  const change: PortfolioHeroChange | null = !periodResult
    ? periodFailed
      ? { kind: 'unknown', text: t('hero.portfolioChangeFailed') }
      : seriesPending || points.length > 0
        ? { kind: 'pending' }
        : null
    : totalChange === null
      ? { kind: 'unknown', text: <UnknownAmount reason={periodResultUnknownReason(periodResult.reasons)} /> }
      : {
          kind: 'known',
          up: totalChange >= 0,
          text: t.rich('hero.changeOverWindow', {
            direction: totalChange >= 0 ? 'up' : 'down',
            amount: formatCurrency(Math.abs(totalChange), defaultCurrency),
            window: windowLabel,
            dir,
          }),
        };

  const metricValue = (): ReactNode => {
    if (config.portfolioMetric === 'simpleReturn') {
      // Over the holdings that have a value: partial while the server withholds it.
      const pct = summaryFigure(summary, 'gainPercent');
      if (pct === null) return <UnknownAmount reasonText={withheldReason(summary, 'gainPercent')} />;
      return (
        <PartialTotal total={pct} displayCurrency={defaultCurrency}>
          {formatSignedPercent(pct.value, 2)}
        </PartialTotal>
      );
    }
    // A failed request is said to be one, not shown as a withheld return.
    if (returnsError) return <UnknownAmount reasonText={t('hero.portfolioLoadFailed')} />;
    if ((returnsLoading && returnsDataKey !== returnsKey) || !returns) return <HeroFigureSkeleton width="w-14" />;
    switch (config.portfolioMetric) {
      case 'twr':
        return returns.timeWeightedReturn != null ? (
          formatSignedPercent(returns.timeWeightedReturn, 2)
        ) : (
          <UnknownAmount reason={periodResultUnknownReason(returns.timeWeightedReturnReasons ?? [])} />
        );
      case 'mwr':
        return returns.moneyWeightedReturn != null ? (
          formatSignedPercent(returns.moneyWeightedReturn, 2)
        ) : (
          <UnknownAmount reason={periodResultUnknownReason(returns.moneyWeightedReturnReasons ?? [])} />
        );
      case 'cagr':
        if (returns.cagr != null) return formatSignedPercent(returns.cagr, 2);
        // Withheld while a price or a rate is missing (a growth rate over a
        // partial value), and otherwise until there is a year of history and
        // more paid in than taken out.
        if (returns.pricesComplete === false) return <UnknownAmount reason="noPrice" />;
        if (returns.fxComplete === false) return <UnknownAmount reason="displayFx" />;
        return <UnknownAmount reasonText={t('hero.cagrUnavailable')} />;
    }
  };

  const metricName = t(`hero.metricNames.${config.portfolioMetric}`);

  // Each figure is partial from whether ITS OWN total was withheld, not from the
  // summary-wide flags.
  const cashTotal = summaryFigure(summary, 'cash');
  const total = summaryFigure(summary, 'portfolioValue');
  const holdingsTotal = summaryFigure(summary, 'holdingsValue');

  const chartNode = seriesError ? (
    <p className="flex h-full items-center justify-center text-sm text-gray-500 dark:text-gray-400">
      {t('hero.portfolioLoadFailed')}
    </p>
  ) : seriesPending ? (
    <HeroChartSkeleton />
  ) : series?.intradayUnavailable ? (
    <p className="flex h-full items-center justify-center text-sm text-gray-500 dark:text-gray-400">
      {t('hero.intradayUnavailable')}
    </p>
  ) : (
    <HeroAreaChart
      points={points}
      currency={defaultCurrency}
      gradientId="dashboardHeroPortfolio"
      formatTick={(key) =>
        intraday
          ? formatChartDate(new Date(key), range === '1d' ? 'HH:mm' : 'MMM d')
          : // A daily window labels its days; a sampled one, one point a
            // month, its months (a daily year by month repeated them).
            formatChartDate(parseISO(key), sampled ? 'MMM yy' : 'MMM d')
      }
      formatTooltipKey={(key) =>
        intraday
          ? formatChartDate(new Date(key), 'MMM d HH:mm')
          : formatChartDate(parseISO(key), 'MMM d, yyyy')
      }
    />
  );


  return renderForStyle(uiStyle, PORTFOLIO_HERO_VARIANTS, {
    label,
    currency: defaultCurrency,
    caption: t.rich('hero.portfolioValueFor', {
      accounts: accountsLabel,
      // Account names keep their own case under the small caps.
      names: (chunks) => <span className="normal-case tracking-normal">{chunks}</span>,
    }),
    total,
    collapsed: {
      title: t('customize.hero.sets.portfolio'),
      figure: total === null ? tInvestments('portfolioSummary.incompleteHeading') : formatCurrency(total.value, defaultCurrency),
      figurePartial: total === null || !isComplete(total),
      change:
        totalChange === null
          ? undefined
          : {
              up: totalChange >= 0,
              text: formatCurrency(Math.abs(totalChange), defaultCurrency),
            },
    },
    change,
    holdings: holdingsTotal,
    cash: cashTotal,
    unknown: {
      total: <UnknownAmount reasonText={withheldReason(summary, 'portfolioValue')} />,
      holdings: <UnknownAmount reasonText={withheldReason(summary, 'holdingsValue')} />,
      cash: <UnknownAmount reasonText={withheldReason(summary, 'cash')} />,
    },
    metric: {
      name: metricName,
      label: t(`customize.hero.metrics.${config.portfolioMetric}`),
      value: metricValue(),
    },
    chart: chartNode,
  });
}
