'use client';

import { useState, useMemo, useCallback } from 'react';
import { useTranslations } from 'next-intl';
import { gainLossColor } from '@/lib/format';
import {
  AreaChart,
  Area,
  ComposedChart,
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  ReferenceLine,
} from 'recharts';
import { chartColors } from '@/lib/chart-colors';
import { computeBalanceGradient } from '@/lib/balance-history';
import {
  ChartFlagShadowFilter,
  computeMinMaxFlagIndices,
  renderMinMaxFlagDots,
} from '@/components/investments/portfolio-chart-utils';
import { ChartTooltipPanel } from '@/components/reports/ChartTooltip';
import { ScheduledTransaction } from '@/types/scheduled-transaction';
import { Account } from '@/types/account';
import { countOverdueOccurrences } from '@/lib/forecast';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import { useChartDateFormat } from '@/hooks/useChartDateFormat';
import type {
  CashFlowForecast,
  CashFlowForecastAccountLine,
  CashFlowForecastPoint,
} from './useCashFlowForecast';
import { CHART_GRID_PROPS } from '@/lib/chart-style';
import { ChartActiveDot } from '@/components/ui/ChartActiveDot';
import { useAmountEstimateText } from '@/components/scheduled-transactions/useAmountEstimateText';

function CashFlowTooltip({
  active,
  payload,
  formatValue,
  formatChartDate,
  lines = [],
}: {
  active?: boolean;
  payload?: Array<{ payload: CashFlowForecastPoint }>;
  formatValue: (v: number) => string;
  formatChartDate: (date: Date | string, pattern: 'MMM d') => string;
  lines?: CashFlowForecastAccountLine[];
}) {
  const t = useTranslations('bills');
  const tc = useTranslations('common');
  if (active && payload?.[0]) {
    const data = payload[0].payload;
    const balances = data.balances ?? {};
    // Every selected account gets a balance at every point, so this only drops
    // a line the series and the data disagree about -- never a known value.
    const accountRows = lines.filter(
      (line) => typeof balances[line.accountId] === 'number',
    );
    const accountNames = new Map(lines.map((line) => [line.accountId, line.name]));
    // Overdue occurrences land on the first day (discussion #1784); saying so is what
    // keeps that day's drop from reading as a mistake.
    const overdueCount = countOverdueOccurrences(data.transactions);
    return (
      <ChartTooltipPanel>
        <div className="max-w-xs">
          <p className="font-medium text-gray-900 dark:text-gray-100 mb-1">
            {formatChartDate(data.date, 'MMM d')}
          </p>
          {accountRows.length > 0 && (
            <p className="text-xs text-gray-500 dark:text-gray-400">
              {t('forecast.totalOfAccounts')}
            </p>
          )}
          <p
            className={`text-lg font-semibold ${
              gainLossColor(data.balance)
            }`}
          >
            {formatValue(data.balance)}
          </p>
          {overdueCount > 0 && (
            <p className="text-xs text-amber-700 dark:text-amber-300">
              {tc('scheduledOverdue.included', { count: overdueCount })}
            </p>
          )}
          {accountRows.length > 0 && (
            <div className="mt-2 pt-2 border-t border-gray-200 dark:border-gray-700 space-y-0.5">
              {accountRows.map((line) => (
                <p key={line.accountId} className="flex items-center gap-2 text-sm">
                  <span
                    aria-hidden="true"
                    className="inline-block h-2 w-2 shrink-0 rounded-full"
                    style={{ backgroundColor: line.color }}
                  />
                  <span className="truncate text-gray-700 dark:text-gray-300">{line.name}</span>
                  <span className="ml-auto shrink-0 font-medium text-gray-900 dark:text-gray-100">
                    {formatValue(balances[line.accountId])}
                  </span>
                </p>
              ))}
            </div>
          )}
          {data.transactions.length > 0 && (
            <div className="mt-2 pt-2 border-t border-gray-200 dark:border-gray-700">
              <p className="text-xs text-gray-500 dark:text-gray-400 mb-1">
                {t('forecast.tooltipTransactions')}
              </p>
              {data.transactions.slice(0, 5).map((tx, i) => {
                const accountName = tx.accountId ? accountNames.get(tx.accountId) : undefined;
                return (
                  <p key={i} className="text-sm text-gray-700 dark:text-gray-300">
                    <span
                      className={
                        gainLossColor(tx.amount)
                      }
                    >
                      {formatValue(tx.amount)}
                    </span>{' '}
                    {tx.estimated && (
                      <span className="text-xs text-gray-500 dark:text-gray-400">
                        {t('forecast.tooltipEstimated')}{' '}
                      </span>
                    )}
                    {accountName
                      ? t('forecast.tooltipTransactionForAccount', {
                          name: tx.name,
                          account: accountName,
                        })
                      : tx.name}
                  </p>
                );
              })}
              {data.transactions.length > 5 && (
                <p className="text-xs text-gray-400 dark:text-gray-500">
                  {t('forecast.tooltipMore', { count: data.transactions.length - 5 })}
                </p>
              )}
            </div>
          )}
        </div>
      </ChartTooltipPanel>
    );
  }
  return null;
}

