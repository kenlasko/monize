'use client';

import { useState, useEffect, useMemo } from 'react';
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Legend,
  PieChart,
  Pie,
  Cell,
} from 'recharts';
import { format, subMonths, subYears, startOfMonth } from 'date-fns';
import { investmentsApi } from '@/lib/investments';
import { PortfolioSummary, HoldingWithMarketValue } from '@/types/investment';
import { Account } from '@/types/account';
import { useNumberFormat } from '@/hooks/useNumberFormat';

const COLORS = [
  '#3b82f6', '#22c55e', '#f97316', '#8b5cf6', '#ec4899',
  '#14b8a6', '#eab308', '#ef4444', '#6366f1', '#06b6d4',
];

type DateRange = '1m' | '3m' | '6m' | '1y' | 'all';

export function InvestmentPerformanceReport() {
  const { formatCurrencyCompact: formatCurrency, formatPercent: formatPercentHook } = useNumberFormat();
  const [portfolio, setPortfolio] = useState<PortfolioSummary | null>(null);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [selectedAccountId, setSelectedAccountId] = useState<string>('');
  const [isLoading, setIsLoading] = useState(true);
  const [dateRange, setDateRange] = useState<DateRange>('1y');
  const [viewType, setViewType] = useState<'performance' | 'allocation'>('performance');

  useEffect(() => {
    const loadData = async () => {
      setIsLoading(true);
      try {
        const [portfolioData, accountsData] = await Promise.all([
          investmentsApi.getPortfolioSummary(selectedAccountId || undefined),
          investmentsApi.getInvestmentAccounts(),
        ]);
        setPortfolio(portfolioData);
        setAccounts(accountsData);
      } catch (error) {
        console.error('Failed to load investment data:', error);
      } finally {
        setIsLoading(false);
      }
    };
    loadData();
  }, [selectedAccountId]);

  const formatPercent = (value: number) => {
    const sign = value >= 0 ? '+' : '';
    return `${sign}${value.toFixed(2)}%`;
  };

  const holdingsData = useMemo(() => {
    if (!portfolio) return [];
    return portfolio.holdings
      .filter((h) => h.marketValue && h.marketValue > 0)
      .sort((a, b) => (b.marketValue || 0) - (a.marketValue || 0))
      .map((h, index) => ({
        ...h,
        color: COLORS[index % COLORS.length],
      }));
  }, [portfolio]);

  const allocationData = useMemo(() => {
    if (!portfolio) return [];
    return portfolio.allocation.map((item, index) => ({
      ...item,
      color: item.color || COLORS[index % COLORS.length],
    }));
  }, [portfolio]);

  const CustomTooltip = ({ active, payload }: { active?: boolean; payload?: Array<{ name: string; value: number; color: string; payload: HoldingWithMarketValue & { color: string } }> }) => {
    if (active && payload && payload.length) {
      const data = payload[0].payload;
      return (
        <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg shadow-lg p-3">
          <p className="font-medium text-gray-900 dark:text-gray-100">{data.name}</p>
          <p className="text-sm text-gray-600 dark:text-gray-400">{data.symbol}</p>
          <p className="text-sm text-gray-900 dark:text-gray-100 mt-1">
            Value: {formatCurrency(data.marketValue || 0)}
          </p>
          <p className={`text-sm ${(data.gainLoss || 0) >= 0 ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'}`}>
            Gain/Loss: {formatCurrency(data.gainLoss || 0)} ({formatPercent(data.gainLossPercent || 0)})
          </p>
        </div>
      );
    }
    return null;
  };

  const AllocationTooltip = ({ active, payload }: { active?: boolean; payload?: Array<{ payload: { name: string; value: number; percentage: number } }> }) => {
    if (active && payload && payload.length) {
      const data = payload[0].payload;
      return (
        <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg shadow-lg p-3">
          <p className="font-medium text-gray-900 dark:text-gray-100">{data.name}</p>
          <p className="text-sm text-gray-600 dark:text-gray-400">
            {formatCurrency(data.value)} ({data.percentage.toFixed(1)}%)
          </p>
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

  if (!portfolio || portfolio.holdings.length === 0) {
    return (
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-6">
        <p className="text-gray-500 dark:text-gray-400 text-center py-8">
          No investment holdings found. Add securities to your investment accounts to see performance data.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Portfolio Summary */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-4">
          <div className="text-sm text-gray-500 dark:text-gray-400">Total Value</div>
          <div className="text-xl font-bold text-gray-900 dark:text-gray-100">
            {formatCurrency(portfolio.totalPortfolioValue)}
          </div>
        </div>
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-4">
          <div className="text-sm text-gray-500 dark:text-gray-400">Cost Basis</div>
          <div className="text-xl font-bold text-gray-900 dark:text-gray-100">
            {formatCurrency(portfolio.totalCostBasis)}
          </div>
        </div>
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-4">
          <div className="text-sm text-gray-500 dark:text-gray-400">Total Gain/Loss</div>
          <div className={`text-xl font-bold ${portfolio.totalGainLoss >= 0 ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'}`}>
            {portfolio.totalGainLoss >= 0 ? '+' : ''}{formatCurrency(portfolio.totalGainLoss)}
          </div>
        </div>
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-4">
          <div className="text-sm text-gray-500 dark:text-gray-400">Return</div>
          <div className={`text-xl font-bold ${portfolio.totalGainLossPercent >= 0 ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'}`}>
            {formatPercent(portfolio.totalGainLossPercent)}
          </div>
        </div>
      </div>

      {/* Controls */}
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-4">
        <div className="flex flex-wrap gap-4 items-center justify-between">
          <div className="flex flex-wrap gap-2">
            <select
              value={selectedAccountId}
              onChange={(e) => setSelectedAccountId(e.target.value)}
              className="rounded-md border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100 text-sm"
            >
              <option value="">All Accounts</option>
              {accounts
                .slice()
                .sort((a, b) => a.name.localeCompare(b.name))
                .map((account) => (
                  <option key={account.id} value={account.id}>
                    {account.name}
                  </option>
                ))}
            </select>
          </div>
          <div className="flex gap-2">
            <button
              onClick={() => setViewType('performance')}
              className={`px-3 py-1.5 text-sm font-medium rounded-md transition-colors ${
                viewType === 'performance'
                  ? 'bg-blue-600 text-white'
                  : 'bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300'
              }`}
            >
              Holdings
            </button>
            <button
              onClick={() => setViewType('allocation')}
              className={`px-3 py-1.5 text-sm font-medium rounded-md transition-colors ${
                viewType === 'allocation'
                  ? 'bg-blue-600 text-white'
                  : 'bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300'
              }`}
            >
              Allocation
            </button>
          </div>
        </div>
      </div>

      {viewType === 'performance' ? (
        <>
          {/* Holdings Performance Chart */}
          <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-6">
            <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-4">
              Holdings by Market Value
            </h3>
            <div className="h-80">
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie
                    data={holdingsData}
                    cx="50%"
                    cy="50%"
                    innerRadius={60}
                    outerRadius={120}
                    paddingAngle={2}
                    dataKey="marketValue"
                    nameKey="symbol"
                  >
                    {holdingsData.map((entry, index) => (
                      <Cell key={`cell-${index}`} fill={entry.color} />
                    ))}
                  </Pie>
                  <Tooltip content={<CustomTooltip />} />
                </PieChart>
              </ResponsiveContainer>
            </div>
          </div>

          {/* Holdings Table */}
          <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 overflow-hidden">
            <div className="px-6 py-4 border-b border-gray-200 dark:border-gray-700">
              <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
                Holdings Detail
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
                      Shares
                    </th>
                    <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">
                      Avg Cost
                    </th>
                    <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">
                      Current Price
                    </th>
                    <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">
                      Market Value
                    </th>
                    <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">
                      Gain/Loss
                    </th>
                    <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">
                      Return
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-200 dark:divide-gray-700">
                  {portfolio.holdings.map((holding) => (
                    <tr key={holding.id} className="hover:bg-gray-50 dark:hover:bg-gray-700/50">
                      <td className="px-4 py-3">
                        <div className="font-medium text-gray-900 dark:text-gray-100">
                          {holding.symbol}
                        </div>
                        <div className="text-sm text-gray-500 dark:text-gray-400">
                          {holding.name}
                        </div>
                      </td>
                      <td className="px-4 py-3 text-right text-sm text-gray-900 dark:text-gray-100">
                        {holding.quantity.toFixed(4)}
                      </td>
                      <td className="px-4 py-3 text-right text-sm text-gray-900 dark:text-gray-100">
                        {formatCurrency(holding.averageCost)}
                      </td>
                      <td className="px-4 py-3 text-right text-sm text-gray-900 dark:text-gray-100">
                        {holding.currentPrice ? formatCurrency(holding.currentPrice) : 'N/A'}
                      </td>
                      <td className="px-4 py-3 text-right text-sm font-medium text-gray-900 dark:text-gray-100">
                        {holding.marketValue ? formatCurrency(holding.marketValue) : 'N/A'}
                      </td>
                      <td className={`px-4 py-3 text-right text-sm ${(holding.gainLoss || 0) >= 0 ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'}`}>
                        {holding.gainLoss !== null ? formatCurrency(holding.gainLoss) : 'N/A'}
                      </td>
                      <td className={`px-4 py-3 text-right text-sm font-medium ${(holding.gainLossPercent || 0) >= 0 ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'}`}>
                        {holding.gainLossPercent !== null ? formatPercent(holding.gainLossPercent) : 'N/A'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </>
      ) : (
        /* Asset Allocation View */
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-6">
          <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-4">
            Asset Allocation
          </h3>
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            <div className="h-80">
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie
                    data={allocationData}
                    cx="50%"
                    cy="50%"
                    innerRadius={60}
                    outerRadius={120}
                    paddingAngle={2}
                    dataKey="value"
                    nameKey="name"
                  >
                    {allocationData.map((entry, index) => (
                      <Cell key={`cell-${index}`} fill={entry.color} />
                    ))}
                  </Pie>
                  <Tooltip content={<AllocationTooltip />} />
                </PieChart>
              </ResponsiveContainer>
            </div>
            <div className="space-y-2">
              {allocationData.map((item, index) => (
                <div
                  key={index}
                  className="flex items-center justify-between p-3 rounded-lg bg-gray-50 dark:bg-gray-700/50"
                >
                  <div className="flex items-center gap-3">
                    <div
                      className="w-4 h-4 rounded"
                      style={{ backgroundColor: item.color }}
                    />
                    <div>
                      <div className="font-medium text-gray-900 dark:text-gray-100">
                        {item.name}
                      </div>
                      {item.symbol && (
                        <div className="text-sm text-gray-500 dark:text-gray-400">
                          {item.symbol}
                        </div>
                      )}
                    </div>
                  </div>
                  <div className="text-right">
                    <div className="font-medium text-gray-900 dark:text-gray-100">
                      {formatCurrency(item.value)}
                    </div>
                    <div className="text-sm text-gray-500 dark:text-gray-400">
                      {item.percentage.toFixed(1)}%
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
