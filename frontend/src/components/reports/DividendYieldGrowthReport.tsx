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
} from 'recharts';
import { subYears } from 'date-fns';
import { investmentsApi } from '@/lib/investments';
import { InvestmentTransaction, HoldingWithMarketValue } from '@/types/investment';
import { Account } from '@/types/account';
import { parseLocalDate } from '@/lib/utils';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import { useExchangeRates } from '@/hooks/useExchangeRates';
import { createLogger } from '@/lib/logger';

const logger = createLogger('DividendYieldGrowthReport');

const MAX_PAGES = 50;

interface SecurityYield {
  symbol: string;
  name: string;
  trailing12mDividends: number;
  marketValue: number;
  yield: number;
  frequency: string;
}

interface AnnualDividend {
  year: string;
  amount: number;
  growth: number | null;
}

interface FrequencyBucket {
  frequency: string;
  count: number;
  totalDividends: number;
}

function detectFrequency(dates: Date[]): string {
  if (dates.length < 2) return 'Unknown';
  const sorted = [...dates].sort((a, b) => a.getTime() - b.getTime());
  const gaps: number[] = [];
  for (let i = 1; i < sorted.length; i++) {
    gaps.push((sorted[i].getTime() - sorted[i - 1].getTime()) / (1000 * 60 * 60 * 24));
  }
  const avgGap = gaps.reduce((s, g) => s + g, 0) / gaps.length;
  if (avgGap <= 45) return 'Monthly';
  if (avgGap <= 120) return 'Quarterly';
  if (avgGap <= 210) return 'Semi-Annual';
  return 'Annual';
}

