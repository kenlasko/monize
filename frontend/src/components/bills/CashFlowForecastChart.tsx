'use client';

import { useState, useMemo, useEffect, useCallback } from 'react';
import { useTranslations } from 'next-intl';
import { gainLossColor } from '@/lib/format';
import { Skeleton } from '@/components/ui/LoadingSkeleton';
import {
  AreaChart,
  Area,
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
import { ScheduledTransaction } from '@/types/scheduled-transaction';
import { Account } from '@/types/account';
import { Select } from '@/components/ui/Select';
import { buildAccountDropdownOptions } from '@/lib/account-utils';
import {
  buildForecast,
  getForecastSummary,
  ForecastPeriod,
  ForecastDataPoint,
  FutureTransaction,
  FORECAST_PERIOD_LABELS,
} from '@/lib/forecast';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import { useChartDateFormat } from '@/hooks/useChartDateFormat';
import { useExchangeRates } from '@/hooks/useExchangeRates';

interface CashFlowForecastChartProps {
  scheduledTransactions: ScheduledTransaction[];
  accounts: Account[];
  futureTransactions?: FutureTransaction[];
  isLoading: boolean;
}

function CashFlowTooltip({
  active,
  payload,
  formatCurrency,
  formatChartDate,
}: {
  active?: boolean;
  payload?: Array<{ payload: ForecastDataPoint }>;
  formatCurrency: (v: number) => string;
  formatChartDate: (date: Date | string, pattern: 'MMM d') => string;
}) {
  const t = useTranslations('bills');
  if (active && payload?.[0]) {
    const data = payload[0].payload;
    return (
      <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg shadow-lg p-3 max-w-xs">
        <p className="font-medium text-gray-900 dark:text-gray-100 mb-1">
          {formatChartDate(data.date, 'MMM d')}
        </p>
        <p
          className={`text-lg font-semibold ${
            gainLossColor(data.balance)
          }`}
        >
          {formatCurrency(data.balance)}
        </p>
        {data.transactions.length > 0 && (
          <div className="mt-2 pt-2 border-t border-gray-200 dark:border-gray-700">
            <p className="text-xs text-gray-500 dark:text-gray-400 mb-1">
              {t('forecast.tooltipTransactions')}
            </p>
            {data.transactions.slice(0, 5).map((tx, i) => (
              <p key={i} className="text-sm text-gray-700 dark:text-gray-300">
                <span
                  className={
                    gainLossColor(tx.amount)
                  }
                >
                  {formatCurrency(tx.amount)}
                </span>{' '}
                {tx.name}
              </p>
            ))}
            {data.transactions.length > 5 && (
              <p className="text-xs text-gray-400 dark:text-gray-500">
                {t('forecast.tooltipMore', { count: data.transactions.length - 5 })}
              </p>
            )}
          </div>
        )}
      </div>
    );
  }
  return null;
}

const PERIODS: ForecastPeriod[] = ['week', 'month', '90days', '6months', 'year'];
const STORAGE_KEY_PERIOD = 'cashFlowForecast.period';
const STORAGE_KEY_ACCOUNT = 'cashFlowForecast.accountId';

function getStoredPeriod(): ForecastPeriod {
  if (typeof window === 'undefined') return 'month';
  const stored = localStorage.getItem(STORAGE_KEY_PERIOD);
  if (stored && PERIODS.includes(stored as ForecastPeriod)) {
    return stored as ForecastPeriod;
  }
  return 'month';
}

function getStoredAccountId(): string {
  if (typeof window === 'undefined') return 'all';
  return localStorage.getItem(STORAGE_KEY_ACCOUNT) || 'all';
}

export function CashFlowForecastChart({
  scheduledTransactions,
  accounts,
  futureTransactions = [],
  isLoading,
}: CashFlowForecastChartProps) {
  const t = useTranslations('bills');
  const tc = useTranslations('common');
  const { formatCurrency: formatCurrencyFull, formatCurrencyAxis, formatCurrencyFlag } =
    useNumberFormat();
  const formatChartDate = useChartDateFormat();
  const { convertToDefault, defaultCurrency } = useExchangeRates();
  const [selectedPeriod, setSelectedPeriod] = useState<ForecastPeriod>(() => getStoredPeriod());
  const [selectedAccountId, setSelectedAccountId] = useState<string>(() => getStoredAccountId());
  // High/low value bubbles the user has temporarily dismissed, keyed by the
  // value they marked so a forecast change with a new extreme shows its bubble
  // again. Component-local (not persisted), so it resets on navigation.
  const [dismissedHigh, setDismissedHigh] = useState<number | null>(null);
  const [dismissedLow, setDismissedLow] = useState<number | null>(null);

  // Persist period changes
  useEffect(() => {
    localStorage.setItem(STORAGE_KEY_PERIOD, selectedPeriod);
  }, [selectedPeriod]);

  // Persist account changes
  useEffect(() => {
    localStorage.setItem(STORAGE_KEY_ACCOUNT, selectedAccountId);
  }, [selectedAccountId]);

  const accountOptions = useMemo(() => {
    return [
      { value: 'all', label: t('forecast.allAccounts') },
      ...buildAccountDropdownOptions(
        accounts,
        a => !a.isClosed && a.accountType !== 'ASSET' && a.accountSubType !== 'INVESTMENT_BROKERAGE',
        a => a.name,
      ),
    ];
  }, [accounts, t]);

  // Determine display currency from selected accounts
  const { chartCurrency, needsConversion } = useMemo(() => {
    const targetAccounts = selectedAccountId === 'all'
      ? accounts.filter(a => !a.isClosed)
      : accounts.filter(a => a.id === selectedAccountId);
    const currencies = new Set(targetAccounts.map(a => a.currencyCode));
    return {
      chartCurrency: currencies.size === 1 ? [...currencies][0] : defaultCurrency,
      needsConversion: currencies.size > 1,
    };
  }, [accounts, selectedAccountId, defaultCurrency]);

  const formatCurrency = useCallback(
    (value: number) => formatCurrencyFull(value, chartCurrency),
    [formatCurrencyFull, chartCurrency],
  );

  const formatAxis = useCallback(
    (value: number) => formatCurrencyAxis(value, chartCurrency),
    [formatCurrencyAxis, chartCurrency],
  );

  const formatFlag = useCallback(
    (value: number) => formatCurrencyFlag(value, chartCurrency),
    [formatCurrencyFlag, chartCurrency],
  );

  const forecastData = useMemo(() => {
    return buildForecast(
      accounts, scheduledTransactions, selectedPeriod, selectedAccountId, futureTransactions,
      needsConversion ? convertToDefault : undefined,
    );
  }, [accounts, scheduledTransactions, selectedPeriod, selectedAccountId, futureTransactions, needsConversion, convertToDefault]);

  const summary = useMemo(() => {
    return getForecastSummary(forecastData);
  }, [forecastData]);

  // Count total transactions in forecast for debugging
  const totalForecastedTransactions = useMemo(() => {
    return forecastData.reduce((sum, dp) => sum + dp.transactions.length, 0);
  }, [forecastData]);

  // Highest/lowest forecast points get green/red value bubbles, each placed to
  // the inside of whichever chart half it falls on so the callouts stay clear
  // of the plot edges and the dot marker.
  const flags = useMemo(
    () => computeMinMaxFlagIndices(forecastData.map((dp) => dp.balance)),
    [forecastData],
  );
  const highValue = flags.show ? forecastData[flags.maxIndex].balance : null;
  const lowValue = flags.show ? forecastData[flags.minIndex].balance : null;
  const highLabel = highValue !== null ? formatFlag(highValue) : '';
  const lowLabel = lowValue !== null ? formatFlag(lowValue) : '';
  const highDismissed = highValue !== null && highValue === dismissedHigh;
  const lowDismissed = lowValue !== null && lowValue === dismissedLow;

  const areaGradient = useMemo(
    () => computeBalanceGradient(forecastData.map((point) => point.balance)),
    [forecastData],
  );

  if (isLoading) {
    return (
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-3 sm:p-6 mb-6">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
            {t('forecast.title')}
          </h3>
        </div>
        <div className="h-72 flex items-center justify-center">
          <Skeleton className="w-full h-full" />
        </div>
      </div>
    );
  }

  return (
    <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-3 sm:p-6 mb-6">
      {/* Header with controls */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 mb-4">
        <div>
          <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
            {t('forecast.title')}
          </h3>
          {totalForecastedTransactions > 0 && (
            <p className="text-sm text-gray-500 dark:text-gray-400">
              {t('forecast.scheduledCount', { count: totalForecastedTransactions })}
            </p>
          )}
        </div>
        <div className="flex flex-col sm:flex-row items-start sm:items-center gap-3">
          {/* Period selector */}
          <div className="flex bg-gray-100 dark:bg-gray-700 rounded-lg p-1">
            {PERIODS.map((period) => (
              <button
                key={period}
                onClick={() => setSelectedPeriod(period)}
                className={`px-3 py-1.5 text-sm font-medium rounded-md transition-colors ${
                  selectedPeriod === period
                    ? 'bg-white dark:bg-gray-600 text-gray-900 dark:text-gray-100 shadow-sm'
                    : 'text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-200'
                }`}
              >
                {FORECAST_PERIOD_LABELS[period]}
              </button>
            ))}
          </div>
          {/* Account selector */}
          <div className="w-48">
            <Select
              value={selectedAccountId}
              onChange={(e) => setSelectedAccountId(e.target.value)}
              options={accountOptions}
              className="text-sm"
            />
          </div>
        </div>
      </div>

      {/* Chart */}
      {forecastData.length === 0 ? (
        <div className="h-72 flex flex-col items-center justify-center text-gray-500 dark:text-gray-400">
          <p>{t('forecast.noData')}</p>
          <p className="text-sm mt-1">
            {accounts.length === 0 ? t('forecast.noAccounts') :
             scheduledTransactions.length === 0 ? t('forecast.noScheduled') :
             t('forecast.noMatchingAccount')}
          </p>
        </div>
      ) : totalForecastedTransactions === 0 ? (
        <div className="h-72" style={{ minHeight: 288 }}>
          <div className="text-center text-sm text-gray-500 dark:text-gray-400 mb-2">
            {t('forecast.noUpcoming')}
          </div>
          <ResponsiveContainer width="100%" height="90%" minWidth={0}>
            <LineChart data={forecastData} margin={{ left: 0, right: 8, top: 5, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke={chartColors.grid} />
              <XAxis dataKey="date" tickFormatter={(value: string) => formatChartDate(value, 'MMM d')} tick={{ fill: chartColors.axis, fontSize: 12 }} tickLine={false} axisLine={{ stroke: chartColors.grid }} interval="preserveStartEnd" />
              <YAxis tick={{ fill: chartColors.axis, fontSize: 11 }} tickLine={false} axisLine={false} tickFormatter={formatAxis} width="auto" domain={['auto', 'auto']} />
              <Tooltip content={<CashFlowTooltip formatCurrency={formatCurrency} formatChartDate={formatChartDate} />} />
              <ReferenceLine y={0} stroke={chartColors.expense} strokeDasharray="5 5" strokeOpacity={0.5} />
              <Line type="monotone" dataKey="balance" stroke={chartColors.axis} strokeWidth={2} dot={false} strokeDasharray="5 5" />
            </LineChart>
          </ResponsiveContainer>
        </div>
      ) : (
        <div className="h-72" style={{ minHeight: 288 }}>
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
              <CartesianGrid
                strokeDasharray="3 3"
                stroke={chartColors.grid}
              />
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
              <Tooltip content={<CashFlowTooltip formatCurrency={formatCurrency} formatChartDate={formatChartDate} />} />
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
                dot={(props: { cx?: number; cy?: number; index?: number }) =>
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
                  })
                }
                activeDot={{ r: 6, fill: chartColors.primary }}
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
              {formatCurrency(summary.startingBalance)}
            </div>
          </div>
          <div>
            <div className="text-sm text-gray-500 dark:text-gray-400">{t('forecast.summaryEnding')}</div>
            <div
              className={`font-semibold ${
                gainLossColor(summary.endingBalance)
              }`}
            >
              {formatCurrency(summary.endingBalance)}
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
              {formatCurrency(summary.minBalance)}
              {summary.goesNegative && (
                <span className="ml-1 text-xs text-red-500">!</span>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
