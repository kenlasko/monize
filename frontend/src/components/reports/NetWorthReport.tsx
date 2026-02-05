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
import { investmentsApi } from '@/lib/investments';
import { exchangeRatesApi, ExchangeRate } from '@/lib/exchange-rates';
import { Transaction } from '@/types/transaction';
import { Account } from '@/types/account';
import { PortfolioSummary } from '@/types/investment';
import { parseLocalDate } from '@/lib/utils';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import { useExchangeRates, convertWithRateMap } from '@/hooks/useExchangeRates';

const LIABILITY_TYPES = ['CREDIT_CARD', 'LOAN', 'MORTGAGE', 'LINE_OF_CREDIT'];

type DateRange = '1y' | '2y' | '5y' | 'all' | 'custom';

export function NetWorthReport() {
  const { formatCurrencyCompact: formatCurrency } = useNumberFormat();
  const { rates: currentRates, defaultCurrency } = useExchangeRates();
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [portfolioSummary, setPortfolioSummary] = useState<PortfolioSummary | null>(null);
  const [historicalRates, setHistoricalRates] = useState<ExchangeRate[]>([]);
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

      const [txData, accData, portfolio, rateHistory] = await Promise.all([
        transactionsApi.getAll({ startDate: start, endDate: end, limit: 100000 }),
        accountsApi.getAll(),
        investmentsApi.getPortfolioSummary().catch(() => null),
        exchangeRatesApi.getRateHistory(start, end).catch(() => [] as ExchangeRate[]),
      ]);
      setTransactions(txData.data);
      setAccounts(accData);
      setPortfolioSummary(portfolio);
      setHistoricalRates(rateHistory);
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

    // Build a map of brokerage account ID -> total market value
    const brokerageValues = new Map<string, number>();
    if (portfolioSummary) {
      for (const accountHoldings of portfolioSummary.holdingsByAccount) {
        const totalValue = accountHoldings.totalMarketValue + accountHoldings.cashBalance;
        brokerageValues.set(accountHoldings.accountId, totalValue);
      }
    }

    // Build per-account current balances in native currency
    const activeAccounts = accounts.filter((acc) => !acc.isClosed);
    const accountCurrentBalances = new Map<string, number>();
    const accountCurrencies = new Map<string, string>();
    const accountTypes = new Map<string, string>();
    const accountDateAcquired = new Map<string, string | null>();
    const accountOpeningBalances = new Map<string, number>();

    activeAccounts.forEach((acc) => {
      const effectiveBalance = acc.accountSubType === 'INVESTMENT_BROKERAGE'
        ? (brokerageValues.get(acc.id) ?? 0)
        : (Number(acc.currentBalance) || 0);
      accountCurrentBalances.set(acc.id, effectiveBalance);
      accountCurrencies.set(acc.id, acc.currencyCode);
      accountTypes.set(acc.id, acc.accountType);
      accountDateAcquired.set(acc.id, acc.dateAcquired);
      accountOpeningBalances.set(acc.id, Number(acc.openingBalance) || 0);
    });

    // Group transactions by account and month
    const txByAccountMonth = new Map<string, Map<string, Transaction[]>>();
    transactions.forEach((tx) => {
      const monthKey = format(parseLocalDate(tx.transactionDate), 'yyyy-MM');
      if (!txByAccountMonth.has(tx.accountId)) {
        txByAccountMonth.set(tx.accountId, new Map());
      }
      const accountMonths = txByAccountMonth.get(tx.accountId)!;
      if (!accountMonths.has(monthKey)) {
        accountMonths.set(monthKey, []);
      }
      accountMonths.get(monthKey)!.push(tx);
    });

    // Build per-account monthly balances by working backwards from current
    const accountMonthlyBalances = new Map<string, Map<string, number>>();

    accountCurrentBalances.forEach((currentBal, accountId) => {
      const monthlyBals = new Map<string, number>();
      let running = currentBal;
      const accountTxMonths = txByAccountMonth.get(accountId) || new Map<string, Transaction[]>();

      for (let i = months.length - 1; i >= 0; i--) {
        const monthKey = format(months[i], 'yyyy-MM');
        monthlyBals.set(monthKey, running);

        // Reverse transactions for this month to get earlier balance
        const monthTxs = accountTxMonths.get(monthKey) || [];
        monthTxs.forEach((tx) => {
          running -= (Number(tx.amount) || 0);
        });
      }

      // For ASSET accounts: use openingBalance for months before the earliest
      // transaction, since the backward computation would incorrectly carry the
      // current value (which includes appreciation) into historical months.
      const accType = accountTypes.get(accountId);
      if (accType === 'ASSET') {
        const openingBal = accountOpeningBalances.get(accountId) ?? 0;

        // Find the earliest month with transactions on this account
        let earliestTxMonthIdx = -1;
        for (let i = 0; i < months.length; i++) {
          const monthKey = format(months[i], 'yyyy-MM');
          if (accountTxMonths.has(monthKey)) {
            earliestTxMonthIdx = i;
            break;
          }
        }

        if (earliestTxMonthIdx > 0) {
          // Use openingBalance for months before earliest transaction
          for (let i = 0; i < earliestTxMonthIdx; i++) {
            monthlyBals.set(format(months[i], 'yyyy-MM'), openingBal);
          }
        } else if (earliestTxMonthIdx === -1 && openingBal !== currentBal) {
          // No transactions at all — use openingBalance for all months except the last
          for (let i = 0; i < months.length - 1; i++) {
            monthlyBals.set(format(months[i], 'yyyy-MM'), openingBal);
          }
        }
      }

      accountMonthlyBalances.set(accountId, monthlyBals);
    });

    // Build monthly rate maps from historical rates
    // Sort rates by date, group by pair, find latest rate <= each month-end
    const sortedRates = [...historicalRates].sort(
      (a, b) => a.rateDate.localeCompare(b.rateDate),
    );
    const ratesByPair = new Map<string, Array<{ date: string; rate: number }>>();
    sortedRates.forEach((r) => {
      const key = `${r.fromCurrency}->${r.toCurrency}`;
      if (!ratesByPair.has(key)) {
        ratesByPair.set(key, []);
      }
      ratesByPair.get(key)!.push({ date: r.rateDate, rate: Number(r.rate) });
    });

    // Also add current rates as a fallback for the most recent month
    currentRates.forEach((r) => {
      const key = `${r.fromCurrency}->${r.toCurrency}`;
      if (!ratesByPair.has(key)) {
        ratesByPair.set(key, []);
      }
      ratesByPair.get(key)!.push({ date: r.rateDate, rate: Number(r.rate) });
    });

    // For each month, find the best rate per pair
    const monthRateMaps = new Map<string, Map<string, number>>();
    months.forEach((month) => {
      const monthEnd = format(endOfMonth(month), 'yyyy-MM-dd');
      const monthKey = format(month, 'yyyy-MM');
      const rateMap = new Map<string, number>();

      ratesByPair.forEach((rates, pair) => {
        let bestRate: number | null = null;
        for (const r of rates) {
          if (r.date <= monthEnd) {
            bestRate = r.rate;
          }
        }
        // If no rate found before month-end, use the earliest available rate
        if (bestRate === null && rates.length > 0) {
          bestRate = rates[0].rate;
        }
        if (bestRate !== null) {
          rateMap.set(pair, bestRate);
        }
      });

      monthRateMaps.set(monthKey, rateMap);
    });

    // Convert per-account balances and aggregate by month
    return months.map((month) => {
      const monthKey = format(month, 'yyyy-MM');
      const rateMap = monthRateMaps.get(monthKey) || new Map();

      let assets = 0;
      let liabilities = 0;

      accountCurrentBalances.forEach((_, accountId) => {
        const accType = accountTypes.get(accountId) || 'OTHER';

        // Skip ASSET accounts before their acquisition date
        const dateAcquired = accountDateAcquired.get(accountId);
        if (dateAcquired && accType === 'ASSET') {
          const monthEnd = endOfMonth(month);
          const acquiredDate = parseLocalDate(dateAcquired.substring(0, 10));
          if (monthEnd < acquiredDate) {
            return;
          }
        }

        const balance = accountMonthlyBalances.get(accountId)?.get(monthKey) ?? 0;
        const currency = accountCurrencies.get(accountId) || defaultCurrency;

        const converted = convertWithRateMap(balance, currency, defaultCurrency, rateMap);

        if (LIABILITY_TYPES.includes(accType)) {
          liabilities += Math.abs(converted);
        } else {
          assets += converted;
        }
      });

      return {
        name: format(month, 'MMM yyyy'),
        Assets: Math.round(assets),
        Liabilities: Math.round(liabilities),
        NetWorth: Math.round(assets - liabilities),
      };
    });
  }, [transactions, accounts, portfolioSummary, historicalRates, currentRates, defaultCurrency, dateRange, startDate, endDate, getDateRange]);

  const summary = useMemo(() => {
    if (chartData.length === 0) return { current: 0, change: 0, changePercent: 0 };
    const current = chartData[chartData.length - 1]?.NetWorth || 0;
    const initial = chartData[0]?.NetWorth || 0;
    const change = current - initial;
    const changePercent = initial !== 0 ? (change / Math.abs(initial)) * 100 : 0;
    return { current, change, changePercent };
  }, [chartData]);

  // For long ranges, explicitly specify which ticks to show so years don't repeat
  const xAxisTicks = useMemo(() => {
    if (chartData.length <= 36) return undefined; // let Recharts auto-decide for shorter ranges
    // Only show ticks on January of each year
    return chartData
      .filter(d => d.name.startsWith('Jan '))
      .map(d => d.name);
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

  const CustomTooltip = ({ active, payload }: { active?: boolean; payload?: Array<{ name: string; value: number; color: string; payload: { name: string } }> }) => {
    if (active && payload && payload.length) {
      const data = payload[0]?.payload;
      return (
        <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg shadow-lg p-3">
          <p className="font-medium text-gray-900 dark:text-gray-100 mb-1">{data?.name}</p>
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
                <XAxis
                  dataKey="name"
                  tick={{ fontSize: 12 }}
                  {...(xAxisTicks ? { ticks: xAxisTicks } : {})}
                  tickFormatter={(value: string) => {
                    if (chartData.length > 36) {
                      // Long range (5Y, All Time): show just the year
                      return value.split(' ')[1] || value;
                    } else if (chartData.length > 18) {
                      // Medium range (2Y): show "MMM 'YY"
                      const parts = value.split(' ');
                      return parts.length === 2 ? `${parts[0]} '${parts[1].slice(2)}` : value;
                    }
                    // Short range (1Y): show month only
                    return value.split(' ')[0];
                  }}
                />
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
