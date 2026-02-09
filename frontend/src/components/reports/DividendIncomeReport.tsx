'use client';

import { useState, useEffect, useMemo, useCallback } from 'react';
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Legend,
} from 'recharts';
import { format, eachMonthOfInterval } from 'date-fns';
import { investmentsApi } from '@/lib/investments';
import { InvestmentTransaction } from '@/types/investment';
import { Account } from '@/types/account';
import { parseLocalDate } from '@/lib/utils';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import { useExchangeRates } from '@/hooks/useExchangeRates';
import { useDateRange } from '@/hooks/useDateRange';
import { DateRangeSelector } from '@/components/ui/DateRangeSelector';
import { createLogger } from '@/lib/logger';

const logger = createLogger('DividendIncomeReport');

interface MonthlyIncome {
  month: string;
  label: string;
  dividends: number;
  interest: number;
  capitalGains: number;
  total: number;
}

interface SecurityIncome {
  symbol: string;
  name: string;
  dividends: number;
  interest: number;
  capitalGains: number;
  total: number;
}

export function DividendIncomeReport() {
  const { formatCurrency: formatCurrencyFull, formatCurrencyAxis } = useNumberFormat();
  const { defaultCurrency, convertToDefault } = useExchangeRates();
  const [transactions, setTransactions] = useState<InvestmentTransaction[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [selectedAccountId, setSelectedAccountId] = useState<string>('');
  const { dateRange, setDateRange, resolvedRange, isValid } = useDateRange({ defaultRange: '1y', alignment: 'month' });
  const [isLoading, setIsLoading] = useState(true);
  const [viewType, setViewType] = useState<'monthly' | 'bySecurity'>('monthly');

  // Build account currency lookup
  const accountCurrencyMap = useMemo(() => {
    const map = new Map<string, string>();
    accounts.forEach((a) => map.set(a.id, a.currencyCode));
    return map;
  }, [accounts]);

  // When a single account is selected, show in native currency; otherwise convert to default
  const selectedAccount = accounts.find((a) => a.id === selectedAccountId);
  const displayCurrency = selectedAccount?.currencyCode || defaultCurrency;
  const isForeign = displayCurrency !== defaultCurrency;

  const getTxAmount = useCallback((tx: InvestmentTransaction): number => {
    const amount = Math.abs(tx.totalAmount);
    if (selectedAccountId) {
      // Single account selected: native currency, no conversion needed
      return amount;
    }
    // All accounts: convert to default currency
    const txCurrency = accountCurrencyMap.get(tx.accountId) || defaultCurrency;
    return convertToDefault(amount, txCurrency);
  }, [selectedAccountId, accountCurrencyMap, defaultCurrency, convertToDefault]);

  const fmtValue = useCallback((value: number): string => {
    if (isForeign) {
      return `${formatCurrencyFull(value, displayCurrency)} ${displayCurrency}`;
    }
    return formatCurrencyFull(value);
  }, [isForeign, displayCurrency, formatCurrencyFull]);

  useEffect(() => {
    if (!isValid) return;
    const loadData = async () => {
      setIsLoading(true);
      try {
        const { start, end } = resolvedRange;
        const [txData, accountsData] = await Promise.all([
          investmentsApi.getTransactions({
            accountIds: selectedAccountId || undefined,
            startDate: start || undefined,
            endDate: end,
            limit: 10000,
          }),
          investmentsApi.getInvestmentAccounts(),
        ]);

        // Filter to only income transactions
        const incomeTransactions = txData.data.filter(
          (tx) => tx.action === 'DIVIDEND' || tx.action === 'INTEREST' || tx.action === 'CAPITAL_GAIN'
        );

        setTransactions(incomeTransactions);
        setAccounts(accountsData);
      } catch (error) {
        logger.error('Failed to load investment transactions:', error);
      } finally {
        setIsLoading(false);
      }
    };
    loadData();
  }, [selectedAccountId, resolvedRange, isValid]);

  const monthlyData = useMemo((): MonthlyIncome[] => {
    const { start, end } = resolvedRange;
    if (!start && dateRange !== 'all') return [];

    const startDate = start ? parseLocalDate(start) : null;
    const endDate = parseLocalDate(end);

    // Get all months in range
    const months = startDate
      ? eachMonthOfInterval({ start: startDate, end: endDate })
      : [];

    // Initialize month buckets
    const monthMap = new Map<string, MonthlyIncome>();
    months.forEach((month) => {
      const key = format(month, 'yyyy-MM');
      monthMap.set(key, {
        month: key,
        label: format(month, 'MMM yyyy'),
        dividends: 0,
        interest: 0,
        capitalGains: 0,
        total: 0,
      });
    });

    // Aggregate transactions
    transactions.forEach((tx) => {
      const txDate = parseLocalDate(tx.transactionDate);
      const monthKey = format(txDate, 'yyyy-MM');

      let bucket = monthMap.get(monthKey);
      if (!bucket) {
        bucket = {
          month: monthKey,
          label: format(txDate, 'MMM yyyy'),
          dividends: 0,
          interest: 0,
          capitalGains: 0,
          total: 0,
        };
        monthMap.set(monthKey, bucket);
      }

      const amount = getTxAmount(tx);
      switch (tx.action) {
        case 'DIVIDEND':
          bucket.dividends += amount;
          break;
        case 'INTEREST':
          bucket.interest += amount;
          break;
        case 'CAPITAL_GAIN':
          bucket.capitalGains += amount;
          break;
      }
      bucket.total += amount;
    });

    return Array.from(monthMap.values()).sort((a, b) => a.month.localeCompare(b.month));
  }, [transactions, dateRange, resolvedRange, getTxAmount]);

  const securityData = useMemo((): SecurityIncome[] => {
    const securityMap = new Map<string, SecurityIncome>();

    transactions.forEach((tx) => {
      const symbol = tx.security?.symbol || 'Unknown';
      const name = tx.security?.name || 'Unknown Security';

      let bucket = securityMap.get(symbol);
      if (!bucket) {
        bucket = {
          symbol,
          name,
          dividends: 0,
          interest: 0,
          capitalGains: 0,
          total: 0,
        };
        securityMap.set(symbol, bucket);
      }

      const amount = getTxAmount(tx);
      switch (tx.action) {
        case 'DIVIDEND':
          bucket.dividends += amount;
          break;
        case 'INTEREST':
          bucket.interest += amount;
          break;
        case 'CAPITAL_GAIN':
          bucket.capitalGains += amount;
          break;
      }
      bucket.total += amount;
    });

    return Array.from(securityMap.values()).sort((a, b) => b.total - a.total);
  }, [transactions, getTxAmount]);

  const totals = useMemo(() => {
    return {
      dividends: transactions.filter((t) => t.action === 'DIVIDEND').reduce((sum, t) => sum + getTxAmount(t), 0),
      interest: transactions.filter((t) => t.action === 'INTEREST').reduce((sum, t) => sum + getTxAmount(t), 0),
      capitalGains: transactions.filter((t) => t.action === 'CAPITAL_GAIN').reduce((sum, t) => sum + getTxAmount(t), 0),
      total: transactions.reduce((sum, t) => sum + getTxAmount(t), 0),
    };
  }, [transactions, getTxAmount]);

  const CustomTooltip = ({ active, payload, label }: { active?: boolean; payload?: Array<{ name: string; value: number; color: string }>; label?: string }) => {
    if (active && payload && payload.length) {
      return (
        <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg shadow-lg p-3">
          <p className="font-medium text-gray-900 dark:text-gray-100 mb-1">{label}</p>
          {payload.map((entry, index) => (
            <p key={index} className="text-sm" style={{ color: entry.color }}>
              {entry.name}: {fmtValue(entry.value)}
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
          <div className="h-64 bg-gray-200 dark:bg-gray-700 rounded" />
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Summary Cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <div className="bg-green-50 dark:bg-green-900/20 rounded-lg p-4">
          <div className="text-sm text-green-600 dark:text-green-400">Dividends</div>
          <div className="text-xl font-bold text-green-700 dark:text-green-300">
            {fmtValue(totals.dividends)}
          </div>
        </div>
        <div className="bg-blue-50 dark:bg-blue-900/20 rounded-lg p-4">
          <div className="text-sm text-blue-600 dark:text-blue-400">Interest</div>
          <div className="text-xl font-bold text-blue-700 dark:text-blue-300">
            {fmtValue(totals.interest)}
          </div>
        </div>
        <div className="bg-purple-50 dark:bg-purple-900/20 rounded-lg p-4">
          <div className="text-sm text-purple-600 dark:text-purple-400">Capital Gains</div>
          <div className="text-xl font-bold text-purple-700 dark:text-purple-300">
            {fmtValue(totals.capitalGains)}
          </div>
        </div>
        <div className="bg-gray-50 dark:bg-gray-700/50 rounded-lg p-4">
          <div className="text-sm text-gray-600 dark:text-gray-400">Total Income</div>
          <div className="text-xl font-bold text-gray-900 dark:text-gray-100">
            {fmtValue(totals.total)}
          </div>
        </div>
      </div>

      {/* Controls */}
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-4">
        <div className="flex flex-wrap gap-4 items-center justify-between">
          <div className="flex flex-wrap gap-2 items-center">
            <select
              value={selectedAccountId}
              onChange={(e) => setSelectedAccountId(e.target.value)}
              className="rounded-md border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100 text-sm"
            >
              <option value="">All Accounts</option>
              {accounts
                .filter((a) => a.accountSubType !== 'INVESTMENT_BROKERAGE')
                .sort((a, b) => a.name.localeCompare(b.name))
                .map((account) => (
                  <option key={account.id} value={account.id}>
                    {account.name.replace(/ - (Brokerage|Cash)$/, '')}
                  </option>
                ))}
            </select>
            <DateRangeSelector
              ranges={['6m', '1y', '2y', 'all']}
              value={dateRange}
              onChange={setDateRange}
            />
          </div>
          <div className="flex gap-2">
            <button
              onClick={() => setViewType('monthly')}
              className={`px-3 py-1.5 text-sm font-medium rounded-md transition-colors ${
                viewType === 'monthly'
                  ? 'bg-blue-600 text-white'
                  : 'bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300'
              }`}
            >
              Monthly
            </button>
            <button
              onClick={() => setViewType('bySecurity')}
              className={`px-3 py-1.5 text-sm font-medium rounded-md transition-colors ${
                viewType === 'bySecurity'
                  ? 'bg-blue-600 text-white'
                  : 'bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300'
              }`}
            >
              By Security
            </button>
          </div>
        </div>
      </div>

      {transactions.length === 0 ? (
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-6">
          <p className="text-gray-500 dark:text-gray-400 text-center py-8">
            No dividend, interest, or capital gain transactions found for this period.
          </p>
        </div>
      ) : viewType === 'monthly' ? (
        /* Monthly Chart */
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-6">
          <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-4">
            Monthly Income
          </h3>
          <div className="h-80">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={monthlyData}>
                <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
                <XAxis dataKey="label" tick={{ fontSize: 11 }} />
                <YAxis tickFormatter={formatCurrencyAxis} />
                <Tooltip content={<CustomTooltip />} />
                <Legend />
                <Bar dataKey="dividends" stackId="a" fill="#22c55e" name="Dividends" />
                <Bar dataKey="interest" stackId="a" fill="#3b82f6" name="Interest" />
                <Bar dataKey="capitalGains" stackId="a" fill="#8b5cf6" name="Capital Gains" />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>
      ) : (
        /* By Security Table */
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 overflow-hidden">
          <div className="px-6 py-4 border-b border-gray-200 dark:border-gray-700">
            <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
              Income by Security
            </h3>
          </div>
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-gray-200 dark:divide-gray-700">
              <thead className="bg-gray-50 dark:bg-gray-900/50">
                <tr>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">
                    Security
                  </th>
                  <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">
                    Dividends
                  </th>
                  <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">
                    Interest
                  </th>
                  <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">
                    Capital Gains
                  </th>
                  <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">
                    Total
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-200 dark:divide-gray-700">
                {securityData.map((security) => (
                  <tr key={security.symbol} className="hover:bg-gray-50 dark:hover:bg-gray-700/50">
                    <td className="px-4 py-3">
                      <div className="font-medium text-gray-900 dark:text-gray-100">
                        {security.symbol}
                      </div>
                      <div className="text-sm text-gray-500 dark:text-gray-400">
                        {security.name}
                      </div>
                    </td>
                    <td className="px-4 py-3 text-right text-sm text-green-600 dark:text-green-400">
                      {security.dividends > 0 ? fmtValue(security.dividends) : '-'}
                    </td>
                    <td className="px-4 py-3 text-right text-sm text-blue-600 dark:text-blue-400">
                      {security.interest > 0 ? fmtValue(security.interest) : '-'}
                    </td>
                    <td className="px-4 py-3 text-right text-sm text-purple-600 dark:text-purple-400">
                      {security.capitalGains > 0 ? fmtValue(security.capitalGains) : '-'}
                    </td>
                    <td className="px-4 py-3 text-right text-sm font-medium text-gray-900 dark:text-gray-100">
                      {fmtValue(security.total)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