interface CashFlowForecastPlotProps {
  forecast: CashFlowForecast;
  /** The inputs the forecast was built from, to explain an empty one. */
  accounts: Account[];
  scheduledTransactions: ScheduledTransaction[];
  /** Height of the chart area. Defaults to the Bills & Deposits page's. */
  chartClassName?: string;
}

/**
 * The forecast as drawn: the missing-rate refusal, the legend, the chart and
 * the starting/ending/lowest summary. The Bills & Deposits chart and the
 * dashboard widget each wrap it in their own header and controls.
 */
export function CashFlowForecastPlot({
  forecast,
  accounts,
  scheduledTransactions,
  chartClassName = 'h-72',
}: CashFlowForecastPlotProps) {
  const t = useTranslations('bills');
  const tc = useTranslations('common');
  const { formatCurrency, formatCurrencyAxis, formatCurrencyFlag } =
    useNumberFormat();
  const formatChartDate = useChartDateFormat();
  const estimateText = useAmountEstimateText();
  const { chartCurrency, isMultiAccount, accountLines, summary, totalForecastedTransactions } =
    forecast;
  const forecastData = forecast.points;
  // High/low value bubbles the user has temporarily dismissed, keyed by the
  // value they marked so a forecast change with a new extreme shows its bubble
  // again. Component-local (not persisted), so it resets on navigation.
  const [dismissedHigh, setDismissedHigh] = useState<number | null>(null);
  const [dismissedLow, setDismissedLow] = useState<number | null>(null);

  const formatValue = useCallback(
    (value: number) => formatCurrency(value, chartCurrency),
    [formatCurrency, chartCurrency],
  );

  const formatAxis = useCallback(
    (value: number) => formatCurrencyAxis(value, chartCurrency),
    [formatCurrencyAxis, chartCurrency],
  );

  // Highest/lowest forecast points get green/red value bubbles, each placed to
  // the inside of whichever chart half it falls on so the callouts stay clear
  // of the plot edges and the dot marker.
  const flags = useMemo(
    () => computeMinMaxFlagIndices(forecastData.map((dp) => dp.balance)),
    [forecastData],
  );
  const highValue = flags.show ? forecastData[flags.maxIndex].balance : null;
  const lowValue = flags.show ? forecastData[flags.minIndex].balance : null;
  const highLabel = highValue !== null ? formatCurrencyFlag(highValue, chartCurrency) : '';
  const lowLabel = lowValue !== null ? formatCurrencyFlag(lowValue, chartCurrency) : '';
  const highDismissed = highValue !== null && highValue === dismissedHigh;
  const lowDismissed = lowValue !== null && lowValue === dismissedLow;

  const areaGradient = useMemo(
    () => computeBalanceGradient(forecastData.map((point) => point.balance)),
    [forecastData],
  );

  const renderTotalFlagDots = (props: { cx?: number; cy?: number; index?: number }) =>
    renderMinMaxFlagDots({
      cx: props.cx,
      cy: props.cy,
      index: props.index,
      flags,
      pointCount: forecastData.length,
      highColor: chartColors.income,
      lowColor: chartColors.expense,
      highLabel,
      lowLabel,
      highDismissed,
      lowDismissed,
      onDismissHigh: () => setDismissedHigh(highValue),
      onDismissLow: () => setDismissedLow(lowValue),
      dismissLabel: tc('chartFlag.dismiss'),
    });

  // A projected balance is cumulative, so one missing rate makes every day after
  // it wrong. The forecast builders return no points in that case and name the
  // currencies; the chart says so instead of drawing a plausible line.
  if (forecast.missingCurrencies.length > 0 || forecast.unknownEstimates.length > 0) {
    return (
      <div
        role="alert"
        className="space-y-1 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:border-amber-700 dark:bg-amber-900/30 dark:text-amber-200"
      >
        {forecast.missingCurrencies.length > 0 && (
          <p>
            {t('forecast.unavailableMissingRates', {
              currencies: forecast.missingCurrencies.join(', '),
              displayCurrency: chartCurrency,
            })}
          </p>
        )}
        {/* An unknown history estimate (issue #2096) is its own gap: no rate
            to add, but an occurrence amount to enter or a payment to record. */}
        {forecast.unknownEstimates.length > 0 && (
          <>
            <p>{t('forecast.unavailableUnknownEstimates')}</p>
            <ul className="list-disc pl-5">
              {forecast.unknownEstimates.map((id) => {
                const st = scheduledTransactions.find((s) => s.id === id);
                if (!st) return null;
                return (
                  <li key={id}>
                    {t('forecast.unknownEstimateItem', {
                      name: st.name,
                      reason: estimateText(st.amountEstimate, {
                        payeeName: st.payee?.name ?? st.payeeName,
                        categoryName: st.category?.name ?? null,
                      }),
                    })}
                  </li>
                );
              })}
            </ul>
          </>
        )}
      </div>
    );
  }

  return (
    <>
      {/* Legend: only meaningful once there is more than one line */}
      {accountLines.length > 0 && forecastData.length > 0 && (
        <ul
          aria-label={t('forecast.legendAriaLabel')}
          className="flex flex-wrap items-center gap-x-4 gap-y-1 mb-3 text-xs"
        >
          {([
            { accountId: '', name: t('forecast.totalOfAccounts'), color: chartColors.primary },
            ...accountLines,
          ] as CashFlowForecastAccountLine[])
            .map((line) => (
              <li key={line.accountId} className="flex items-center gap-1.5">
                <span
                  aria-hidden="true"
                  className="inline-block h-2.5 w-2.5 rounded-sm"
                  style={{ backgroundColor: line.color }}
                />
                <span className="text-gray-600 dark:text-gray-300">{line.name}</span>
              </li>
            ))}
        </ul>
      )}

      {/* Chart */}
      {forecastData.length === 0 ? (
        <div className={`${chartClassName} flex flex-col items-center justify-center text-gray-500 dark:text-gray-400`}>
          <p>{t('forecast.noData')}</p>
          <p className="text-sm mt-1">
            {accounts.length === 0 ? t('forecast.noAccounts') :
             scheduledTransactions.length === 0 ? t('forecast.noScheduled') :
             t('forecast.noMatchingAccount')}
          </p>
        </div>
      ) : isMultiAccount ? (
        <div className={chartClassName} style={{ minHeight: 288 }}>
          {totalForecastedTransactions === 0 && (
            <div className="text-center text-sm text-gray-500 dark:text-gray-400 mb-2">
              {t('forecast.noUpcoming')}
            </div>
          )}
          <ResponsiveContainer
            width="100%"
            height={totalForecastedTransactions === 0 ? '90%' : '100%'}
            minWidth={0}
          >
            {/* top margin leaves headroom for the high-value bubble callout */}
            <ComposedChart data={forecastData} margin={{ left: 0, right: 8, top: 20, bottom: 0 }}>
              <defs>
                <linearGradient id="forecastBalance" x1="0" y1="0" x2="0" y2="1">
                  <stop offset={0} stopColor={chartColors.primary} stopOpacity={areaGradient.topOpacity} />
                  <stop offset={areaGradient.zeroOffset} stopColor={chartColors.primary} stopOpacity={0} />
                  <stop offset={1} stopColor={chartColors.primary} stopOpacity={areaGradient.bottomOpacity} />
                </linearGradient>
              </defs>
              <ChartFlagShadowFilter />
              <CartesianGrid {...CHART_GRID_PROPS} />
              <XAxis
                dataKey="date"
                tickFormatter={(value: string) => formatChartDate(value, 'MMM d')}
                tick={{ fill: chartColors.axis, fontSize: 12 }}
                tickLine={false}
                axisLine={{ stroke: chartColors.grid }}
                interval="preserveStartEnd"
              />
              <YAxis
                tick={{ fill: chartColors.axis, fontSize: 11 }}
                tickLine={false}
                axisLine={false}
                tickFormatter={formatAxis}
                width="auto"
                domain={['auto', 'auto']}
              />
              <Tooltip
                content={
                  <CashFlowTooltip
                    formatValue={formatValue}
                    formatChartDate={formatChartDate}
                    lines={accountLines}
                  />
                }
              />
              <ReferenceLine y={0} stroke={chartColors.expense} strokeDasharray="5 5" strokeOpacity={0.5} />
              {summary.minBalance !== summary.startingBalance && (
                <ReferenceLine
                  y={summary.minBalance}
                  stroke={summary.minBalance < 0 ? chartColors.expense : chartColors.warning}
                  strokeDasharray="3 3"
                  strokeOpacity={0.4}
                />
              )}
              {/* The total keeps the single-account fill; the members are lines */}
              <Area
                type="monotone"
                dataKey="balance"
                name={t('forecast.totalOfAccounts')}
                stroke={chartColors.primary}
                strokeWidth={2}
                fillOpacity={1}
                fill="url(#forecastBalance)"
                dot={renderTotalFlagDots}
                activeDot={ChartActiveDot}
              />
              {accountLines.map((line) => (
                <Line
                  key={line.accountId}
                  type="monotone"
                  dataKey={`balances.${line.accountId}`}
                  name={line.name}
                  stroke={line.color}
                  strokeWidth={1.5}
                  fill="none"
                  dot={false}
                  connectNulls={false}
                  activeDot={ChartActiveDot}
                />
              ))}
            </ComposedChart>
          </ResponsiveContainer>
        </div>
      ) : totalForecastedTransactions === 0 ? (
        <div className={chartClassName} style={{ minHeight: 288 }}>
          <div className="text-center text-sm text-gray-500 dark:text-gray-400 mb-2">
            {t('forecast.noUpcoming')}
          </div>
          <ResponsiveContainer width="100%" height="90%" minWidth={0}>
            <LineChart data={forecastData} margin={{ left: 0, right: 8, top: 5, bottom: 0 }}>
              <CartesianGrid {...CHART_GRID_PROPS} />
              <XAxis dataKey="date" tickFormatter={(value: string) => formatChartDate(value, 'MMM d')} tick={{ fill: chartColors.axis, fontSize: 12 }} tickLine={false} axisLine={{ stroke: chartColors.grid }} interval="preserveStartEnd" />
              <YAxis tick={{ fill: chartColors.axis, fontSize: 11 }} tickLine={false} axisLine={false} tickFormatter={formatAxis} width="auto" domain={['auto', 'auto']} />
              <Tooltip content={<CashFlowTooltip formatValue={formatValue} formatChartDate={formatChartDate} />} />
              <ReferenceLine y={0} stroke={chartColors.expense} strokeDasharray="5 5" strokeOpacity={0.5} />
              <Line activeDot={ChartActiveDot} type="monotone" dataKey="balance" stroke={chartColors.axis} strokeWidth={2} dot={false} strokeDasharray="5 5" />
            </LineChart>
          </ResponsiveContainer>
        </div>
      ) : (
        <div className={chartClassName} style={{ minHeight: 288 }}>
          <ResponsiveContainer width="100%" height="100%" minWidth={0}>
            {/* top margin leaves headroom for the high-value bubble callout */}
            <AreaChart data={forecastData} margin={{ left: 0, right: 8, top: 20, bottom: 0 }}>
              <defs>
                <linearGradient id="forecastBalance" x1="0" y1="0" x2="0" y2="1">
                  <stop offset={0} stopColor={chartColors.primary} stopOpacity={areaGradient.topOpacity} />
                  <stop offset={areaGradient.zeroOffset} stopColor={chartColors.primary} stopOpacity={0} />
                  <stop offset={1} stopColor={chartColors.primary} stopOpacity={areaGradient.bottomOpacity} />
                </linearGradient>
              </defs>
              <ChartFlagShadowFilter />
              <CartesianGrid {...CHART_GRID_PROPS} />
              <XAxis
                dataKey="date"
                tickFormatter={(value: string) => formatChartDate(value, 'MMM d')}
                tick={{ fill: chartColors.axis, fontSize: 12 }}
                tickLine={false}
                axisLine={{ stroke: chartColors.grid }}
                interval="preserveStartEnd"
              />
              <YAxis
                tick={{ fill: chartColors.axis, fontSize: 11 }}
                tickLine={false}
                axisLine={false}
                tickFormatter={formatAxis}
                width="auto"
                domain={['auto', 'auto']}
              />
              <Tooltip content={<CashFlowTooltip formatValue={formatValue} formatChartDate={formatChartDate} />} />
              {/* Reference line at $0 */}
              <ReferenceLine
                y={0}
                stroke={chartColors.expense}
                strokeDasharray="5 5"
                strokeOpacity={0.5}
              />
              {/* Reference line at minimum balance */}
              {summary.minBalance !== summary.startingBalance && (
                <ReferenceLine
                  y={summary.minBalance}
                  stroke={summary.minBalance < 0 ? chartColors.expense : chartColors.warning}
                  strokeDasharray="3 3"
                  strokeOpacity={0.4}
                />
              )}
              <Area
                type="monotone"
                dataKey="balance"
                stroke={chartColors.primary}
                strokeWidth={2}
                fillOpacity={1}
                fill="url(#forecastBalance)"
                dot={renderTotalFlagDots}
                activeDot={ChartActiveDot}
              />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      )}

      {/* Summary footer */}
      {forecastData.length > 0 && (
        <div className="mt-4 pt-4 border-t border-gray-200 dark:border-gray-700 grid grid-cols-3 gap-4 text-center">
          <div>
            <div className="text-sm text-gray-500 dark:text-gray-400">{t('forecast.summaryStarting')}</div>
            <div
              className={`font-semibold ${
                summary.startingBalance >= 0
                  ? 'text-gray-900 dark:text-gray-100'
                  : 'text-red-600 dark:text-red-400'
              }`}
            >
              {formatValue(summary.startingBalance)}
            </div>
          </div>
          <div>
            <div className="text-sm text-gray-500 dark:text-gray-400">{t('forecast.summaryEnding')}</div>
            <div
              className={`font-semibold ${
                gainLossColor(summary.endingBalance)
              }`}
            >
              {formatValue(summary.endingBalance)}
            </div>
          </div>
          <div>
            <div className="text-sm text-gray-500 dark:text-gray-400">
              {summary.goesNegative ? t('forecast.summaryLowest') : t('forecast.summaryMinBalance')}
            </div>
            <div
              className={`font-semibold ${
                summary.minBalance >= 0
                  ? 'text-gray-900 dark:text-gray-100'
                  : 'text-red-600 dark:text-red-400'
              }`}
            >
              {formatValue(summary.minBalance)}
              {summary.goesNegative && (
                <span className="ml-1 text-xs text-red-500">!</span>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
