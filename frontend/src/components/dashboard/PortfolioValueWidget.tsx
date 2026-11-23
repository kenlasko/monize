'use client';

import { useCallback, useMemo } from 'react';
import { useTranslations } from 'next-intl';
import { parseISO } from 'date-fns';
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from 'recharts';
import { Account } from '@/types/account';
import { netWorthApi } from '@/lib/net-worth';
import { investmentsApi } from '@/lib/investments';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import { useExchangeRates } from '@/hooks/useExchangeRates';
import { useReportData } from '@/hooks/useReportData';
import { usePriceRefresh } from '@/hooks/usePriceRefresh';
import { useIsMobile } from '@/hooks/useIsMobile';
import { useChartDateFormat } from '@/hooks/useChartDateFormat';
import { useWidgetConfig } from '@/hooks/useWidgetConfig';
import { resolveRangePreset } from '@/lib/date-range';
import { usePortfolioRangeWindow } from '@/hooks/usePortfolioRangeWindow';
import { usePortfolioPeriodResult } from '@/hooks/usePortfolioPeriodResult';
import {
  openingSessionDate,
  relabelOpeningPoint,
} from '@/components/investments/portfolio-change-baseline';
import {
  periodResultUnknownReason,
} from '@/components/investments/portfolio-period-result';
import { investedValue } from '@/lib/invested-value';
import { chartColors } from '@/lib/chart-colors';
import { gainLossColor } from '@/lib/format';
import { ChartTooltipPanel } from '@/components/reports/ChartTooltip';
import { InfoTooltip } from '@/components/ui/InfoTooltip';
import { UnknownAmount } from '@/components/ui/UnknownAmount';
import { PartialTotal } from '@/components/ui/PartialTotal';
import { portfolioPartialTotal } from '@/lib/net-worth-completeness';
import { DateRangeSelector } from '@/components/ui/DateRangeSelector';
import { ReportAccountMultiSelect } from '@/components/reports/ReportAccountMultiSelect';
import { WidgetCard, WidgetConfigRow, WidgetMessage } from './WidgetCard';
import {
  PORTFOLIO_VALUE_DEFAULT,
  PORTFOLIO_RANGES,
  PortfolioValueConfig,
} from './widget-config';
import { CHART_GRID_PROPS } from '@/lib/chart-style';
import { ChartActiveDot } from '@/components/ui/ChartActiveDot';
import { ChartAreaGradient } from '@/components/ui/ChartAreaGradient';

const WIDGET_ID = 'portfolio-value';

// Short ranges render at daily resolution; longer ones use monthly snapshots so
// the series stays readable without thousands of points. 1W, MTD and YTD are
// windows a month of monthly snapshots would draw as one or two points.
const DAILY_RANGES = new Set(['1w', 'mtd', '3m', '6m', 'ytd']);

interface PortfolioValueWidgetProps {
  accounts: Account[];
  isLoading: boolean;
}

