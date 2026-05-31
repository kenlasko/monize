'use client';

import React, { useState, useEffect, useMemo, useRef } from 'react';
import {
  Tooltip,
  ResponsiveContainer,
  PieChart,
  Pie,
  Cell,
  Legend,
} from 'recharts';
import { investmentsApi } from '@/lib/investments';
import { PortfolioSummary, HoldingWithMarketValue } from '@/types/investment';
import { Account } from '@/types/account';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import { useExchangeRates } from '@/hooks/useExchangeRates';
import { CHART_COLOURS } from '@/lib/chart-colours';
import { gainLossColor } from '@/lib/format';
import { ExportDropdown } from '@/components/ui/ExportDropdown';
import { ReportAccountMultiSelect } from '@/components/reports/ReportAccountMultiSelect';
import { RefreshPricesButton } from '@/components/reports/RefreshPricesButton';
import { SortableHeader } from '@/components/ui/SortableHeader';
import { useSortableTable, compareValues } from '@/hooks/useSortableTable';
import { createLogger } from '@/lib/logger';
import { aggregateHoldingsBySecurity, AggregatedHolding } from '@/lib/aggregate-holdings';

const logger = createLogger('InvestmentPerformanceReport');

type HoldingsSortField = 'symbol' | 'quantity' | 'averageCost' | 'currentPrice' | 'marketValue' | 'gainLoss' | 'gainLossPercent';

