'use client';

import { useState, useEffect, useMemo, useRef } from 'react';
import { Skeleton } from '@/components/ui/LoadingSkeleton';
import { useReportData } from '@/hooks/useReportData';
import { ReportError } from '@/components/reports/ReportError';
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  Legend,
} from 'recharts';
import { investmentsApi } from '@/lib/investments';
import { Security } from '@/types/investment';
import { Account } from '@/types/account';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import { useExchangeRates } from '@/hooks/useExchangeRates';
import { ExportDropdown } from '@/components/ui/ExportDropdown';
import { MultiSelect } from '@/components/ui/MultiSelect';
import { ReportAccountMultiSelect } from '@/components/reports/ReportAccountMultiSelect';
import { RefreshPricesButton } from '@/components/reports/RefreshPricesButton';
import { SortableHeader } from '@/components/ui/SortableHeader';
import { useSortableTable, compareValues } from '@/hooks/useSortableTable';
import { createLogger } from '@/lib/logger';

const logger = createLogger('SectorWeightingsReport');

// Portfolio-summary reports key holdings off the brokerage sub-account, so the
// account picker offers those (the sibling cash account is excluded).
const excludeCashAccounts = (a: Account) => a.accountSubType !== 'INVESTMENT_CASH';

type SectorSortField = 'sector' | 'direct' | 'etf' | 'total' | 'percentage';

const SECTOR_COLOURS = [
  '#3b82f6', '#22c55e', '#f97316', '#8b5cf6', '#ec4899',
  '#14b8a6', '#eab308', '#ef4444', '#06b6d4', '#a855f7',
  '#f43f5e', '#84cc16',
];

function CustomTooltip({ active, payload, formatCurrencyFull, defaultCurrency }: {
  active?: boolean;
  payload?: Array<{ payload: { sector: string; direct: number; etf: number; total: number; percentage: number } }>;
  formatCurrencyFull: (v: number, c: string) => string;
  defaultCurrency: string;
}) {
  if (!active || !payload?.length) return null;
  const d = payload[0].payload;
  return (
    <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg shadow-lg p-3">
      <p className="font-medium text-gray-900 dark:text-gray-100">{d.sector} ({d.percentage.toFixed(1)}%)</p>
      {d.direct > 0 && (
        <p className="text-sm text-blue-600 dark:text-blue-400">Direct (Stocks): {formatCurrencyFull(d.direct, defaultCurrency)}</p>
      )}
      {d.etf > 0 && (
        <p className="text-sm text-green-600 dark:text-green-400">ETF Exposure: {formatCurrencyFull(d.etf, defaultCurrency)}</p>
      )}
      <p className="text-sm font-medium text-gray-900 dark:text-gray-100 mt-1">Total: {formatCurrencyFull(d.total, defaultCurrency)}</p>
    </div>
  );
}

