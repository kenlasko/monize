'use client';

import { useState, useMemo, useEffect } from 'react';
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  ReferenceLine,
} from 'recharts';
import { ScheduledTransaction } from '@/types/scheduled-transaction';
import { Account } from '@/types/account';
import { Select } from '@/components/ui/Select';
import {
  buildForecast,
  getForecastSummary,
  ForecastPeriod,
  ForecastDataPoint,
  FutureTransaction,
  FORECAST_PERIOD_LABELS,
} from '@/lib/forecast';
import { useNumberFormat } from '@/hooks/useNumberFormat';

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
}: {
  active?: boolean;
  payload?: Array<{ payload: ForecastDataPoint }>;
  formatCurrency: (v: number) => string;
}) {
  if (active && payload?.[0]) {
    const data = payload[0].payload;
    return (
      <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg shadow-lg p-3 max-w-xs">
        <p className="font-medium text-gray-900 dark:text-gray-100 mb-1">
          {data.label}
        </p>
        <p
          className={`text-lg font-semibold ${
            data.balance >= 0
              ? 'text-green-600 dark:text-green-400'
              : 'text-red-600 dark:text-red-400'
          }`}
        >
          {formatCurrency(data.balance)}
        </p>
        {data.transactions.length > 0 && (
          <div className="mt-2 pt-2 border-t border-gray-200 dark:border-gray-700">
            <p className="text-xs text-gray-500 dark:text-gray-400 mb-1">
              Transactions:
            </p>
            {data.transactions.slice(0, 5).map((tx, i) => (
              <p key={i} className="text-sm text-gray-700 dark:text-gray-300">
                <span
                  className={
                    tx.amount >= 0
                      ? 'text-green-600 dark:text-green-400'
                      : 'text-red-600 dark:text-red-400'
                  }
                >
                  {formatCurrency(tx.amount)}
                </span>{' '}
                {tx.name}
              </p>
            ))}
            {data.transactions.length > 5 && (
              <p className="text-xs text-gray-400 dark:text-gray-500">
                +{data.transactions.length - 5} more
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
  const { formatCurrencyCompact: formatCurrency, formatCurrencyAxis } = useNumberFormat();
  const [selectedPeriod, setSelectedPeriod] = useState<ForecastPeriod>(() => getStoredPeriod());
  const [selectedAccountId, setSelectedAccountId] = useState<string>(() => getStoredAccountId());

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
      { value: 'all', label: 'All Accounts' },
      ...accounts
        .filter(a => !a.isClosed && a.accountType !== 'ASSET' && a.accountSubType !== 'INVESTMENT_BROKERAGE')
        .sort((a, b) => a.name.localeCompare(b.name))
        .map(a => ({ value: a.id, label: a.name })),
    ];
  }, [accounts]);

  const forecastData = useMemo(() => {
    return buildForecast(accounts, scheduledTransactions, selectedPeriod, selectedAccountId, futureTransactions);
  }, [accounts, scheduledTransactions, selectedPeriod, selectedAccountId, futureTransactions]);

  const summary = useMemo(() => {
    return getForecastSummary(forecastData);
  }, [forecastData]);

  // Count total transactions in forecast for debugging
  const totalForecastedTransactions = useMemo(() => {
    return forecastData.reduce((sum, dp) => sum + dp.transactions.length, 0);
  }, [forecastData]);

  // Index of the first data point at the minimum balance (for single callout)
  const minBalanceIndex = useMemo(() => {
    if (forecastData.length === 0) return -1;
    return forecastData.findIndex((dp) => dp.balance === summary.minBalance);
  }, [forecastData, summary.minBalance]);

  if (isLoading) {
    return (
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-3 sm:p-6 mb-6">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
            Cash Flow Forecast
          </h3>
        </div>
        <div className="h-72 flex items-center justify-center">
          <div className="animate-pulse w-full h-full bg-gray-200 dark:bg-gray-700 rounded" />
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
            Cash Flow Forecast
          </h3>
          {totalForecastedTransactions > 0 && (
            <p className="text-sm text-gray-500 dark:text-gray-400">
              {totalForecastedTransactions} scheduled transaction{totalForecastedTransactions !== 1 ? 's' : ''} in forecast
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
          <p>No data to display</p>
          <p className="text-sm mt-1">
            {accounts.length === 0 ? 'No accounts found' :
             scheduledTransactions.length === 0 ? 'No scheduled transactions' :
             'Select an account with scheduled transactions'}
          </p>
        </div>
      ) : totalForecastedTransactions === 0 ? (
        <div className="h-72" style={{ minHeight: 288 }}>
          <div className="text-center text-sm text-gray-500 dark:text-gray-400 mb-2">
            No upcoming transactions in this period - showing current balance
          </div>
          <ResponsiveContainer width="100%" height="90%" minWidth={0}>
            <LineChart data={forecastData} margin={{ left: 0, right: 8, top: 5, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" className="dark:stroke-gray-700" />
              <XAxis dataKey="label" tick={{ fill: '#6b7280', fontSize: 12 }} tickLine={false} axisLine={{ stroke: '#e5e7eb' }} interval="preserveStartEnd" />
              <YAxis tick={{ fill: '#6b7280', fontSize: 11 }} tickLine={false} axisLine={false} tickFormatter={formatCurrencyAxis} width={45} domain={['auto', 'auto']} />
              <Tooltip content={<CashFlowTooltip formatCurrency={formatCurrency} />} />
              <ReferenceLine y={0} stroke="#ef4444" strokeDasharray="5 5" strokeOpacity={0.5} />
              <Line type="monotone" dataKey="balance" stroke="#9ca3af" strokeWidth={2} dot={false} strokeDasharray="5 5" />
            </LineChart>
          </ResponsiveContainer>
        </div>
      ) : (
        <div className="h-72" style={{ minHeight: 288 }}>
          <ResponsiveContainer width="100%" height="100%" minWidth={0}>
            <LineChart data={forecastData} margin={{ left: 0, right: 8, top: 5, bottom: 0 }}>
              <defs>
                <filter id="minShadow" x="-20%" y="-20%" width="140%" height="140%">
                  <feDropShadow dx="0" dy="1" stdDeviation="2" floodOpacity="0.3" />
                </filter>
              </defs>
              <CartesianGrid
                strokeDasharray="3 3"
                stroke="#e5e7eb"
                className="dark:stroke-gray-700"
              />
              <XAxis
                dataKey="label"
                tick={{ fill: '#6b7280', fontSize: 12 }}
                tickLine={false}
                axisLine={{ stroke: '#e5e7eb' }}
                interval="preserveStartEnd"
              />
              <YAxis
                tick={{ fill: '#6b7280', fontSize: 11 }}
                tickLine={false}
                axisLine={false}
                tickFormatter={formatCurrencyAxis}
                width={45}
                domain={['auto', 'auto']}
              />
              <Tooltip content={<CashFlowTooltip formatCurrency={formatCurrency} />} />
              {/* Reference line at $0 */}
              <ReferenceLine
                y={0}
                stroke="#ef4444"
                strokeDasharray="5 5"
                strokeOpacity={0.5}
              />
              {/* Reference line at minimum balance */}
              {summary.minBalance !== summary.startingBalance && (
                <ReferenceLine
                  y={summary.minBalance}
                  stroke={summary.minBalance < 0 ? '#ef4444' : '#f59e0b'}
                  strokeDasharray="3 3"
                  strokeOpacity={0.4}
                />
              )}
              <Line
                type="monotone"
                dataKey="balance"
                stroke="#3b82f6"
                strokeWidth={2}
                dot={(props: any) => {
                  const { cx, cy, payload } = props;
                  if (props.index === minBalanceIndex) {
                    const color = summary.minBalance < 0 ? '#ef4444' : '#f59e0b';
                    const label = formatCurrencyAxis(summary.minBalance);
                    const labelWidth = label.length * 7 + 14;
                    const labelHeight = 22;
                    const arrowSize = 5;
                    const gap = 24;
                    const bubbleBottom = cy - gap;
                    const bubbleTop = bubbleBottom - arrowSize - labelHeight;
                    return (
                      <g key={`min-${props.index}`}>
                        <circle cx={cx} cy={cy} r={5} fill={color} stroke="#fff" strokeWidth={2} />
                        {/* Connector line from dot to arrow */}
                        <line x1={cx} y1={cy - 5} x2={cx} y2={bubbleBottom} stroke={color} strokeWidth={1.5} strokeDasharray="3 2" />
                        {/* Bubble */}
                        <rect
                          x={cx - labelWidth / 2}
                          y={bubbleTop}
                          width={labelWidth}
                          height={labelHeight}
                          rx={5}
                          fill={color}
                          filter="url(#minShadow)"
                        />
                        {/* Arrow */}
                        <polygon
                          points={`${cx - arrowSize},${bubbleTop + labelHeight} ${cx + arrowSize},${bubbleTop + labelHeight} ${cx},${bubbleBottom}`}
                          fill={color}
                        />
                        <text
                          x={cx}
                          y={bubbleTop + labelHeight / 2}
                          textAnchor="middle"
                          dominantBaseline="central"
                          fill="#fff"
                          fontSize={11}
                          fontWeight={600}
                        >
                          {label}
                        </text>
                      </g>
                    );
                  }
                  return <circle key={`dot-${props.index}`} cx={cx} cy={cy} r={0} fill="none" />;
                }}
                activeDot={{ r: 6, fill: '#3b82f6' }}
              />
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}

      {/* Summary footer */}
      {forecastData.length > 0 && (
        <div className="mt-4 pt-4 border-t border-gray-200 dark:border-gray-700 grid grid-cols-3 gap-4 text-center">
          <div>
            <div className="text-sm text-gray-500 dark:text-gray-400">Starting</div>
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
            <div className="text-sm text-gray-500 dark:text-gray-400">Ending</div>
            <div
              className={`font-semibold ${
                summary.endingBalance >= 0
                  ? 'text-green-600 dark:text-green-400'
                  : 'text-red-600 dark:text-red-400'
              }`}
            >
              {formatCurrency(summary.endingBalance)}
            </div>
          </div>
          <div>
            <div className="text-sm text-gray-500 dark:text-gray-400">
              {summary.goesNegative ? 'Lowest' : 'Min Balance'}
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
