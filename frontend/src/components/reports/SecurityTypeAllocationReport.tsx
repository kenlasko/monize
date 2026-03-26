'use client';

import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import {
  PieChart,
  Pie,
  Cell,
  Tooltip,
  ResponsiveContainer,
  Legend,
} from 'recharts';
import { investmentsApi } from '@/lib/investments';
import { HoldingWithMarketValue } from '@/types/investment';
import { Account } from '@/types/account';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import { useExchangeRates } from '@/hooks/useExchangeRates';
import { createLogger } from '@/lib/logger';

const logger = createLogger('SecurityTypeAllocationReport');

const TYPE_COLOURS: Record<string, string> = {
  STOCK: '#3b82f6',
  ETF: '#22c55e',
  MUTUAL_FUND: '#f97316',
  BOND: '#8b5cf6',
  CASH: '#6b7280',
};

const FALLBACK_COLOURS = ['#14b8a6', '#eab308', '#ef4444', '#06b6d4', '#a855f7', '#f43f5e'];

const TYPE_LABELS: Record<string, string> = {
  STOCK: 'Stocks',
  ETF: 'ETFs',
  MUTUAL_FUND: 'Mutual Funds',
  BOND: 'Bonds',
  CASH: 'Cash',
};

interface TypeAllocation {
  type: string;
  label: string;
  totalValue: number;
  percentage: number;
  count: number;
  color: string;
  holdings: HoldingWithMarketValue[];
}

function getColor(type: string, index: number): string {
  return TYPE_COLOURS[type] || FALLBACK_COLOURS[index % FALLBACK_COLOURS.length];
}

function CustomTooltip({ active, payload, formatCurrencyFull }: {
  active?: boolean;
  payload?: Array<{ payload: TypeAllocation }>;
  formatCurrencyFull: (v: number) => string;
}) {
  if (!active || !payload?.length) return null;
  const d = payload[0].payload;
  return (
    <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg shadow-lg p-3">
      <p className="font-medium text-gray-900 dark:text-gray-100">{d.label}</p>
      <p className="text-sm text-gray-600 dark:text-gray-400">{formatCurrencyFull(d.totalValue)} ({d.percentage.toFixed(1)}%)</p>
      <p className="text-sm text-gray-500 dark:text-gray-400">{d.count} holding{d.count !== 1 ? 's' : ''}</p>
    </div>
  );
}