export function SectorWeightingsReport() {
  const { formatCurrencyCompact: formatCurrency, formatCurrency: formatCurrencyFull } = useNumberFormat();
  const { defaultCurrency } = useExchangeRates();
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [securities, setSecurities] = useState<Security[]>([]);
  const [selectedAccountIds, setSelectedAccountIds] = useState<string[]>([]);
  const [selectedSecurityIds, setSelectedSecurityIds] = useState<string[]>([]);
  const chartRef = useRef<HTMLDivElement>(null);

  const securityOptions = useMemo(
    () =>
      securities
        .filter((s) => s.isActive)
        .map((s) => ({ value: s.id, label: `${s.symbol} - ${s.name}` })),
    [securities],
  );
  const { sortField, sortDirection, handleSort } = useSortableTable<SectorSortField>(
    'reports.sector-weightings.sort',
    { field: 'total', direction: 'desc' },
  );

  // Reload weightings whenever filters change. `reload` (a stable callback) is
  // wired to the RefreshPricesButton so a manual price refresh re-fetches.
  const { data, isLoading, error, reload: loadWeightings } = useReportData(
    () =>
      investmentsApi.getSectorWeightings(
        selectedAccountIds.length > 0 ? selectedAccountIds : undefined,
        selectedSecurityIds.length > 0 ? selectedSecurityIds : undefined,
      ),
    [selectedAccountIds, selectedSecurityIds],
  );

  const sortedItems = useMemo(() => {
    if (!data) return [];
    const items = [...data.items];
    items.sort((a, b) => {
      let comparison = 0;
      switch (sortField) {
        case 'sector':
          comparison = compareValues(a.sector, b.sector);
          break;
        case 'direct':
          comparison = compareValues(a.directValue, b.directValue);
          break;
        case 'etf':
          comparison = compareValues(a.etfValue, b.etfValue);
          break;
        case 'total':
          comparison = compareValues(a.totalValue, b.totalValue);
          break;
        case 'percentage':
          comparison = compareValues(a.percentage, b.percentage);
          break;
      }
      return sortDirection === 'asc' ? comparison : -comparison;
    });
    return items;
  }, [data, sortField, sortDirection]);

  // Load accounts and securities once on mount
  useEffect(() => {
    Promise.all([
      investmentsApi.getInvestmentAccounts(),
      investmentsApi.getSecurities(),
    ])
      .then(([accountsData, securitiesData]) => {
        setAccounts(accountsData);
        setSecurities(securitiesData);
      })
      .catch((error) => logger.error('Failed to load filter data:', error));
  }, []);

  const handleExportPdf = async () => {
    const { exportToPdf } = await import('@/lib/pdf-export');
    const headers = ['Sector', 'Direct Value', 'ETF Value', 'Total Value', '% of Portfolio'];
    const rows = data ? data.items.map(item => [
      item.sector,
      formatCurrencyFull(item.directValue, defaultCurrency),
      formatCurrencyFull(item.etfValue, defaultCurrency),
      formatCurrencyFull(item.totalValue, defaultCurrency),
      `${item.percentage.toFixed(1)}%`,
    ]) : [];
    const accountLabel = selectedAccountIds.length > 0
      ? accounts.filter((a) => selectedAccountIds.includes(a.id)).map((a) => a.name).join(', ')
      : 'All Accounts';
    await exportToPdf({
      title: 'Sector Weightings',
      subtitle: accountLabel,
      chartContainer: chartRef.current,
      tableData: { headers, rows },
      filename: 'sector-weightings',
    });
  };

  if (error) {
    return <ReportError onRetry={loadWeightings} />;
  }

  if (isLoading && !data) {
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

  if (!data || (data.items.length === 0 && data.unclassifiedValue === 0)) {
    return (
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-8 text-center">
        <p className="text-gray-500 dark:text-gray-400">
          No investment holdings with sector data found. Add securities with sector classification to see the breakdown.
        </p>
      </div>
    );
  }

  const chartData = data.items.map((item, idx) => ({
    sector: item.sector,
    direct: item.directValue,
    etf: item.etfValue,
    total: item.totalValue,
    percentage: item.percentage,
    color: SECTOR_COLOURS[idx % SECTOR_COLOURS.length],
  }));

  return (
    <div className="space-y-6">
      {/* Filters */}
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-4">
        <div className="flex flex-wrap gap-3 items-center justify-between">
          <div className="flex flex-wrap gap-3 items-center">
            {/* Account Filter */}
            <ReportAccountMultiSelect
              accounts={accounts}
              value={selectedAccountIds}
              onChange={setSelectedAccountIds}
              filter={excludeCashAccounts}
            />

            {/* Security Filter */}
            <div className="w-48">
              <MultiSelect
                ariaLabel="Filter by security"
                placeholder="All Securities"
                options={securityOptions}
                value={selectedSecurityIds}
                onChange={setSelectedSecurityIds}
              />
            </div>

            {(selectedAccountIds.length > 0 || selectedSecurityIds.length > 0) && (
              <button
                onClick={() => {
                  setSelectedAccountIds([]);
                  setSelectedSecurityIds([]);
                }}
                className="px-4 py-2 text-sm font-medium rounded-lg text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors"
              >
                Clear Filters
              </button>
            )}
          </div>
          <div className="flex gap-2 items-center">
            <RefreshPricesButton onRefreshComplete={loadWeightings} />
            <ExportDropdown onExportPdf={handleExportPdf} />
          </div>
        </div>
      </div>

      {/* Summary Cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-2 sm:gap-4">
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-3 sm:p-4">
          <p className="text-xs sm:text-sm text-gray-500 dark:text-gray-400">Total Portfolio</p>
          <p className="text-lg sm:text-xl font-bold text-gray-900 dark:text-gray-100">
            {formatCurrency(data.totalPortfolioValue, defaultCurrency)}
          </p>
        </div>
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-3 sm:p-4">
          <p className="text-xs sm:text-sm text-gray-500 dark:text-gray-400">Direct Exposure</p>
          <p className="text-lg sm:text-xl font-bold text-blue-600 dark:text-blue-400">
            {formatCurrency(data.totalDirectValue, defaultCurrency)}
          </p>
        </div>
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-3 sm:p-4">
          <p className="text-xs sm:text-sm text-gray-500 dark:text-gray-400">ETF Exposure</p>
          <p className="text-lg sm:text-xl font-bold text-green-600 dark:text-green-400">
            {formatCurrency(data.totalEtfValue, defaultCurrency)}
          </p>
        </div>
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-3 sm:p-4">
          <p className="text-xs sm:text-sm text-gray-500 dark:text-gray-400">Sectors</p>
          <p className="text-lg sm:text-xl font-bold text-gray-900 dark:text-gray-100">
            {data.items.length}
          </p>
        </div>
      </div>

      {/* Stacked Bar Chart */}
      <div ref={chartRef} className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-3 sm:p-6">
        <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-4">
          Sector Allocation
        </h3>
        <div style={{ width: '100%', height: Math.max(300, chartData.length * 40 + 60) }}>
          <ResponsiveContainer minWidth={0}>
            <BarChart
              data={chartData}
              layout="vertical"
              margin={{ top: 5, right: 10, left: 0, bottom: 5 }}
            >
              <XAxis
                type="number"
                tickFormatter={(v: number) => formatCurrency(v, defaultCurrency)}
                tick={{ fill: 'currentColor', fontSize: 11 }}
              />
              <YAxis
                type="category"
                dataKey="sector"
                width={100}
                tick={{ fill: 'currentColor', fontSize: 11 }}
              />
              <Tooltip content={<CustomTooltip formatCurrencyFull={formatCurrencyFull} defaultCurrency={defaultCurrency} />} />
              <Legend
                formatter={(value: string) =>
                  value === 'direct' ? 'Direct (Stocks)' : 'ETF Exposure'
                }
              />
              <Bar dataKey="direct" stackId="a" fill="#3b82f6" name="direct" />
              <Bar dataKey="etf" stackId="a" fill="#22c55e" name="etf" radius={[0, 4, 4, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>

      {/* Data Table */}
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-gray-200 dark:divide-gray-700">
            <thead className="bg-gray-50 dark:bg-gray-900/50">
              <tr>
                <SortableHeader<SectorSortField>
                  field="sector"
                  sortField={sortField}
                  sortDirection={sortDirection}
                  onSort={handleSort}
                  className="px-4 py-3 text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider"
                >
                  Sector
                </SortableHeader>
                <SortableHeader<SectorSortField>
                  field="direct"
                  sortField={sortField}
                  sortDirection={sortDirection}
                  onSort={handleSort}
                  align="right"
                  className="px-4 py-3 text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider"
                >
                  Direct Value
                </SortableHeader>
                <SortableHeader<SectorSortField>
                  field="etf"
                  sortField={sortField}
                  sortDirection={sortDirection}
                  onSort={handleSort}
                  align="right"
                  className="px-4 py-3 text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider"
                >
                  ETF Value
                </SortableHeader>
                <SortableHeader<SectorSortField>
                  field="total"
                  sortField={sortField}
                  sortDirection={sortDirection}
                  onSort={handleSort}
                  align="right"
                  className="px-4 py-3 text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider"
                >
                  Total Value
                </SortableHeader>
                <SortableHeader<SectorSortField>
                  field="percentage"
                  sortField={sortField}
                  sortDirection={sortDirection}
                  onSort={handleSort}
                  align="right"
                  className="px-4 py-3 text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider"
                >
                  % of Portfolio
                </SortableHeader>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-200 dark:divide-gray-700">
              {sortedItems.map((item) => {
                const idx = data.items.indexOf(item);
                return (
                <tr key={item.sector} className="hover:bg-gray-50 dark:hover:bg-gray-700/50">
                  <td className="px-4 py-3 text-sm font-medium text-gray-900 dark:text-gray-100">
                    <div className="flex items-center gap-2">
                      <div
                        className="w-3 h-3 rounded-full flex-shrink-0"
                        style={{ backgroundColor: SECTOR_COLOURS[idx % SECTOR_COLOURS.length] }}
                      />
                      {item.sector}
                    </div>
                  </td>
                  <td className="px-4 py-3 text-sm text-right text-blue-600 dark:text-blue-400">
                    {formatCurrencyFull(item.directValue, defaultCurrency)}
                  </td>
                  <td className="px-4 py-3 text-sm text-right text-green-600 dark:text-green-400">
                    {formatCurrencyFull(item.etfValue, defaultCurrency)}
                  </td>
                  <td className="px-4 py-3 text-sm text-right font-medium text-gray-900 dark:text-gray-100">
                    {formatCurrencyFull(item.totalValue, defaultCurrency)}
                  </td>
                  <td className="px-4 py-3 text-sm text-right text-gray-600 dark:text-gray-400">
                    {item.percentage.toFixed(1)}%
                  </td>
                </tr>
                );
              })}
              {data.unclassifiedValue > 0 && (
                <tr className="hover:bg-gray-50 dark:hover:bg-gray-700/50 bg-gray-50/50 dark:bg-gray-900/20">
                  <td className="px-4 py-3 text-sm font-medium text-gray-500 dark:text-gray-400 italic">
                    Unclassified
                  </td>
                  <td className="px-4 py-3 text-sm text-right text-gray-500 dark:text-gray-400">
                    —
                  </td>
                  <td className="px-4 py-3 text-sm text-right text-gray-500 dark:text-gray-400">
                    —
                  </td>
                  <td className="px-4 py-3 text-sm text-right font-medium text-gray-500 dark:text-gray-400">
                    {formatCurrencyFull(data.unclassifiedValue, defaultCurrency)}
                  </td>
                  <td className="px-4 py-3 text-sm text-right text-gray-500 dark:text-gray-400">
                    {data.totalPortfolioValue > 0
                      ? ((data.unclassifiedValue / data.totalPortfolioValue) * 100).toFixed(1)
                      : '0.0'}%
                  </td>
                </tr>
              )}
            </tbody>
            <tfoot className="bg-gray-50 dark:bg-gray-900/50">
              <tr>
                <td className="px-4 py-3 text-sm font-bold text-gray-900 dark:text-gray-100">
                  Total
                </td>
                <td className="px-4 py-3 text-sm text-right font-bold text-blue-600 dark:text-blue-400">
                  {formatCurrencyFull(data.totalDirectValue, defaultCurrency)}
                </td>
                <td className="px-4 py-3 text-sm text-right font-bold text-green-600 dark:text-green-400">
                  {formatCurrencyFull(data.totalEtfValue, defaultCurrency)}
                </td>
                <td className="px-4 py-3 text-sm text-right font-bold text-gray-900 dark:text-gray-100">
                  {formatCurrencyFull(data.totalPortfolioValue, defaultCurrency)}
                </td>
                <td className="px-4 py-3 text-sm text-right font-bold text-gray-900 dark:text-gray-100">
                  100%
                </td>
              </tr>
            </tfoot>
          </table>
        </div>
      </div>
    </div>
  );
}
