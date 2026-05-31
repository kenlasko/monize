'use client';

import React, { useState, useEffect, useMemo, useRef } from 'react';
import { Skeleton } from '@/components/ui/LoadingSkeleton';
import { useReportData } from '@/hooks/useReportData';
import { ReportError } from '@/components/reports/ReportError';
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
import { ExportDropdown } from '@/components/ui/ExportDropdown';
import { ReportAccountMultiSelect } from '@/components/reports/ReportAccountMultiSelect';
import { RefreshPricesButton } from '@/components/reports/RefreshPricesButton';
import { SortableHeader } from '@/components/ui/SortableHeader';
import { useSortableTable, compareValues } from '@/hooks/useSortableTable';
import { createLogger } from '@/lib/logger';
import { aggregateHoldingsBySecurity, AggregatedHolding } from '@/lib/aggregate-holdings';

const logger = createLogger('SecurityTypeAllocationReport');

// Holdings are keyed off the brokerage sub-account, so offer those (the
// sibling cash account is excluded from the picker).
const excludeCashAccounts = (a: Account) => a.accountSubType !== 'INVESTMENT_CASH';

type SecurityTypeSortField = 'label' | 'totalValue' | 'percentage' | 'count';

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
  holdings: AggregatedHolding[];
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
  const [selectedAccountIds, setSelectedAccountIds] = useState<string[]>([]);
  const [expandedType, setExpandedType] = useState<string | null>(null);
  const chartRef = useRef<HTMLDivElement>(null);
  const { sortField, sortDirection, handleSort } = useSortableTable<SecurityTypeSortField>(
    'reports.security-type-allocation.sort',
    { field: 'totalValue', direction: 'desc' },
  );

  // Fetch accounts once on mount
  useEffect(() => {
    investmentsApi.getInvestmentAccounts()
      .then(setAccounts)
      .catch((error) => logger.error('Failed to load accounts:', error));
  }, []);

  // `reload` (a stable callback) is wired to the RefreshPricesButton so a
  // manual price refresh re-fetches the holdings.
  const { data: summaryData, isLoading, error, reload: loadData } = useReportData(
    () =>
      investmentsApi.getPortfolioSummary(
        selectedAccountIds.length > 0 ? selectedAccountIds : undefined,
      ),
    [selectedAccountIds],
  );

  const holdings = useMemo<HoldingWithMarketValue[]>(
    () => summaryData?.holdings ?? [],
    [summaryData],
  );

  const allocationData = useMemo((): TypeAllocation[] => {
    // Aggregate holdings by security first so the same symbol held across
    // multiple accounts appears as a single row under its security type.
    const aggregated = aggregateHoldingsBySecurity(holdings);

    const typeMap = new Map<string, { totalValue: number; holdings: AggregatedHolding[] }>();
    aggregated.forEach((h) => {
      const type = h.securityType || 'OTHER';
      const converted = convertToDefault(h.marketValue ?? 0, h.currencyCode);

      let existing = typeMap.get(type);
      if (!existing) {
        existing = { totalValue: 0, holdings: [] };
        typeMap.set(type, existing);
      }
      existing.totalValue += converted;
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
        count: data.holdings.length,
        color: getColor(type, colorIndex++),
        holdings: data.holdings.sort(
          (a, b) =>
            convertToDefault(b.marketValue ?? 0, b.currencyCode) -
            convertToDefault(a.marketValue ?? 0, a.currencyCode),
        ),
      }))
      .sort((a, b) => b.totalValue - a.totalValue);
  }, [holdings, convertToDefault]);

  const totalPortfolioValue = useMemo(
    () => allocationData.reduce((sum, a) => sum + a.totalValue, 0),
    [allocationData],
  );

  const sortedAllocationData = useMemo(() => {
    const sorted = [...allocationData];
    sorted.sort((a, b) => {
      let comparison = 0;
      switch (sortField) {
        case 'label':
          comparison = compareValues(a.label, b.label);
          break;
        case 'totalValue':
          comparison = compareValues(a.totalValue, b.totalValue);
          break;
        case 'percentage':
          comparison = compareValues(a.percentage, b.percentage);
          break;
        case 'count':
          comparison = compareValues(a.count, b.count);
          break;
      }
      return sortDirection === 'asc' ? comparison : -comparison;
    });
    return sorted;
  }, [allocationData, sortField, sortDirection]);

  const handleExportPdf = async () => {
    const { exportToPdf } = await import('@/lib/pdf-export');
    const headers = ['Asset Type', 'Total Value', '% of Portfolio', 'Holdings'];
    const rows = allocationData.map(item => [
      item.label,
      formatCurrencyFull(item.totalValue, defaultCurrency),
      `${item.percentage.toFixed(1)}%`,
      String(item.count),
    ]);
    const totalHoldings = allocationData.reduce((sum, a) => sum + a.count, 0);
    await exportToPdf({
      title: 'Security Type Allocation',
      summaryCards: [
        { label: 'Total Portfolio', value: formatCurrency(totalPortfolioValue, defaultCurrency), color: '#111827' },
        { label: 'Asset Types', value: String(allocationData.length), color: '#111827' },
        { label: 'Total Holdings', value: String(totalHoldings), color: '#111827' },
        { label: 'Largest Type', value: allocationData[0]?.label || '-', color: '#111827' },
      ],
      chartContainer: chartRef.current,
      chartLegend: allocationData.map((item) => ({
        color: item.color,
        label: `${item.label} - ${formatCurrencyFull(item.totalValue, defaultCurrency)} (${item.percentage.toFixed(1)}%)`,
      })),
      tableData: { headers, rows },
      filename: 'security-type-allocation',
    });
  };

  if (error) {
    return <ReportError onRetry={loadData} />;
  }

  if (isLoading && !summaryData) {
    return (
      <div className="space-y-6">
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-6">
          <div className="space-y-4">
            <Skeleton className="h-8 w-1/3" />
            <Skeleton className="h-64 w-full" />
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
        <div className="flex flex-wrap gap-3 items-center justify-between">
          <div className="flex flex-wrap gap-3 items-center">
            <ReportAccountMultiSelect
              accounts={accounts}
              value={selectedAccountIds}
              onChange={setSelectedAccountIds}
              filter={excludeCashAccounts}
            />
          </div>
          <div className="flex gap-2 items-center">
            <RefreshPricesButton onRefreshComplete={loadData} />
            <ExportDropdown onExportPdf={handleExportPdf} />
          </div>
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
      <div ref={chartRef} className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-3 sm:p-6">
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
                <SortableHeader<SecurityTypeSortField>
                  field="label"
                  sortField={sortField}
                  sortDirection={sortDirection}
                  onSort={handleSort}
                  className="px-4 py-3 text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider"
                >
                  Asset Type
                </SortableHeader>
                <SortableHeader<SecurityTypeSortField>
                  field="totalValue"
                  sortField={sortField}
                  sortDirection={sortDirection}
                  onSort={handleSort}
                  align="right"
                  className="px-4 py-3 text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider"
                >
                  Total Value
                </SortableHeader>
                <SortableHeader<SecurityTypeSortField>
                  field="percentage"
                  sortField={sortField}
                  sortDirection={sortDirection}
                  onSort={handleSort}
                  align="right"
                  className="px-4 py-3 text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider"
                >
                  % of Portfolio
                </SortableHeader>
                <SortableHeader<SecurityTypeSortField>
                  field="count"
                  sortField={sortField}
                  sortDirection={sortDirection}
                  onSort={handleSort}
                  align="right"
                  className="px-4 py-3 text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider"
                >
                  Holdings
                </SortableHeader>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-200 dark:divide-gray-700">
              {sortedAllocationData.map((item) => (
                <React.Fragment key={item.type}>
                  <tr
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
                    <tr key={h.securityId} className="bg-gray-50/50 dark:bg-gray-900/20">
                      <td className="px-4 py-2 text-sm text-gray-600 dark:text-gray-400 pl-10">
                        {h.symbol} - {h.name}
                        {h.accountBreakdowns.length > 1 && (
                          <span className="ml-2 text-xs text-gray-400 dark:text-gray-500">
                            ({h.accountBreakdowns.length} accounts)
                          </span>
                        )}
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
                </React.Fragment>
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