export function SecurityTypeAllocationReport() {
  const { formatCurrencyCompact: formatCurrency, formatCurrency: formatCurrencyFull } = useNumberFormat();
  const { defaultCurrency, convertToDefault } = useExchangeRates();
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [holdings, setHoldings] = useState<HoldingWithMarketValue[]>([]);
  const [selectedAccountIds, setSelectedAccountIds] = useState<string[]>([]);
  const [expandedType, setExpandedType] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [showAccountFilter, setShowAccountFilter] = useState(false);
  const accountFilterRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (showAccountFilter && accountFilterRef.current && !accountFilterRef.current.contains(e.target as Node)) {
        setShowAccountFilter(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [showAccountFilter]);

  // Fetch accounts once on mount
  useEffect(() => {
    investmentsApi.getInvestmentAccounts()
      .then(setAccounts)
      .catch((error) => logger.error('Failed to load accounts:', error));
  }, []);

  const loadData = useCallback(async () => {
    setIsLoading(true);
    try {
      const summaryData = await investmentsApi.getPortfolioSummary(
        selectedAccountIds.length > 0 ? selectedAccountIds : undefined,
      );
      setHoldings(summaryData.holdings);
    } catch (error) {
      logger.error('Failed to load data:', error);
    } finally {
      setIsLoading(false);
    }
  }, [selectedAccountIds]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  const toggleAccountId = (id: string) => {
    setSelectedAccountIds((prev) =>
      prev.includes(id) ? prev.filter((a) => a !== id) : [...prev, id],
    );
  };

  const allocationData = useMemo((): TypeAllocation[] => {
    const typeMap = new Map<string, { totalValue: number; count: number; holdings: HoldingWithMarketValue[] }>();

    holdings.forEach((h) => {
      const type = h.securityType || 'OTHER';
      const marketValue = h.marketValue ?? 0;
      const converted = convertToDefault(marketValue, h.currencyCode);

      let existing = typeMap.get(type);
      if (!existing) {
        existing = { totalValue: 0, count: 0, holdings: [] };
        typeMap.set(type, existing);
      }
      existing.totalValue += converted;
      existing.count += 1;
      existing.holdings.push(h);
    });

    const totalValue = Array.from(typeMap.values()).reduce((sum, v) => sum + v.totalValue, 0);
    let colorIndex = 0;

    return Array.from(typeMap.entries())
      .map(([type, data]) => ({
        type,
        label: TYPE_LABELS[type] || type,
        totalValue: data.totalValue,
        percentage: totalValue > 0 ? (data.totalValue / totalValue) * 100 : 0,
        count: data.count,
        color: getColor(type, colorIndex++),
        holdings: data.holdings,
      }))
      .sort((a, b) => b.totalValue - a.totalValue);
  }, [holdings, convertToDefault]);

  const totalPortfolioValue = useMemo(
    () => allocationData.reduce((sum, a) => sum + a.totalValue, 0),
    [allocationData],
  );

  if (isLoading) {
    return (
      <div className="space-y-6">
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-6">
          <div className="animate-pulse space-y-4">
            <div className="h-8 bg-gray-200 dark:bg-gray-700 rounded w-1/3" />
            <div className="h-64 bg-gray-200 dark:bg-gray-700 rounded" />
          </div>
        </div>
      </div>
    );
  }

  if (allocationData.length === 0) {
    return (
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-8 text-center">
        <p className="text-gray-500 dark:text-gray-400">
          No investment holdings found. Add securities to see the asset type breakdown.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Account Filter */}
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-4">
        <div className="flex flex-wrap gap-3">
          <div className="relative" ref={accountFilterRef}>
            <button
              onClick={() => setShowAccountFilter(!showAccountFilter)}
              className="px-4 py-2 text-sm font-medium rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors"
            >
              Accounts{selectedAccountIds.length > 0 ? ` (${selectedAccountIds.length})` : ''}
            </button>
            {showAccountFilter && (
              <div className="absolute top-full left-0 mt-1 w-64 bg-white dark:bg-gray-800 rounded-lg shadow-lg dark:shadow-gray-700/50 border border-gray-200 dark:border-gray-700 z-10 max-h-60 overflow-y-auto">
                <div className="p-2">
                  {accounts.filter((a) => a.accountSubType !== 'INVESTMENT_CASH').length === 0 ? (
                    <p className="text-sm text-gray-500 dark:text-gray-400 p-2">No investment accounts</p>
                  ) : (
                    accounts.filter((a) => a.accountSubType !== 'INVESTMENT_CASH').map((acct) => (
                      <label
                        key={acct.id}
                        className="flex items-center gap-2 p-2 hover:bg-gray-50 dark:hover:bg-gray-700 rounded cursor-pointer"
                      >
                        <input
                          type="checkbox"
                          checked={selectedAccountIds.includes(acct.id)}
                          onChange={() => toggleAccountId(acct.id)}
                          className="rounded border-gray-300 dark:border-gray-600"
                        />
                        <span className="text-sm text-gray-700 dark:text-gray-300 truncate">
                          {acct.name}
                        </span>
                      </label>
                    ))
                  )}
                </div>
              </div>
            )}
          </div>
          {selectedAccountIds.length > 0 && (
            <button
              onClick={() => setSelectedAccountIds([])}
              className="px-4 py-2 text-sm font-medium rounded-lg text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors"
            >
              Clear Filters
            </button>
          )}
        </div>
      </div>

      {/* Summary Cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-2 sm:gap-4">
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-3 sm:p-4">
          <p className="text-xs sm:text-sm text-gray-500 dark:text-gray-400">Total Portfolio</p>
          <p className="text-lg sm:text-xl font-bold text-gray-900 dark:text-gray-100">
            {formatCurrency(totalPortfolioValue, defaultCurrency)}
          </p>
        </div>
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-3 sm:p-4">
          <p className="text-xs sm:text-sm text-gray-500 dark:text-gray-400">Asset Types</p>
          <p className="text-lg sm:text-xl font-bold text-gray-900 dark:text-gray-100">
            {allocationData.length}
          </p>
        </div>
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-3 sm:p-4">
          <p className="text-xs sm:text-sm text-gray-500 dark:text-gray-400">Total Holdings</p>
          <p className="text-lg sm:text-xl font-bold text-gray-900 dark:text-gray-100">
            {allocationData.reduce((sum, a) => sum + a.count, 0)}
          </p>
        </div>
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-3 sm:p-4">
          <p className="text-xs sm:text-sm text-gray-500 dark:text-gray-400">Largest Type</p>
          <p className="text-lg sm:text-xl font-bold text-gray-900 dark:text-gray-100">
            {allocationData[0]?.label || '-'}
          </p>
        </div>
      </div>

      {/* Pie Chart */}
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-3 sm:p-6">
        <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-4">
          Asset Type Allocation
        </h3>
        <div style={{ width: '100%', height: 350 }}>
          <ResponsiveContainer minWidth={0}>
            <PieChart>
              <Pie
                data={allocationData}
                dataKey="totalValue"
                nameKey="label"
                cx="50%"
                cy="50%"
                innerRadius={60}
                outerRadius={120}
                paddingAngle={2}
              >
                {allocationData.map((entry) => (
                  <Cell key={entry.type} fill={entry.color} />
                ))}
              </Pie>
              <Tooltip content={<CustomTooltip formatCurrencyFull={(v) => formatCurrencyFull(v, defaultCurrency)} />} />
              <Legend />
            </PieChart>
          </ResponsiveContainer>
        </div>
      </div>

      {/* Data Table */}
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-gray-200 dark:divide-gray-700">
            <thead className="bg-gray-50 dark:bg-gray-900/50">
              <tr>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">
                  Asset Type
                </th>
                <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">
                  Total Value
                </th>
                <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">
                  % of Portfolio
                </th>
                <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">
                  Holdings
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-200 dark:divide-gray-700">
              {allocationData.map((item) => (
                <>
                  <tr
                    key={item.type}
                    className="hover:bg-gray-50 dark:hover:bg-gray-700/50 cursor-pointer"
                    onClick={() => setExpandedType(expandedType === item.type ? null : item.type)}
                  >
                    <td className="px-4 py-3 text-sm font-medium text-gray-900 dark:text-gray-100">
                      <div className="flex items-center gap-2">
                        <div
                          className="w-3 h-3 rounded-full flex-shrink-0"
                          style={{ backgroundColor: item.color }}
                        />
                        {item.label}
                        <svg
                          className={`w-4 h-4 text-gray-400 transition-transform ${expandedType === item.type ? 'rotate-180' : ''}`}
                          fill="none"
                          viewBox="0 0 24 24"
                          stroke="currentColor"
                        >
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                        </svg>
                      </div>
                    </td>
                    <td className="px-4 py-3 text-sm text-right font-medium text-gray-900 dark:text-gray-100">
                      {formatCurrencyFull(item.totalValue, defaultCurrency)}
                    </td>
                    <td className="px-4 py-3 text-sm text-right text-gray-600 dark:text-gray-400">
                      {item.percentage.toFixed(1)}%
                    </td>
                    <td className="px-4 py-3 text-sm text-right text-gray-600 dark:text-gray-400">
                      {item.count}
                    </td>
                  </tr>
                  {expandedType === item.type && item.holdings.map((h) => (
                    <tr key={h.id} className="bg-gray-50/50 dark:bg-gray-900/20">
                      <td className="px-4 py-2 text-sm text-gray-600 dark:text-gray-400 pl-10">
                        {h.symbol} - {h.name}
                      </td>
                      <td className="px-4 py-2 text-sm text-right text-gray-600 dark:text-gray-400">
                        {formatCurrencyFull(convertToDefault(h.marketValue ?? 0, h.currencyCode), defaultCurrency)}
                      </td>
                      <td className="px-4 py-2 text-sm text-right text-gray-500 dark:text-gray-500">
                        {totalPortfolioValue > 0
                          ? ((convertToDefault(h.marketValue ?? 0, h.currencyCode) / totalPortfolioValue) * 100).toFixed(1)
                          : '0.0'}%
                      </td>
                      <td className="px-4 py-2 text-sm text-right text-gray-500 dark:text-gray-500">
                        {h.quantity}
                      </td>
                    </tr>
                  ))}
                </>
              ))}
            </tbody>
            <tfoot className="bg-gray-50 dark:bg-gray-900/50">
              <tr>
                <td className="px-4 py-3 text-sm font-bold text-gray-900 dark:text-gray-100">
                  Total
                </td>
                <td className="px-4 py-3 text-sm text-right font-bold text-gray-900 dark:text-gray-100">
                  {formatCurrencyFull(totalPortfolioValue, defaultCurrency)}
                </td>
                <td className="px-4 py-3 text-sm text-right font-bold text-gray-900 dark:text-gray-100">
                  100%
                </td>
                <td className="px-4 py-3 text-sm text-right font-bold text-gray-900 dark:text-gray-100">
                  {allocationData.reduce((sum, a) => sum + a.count, 0)}
                </td>
              </tr>
            </tfoot>
          </table>
        </div>
      </div>
    </div>
  );
}