export function DividendYieldGrowthReport() {
  const { formatCurrency: formatCurrencyFull, formatCurrencyAxis } = useNumberFormat();
  const { defaultCurrency, convertToDefault } = useExchangeRates();
  const [transactions, setTransactions] = useState<InvestmentTransaction[]>([]);
  const [holdings, setHoldings] = useState<HoldingWithMarketValue[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [selectedAccountId, setSelectedAccountId] = useState<string>('');
  const [isLoading, setIsLoading] = useState(true);
  const [viewType, setViewType] = useState<'yield' | 'growth' | 'frequency'>('yield');

  const accountCurrencyMap = useMemo(() => {
    const map = new Map<string, string>();
    accounts.forEach((a) => map.set(a.id, a.currencyCode));
    return map;
  }, [accounts]);

  const selectedAccount = accounts.find((a) => a.id === selectedAccountId);
  const displayCurrency = selectedAccount?.currencyCode || defaultCurrency;

  const getTxAmount = useCallback((tx: InvestmentTransaction): number => {
    const amount = Math.abs(tx.totalAmount);
    if (selectedAccountId) return amount;
    const txCurrency = accountCurrencyMap.get(tx.accountId) || defaultCurrency;
    return convertToDefault(amount, txCurrency);
  }, [selectedAccountId, accountCurrencyMap, defaultCurrency, convertToDefault]);

  const fmtValue = useCallback((value: number): string => {
    const isForeign = displayCurrency !== defaultCurrency;
    if (isForeign) return `${formatCurrencyFull(value, displayCurrency)} ${displayCurrency}`;
    return formatCurrencyFull(value);
  }, [displayCurrency, defaultCurrency, formatCurrencyFull]);

  // Fetch accounts once on mount (they don't change with filters)
  useEffect(() => {
    investmentsApi.getInvestmentAccounts()
      .then(setAccounts)
      .catch((error) => logger.error('Failed to load accounts:', error));
  }, []);

  useEffect(() => {
    const loadData = async () => {
      setIsLoading(true);
      try {
        const accountIds = selectedAccountId || undefined;

        const fetchAllPages = async (action: string): Promise<InvestmentTransaction[]> => {
          const results: InvestmentTransaction[] = [];
          let page = 1;
          let hasMore = true;
          while (hasMore && page <= MAX_PAGES) {
            const result = await investmentsApi.getTransactions({
              accountIds,
              action,
              limit: 200,
              page,
            });
            results.push(...result.data);
            hasMore = result.pagination.hasMore;
            page++;
          }
          return results;
        };

        const [summaryData, dividendTx, reinvestTx] = await Promise.all([
          investmentsApi.getPortfolioSummary(
            selectedAccountId ? [selectedAccountId] : undefined,
          ),
          fetchAllPages('DIVIDEND'),
          fetchAllPages('REINVEST'),
        ]);

        setTransactions([...dividendTx, ...reinvestTx]);
        setHoldings(summaryData.holdings);
      } catch (error) {
        logger.error('Failed to load data:', error);
      } finally {
        setIsLoading(false);
      }
    };
    loadData();
  }, [selectedAccountId]);

  // Trailing 12-month portfolio yield
  const trailing12mTotal = useMemo(() => {
    const cutoff = subYears(new Date(), 1);
    return transactions
      .filter((tx) => parseLocalDate(tx.transactionDate) >= cutoff)
      .reduce((sum, tx) => sum + getTxAmount(tx), 0);
  }, [transactions, getTxAmount]);

  const totalPortfolioValue = useMemo(
    () => holdings.reduce((sum, h) => sum + convertToDefault(h.marketValue ?? 0, h.currencyCode), 0),
    [holdings, convertToDefault],
  );

  const portfolioYield = totalPortfolioValue > 0 ? (trailing12mTotal / totalPortfolioValue) * 100 : 0;

  // Per-security yield
  const securityYields = useMemo((): SecurityYield[] => {
    const cutoff = subYears(new Date(), 1);
    const recentTx = transactions.filter((tx) => parseLocalDate(tx.transactionDate) >= cutoff);

    // Aggregate dividends by security
    const dividendMap = new Map<string, { total: number; dates: Date[] }>();
    recentTx.forEach((tx) => {
      const key = tx.securityId || 'unknown';
      let existing = dividendMap.get(key);
      if (!existing) {
        existing = { total: 0, dates: [] };
        dividendMap.set(key, existing);
      }
      existing.total += getTxAmount(tx);
      existing.dates.push(parseLocalDate(tx.transactionDate));
    });

    // Map holdings to yields
    const holdingMap = new Map<string, HoldingWithMarketValue>();
    holdings.forEach((h) => holdingMap.set(h.securityId, h));

    const results: SecurityYield[] = [];
    dividendMap.forEach((data, secId) => {
      const holding = holdingMap.get(secId);
      const symbol = holding?.symbol || 'Unknown';
      const name = holding?.name || 'Unknown Security';
      const mv = holding ? convertToDefault(holding.marketValue ?? 0, holding.currencyCode) : 0;
      results.push({
        symbol,
        name,
        trailing12mDividends: data.total,
        marketValue: mv,
        yield: mv > 0 ? (data.total / mv) * 100 : 0,
        frequency: detectFrequency(data.dates),
      });
    });

    return results.sort((a, b) => b.yield - a.yield);
  }, [transactions, holdings, getTxAmount, convertToDefault]);

  // Year-over-year growth
  const annualData = useMemo((): AnnualDividend[] => {
    const yearMap = new Map<string, number>();
    transactions.forEach((tx) => {
      const year = tx.transactionDate.substring(0, 4);
      yearMap.set(year, (yearMap.get(year) || 0) + getTxAmount(tx));
    });

    const years = Array.from(yearMap.keys()).sort();
    return years.map((year, idx) => {
      const amount = yearMap.get(year) || 0;
      const prevAmount = idx > 0 ? yearMap.get(years[idx - 1]) || 0 : null;
      const growth = prevAmount !== null && prevAmount > 0
        ? ((amount - prevAmount) / prevAmount) * 100
        : null;
      return { year, amount, growth };
    });
  }, [transactions, getTxAmount]);

  // Frequency analysis
  const frequencyData = useMemo((): FrequencyBucket[] => {
    const freqMap = new Map<string, { count: number; total: number }>();
    securityYields.forEach((sy) => {
      const existing = freqMap.get(sy.frequency) || { count: 0, total: 0 };
      freqMap.set(sy.frequency, {
        count: existing.count + 1,
        total: existing.total + sy.trailing12mDividends,
      });
    });
    return Array.from(freqMap.entries())
      .map(([frequency, data]) => ({
        frequency,
        count: data.count,
        totalDividends: data.total,
      }))
      .sort((a, b) => b.totalDividends - a.totalDividends);
  }, [securityYields]);

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
          <div className="text-sm text-green-600 dark:text-green-400">Portfolio Yield</div>
          <div className="text-xl font-bold text-green-700 dark:text-green-300">
            {portfolioYield.toFixed(2)}%
          </div>
        </div>
        <div className="bg-blue-50 dark:bg-blue-900/20 rounded-lg p-4">
          <div className="text-sm text-blue-600 dark:text-blue-400">Trailing 12M Dividends</div>
          <div className="text-xl font-bold text-blue-700 dark:text-blue-300">
            {fmtValue(trailing12mTotal)}
          </div>
        </div>
        <div className="bg-purple-50 dark:bg-purple-900/20 rounded-lg p-4">
          <div className="text-sm text-purple-600 dark:text-purple-400">Portfolio Value</div>
          <div className="text-xl font-bold text-purple-700 dark:text-purple-300">
            {fmtValue(totalPortfolioValue)}
          </div>
        </div>
        <div className="bg-gray-50 dark:bg-gray-700/50 rounded-lg p-4">
          <div className="text-sm text-gray-600 dark:text-gray-400">Dividend Payers</div>
          <div className="text-xl font-bold text-gray-900 dark:text-gray-100">
            {securityYields.length}
          </div>
        </div>
      </div>

      {/* Controls */}
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-4">
        <div className="flex flex-wrap gap-4 items-center justify-between">
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
          <div className="flex gap-2">
            <button
              onClick={() => setViewType('yield')}
              className={`px-3 py-1.5 text-sm font-medium rounded-md transition-colors ${
                viewType === 'yield' ? 'bg-blue-600 text-white' : 'bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300'
              }`}
            >
              Per-Security Yield
            </button>
            <button
              onClick={() => setViewType('growth')}
              className={`px-3 py-1.5 text-sm font-medium rounded-md transition-colors ${
                viewType === 'growth' ? 'bg-blue-600 text-white' : 'bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300'
              }`}
            >
              Year-over-Year
            </button>
            <button
              onClick={() => setViewType('frequency')}
              className={`px-3 py-1.5 text-sm font-medium rounded-md transition-colors ${
                viewType === 'frequency' ? 'bg-blue-600 text-white' : 'bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300'
              }`}
            >
              Frequency
            </button>
          </div>
        </div>
      </div>

      {transactions.length === 0 ? (
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-6">
          <p className="text-gray-500 dark:text-gray-400 text-center py-8">
            No dividend transactions found. Record dividend transactions to see yield and growth analysis.
          </p>
        </div>
      ) : viewType === 'yield' ? (
        /* Per-Security Yield Table */
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 overflow-hidden">
          <div className="px-6 py-4 border-b border-gray-200 dark:border-gray-700">
            <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
              Per-Security Dividend Yield (Trailing 12 Months)
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
                    12M Dividends
                  </th>
                  <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">
                    Market Value
                  </th>
                  <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">
                    Yield
                  </th>
                  <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">
                    Frequency
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-200 dark:divide-gray-700">
                {securityYields.map((sy) => (
                  <tr key={sy.symbol} className="hover:bg-gray-50 dark:hover:bg-gray-700/50">
                    <td className="px-4 py-3">
                      <div className="font-medium text-gray-900 dark:text-gray-100">{sy.symbol}</div>
                      <div className="text-sm text-gray-500 dark:text-gray-400">{sy.name}</div>
                    </td>
                    <td className="px-4 py-3 text-right text-sm text-green-600 dark:text-green-400">
                      {fmtValue(sy.trailing12mDividends)}
                    </td>
                    <td className="px-4 py-3 text-right text-sm text-gray-600 dark:text-gray-400">
                      {fmtValue(sy.marketValue)}
                    </td>
                    <td className="px-4 py-3 text-right text-sm font-medium text-gray-900 dark:text-gray-100">
                      {sy.yield.toFixed(2)}%
                    </td>
                    <td className="px-4 py-3 text-right text-sm text-gray-500 dark:text-gray-400">
                      {sy.frequency}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : viewType === 'growth' ? (
        /* Year-over-Year Growth */
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 px-2 py-4 sm:p-6">
          <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-4">
            Annual Dividend Income
          </h3>
          {annualData.length > 0 ? (
            <>
              <div className="h-80">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={annualData}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
                    <XAxis dataKey="year" tick={{ fontSize: 11 }} />
                    <YAxis tickFormatter={formatCurrencyAxis} />
                    <Tooltip
                      content={({ active, payload, label }) => {
                        if (!active || !payload?.length) return null;
                        const d = payload[0].payload as AnnualDividend;
                        return (
                          <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg shadow-lg p-3">
                            <p className="font-medium text-gray-900 dark:text-gray-100">{label}</p>
                            <p className="text-sm text-green-600 dark:text-green-400">
                              Dividends: {fmtValue(d.amount)}
                            </p>
                            {d.growth !== null && (
                              <p className={`text-sm ${d.growth >= 0 ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'}`}>
                                Growth: {d.growth >= 0 ? '+' : ''}{d.growth.toFixed(1)}%
                              </p>
                            )}
                          </div>
                        );
                      }}
                    />
                    <Bar dataKey="amount" fill="#22c55e" name="Dividends" radius={[4, 4, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
              {/* Growth Table */}
              <div className="mt-6 overflow-x-auto">
                <table className="min-w-full divide-y divide-gray-200 dark:divide-gray-700">
                  <thead className="bg-gray-50 dark:bg-gray-900/50">
                    <tr>
                      <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">Year</th>
                      <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">Dividend Income</th>
                      <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">YoY Growth</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-200 dark:divide-gray-700">
                    {annualData.map((row) => (
                      <tr key={row.year} className="hover:bg-gray-50 dark:hover:bg-gray-700/50">
                        <td className="px-4 py-3 text-sm font-medium text-gray-900 dark:text-gray-100">{row.year}</td>
                        <td className="px-4 py-3 text-sm text-right text-green-600 dark:text-green-400">{fmtValue(row.amount)}</td>
                        <td className={`px-4 py-3 text-sm text-right ${row.growth !== null ? (row.growth >= 0 ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400') : 'text-gray-400'}`}>
                          {row.growth !== null ? `${row.growth >= 0 ? '+' : ''}${row.growth.toFixed(1)}%` : '-'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          ) : (
            <p className="text-gray-500 dark:text-gray-400 text-center py-8">No annual data available.</p>
          )}
        </div>
      ) : (
        /* Frequency Analysis */
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 px-2 py-4 sm:p-6">
          <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-4">
            Dividend Frequency Analysis
          </h3>
          {frequencyData.length > 0 ? (
            <>
              <div className="h-64">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={frequencyData}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
                    <XAxis dataKey="frequency" tick={{ fontSize: 11 }} />
                    <YAxis tickFormatter={formatCurrencyAxis} />
                    <Tooltip
                      content={({ active, payload, label }) => {
                        if (!active || !payload?.length) return null;
                        const d = payload[0].payload as FrequencyBucket;
                        return (
                          <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg shadow-lg p-3">
                            <p className="font-medium text-gray-900 dark:text-gray-100">{label}</p>
                            <p className="text-sm text-gray-600 dark:text-gray-400">{d.count} securities</p>
                            <p className="text-sm text-green-600 dark:text-green-400">Total: {fmtValue(d.totalDividends)}</p>
                          </div>
                        );
                      }}
                    />
                    <Bar dataKey="totalDividends" fill="#8b5cf6" name="Total Dividends" radius={[4, 4, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
              <div className="mt-6 overflow-x-auto">
                <table className="min-w-full divide-y divide-gray-200 dark:divide-gray-700">
                  <thead className="bg-gray-50 dark:bg-gray-900/50">
                    <tr>
                      <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">Frequency</th>
                      <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">Securities</th>
                      <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">Total Dividends</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-200 dark:divide-gray-700">
                    {frequencyData.map((row) => (
                      <tr key={row.frequency} className="hover:bg-gray-50 dark:hover:bg-gray-700/50">
                        <td className="px-4 py-3 text-sm font-medium text-gray-900 dark:text-gray-100">{row.frequency}</td>
                        <td className="px-4 py-3 text-sm text-right text-gray-600 dark:text-gray-400">{row.count}</td>
                        <td className="px-4 py-3 text-sm text-right text-green-600 dark:text-green-400">{fmtValue(row.totalDividends)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          ) : (
            <p className="text-gray-500 dark:text-gray-400 text-center py-8">No frequency data available.</p>
          )}
        </div>
      )}
    </div>
  );
}