export function PortfolioValueWidget({ accounts, isLoading }: PortfolioValueWidgetProps) {
  const t = useTranslations('dashboard');
  const { formatCurrency, formatCurrencyAxis, formatSignedPercent } = useNumberFormat();
  const { defaultCurrency } = useExchangeRates();
  const formatChartDate = useChartDateFormat();
  // The refresh control sits on the title's line on a desktop and beside the
  // value on a phone, so which line it belongs to is a real branch rather than
  // a breakpoint class: rendering it twice would give one control two
  // accessible names in one card.
  const isMobile = useIsMobile();
  const { config, updateConfig } = useWidgetConfig<PortfolioValueConfig>(
    WIDGET_ID,
    PORTFOLIO_VALUE_DEFAULT,
  );

  const investmentAccounts = useMemo(
    () => accounts.filter((a) => a.accountType === 'INVESTMENT'),
    [accounts],
  );

  const isDaily = DAILY_RANGES.has(config.range);
  const baseWindow = useMemo(
    () => resolveRangePreset(config.range, { alignment: isDaily ? 'day' : 'month' }),
    [config.range, isDaily],
  );

  const accountIdsCsv =
    config.accountIds.length > 0 ? config.accountIds.join(',') : undefined;

  // A price series opens on the close it is measured from, not on the period
  // boundary the range names -- see `portfolio-range-window.ts`. Shared with
  // the Portfolio Value report and the Investments chart so all three agree.
  const { start, periodStart, end } = usePortfolioRangeWindow({
    range: config.range,
    base: baseWindow,
  });

  const { data: series, isLoading: dataLoading, reload: reloadSeries } = useReportData(() => {
    const params = {
      startDate: start || undefined,
      endDate: end,
      accountIds: accountIdsCsv,
      displayCurrency: defaultCurrency,
    };
    // A long range is the same daily valuation sampled at each month-end, so
    // the sparkline opens and closes on the closes the figures beside it are
    // measured between (`docs/specs/portfolio-period-result.md` section 10.9).
    return netWorthApi
      .getInvestmentsDaily(
        isDaily ? params : { ...params, sampling: 'monthEnd' },
      )
      // The INVESTED part, not the account: cash is not an investment, so
      // a deposit must not draw as a rise in portfolio value
      // (`docs/specs/portfolio-period-result.md` section 10.7).
      //
      // A day the server could not price or convert is a subtotal of what it
      // could, and a subtotal on a value axis reads as a measured dip: it is
      // `null`, and the area breaks there. `cashComplete` is not read: the
      // invested value holds no cash.
      .then((rows) =>
        rows.map((r) => ({
          date: r.date,
          value:
            r.pricesComplete !== false && r.fxComplete !== false
              ? investedValue(r)
              : null,
        })),
      );
  }, [start, end, accountIdsCsv, defaultCurrency, isDaily]);

  // Fetch the same valuation the Investments page's summary is built on so the
  // header shows live "Total Portfolio Value" (holdings + cash, from current
  // prices), rather than the last point of the historical snapshot series.
  // Scope it to the widget's configured accounts so it stays in sync with the
  // chart.
  const { data: summary, reload: reloadSummary } = useReportData(
    () => investmentsApi.getPortfolioValuation(config.accountIds),
    [accountIdsCsv],
  );

  const reloadValueData = useCallback(() => {
    reloadSeries();
    reloadSummary();
  }, [reloadSeries, reloadSummary]);

  const { isRefreshing, triggerManualRefresh } = usePriceRefresh({
    onRefreshComplete: reloadValueData,
  });

  const handleRefresh = useCallback(() => {
    // Scope the price refresh to the holdings this widget shows when an account
    // filter is active; otherwise refresh every eligible security.
    const scope =
      config.accountIds.length > 0 && summary
        ? [...new Set(summary.holdings.map((h) => h.securityId))]
        : undefined;
    void triggerManualRefresh(scope);
  }, [config.accountIds, summary, triggerManualRefresh]);

  const totalPortfolioValue = summary?.totalPortfolioValue ?? null;
  // The headline is a subtotal whenever the server says a holding has no price
  // or a currency no rate (`valuationComplete === false`; absent is no
  // information). It stays on screen under the marker, which names the missing
  // currencies and counts the unpriced holdings left out.

  // What the portfolio DID over this window, as the server worked it out. A
  // change read off the plotted series counts the reader's own deposits as
  // performance (INV-PORTRESULT-001), so nothing here subtracts two points: the
  // widget asks the same endpoint the Portfolio Value report reads, for the
  // same scope, and prints what comes back. A range the server has a preset
  // for is named rather than dated and the server resolves it; the series
  // above was requested from the day that preset is measured from.
  const { periodResult } = usePortfolioPeriodResult({
    range: config.range,
    startDate: start,
    periodStartDate: periodStart,
    endDate: end,
    hasSeries: (series?.length ?? 0) > 0,
    accountIds: accountIdsCsv,
    displayCurrency: defaultCurrency,
  });

  // The opening point is dated by the session its close came from, which is
  // the session the period result is measured from, rather than by a boundary
  // the market was shut on (`openingSessionDate`).
  const openingSession = openingSessionDate(series?.[0]?.date, periodResult);
  const chartData = useMemo(
    () =>
      relabelOpeningPoint(
        (series ?? []).map((row, index, rows) => {
          const parsed = parseISO(row.date);
          // A sampled series names its two ends by their day and the
          // month-ends between them by their month.
          const boundary = index === 0 || index === rows.length - 1;
          return {
            date: row.date,
            label: formatChartDate(
              parsed,
              isDaily || boundary ? 'MMM d' : 'MMM yyyy',
            ),
            value: row.value === null ? null : Math.round(row.value),
          };
        }),
        openingSession,
        (point, session) => ({
          ...point,
          label: formatChartDate(parseISO(session), 'MMM d'),
        }),
      ),
    [series, formatChartDate, isDaily, openingSession],
  );

  // The widget plots the invested value, so its headline reads the invested
  // part's own figures -- the same measure the Investments page's performance
  // card reports.
  const investmentResult = periodResult?.investmentPnl ?? null;
  const returnPercent = periodResult?.investmentReturnPercent ?? null;
  const unknownReason = periodResultUnknownReason(
    periodResult?.investedReasons ?? [],
  );
  // The two figures the headline is made of, named where the caption has no
  // room for them. A withheld one says so in the same words the report's cards
  // and exports use -- never an empty space a reader completes as zero.
  const breakdownText = (value: number | null) =>
    value === null
      ? t('portfolioValue.notAvailable')
      : `${value >= 0 ? '+' : ''}${formatCurrency(value, defaultCurrency)}`;

  const configControls = (
    <>
      <WidgetConfigRow label={t('widgets.timeframe')}>
        <DateRangeSelector
          ranges={PORTFOLIO_RANGES}
          value={config.range}
          onChange={(range) => updateConfig({ range })}
          size="sm"
        />
      </WidgetConfigRow>
      <WidgetConfigRow label={t('widgets.accounts')}>
        <ReportAccountMultiSelect
          accounts={investmentAccounts}
          value={config.accountIds}
          onChange={(accountIds) => updateConfig({ accountIds })}
          mode="portfolio"
          className="w-full"
        />
      </WidgetConfigRow>
    </>
  );

  const loading = isLoading || dataLoading;

  const refreshButton = (
    <button
      type="button"
      onClick={handleRefresh}
      disabled={isRefreshing}
      aria-label={t('portfolioValue.refresh')}
      title={t('portfolioValue.refresh')}
      className="flex-shrink-0 p-1.5 rounded-md text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
    >
      <svg
        className={`h-4 w-4 ${isRefreshing ? 'animate-spin' : ''}`}
        fill="none"
        stroke="currentColor"
        viewBox="0 0 24 24"
        aria-hidden="true"
      >
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
      </svg>
    </button>
  );

  return (
    <WidgetCard
      title={t('portfolioValue.title')}
      titleHref="/reports/portfolio-value"
      widgetId={WIDGET_ID}
      headerRight={
        /* The window the chart draws, and on a desktop the control that
           reprices it, to its left. The figures are not here: a header-right
           column ends where the settings gear begins, and the value reads as
           the card's figure only when it ends on the card's own edge. */
        <div className="flex items-center gap-x-2">
          {!isMobile && refreshButton}
          <span className="whitespace-nowrap text-sm text-gray-500 dark:text-gray-400">
            {t(`widgets.rangeLabels.${config.range}` as Parameters<typeof t>[0])}
          </span>
        </div>
      }
      configControls={configControls}
      configTitle={t('portfolioValue.title')}
    >
      {/* The value and the move it made, on their own row at the top of the
          body: the body spans the whole card, so the two end flush with its
          right edge at every width instead of stopping short of the gear. On a
          phone the refresh control rides at their left, which is the line that
          still has room for it. */}
      <div className="mb-2 flex items-center justify-end gap-2" data-testid="portfolio-figures">
        {isMobile && refreshButton}
        <div className="flex flex-col items-end gap-0.5">
          {totalPortfolioValue !== null && (
            <span className="whitespace-nowrap text-sm font-semibold text-gray-900 dark:text-gray-100">
              <PartialTotal
                total={portfolioPartialTotal(totalPortfolioValue, summary)}
                displayCurrency={defaultCurrency}
              >
                {formatCurrency(totalPortfolioValue, defaultCurrency)}
              </PartialTotal>
            </span>
          )}
          {/* What the holdings earned over the window, with the reader's own
              deposits taken out -- captioned as the investment result, because
              a value change under a "Change" caption reports a transfer as a
              gain. The value change and the net deposits behind it are named in
              the tooltip, which is the only room this card has for them.

              A server that has not answered shows nothing at all: a failed
              request is not a period that did nothing. A figure the server
              withheld is the unknown marker with its own cause, never a zero. */}
          {!loading && periodResult && (
            <span
              className={`flex items-center gap-1 whitespace-nowrap text-xs font-medium ${investmentResult === null ? '' : gainLossColor(investmentResult)}`}
              data-testid="portfolio-period-change"
            >
              <span className="text-gray-500 dark:text-gray-400">
                {t('portfolioValue.investmentResult')}
              </span>
              {investmentResult === null ? (
                <UnknownAmount reason={unknownReason} className="font-normal" />
              ) : (
                <>
                  {investmentResult >= 0 ? '+' : ''}
                  {formatCurrency(investmentResult, defaultCurrency)}
                  {returnPercent !== null && (
                    <span>({formatSignedPercent(returnPercent, 1)})</span>
                  )}
                </>
              )}
              <InfoTooltip
                placement="top"
                align="right"
                text={t('portfolioValue.periodBreakdownInvestedTooltip', {
                  valueChange: breakdownText(
                    periodResult.investedValueChange ?? null,
                  ),
                  netInvested: breakdownText(
                    periodResult.investmentCapitalFlows ?? null,
                  ),
                  income: breakdownText(periodResult.investmentIncome ?? null),
                })}
              />
            </span>
          )}
        </div>
      </div>
      {loading ? (
        <div className="flex-1 min-h-[260px] animate-pulse skeleton-shimmer rounded-md bg-gray-100 dark:bg-gray-700/50" />
      ) : chartData.length === 0 ? (
        <WidgetMessage>{t('portfolioValue.empty')}</WidgetMessage>
      ) : (
        <div className="flex-1 min-h-[260px]">
          <ResponsiveContainer width="100%" height="100%" minWidth={0}>
            <AreaChart data={chartData} margin={{ left: 4, right: 8, top: 4 }}>
              <defs>
                <ChartAreaGradient id="portfolioValueGradient" color={chartColors.primary} />
              </defs>
              <CartesianGrid {...CHART_GRID_PROPS} />
              <XAxis
                dataKey="date"
                tickFormatter={(value) => chartData.find((d) => d.date === value)?.label ?? String(value)}
                tick={{ fontSize: 11 }}
                minTickGap={24}
              />
              <YAxis tickFormatter={formatCurrencyAxis} tick={{ fontSize: 11 }} width={56} domain={['auto', 'auto']} />
              <Tooltip
                content={({ active, payload }) => {
                  if (!active || !payload?.length) return null;
                  const d = payload[0].payload as (typeof chartData)[number];
                  return (
                    <ChartTooltipPanel>
                      <p className="font-medium text-gray-900 dark:text-gray-100">{d.label}</p>
                      <p className="text-sm text-gray-600 dark:text-gray-400">
                        {d.value === null ? (
                          t('portfolioValue.notAvailable')
                        ) : (
                          formatCurrency(d.value, defaultCurrency)
                        )}
                      </p>
                    </ChartTooltipPanel>
                  );
                }}
              />
              <Area
                activeDot={ChartActiveDot}
                type="monotone"
                dataKey="value"
                stroke={chartColors.primary}
                strokeWidth={2}
                fill="url(#portfolioValueGradient)"
                connectNulls={false}
              />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      )}
    </WidgetCard>
  );
}
