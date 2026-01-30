'use client';

import { useState, useMemo } from 'react';
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
  FORECAST_PERIOD_LABELS,
} from '@/lib/forecast';

interface CashFlowForecastChartProps {
  scheduledTransactions: ScheduledTransaction[];
  accounts: Account[];
  isLoading: boolean;
}

const PERIODS: ForecastPeriod[] = ['week', 'month', '90days', '6months', 'year'];

export function CashFlowForecastChart({
  scheduledTransactions,
  accounts,
  isLoading,
}: CashFlowForecastChartProps) {
  const [selectedPeriod, setSelectedPeriod] = useState<ForecastPeriod>('month');
  const [selectedAccountId, setSelectedAccountId] = useState<string>('all');

  const accountOptions = useMemo(() => {
    return [
      { value: 'all', label: 'All Accounts' },
      ...accounts
        .filter(a => !a.isClosed)
        .sort((a, b) => a.name.localeCompare(b.name))
        .map(a => ({ value: a.id, label: a.name })),
    ];
  }, [accounts]);

  const forecastData = useMemo(() => {
    return buildForecast(accounts, scheduledTransactions, selectedPeriod, selectedAccountId);
  }, [accounts, scheduledTransactions, selectedPeriod, selectedAccountId]);

  const summary = useMemo(() => {
    return getForecastSummary(forecastData);
  }, [forecastData]);

  // Count total transactions in forecast for debugging
  const totalForecastedTransactions = useMemo(() => {
    return forecastData.reduce((sum, dp) => sum + dp.transactions.length, 0);
  }, [forecastData]);

  const formatCurrency = (value: number) => {
    return new Intl.NumberFormat('en-CA', {
      style: 'currency',
      currency: 'CAD',
      minimumFractionDigits: 0,
      maximumFractionDigits: 0,
    }).format(value);
  };

  const formatCompactCurrency = (value: number) => {
    if (Math.abs(value) >= 1000) {
      return `$${(value / 1000).toFixed(0)}k`;
    }
    return `$${value}`;
  };

  const CustomTooltip = ({
    active,
    payload,
  }: {
    active?: boolean;
    payload?: Array<{ payload: ForecastDataPoint }>;
  }) => {
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
  };

  if (isLoading) {
    return (
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-6 mb-6">
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
    <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-6 mb-6">
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
        <div className="h-72">
          <div className="text-center text-sm text-gray-500 dark:text-gray-400 mb-2">
            No upcoming transactions in this period - showing current balance
          </div>
          <ResponsiveContainer width="100%" height="90%">
            <LineChart data={forecastData}>
              <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" className="dark:stroke-gray-700" />
              <XAxis dataKey="label" tick={{ fill: '#6b7280', fontSize: 12 }} tickLine={false} axisLine={{ stroke: '#e5e7eb' }} interval="preserveStartEnd" />
              <YAxis tick={{ fill: '#6b7280', fontSize: 12 }} tickLine={false} axisLine={{ stroke: '#e5e7eb' }} tickFormatter={formatCompactCurrency} width={60} domain={['auto', 'auto']} />
              <Tooltip content={<CustomTooltip />} />
              <ReferenceLine y={0} stroke="#ef4444" strokeDasharray="5 5" strokeOpacity={0.5} />
              <Line type="monotone" dataKey="balance" stroke="#9ca3af" strokeWidth={2} dot={false} strokeDasharray="5 5" />
            </LineChart>
          </ResponsiveContainer>
        </div>
      ) : (
        <div className="h-72">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={forecastData}>
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
                tick={{ fill: '#6b7280', fontSize: 12 }}
                tickLine={false}
                axisLine={{ stroke: '#e5e7eb' }}
                tickFormatter={formatCompactCurrency}
                width={60}
                domain={['auto', 'auto']}
              />
              <Tooltip content={<CustomTooltip />} />
              {/* Reference line at $0 */}
              <ReferenceLine
                y={0}
                stroke="#ef4444"
                strokeDasharray="5 5"
                strokeOpacity={0.5}
              />
              <Line
                type="monotone"
                dataKey="balance"
                stroke="#3b82f6"
                strokeWidth={2}
                dot={false}
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
