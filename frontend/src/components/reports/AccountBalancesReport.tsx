'use client';

import { useState, useEffect, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import { PieChart, Pie, Cell, ResponsiveContainer, Tooltip } from 'recharts';
import { accountsApi } from '@/lib/accounts';
import { investmentsApi } from '@/lib/investments';
import { Account } from '@/types/account';
import { PortfolioSummary } from '@/types/investment';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import { useExchangeRates } from '@/hooks/useExchangeRates';
import { CHART_COLOURS } from '@/lib/chart-colours';
import { createLogger } from '@/lib/logger';

const logger = createLogger('AccountBalancesReport');

type AccountTypeFilter = 'all' | 'assets' | 'liabilities';
type ViewMode = 'table' | 'chart';
type ChartGrouping = 'type' | 'account';

const LIABILITY_TYPES = ['CREDIT_CARD', 'LOAN', 'MORTGAGE', 'LINE_OF_CREDIT'];

const accountTypeLabels: Record<string, string> = {
  CHEQUING: 'Chequing',
  SAVINGS: 'Savings',
  CREDIT_CARD: 'Credit Card',
  LINE_OF_CREDIT: 'Line of Credit',
  LOAN: 'Loan',
  MORTGAGE: 'Mortgage',
  INVESTMENT: 'Investment',
  CASH: 'Cash',
  ASSET: 'Asset',
  OTHER: 'Other',
};


export function AccountBalancesReport() {
  const router = useRouter();
  const { formatCurrency } = useNumberFormat();
  const { convertToDefault, defaultCurrency } = useExchangeRates();
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [portfolioSummary, setPortfolioSummary] = useState<PortfolioSummary | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [typeFilter, setTypeFilter] = useState<AccountTypeFilter>('all');
  const [viewMode, setViewMode] = useState<ViewMode>('table');
  const [chartGrouping, setChartGrouping] = useState<ChartGrouping>('type');

  useEffect(() => {
    const loadData = async () => {
      setIsLoading(true);
      try {
        const [data, portfolio] = await Promise.all([
          accountsApi.getAll(),
          investmentsApi.getPortfolioSummary().catch(() => null),
        ]);
        setAccounts(data);
        setPortfolioSummary(portfolio);
      } catch (error) {
        logger.error('Failed to load accounts:', error);
      } finally {
        setIsLoading(false);
      }
    };
    loadData();
  }, []);

  // Build a map of brokerage account ID -> total market value of holdings
  const brokerageMarketValues = useMemo(() => {
    const map = new Map<string, number>();
    if (!portfolioSummary) return map;
    for (const accountHoldings of portfolioSummary.holdingsByAccount) {
      const totalValue = accountHoldings.totalMarketValue + accountHoldings.cashBalance;
      map.set(accountHoldings.accountId, totalValue);
    }
    return map;
  }, [portfolioSummary]);

  const filteredAccounts = useMemo(() => {
    return accounts.filter((acc) => {
      if (acc.isClosed) return false;

      const isLiability = LIABILITY_TYPES.includes(acc.accountType);
      if (typeFilter === 'assets' && isLiability) return false;
      if (typeFilter === 'liabilities' && !isLiability) return false;

      return true;
    });
  }, [accounts, typeFilter]);

  const groupedAccounts = useMemo(() => {
    const groups = new Map<string, Account[]>();

    filteredAccounts.forEach((acc) => {
      const type = acc.accountType || 'OTHER';
      if (!groups.has(type)) {
        groups.set(type, []);
      }
      groups.get(type)!.push(acc);
    });

    // Sort accounts within each group by effective balance
    groups.forEach((accs) => {
      accs.sort((a, b) => {
        const balA = a.accountSubType === 'INVESTMENT_BROKERAGE'
          ? (brokerageMarketValues.get(a.id) ?? 0)
          : Math.abs(Number(a.currentBalance));
        const balB = b.accountSubType === 'INVESTMENT_BROKERAGE'
          ? (brokerageMarketValues.get(b.id) ?? 0)
          : Math.abs(Number(b.currentBalance));
        return balB - balA;
      });
    });

    return groups;
  }, [filteredAccounts, brokerageMarketValues]);

  const totals = useMemo(() => {
    let assets = 0;
    let liabilities = 0;

    filteredAccounts.forEach((acc) => {
      const rawBalance = acc.accountSubType === 'INVESTMENT_BROKERAGE'
        ? (brokerageMarketValues.get(acc.id) ?? 0)
        : (Number(acc.currentBalance) || 0);
      const convertedBalance = convertToDefault(rawBalance, acc.currencyCode);

      if (LIABILITY_TYPES.includes(acc.accountType)) {
        liabilities += Math.abs(convertedBalance);
      } else {
        assets += convertedBalance;
      }
    });

    return { assets, liabilities, netWorth: assets - liabilities };
  }, [filteredAccounts, brokerageMarketValues, convertToDefault]);

  // Helper to get effective balance for an account
  const getEffectiveBalance = (acc: Account): number => {
    return acc.accountSubType === 'INVESTMENT_BROKERAGE'
      ? (brokerageMarketValues.get(acc.id) ?? 0)
      : (Number(acc.currentBalance) || 0);
  };

  // Build chart data
  const chartData = useMemo(() => {
    if (chartGrouping === 'type') {
      const data: Array<{ name: string; value: number; color: string }> = [];
      let colorIdx = 0;
      groupedAccounts.forEach((accs, type) => {
        const total = accs.reduce((sum, acc) => {
          return sum + Math.abs(convertToDefault(getEffectiveBalance(acc), acc.currencyCode));
        }, 0);
        if (total > 0) {
          data.push({
            name: accountTypeLabels[type] || type,
            value: total,
            color: CHART_COLOURS[colorIdx % CHART_COLOURS.length],
          });
          colorIdx++;
        }
      });
      return data.sort((a, b) => b.value - a.value);
    } else {
      const data: Array<{ name: string; value: number; color: string }> = [];
      filteredAccounts.forEach((acc, idx) => {
        const converted = Math.abs(convertToDefault(getEffectiveBalance(acc), acc.currencyCode));
        if (converted > 0) {
          data.push({
            name: acc.name,
            value: converted,
            color: CHART_COLOURS[idx % CHART_COLOURS.length],
          });
        }
      });
      return data.sort((a, b) => b.value - a.value);
    }
  }, [chartGrouping, groupedAccounts, filteredAccounts, convertToDefault, brokerageMarketValues]);

  const chartTotal = useMemo(() => {
    return chartData.reduce((sum, d) => sum + d.value, 0);
  }, [chartData]);

  const CustomTooltip = ({
    active,
    payload,
  }: {
    active?: boolean;
    payload?: Array<{
      payload: { name: string; value: number };
    }>;
  }) => {
    if (active && payload?.length) {
      const data = payload[0].payload;
      const pct = chartTotal > 0 ? ((data.value / chartTotal) * 100).toFixed(1) : '0.0';
      return (
        <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg shadow-lg p-3">
          <p className="font-medium text-gray-900 dark:text-gray-100">{data.name}</p>
          <p className="text-gray-600 dark:text-gray-400">
            {formatCurrency(data.value)} ({pct}%)
          </p>
        </div>
      );
    }
    return null;
  };

  const handleAccountClick = (accountId: string) => {
    router.push(`/transactions?accountId=${accountId}`);
  };

  if (isLoading) {
    return (
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-6">
        <div className="animate-pulse space-y-4">
          <div className="h-8 bg-gray-200 dark:bg-gray-700 rounded w-1/3" />
          <div className="space-y-3">
            {[1, 2, 3, 4, 5].map((i) => (
              <div key={i} className="h-16 bg-gray-200 dark:bg-gray-700 rounded" />
            ))}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Summary Cards */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-6">
          <div className="text-sm text-gray-500 dark:text-gray-400">Total Assets</div>
          <div className="text-2xl font-bold text-green-600 dark:text-green-400">
            {formatCurrency(totals.assets)}
          </div>
        </div>
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-6">
          <div className="text-sm text-gray-500 dark:text-gray-400">Total Liabilities</div>
          <div className="text-2xl font-bold text-red-600 dark:text-red-400">
            {formatCurrency(totals.liabilities)}
          </div>
        </div>
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-6">
          <div className="text-sm text-gray-500 dark:text-gray-400">Net Worth</div>
          <div className={`text-2xl font-bold ${
            totals.netWorth >= 0 ? 'text-blue-600 dark:text-blue-400' : 'text-orange-600 dark:text-orange-400'
          }`}>
            {formatCurrency(totals.netWorth)}
          </div>
        </div>
      </div>

      {/* Controls */}
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-4">
        <div className="flex flex-wrap gap-4 items-center justify-between">
          <div className="flex flex-wrap gap-2">
            {(['all', 'assets', 'liabilities'] as AccountTypeFilter[]).map((filter) => (
              <button
                key={filter}
                onClick={() => setTypeFilter(filter)}
                className={`px-3 py-1.5 text-sm font-medium rounded-md transition-colors capitalize ${
                  typeFilter === filter
                    ? 'bg-blue-600 text-white'
                    : 'bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-600'
                }`}
              >
                {filter}
              </button>
            ))}
          </div>
          <div className="flex gap-1">
            <button
              onClick={() => setViewMode('table')}
              className={`p-2 rounded-md transition-colors ${
                viewMode === 'table'
                  ? 'bg-blue-600 text-white'
                  : 'text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700'
              }`}
              title="Table view"
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 10h16M4 14h16M4 18h16" />
              </svg>
            </button>
            <button
              onClick={() => setViewMode('chart')}
              className={`p-2 rounded-md transition-colors ${
                viewMode === 'chart'
                  ? 'bg-blue-600 text-white'
                  : 'text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700'
              }`}
              title="Chart view"
            >
              <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24">
                <path d="M11 2v20c-5.07-.5-9-4.79-9-10s3.93-9.5 9-10zm2.03 0v8.99H22c-.47-4.74-4.24-8.52-8.97-8.99zm0 11.01V22c4.74-.47 8.5-4.25 8.97-8.99h-8.97z" />
              </svg>
            </button>
          </div>
        </div>
      </div>

      {/* Chart View */}
      {viewMode === 'chart' && (
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-6">
          {/* Grouping toggle */}
          <div className="flex gap-2 mb-6">
            {(['type', 'account'] as ChartGrouping[]).map((g) => (
              <button
                key={g}
                onClick={() => setChartGrouping(g)}
                className={`px-3 py-1.5 text-sm font-medium rounded-md transition-colors ${
                  chartGrouping === g
                    ? 'bg-blue-600 text-white'
                    : 'bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-600'
                }`}
              >
                {g === 'type' ? 'By Account Type' : 'By Account'}
              </button>
            ))}
          </div>

          {chartData.length === 0 ? (
            <p className="text-gray-500 dark:text-gray-400 text-center py-8">No data to display.</p>
          ) : (
            <>
              <div className="h-72">
                <ResponsiveContainer width="100%" height="100%">
                  <PieChart>
                    <Pie
                      data={chartData}
                      cx="50%"
                      cy="50%"
                      innerRadius={60}
                      outerRadius={100}
                      paddingAngle={2}
                      dataKey="value"
                    >
                      {chartData.map((entry, index) => (
                        <Cell key={`cell-${index}`} fill={entry.color} />
                      ))}
                    </Pie>
                    <Tooltip content={<CustomTooltip />} />
                  </PieChart>
                </ResponsiveContainer>
              </div>

              {/* Legend */}
              <div className="mt-4 grid grid-cols-2 gap-2 max-h-48 overflow-y-auto">
                {chartData.map((item, index) => {
                  const pct = chartTotal > 0 ? ((item.value / chartTotal) * 100).toFixed(1) : '0.0';
                  return (
                    <div key={index} className="flex items-center gap-2 text-sm">
                      <div
                        className="w-3 h-3 rounded-full flex-shrink-0"
                        style={{ backgroundColor: item.color }}
                      />
                      <span className="text-gray-600 dark:text-gray-400 truncate">
                        {item.name}
                      </span>
                      <span className="text-gray-900 dark:text-gray-100 ml-auto whitespace-nowrap">
                        {pct}%
                      </span>
                    </div>
                  );
                })}
              </div>

              {/* Total */}
              <div className="mt-4 pt-4 border-t border-gray-200 dark:border-gray-700 text-center">
                <div className="text-sm text-gray-500 dark:text-gray-400">Total</div>
                <div className="font-semibold text-gray-900 dark:text-gray-100">
                  {formatCurrency(chartTotal)}
                </div>
              </div>
            </>
          )}
        </div>
      )}

      {/* Table View - Account Groups */}
      {viewMode === 'table' && (
        <>
          {Array.from(groupedAccounts.entries()).map(([type, accs]) => {
            const isLiabilityGroup = LIABILITY_TYPES.includes(type);
            const groupTotal = accs.reduce((sum, acc) => {
              const rawBalance = acc.accountSubType === 'INVESTMENT_BROKERAGE'
                ? (brokerageMarketValues.get(acc.id) ?? 0)
                : (Number(acc.currentBalance) || 0);
              return sum + convertToDefault(rawBalance, acc.currencyCode);
            }, 0);

            return (
              <div key={type} className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 overflow-hidden">
                <div className="px-6 py-4 bg-gray-50 dark:bg-gray-900/50 border-b border-gray-200 dark:border-gray-700 flex items-center justify-between">
                  <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
                    {accountTypeLabels[type] || type}
                  </h3>
                  <span className={`font-semibold ${
                    isLiabilityGroup ? 'text-red-600 dark:text-red-400' : 'text-green-600 dark:text-green-400'
                  }`}>
                    {formatCurrency(isLiabilityGroup ? Math.abs(groupTotal) : groupTotal)}
                  </span>
                </div>
                <div className="divide-y divide-gray-200 dark:divide-gray-700">
                  {accs.map((acc) => {
                    const isBrokerage = acc.accountSubType === 'INVESTMENT_BROKERAGE';
                    const effectiveBalance = isBrokerage
                      ? (brokerageMarketValues.get(acc.id) ?? 0)
                      : (Number(acc.currentBalance) || 0);
                    return (
                      <button
                        key={acc.id}
                        onClick={() => isBrokerage ? router.push('/investments') : handleAccountClick(acc.id)}
                        className="w-full px-6 py-4 flex items-center justify-between hover:bg-gray-50 dark:hover:bg-gray-700/50 transition-colors text-left"
                      >
                        <div>
                          <div className="font-medium text-gray-900 dark:text-gray-100 flex items-center gap-2">
                            {acc.name}
                            {acc.isClosed && (
                              <span className="px-2 py-0.5 text-xs bg-gray-200 dark:bg-gray-600 text-gray-600 dark:text-gray-300 rounded">
                                Closed
                              </span>
                            )}
                          </div>
                          {isBrokerage && (
                            <div className="text-sm text-gray-500 dark:text-gray-400">
                              Market value
                            </div>
                          )}
                          {!isBrokerage && acc.description && (
                            <div className="text-sm text-gray-500 dark:text-gray-400">
                              {acc.description}
                            </div>
                          )}
                        </div>
                        <div className="text-right">
                          <div className={`font-semibold ${
                            isLiabilityGroup ? 'text-red-600 dark:text-red-400' : 'text-green-600 dark:text-green-400'
                          }`}>
                            {formatCurrency(isLiabilityGroup ? Math.abs(effectiveBalance) : effectiveBalance, acc.currencyCode)}
                          </div>
                          {acc.currencyCode !== defaultCurrency && (
                            <div className="text-xs text-gray-400 dark:text-gray-500">
                              {'\u2248 '}{formatCurrency(convertToDefault(Math.abs(effectiveBalance), acc.currencyCode), defaultCurrency)}
                            </div>
                          )}
                        </div>
                      </button>
                    );
                  })}
                </div>
              </div>
            );
          })}

          {filteredAccounts.length === 0 && (
            <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-8 text-center">
              <p className="text-gray-500 dark:text-gray-400">No accounts found.</p>
            </div>
          )}
        </>
      )}
    </div>
  );
}
