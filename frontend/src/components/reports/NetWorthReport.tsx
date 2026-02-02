'use client';

import { useState, useEffect, useMemo, useCallback } from 'react';
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Legend,
  ReferenceLine,
} from 'recharts';
import { format, subMonths, startOfMonth, endOfMonth, eachMonthOfInterval } from 'date-fns';
import { transactionsApi } from '@/lib/transactions';
import { accountsApi } from '@/lib/accounts';
import { Transaction } from '@/types/transaction';
import { Account } from '@/types/account';
import { parseLocalDate } from '@/lib/utils';
import { useNumberFormat } from '@/hooks/useNumberFormat';

type DateRange = '1y' | '2y' | '5y' | 'all' | 'custom';

export function NetWorthReport() {
  const { formatCurrencyCompact: formatCurrency } = useNumberFormat();
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [dateRange, setDateRange] = useState<DateRange>('1y');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');

  const getDateRange = useCallback((range: DateRange): { start: string; end: string } => {
    const now = new Date();
    const end = format(endOfMonth(now), 'yyyy-MM-dd');
    let start: string;

    switch (range) {
      case '1y':
        start = format(startOfMonth(subMonths(now, 11)), 'yyyy-MM-dd');
        break;
      case '2y':
        start = format(startOfMonth(subMonths(now, 23)), 'yyyy-MM-dd');
        break;
      case '5y':
        start = format(startOfMonth(subMonths(now, 59)), 'yyyy-MM-dd');
        break;
      case 'all':
        start = '2000-01-01';
        break;
      default:
        start = startDate || format(startOfMonth(subMonths(now, 11)), 'yyyy-MM-dd');
    }

    return { start, end };
  }, [startDate]);

  const loadData = useCallback(async () => {
    setIsLoading(true);
    try {
      const { start, end } = dateRange === 'custom'
        ? { start: startDate, end: endDate }
        : getDateRange(dateRange);

      const [txData, accData] = await Promise.all([
        transactionsApi.getAll({ startDate: start, endDate: end, limit: 100000 }),
        accountsApi.getAll(),
      ]);
      setTransactions(txData.data);
      setAccounts(accData);
    } catch (error) {
      console.error('Failed to load data:', error);
    } finally {
      setIsLoading(false);
    }
  }, [dateRange, startDate, endDate, getDateRange]);

  useEffect(() => {
    if (dateRange !== 'custom' || (startDate && endDate)) {
      loadData();
    }
  }, [dateRange, startDate, endDate, loadData]);

  const chartData = useMemo(() => {
    const { start, end } = dateRange === 'custom'
      ? { start: startDate, end: endDate }
      : getDateRange(dateRange);

    if (!start || !end) return [];

    // Get all months in range
    const months = eachMonthOfInterval({
      start: parseLocalDate(start),
      end: parseLocalDate(end),
    });

    // Calculate current balances as our ending point
    const currentTotals = {
      assets: 0,
      liabilities: 0,
    };

    accounts.forEach((acc) => {
      if (acc.isClosed) return;
      const balance = Number(acc.currentBalance) || 0;
      if (balance >= 0) {
        currentTotals.assets += balance;
      } else {
        currentTotals.liabilities += Math.abs(balance);
      }
    });

    // Build a running total by working backwards from current balances
    // We'll store month-end values
    const monthEndBalances = new Map<string, { assets: number; liabilities: number }>();

    // Start with current totals as the last month
    const lastMonth = format(months[months.length - 1], 'yyyy-MM');
    monthEndBalances.set(lastMonth, { ...currentTotals });

    // Group transactions by month
    const txByMonth = new Map<string, Transaction[]>();
    transactions.forEach((tx) => {
      const txMonth = format(parseLocalDate(tx.transactionDate), 'yyyy-MM');
      if (!txByMonth.has(txMonth)) {
        txByMonth.set(txMonth, []);
      }
      txByMonth.get(txMonth)!.push(tx);
    });

    // Work backwards through months
    let runningAssets = currentTotals.assets;
    let runningLiabilities = currentTotals.liabilities;

    for (let i = months.length - 1; i >= 0; i--) {
      const monthKey = format(months[i], 'yyyy-MM');
      const monthTxs = txByMonth.get(monthKey) || [];

      // Store the end-of-month balance
      monthEndBalances.set(monthKey, {
        assets: runningAssets,
        liabilities: runningLiabilities,
      });

      // Reverse the transactions for this month to get the starting balance
      monthTxs.forEach((tx) => {
        const amount = Number(tx.amount) || 0;
        // Reverse the transaction effect
        if (amount >= 0) {
          // Income was added, so remove it to get earlier balance
          runningAssets -= amount;
        } else {
          // Expense was subtracted, so add it back
          // This depends on whether it affected assets or liabilities
          runningAssets -= amount; // amount is negative, so this adds
        }
      });
    }

    return months.map((month) => {
      const monthKey = format(month, 'yyyy-MM');
      const balances = monthEndBalances.get(monthKey) || { assets: 0, liabilities: 0 };
      return {
        name: format(month, 'MMM'),
        fullName: format(month, 'MMM yyyy'),
        Assets: Math.round(balances.assets),
        Liabilities: Math.round(balances.liabilities),
        NetWorth: Math.round(balances.assets - balances.liabilities),
      };
    });
  }, [transactions, accounts, dateRange, startDate, endDate, getDateRange]);

  const summary = useMemo(() => {
    if (chartData.length === 0) return { current: 0, change: 0, changePercent: 0 };
    const current = chartData[chartData.length - 1]?.NetWorth || 0;
    const initial = chartData[0]?.NetWorth || 0;
    const change = current - initial;
    const changePercent = initial !== 0 ? (change / Math.abs(initial)) * 100 : 0;
    return { current, change, changePercent };
  }, [chartData]);

  // Calculate Y-axis domain to avoid starting at 0 when values are significantly higher
  const yAxisDomain = useMemo(() => {
    if (chartData.length === 0) return [0, 'auto'] as [number, 'auto'];

    const values = chartData.map(d => d.NetWorth);
    const minValue = Math.min(...values);
    const maxValue = Math.max(...values);
    const range = maxValue - minValue;

    // If min is significantly above 0 (more than 20% of the range), don't start at 0
    // Also check that all values are positive
    if (minValue > 0 && minValue > range * 0.2) {
      // Round down to a nice number for the axis minimum
      const padding = range * 0.1; // 10% padding below minimum
      const rawMin = minValue - padding;

      // Round to a nice number based on magnitude
      const magnitude = Math.pow(10, Math.floor(Math.log10(Math.abs(rawMin))));
      const niceMin = Math.floor(rawMin / magnitude) * magnitude;

      return [niceMin, 'auto'] as [number, 'auto'];
    }

    // If values cross 0 or start near 0, include 0 in the domain
    return [Math.min(0, minValue), 'auto'] as [number, 'auto'];
  }, [chartData]);

  const CustomTooltip = ({ active, payload }: { active?: boolean; payload?: Array<{ name: string; value: number; color: string; payload: { fullName: string } }> }) => {
    if (active && payload && payload.length) {
      const data = payload[0]?.payload;
      return (
        <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg shadow-lg p-3">
          <p className="font-medium text-gray-900 dark:text-gray-100 mb-1">{data?.fullName}</p>
          {payload.map((entry, index) => (
            <p key={index} className="text-sm" style={{ color: entry.color }}>
              {entry.name}: {formatCurrency(entry.value)}
            </p>
          ))}
        </div>
      );
    }
    return null;
  };

  if (isLoading) {
    return (
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-6">
        <div className="animate-pulse space-y-4">
          <div className="h-8 bg-gray-200 dark:bg-gray-700 rounded w-1/3" />
          <div className="h-96 bg-gray-200 dark:bg-gray-700 rounded" />
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Summary Cards */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-6">
          <div className="text-sm text-gray-500 dark:text-gray-400">Current Net Worth</div>
          <div className={`text-2xl font-bold ${
            summary.current >= 0 ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'
          }`}>
            {formatCurrency(summary.current)}
          </div>
        </div>
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-6">
          <div className="text-sm text-gray-500 dark:text-gray-400">Change</div>
          <div className={`text-2xl font-bold ${
            summary.change >= 0 ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'
          }`}>
            {summary.change >= 0 ? '+' : ''}{formatCurrency(summary.change)}
          </div>
        </div>
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-6">
          <div className="text-sm text-gray-500 dark:text-gray-400">Change %</div>
          <div className={`text-2xl font-bold ${
            summary.changePercent >= 0 ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'
          }`}>
            {summary.changePercent >= 0 ? '+' : ''}{summary.changePercent.toFixed(1)}%
          </div>
        </div>
      </div>

      {/* Controls */}
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-4">
        <div className="flex flex-wrap gap-4 items-center">
          <div className="flex flex-wrap gap-2">
            {(['1y', '2y', '5y', 'all'] as DateRange[]).map((range) => (
              <button
                key={range}
                onClick={() => setDateRange(range)}
                className={`px-3 py-1.5 text-sm font-medium rounded-md transition-colors ${
                  dateRange === range
                    ? 'bg-blue-600 text-white'
                    : 'bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-600'
                }`}
              >
                {range === 'all' ? 'All Time' : range.toUpperCase()}
              </button>
            ))}
            <button
              onClick={() => setDateRange('custom')}
              className={`px-3 py-1.5 text-sm font-medium rounded-md transition-colors ${
                dateRange === 'custom'
                  ? 'bg-blue-600 text-white'
                  : 'bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-600'
              }`}
            >
              Custom
            </button>
          </div>
        </div>
        {dateRange === 'custom' && (
          <div className="flex gap-4 mt-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                Start Date
              </label>
              <input
                type="date"
                value={startDate}
                onChange={(e) => setStartDate(e.target.value)}
                className="rounded-md border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                End Date
              </label>
              <input
                type="date"
                value={endDate}
                onChange={(e) => setEndDate(e.target.value)}
                className="rounded-md border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100"
              />
            </div>
          </div>
        )}
      </div>

      {/* Chart */}
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-6">
        {chartData.length === 0 ? (
          <p className="text-gray-500 dark:text-gray-400 text-center py-8">
            No data for this period.
          </p>
        ) : (
          <div className="h-96">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={chartData} margin={{ top: 10, right: 30, left: 0, bottom: 0 }}>
                <defs>
                  <linearGradient id="colorNetWorth" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#3b82f6" stopOpacity={0.3} />
                    <stop offset="95%" stopColor="#3b82f6" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
                <XAxis dataKey="name" tick={{ fontSize: 12 }} />
                <YAxis
                  domain={yAxisDomain}
                  tickFormatter={(value) => `$${value >= 1000 ? `${(value / 1000).toFixed(0)}k` : value}`}
                  tick={{ fontSize: 12 }}
                />
                <Tooltip content={<CustomTooltip />} />
                <Legend />
                <ReferenceLine y={0} stroke="#9ca3af" strokeDasharray="3 3" />
                <Area
                  type="monotone"
                  dataKey="NetWorth"
                  stroke="#3b82f6"
                  strokeWidth={2}
                  fillOpacity={1}
                  fill="url(#colorNetWorth)"
                  name="Net Worth"
                />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        )}
      </div>
    </div>
  );
}