export function InvestmentPerformanceReport() {
  const { formatCurrency: formatCurrencyFull, formatSignedPercent } = useNumberFormat();
  const { defaultCurrency } = useExchangeRates();
  const chartRef = useRef<HTMLDivElement>(null);
  const [portfolio, setPortfolio] = useState<PortfolioSummary | null>(null);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [selectedAccountIds, setSelectedAccountIds] = useState<string[]>([]);
  const [reloadKey, setReloadKey] = useState(0);
  const [expandedSecurityId, setExpandedSecurityId] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  // Only the first load shows the full skeleton. Later reloads (e.g. changing
  // the account filter) keep the existing content -- and the account dropdown --
  // mounted so they update in place instead of unmounting the whole report.
  const [hasLoadedOnce, setHasLoadedOnce] = useState(false);
  const [viewType, setViewType] = useState<'performance' | 'allocation'>('performance');
  const isSingleAccount = selectedAccountIds.length === 1;
  const { sortField, sortDirection, handleSort } = useSortableTable<HoldingsSortField>(
    'reports.investment-performance.holdings.sort',
    { field: 'marketValue', direction: 'desc' },
  );

  useEffect(() => {
    const loadData = async () => {
      setIsLoading(true);
      try {
        const [portfolioData, accountsData] = await Promise.all([
          investmentsApi.getPortfolioSummary(selectedAccountIds.length > 0 ? selectedAccountIds : undefined),
          investmentsApi.getInvestmentAccounts(),
        ]);
        setPortfolio(portfolioData);
        setAccounts(accountsData);
      } catch (error) {
        logger.error('Failed to load investment data:', error);
      } finally {
        setIsLoading(false);
        setHasLoadedOnce(true);
      }
    };
    loadData();
  }, [selectedAccountIds, reloadKey]);

  const formatPercent = (value: number) => formatSignedPercent(value);

  // When a single account is selected, show summary values in that account's native currency
  // (per-account totals are in native currency; top-level totals are converted to default)
  const selectedAccount = isSingleAccount
    ? accounts.find((a) => a.id === selectedAccountIds[0])
    : undefined;
  const summaryCurrency = selectedAccount?.currencyCode || defaultCurrency;
  const isForeignSummary = summaryCurrency !== defaultCurrency;

  // Derive native-currency summary from holdingsByAccount when a single account is selected
  const summaryValues = useMemo(() => {
    if (!portfolio) return null;
    if (isSingleAccount && portfolio.holdingsByAccount.length > 0) {
      // Use per-account totals (native currency) instead of converted top-level totals
      let totalMarketValue = 0;
      let totalCashBalance = 0;
      let totalCostBasis = 0;
      for (const acct of portfolio.holdingsByAccount) {
        totalMarketValue += acct.totalMarketValue;
        totalCashBalance += acct.cashBalance;
        totalCostBasis += acct.totalCostBasis;
      }
      const totalPortfolioValue = totalMarketValue + totalCashBalance;
      const totalGainLoss = totalMarketValue - totalCostBasis;
      const totalGainLossPercent = totalCostBasis > 0 ? (totalGainLoss / totalCostBasis) * 100 : 0;
      return { totalPortfolioValue, totalCostBasis, totalGainLoss, totalGainLossPercent };
    }
    // All accounts: use the backend-converted totals (already in default currency)
    return {
      totalPortfolioValue: portfolio.totalPortfolioValue,
      totalCostBasis: portfolio.totalCostBasis,
      totalGainLoss: portfolio.totalGainLoss,
      totalGainLossPercent: portfolio.totalGainLossPercent,
    };
  }, [portfolio, isSingleAccount]);

  const fmtSummary = (value: number) => {
    if (isForeignSummary) {
      return `${formatCurrencyFull(value, summaryCurrency)} ${summaryCurrency}`;
    }
    return formatCurrencyFull(value);
  };

  const fmtHolding = (value: number | null, currencyCode: string) => {
    if (value === null) return 'N/A';
    if (currencyCode && currencyCode !== defaultCurrency) {
      return `${formatCurrencyFull(value, currencyCode)} ${currencyCode}`;
    }
    return formatCurrencyFull(value);
  };

  const accountNameById = useMemo(() => {
    const map = new Map<string, string>();
    accounts.forEach((a) => map.set(a.id, a.name.replace(/ - (Brokerage|Cash)$/, '')));
    return map;
  }, [accounts]);

  const aggregatedHoldings = useMemo((): AggregatedHolding[] => {
    if (!portfolio) return [];
    const aggregated = aggregateHoldingsBySecurity(portfolio.holdings);
    aggregated.sort((a, b) => {
      let comparison = 0;
      switch (sortField) {
        case 'symbol':
          comparison = compareValues(a.symbol, b.symbol);
          break;
        case 'quantity':
          comparison = compareValues(a.quantity, b.quantity);
          break;
        case 'averageCost':
          comparison = compareValues(a.averageCost, b.averageCost);
          break;
        case 'currentPrice':
          comparison = compareValues(a.currentPrice, b.currentPrice);
          break;
        case 'marketValue':
          comparison = compareValues(a.marketValue, b.marketValue);
          break;
        case 'gainLoss':
          comparison = compareValues(a.gainLoss, b.gainLoss);
          break;
        case 'gainLossPercent':
          comparison = compareValues(a.gainLossPercent, b.gainLossPercent);
          break;
      }
      return sortDirection === 'asc' ? comparison : -comparison;
    });
    return aggregated;
  }, [portfolio, sortField, sortDirection]);

  const holdingsData = useMemo(() => {
    return aggregatedHoldings
      .filter((h) => h.marketValue && h.marketValue > 0)
      .map((h, index) => ({
        ...h,
        color: CHART_COLOURS[index % CHART_COLOURS.length],
      }));
  }, [aggregatedHoldings]);

  const allocationData = useMemo(() => {
    if (!portfolio) return [];
    return portfolio.allocation.map((item, index) => ({
      ...item,
      color: item.color || CHART_COLOURS[index % CHART_COLOURS.length],
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
            Value: {fmtHolding(data.marketValue, data.currencyCode)}
          </p>
          <p className={`text-sm ${gainLossColor(data.gainLoss || 0)}`}>
            Gain/Loss: {fmtHolding(data.gainLoss, data.currencyCode)} ({formatPercent(data.gainLossPercent || 0)})
          </p>
        </div>
      );
    }
    return null;
  };

  const handleExportPdf = async () => {
    const { exportToPdf } = await import('@/lib/pdf-export');

    const cards = summaryValues ? [
      { label: 'Total Value', value: fmtSummary(summaryValues.totalPortfolioValue), color: '#111827' },
      { label: 'Cost Basis', value: fmtSummary(summaryValues.totalCostBasis), color: '#111827' },
      { label: 'Total Gain/Loss', value: `${summaryValues.totalGainLoss >= 0 ? '+' : ''}${fmtSummary(summaryValues.totalGainLoss)}`, color: summaryValues.totalGainLoss >= 0 ? '#16a34a' : '#dc2626' },
      { label: 'Return', value: formatPercent(summaryValues.totalGainLossPercent), color: summaryValues.totalGainLossPercent >= 0 ? '#16a34a' : '#dc2626' },
    ] : undefined;

    const headers = ['Security', 'Shares', 'Avg Cost', 'Price', 'Market Value', 'Gain/Loss', 'Return'];
    const rows = aggregatedHoldings.map((h) => [
      `${h.symbol} - ${h.name}`,
      h.quantity.toFixed(4),
      fmtHolding(h.averageCost, h.currencyCode),
      fmtHolding(h.currentPrice, h.currencyCode),
      fmtHolding(h.marketValue, h.currencyCode),
      fmtHolding(h.gainLoss, h.currencyCode),
      h.gainLossPercent !== null ? formatPercent(h.gainLossPercent) : 'N/A',
    ]);

    const legendItems = holdingsData.map((h) => ({
      color: h.color,
      label: `${h.symbol} - ${fmtHolding(h.marketValue, h.currencyCode)}`,
    }));

    await exportToPdf({
      title: 'Investment Performance',
      summaryCards: cards,
      chartContainer: chartRef.current,
      chartLegend: legendItems.length > 0 ? legendItems : undefined,
      tableData: rows.length > 0 ? { headers, rows } : undefined,
      filename: 'investment-performance',
    });
  };

  const AllocationTooltip = ({ active, payload }: { active?: boolean; payload?: Array<{ payload: { name: string; value: number; percentage: number } }> }) => {
    if (active && payload && payload.length) {
      const data = payload[0].payload;
      return (
        <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg shadow-lg p-3">
          <p className="font-medium text-gray-900 dark:text-gray-100">{data.name}</p>
          <p className="text-sm text-gray-600 dark:text-gray-400">
            {formatCurrencyFull(data.value)} ({data.percentage.toFixed(1)}%)
          </p>
        </div>
      );
    }
    return null;
  };

  if (isLoading && !hasLoadedOnce) {
    return (
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-6">
        <div className="animate-pulse space-y-4">
          <div className="h-8 bg-gray-200 dark:bg-gray-700 rounded w-1/3" />
          <div className="h-64 bg-gray-200 dark:bg-gray-700 rounded" />
        </div>
      </div>
    );
  }

  if (!portfolio || !summaryValues || portfolio.holdings.length === 0) {
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
            {fmtSummary(summaryValues.totalPortfolioValue)}
          </div>
        </div>
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-4">
          <div className="text-sm text-gray-500 dark:text-gray-400">Cost Basis</div>
          <div className="text-xl font-bold text-gray-900 dark:text-gray-100">
            {fmtSummary(summaryValues.totalCostBasis)}
          </div>
        </div>
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-4">
          <div className="text-sm text-gray-500 dark:text-gray-400">Total Gain/Loss</div>
          <div className={`text-xl font-bold ${gainLossColor(summaryValues.totalGainLoss)}`}>
            {summaryValues.totalGainLoss >= 0 ? '+' : ''}{fmtSummary(summaryValues.totalGainLoss)}
          </div>
        </div>
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-4">
          <div className="text-sm text-gray-500 dark:text-gray-400">Return</div>
          <div className={`text-xl font-bold ${gainLossColor(summaryValues.totalGainLossPercent)}`}>
            {formatPercent(summaryValues.totalGainLossPercent)}
          </div>
        </div>
      </div>

      {/* Controls */}
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-4">
        <div className="flex flex-wrap gap-4 items-center justify-between">
          <div className="flex flex-wrap gap-2">
            <ReportAccountMultiSelect
              accounts={accounts}
              value={selectedAccountIds}
              onChange={setSelectedAccountIds}
            />
          </div>
          <div className="flex gap-2 items-center">
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
            <RefreshPricesButton onRefreshComplete={() => setReloadKey((k) => k + 1)} />
            <ExportDropdown onExportPdf={handleExportPdf} />
          </div>
        </div>
      </div>

      <div ref={chartRef}>
      {viewType === 'performance' ? (
        <>
          {/* Holdings Performance Chart */}
          <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 px-2 py-4 sm:p-6">
            <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-4">
              Holdings by Market Value
            </h3>
            <div className="h-80">
              <ResponsiveContainer width="100%" height="100%" minWidth={0}>
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
                  <Legend />
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
                    <SortableHeader<HoldingsSortField>
                      field="symbol"
                      sortField={sortField}
                      sortDirection={sortDirection}
                      onSort={handleSort}
                      className="px-4 py-3 text-xs font-medium text-gray-500 dark:text-gray-400 uppercase"
                    >
                      Security
                    </SortableHeader>
                    <SortableHeader<HoldingsSortField>
                      field="quantity"
                      sortField={sortField}
                      sortDirection={sortDirection}
                      onSort={handleSort}
                      align="right"
                      className="px-4 py-3 text-xs font-medium text-gray-500 dark:text-gray-400 uppercase"
                    >
                      Shares
                    </SortableHeader>
                    <SortableHeader<HoldingsSortField>
                      field="averageCost"
                      sortField={sortField}
                      sortDirection={sortDirection}
                      onSort={handleSort}
                      align="right"
                      className="px-4 py-3 text-xs font-medium text-gray-500 dark:text-gray-400 uppercase"
                    >
                      Avg Cost
                    </SortableHeader>
                    <SortableHeader<HoldingsSortField>
                      field="currentPrice"
                      sortField={sortField}
                      sortDirection={sortDirection}
                      onSort={handleSort}
                      align="right"
                      className="px-4 py-3 text-xs font-medium text-gray-500 dark:text-gray-400 uppercase"
                    >
                      Current Price
                    </SortableHeader>
                    <SortableHeader<HoldingsSortField>
                      field="marketValue"
                      sortField={sortField}
                      sortDirection={sortDirection}
                      onSort={handleSort}
                      align="right"
                      className="px-4 py-3 text-xs font-medium text-gray-500 dark:text-gray-400 uppercase"
                    >
                      Market Value
                    </SortableHeader>
                    <SortableHeader<HoldingsSortField>
                      field="gainLoss"
                      sortField={sortField}
                      sortDirection={sortDirection}
                      onSort={handleSort}
                      align="right"
                      className="px-4 py-3 text-xs font-medium text-gray-500 dark:text-gray-400 uppercase"
                    >
                      Gain/Loss
                    </SortableHeader>
                    <SortableHeader<HoldingsSortField>
                      field="gainLossPercent"
                      sortField={sortField}
                      sortDirection={sortDirection}
                      onSort={handleSort}
                      align="right"
                      className="px-4 py-3 text-xs font-medium text-gray-500 dark:text-gray-400 uppercase"
                    >
                      Return
                    </SortableHeader>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-200 dark:divide-gray-700">
                  {aggregatedHoldings.map((holding) => {
                    const isExpandable = holding.accountBreakdowns.length > 1;
                    const isExpanded = expandedSecurityId === holding.securityId;
                    return (
                      <React.Fragment key={holding.securityId}>
                        <tr
                          className={`hover:bg-gray-50 dark:hover:bg-gray-700/50 ${isExpandable ? 'cursor-pointer' : ''}`}
                          onClick={isExpandable ? () => setExpandedSecurityId(isExpanded ? null : holding.securityId) : undefined}
                        >
                          <td className="px-4 py-3">
                            <div className="flex items-center gap-2">
                              <div>
                                <div className="font-medium text-gray-900 dark:text-gray-100">
                                  {holding.symbol}
                                </div>
                                <div className="text-sm text-gray-500 dark:text-gray-400">
                                  {holding.name}
                                  {isExpandable && (
                                    <span className="ml-2 text-xs text-gray-400 dark:text-gray-500">
                                      ({holding.accountBreakdowns.length} accounts)
                                    </span>
                                  )}
                                </div>
                              </div>
                              {isExpandable && (
                                <svg
                                  className={`w-4 h-4 text-gray-400 transition-transform ${isExpanded ? 'rotate-180' : ''}`}
                                  fill="none"
                                  viewBox="0 0 24 24"
                                  stroke="currentColor"
                                >
                                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                                </svg>
                              )}
                            </div>
                          </td>
                          <td className="px-4 py-3 text-right text-sm text-gray-900 dark:text-gray-100">
                            {holding.quantity.toFixed(4)}
                          </td>
                          <td className="px-4 py-3 text-right text-sm text-gray-900 dark:text-gray-100">
                            {fmtHolding(holding.averageCost, holding.currencyCode)}
                          </td>
                          <td className="px-4 py-3 text-right text-sm text-gray-900 dark:text-gray-100">
                            {fmtHolding(holding.currentPrice, holding.currencyCode)}
                          </td>
                          <td className="px-4 py-3 text-right text-sm font-medium text-gray-900 dark:text-gray-100">
                            {fmtHolding(holding.marketValue, holding.currencyCode)}
                          </td>
                          <td className={`px-4 py-3 text-right text-sm ${(holding.gainLoss || 0) >= 0 ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'}`}>
                            {fmtHolding(holding.gainLoss, holding.currencyCode)}
                          </td>
                          <td className={`px-4 py-3 text-right text-sm font-medium ${(holding.gainLossPercent || 0) >= 0 ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'}`}>
                            {holding.gainLossPercent !== null ? formatPercent(holding.gainLossPercent) : 'N/A'}
                          </td>
                        </tr>
                        {isExpanded && holding.accountBreakdowns.map((sub) => (
                          <tr key={sub.id} className="bg-gray-50/70 dark:bg-gray-900/20">
                            <td className="px-4 py-2 pl-10 text-sm text-gray-600 dark:text-gray-400">
                              {accountNameById.get(sub.accountId) || 'Unknown account'}
                            </td>
                            <td className="px-4 py-2 text-right text-sm text-gray-600 dark:text-gray-400">
                              {sub.quantity.toFixed(4)}
                            </td>
                            <td className="px-4 py-2 text-right text-sm text-gray-600 dark:text-gray-400">
                              {fmtHolding(sub.averageCost, sub.currencyCode)}
                            </td>
                            <td className="px-4 py-2 text-right text-sm text-gray-600 dark:text-gray-400">
                              {fmtHolding(sub.currentPrice, sub.currencyCode)}
                            </td>
                            <td className="px-4 py-2 text-right text-sm text-gray-600 dark:text-gray-400">
                              {fmtHolding(sub.marketValue, sub.currencyCode)}
                            </td>
                            <td className={`px-4 py-2 text-right text-sm ${(sub.gainLoss || 0) >= 0 ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'}`}>
                              {fmtHolding(sub.gainLoss, sub.currencyCode)}
                            </td>
                            <td className={`px-4 py-2 text-right text-sm ${(sub.gainLossPercent || 0) >= 0 ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'}`}>
                              {sub.gainLossPercent !== null ? formatPercent(sub.gainLossPercent) : 'N/A'}
                            </td>
                          </tr>
                        ))}
                      </React.Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </>
      ) : (
        /* Asset Allocation View */
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 px-2 py-4 sm:p-6">
          <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-4">
            Asset Allocation
          </h3>
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            <div className="h-80">
              <ResponsiveContainer width="100%" height="100%" minWidth={0}>
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
                      {formatCurrencyFull(item.value)}
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
    </div>
  );
}
