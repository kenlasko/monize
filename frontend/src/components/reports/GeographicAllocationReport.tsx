'use client';

import { useState, useEffect, useMemo, useRef } from 'react';
import { Skeleton } from '@/components/ui/LoadingSkeleton';
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  PieChart,
  Pie,
  Cell,
  Legend,
} from 'recharts';
import { investmentsApi } from '@/lib/investments';
import { HoldingWithMarketValue, Security } from '@/types/investment';
import { Account } from '@/types/account';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import { useExchangeRates } from '@/hooks/useExchangeRates';
import { ExportDropdown } from '@/components/ui/ExportDropdown';
import { ReportAccountMultiSelect } from '@/components/reports/ReportAccountMultiSelect';
import { RefreshPricesButton } from '@/components/reports/RefreshPricesButton';
import { SortableHeader } from '@/components/ui/SortableHeader';
import { useSortableTable, compareValues } from '@/hooks/useSortableTable';
import { useReportData } from '@/hooks/useReportData';
import { ReportError } from '@/components/reports/ReportError';
import { chartColors } from '@/lib/chart-colors';
import {
  COUNTRY_COLOURS,
  computeGeographicAllocation,
  ExchangeAllocation,
  RegionAllocation,
} from '@/lib/geographic-allocation';
import { createLogger } from '@/lib/logger';
import { useTranslations } from 'next-intl';
import { resolvePdfColor } from '@/components/reports/resolve-pdf-color';

const logger = createLogger('GeographicAllocationReport');

// Holdings are keyed off the brokerage sub-account, so offer those (the
// sibling cash account is excluded from the picker).
const excludeCashAccounts = (a: Account) => a.accountSubType !== 'INVESTMENT_CASH';

type GeoRegionSortField = 'region' | 'count' | 'marketValue' | 'percentage';
type GeoExchangeSortField = 'exchange' | 'country' | 'count' | 'marketValue' | 'percentage';
type GeoCountrySortField = 'country' | 'marketValue' | 'percentage';

interface CountryRow {
  country: string;
  marketValue: number;
  percentage: number;
  color: string;
}

function CustomTooltip({ active, payload, formatCurrencyFull, holdingLabel }: {
  active?: boolean;
  payload?: Array<{ payload: RegionAllocation | ExchangeAllocation }>;
  formatCurrencyFull: (v: number) => string;
  holdingLabel: (count: number) => string;
}) {
  if (!active || !payload?.length) return null;
  const d = payload[0].payload;
  const label = 'region' in d && !('exchange' in d) ? (d as RegionAllocation).region : (d as ExchangeAllocation).exchange;
  return (
    <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg shadow-lg p-3">
      <p className="font-medium text-gray-900 dark:text-gray-100">{label}</p>
      <p className="text-sm text-gray-600 dark:text-gray-400">
        {formatCurrencyFull(d.marketValue)} ({('percentage' in d ? d.percentage : 0).toFixed(1)}%)
      </p>
      <p className="text-sm text-gray-500 dark:text-gray-400">{holdingLabel(d.count)}</p>
    </div>
  );
}

export function GeographicAllocationReport() {
  const t = useTranslations('reports');
  const { formatCurrencyCompact: formatCurrency, formatCurrency: formatCurrencyFull, formatCurrencyAxis } = useNumberFormat();
  const { defaultCurrency, convertToDefault } = useExchangeRates();
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [securities, setSecurities] = useState<Security[]>([]);
  const [selectedAccountIds, setSelectedAccountIds] = useState<string[]>([]);
  const [viewType, setViewType] = useState<'region' | 'exchange' | 'country'>('region');
  const chartRef = useRef<HTMLDivElement>(null);
  const regionSort = useSortableTable<GeoRegionSortField>(
    'reports.geographic-allocation.region.sort',
    { field: 'marketValue', direction: 'desc' },
  );
  const exchangeSort = useSortableTable<GeoExchangeSortField>(
    'reports.geographic-allocation.exchange.sort',
    { field: 'marketValue', direction: 'desc' },
  );
  const countrySort = useSortableTable<GeoCountrySortField>(
    'reports.geographic-allocation.country.sort',
    { field: 'marketValue', direction: 'desc' },
  );

  // Fetch accounts and securities once on mount (static data)
  useEffect(() => {
    Promise.all([
      investmentsApi.getInvestmentAccounts(),
      investmentsApi.getSecurities(),
    ])
      .then(([accountsData, securitiesData]) => {
        setAccounts(accountsData);
        setSecurities(securitiesData);
      })
      .catch((error) => logger.error('Failed to load static data:', error));
  }, []);

  const { data: response, isLoading, error, reload } = useReportData(
    () =>
      investmentsApi.getPortfolioSummary(
        selectedAccountIds.length > 0 ? selectedAccountIds : undefined,
      ),
    [selectedAccountIds],
  );

  // Country look-through breakdown (server-side: splits ETFs/funds across their
  // manual country allocation, places stocks by listing exchange, "Other" =
  // unclassified remainder). Cheap + cached, so fetched alongside the summary.
  const { data: countryResp, reload: reloadCountry } = useReportData(
    () =>
      investmentsApi.getCountryWeightings(
        selectedAccountIds.length > 0 ? selectedAccountIds : undefined,
      ),
    [selectedAccountIds],
  );

  // Only the first load shows the full skeleton. Later reloads (e.g. changing
  // the account filter) keep the existing content -- and the account dropdown --
  // mounted so they update in place instead of unmounting the whole report.
  const holdings = useMemo<HoldingWithMarketValue[]>(
    () => response?.holdings ?? [],
    [response],
  );

  const securityExchangeMap = useMemo(() => {
    const map = new Map<string, string>();
    securities.forEach((s) => {
      if (s.exchange) map.set(s.id, s.exchange);
    });
    return map;
  }, [securities]);

  const { exchangeData, regionData, totalValue } = useMemo(
    () => computeGeographicAllocation(holdings, securityExchangeMap, convertToDefault),
    [holdings, convertToDefault, securityExchangeMap],
  );

  const sortedRegionData = useMemo(() => {
    const sorted = [...regionData];
    sorted.sort((a, b) => {
      let comparison = 0;
      switch (regionSort.sortField) {
        case 'region':
          comparison = compareValues(a.region, b.region);
          break;
        case 'count':
          comparison = compareValues(a.count, b.count);
          break;
        case 'marketValue':
          comparison = compareValues(a.marketValue, b.marketValue);
          break;
        case 'percentage':
          comparison = compareValues(a.percentage, b.percentage);
          break;
      }
      return regionSort.sortDirection === 'asc' ? comparison : -comparison;
    });
    return sorted;
  }, [regionData, regionSort.sortField, regionSort.sortDirection]);

  const sortedExchangeData = useMemo(() => {
    const sorted = [...exchangeData];
    sorted.sort((a, b) => {
      let comparison = 0;
      switch (exchangeSort.sortField) {
        case 'exchange':
          comparison = compareValues(a.exchange, b.exchange);
          break;
        case 'country':
          comparison = compareValues(a.country, b.country);
          break;
        case 'count':
          comparison = compareValues(a.count, b.count);
          break;
        case 'marketValue':
          comparison = compareValues(a.marketValue, b.marketValue);
          break;
        case 'percentage':
          comparison = compareValues(a.percentage, b.percentage);
          break;
      }
      return exchangeSort.sortDirection === 'asc' ? comparison : -comparison;
    });
    return sorted;
  }, [exchangeData, exchangeSort.sortField, exchangeSort.sortDirection]);

  const countryData = useMemo<CountryRow[]>(() => {
    if (!countryResp) return [];
    const total = countryResp.totalPortfolioValue || 0;
    const rows: CountryRow[] = countryResp.items.map((item, idx) => ({
      country: item.country,
      marketValue: item.totalValue,
      percentage: item.percentage,
      color: COUNTRY_COLOURS[idx % COUNTRY_COLOURS.length],
    }));
    if (countryResp.unclassifiedValue > 0.0001) {
      rows.push({
        country: t('geographicAllocation.other'),
        marketValue: countryResp.unclassifiedValue,
        percentage: total > 0 ? (countryResp.unclassifiedValue / total) * 100 : 0,
        color: chartColors.axis,
      });
    }
    return rows;
  }, [countryResp, t]);

  const countryTotalValue = countryResp?.totalPortfolioValue ?? 0;

  const sortedCountryData = useMemo(() => {
    const sorted = [...countryData];
    sorted.sort((a, b) => {
      let comparison = 0;
      switch (countrySort.sortField) {
        case 'country':
          comparison = compareValues(a.country, b.country);
          break;
        case 'marketValue':
          comparison = compareValues(a.marketValue, b.marketValue);
          break;
        case 'percentage':
          comparison = compareValues(a.percentage, b.percentage);
          break;
      }
      return countrySort.sortDirection === 'asc' ? comparison : -comparison;
    });
    return sorted;
  }, [countryData, countrySort.sortField, countrySort.sortDirection]);

  const handleExportPdf = async () => {
    if (viewType === 'country') {
      const { exportToPdf } = await import('@/lib/pdf-export');
      await exportToPdf({
        title: t('page.names.geographic-allocation' as Parameters<typeof t>[0]),
        subtitle: t('geographicAllocation.viewByCountry'),
        summaryCards: [
          { label: t('geographicAllocation.totalPortfolio'), value: formatCurrency(countryTotalValue, defaultCurrency), color: '#111827' },
        ],
        chartContainer: chartRef.current,
        chartLegend: countryData.map((item) => ({
          color: resolvePdfColor(item.color),
          label: `${item.country} - ${formatCurrencyFull(item.marketValue, defaultCurrency)} (${item.percentage.toFixed(1)}%)`,
        })),
        tableData: {
          headers: [t('geographicAllocation.colCountry'), t('geographicAllocation.colMarketValue'), t('geographicAllocation.colPortfolioPct')],
          rows: sortedCountryData.map((item) => [
            item.country,
            formatCurrencyFull(item.marketValue, defaultCurrency),
            `${item.percentage.toFixed(1)}%`,
          ]),
        },
        filename: 'geographic-allocation',
      });
      return;
    }
    return handleExportGeoPdf();
  };

  const handleExportGeoPdf = async () => {
    const { exportToPdf } = await import('@/lib/pdf-export');
    const headers = viewType === 'region'
      ? [t('geographicAllocation.colRegion'), t('geographicAllocation.colHoldings'), t('geographicAllocation.colMarketValue'), t('geographicAllocation.colPortfolioPct')]
      : [t('geographicAllocation.colExchange'), t('geographicAllocation.colCountry'), t('geographicAllocation.colHoldings'), t('geographicAllocation.colMarketValue'), t('geographicAllocation.colPortfolioPct')];
    const rows = viewType === 'region'
      ? regionData.map(item => [
          item.region,
          String(item.count),
          formatCurrencyFull(item.marketValue, defaultCurrency),
          `${item.percentage.toFixed(1)}%`,
        ])
      : exchangeData.map(item => [
          item.exchange,
          item.country,
          String(item.count),
          formatCurrencyFull(item.marketValue, defaultCurrency),
          `${item.percentage.toFixed(1)}%`,
        ]);

    const legendItems = viewType === 'region'
      ? regionData.map((item) => ({
          color: resolvePdfColor(item.color),
          label: `${item.region} - ${formatCurrencyFull(item.marketValue, defaultCurrency)} (${item.percentage.toFixed(1)}%)`,
        }))
      : exchangeData.map((item, idx) => ({
          color: resolvePdfColor(COUNTRY_COLOURS[idx % COUNTRY_COLOURS.length]),
          label: `${item.exchange} - ${formatCurrencyFull(item.marketValue, defaultCurrency)} (${item.percentage.toFixed(1)}%)`,
        }));

    await exportToPdf({
      title: t('page.names.geographic-allocation' as Parameters<typeof t>[0]),
      subtitle: viewType === 'region' ? t('geographicAllocation.viewByRegion') : t('geographicAllocation.viewByExchange'),
      summaryCards: [
        { label: t('geographicAllocation.totalPortfolio'), value: formatCurrency(totalValue, defaultCurrency), color: '#111827' },
        { label: t('geographicAllocation.regions'), value: String(regionData.length), color: '#111827' },
        { label: t('geographicAllocation.exchanges'), value: String(exchangeData.length), color: '#111827' },
        { label: t('geographicAllocation.topRegion'), value: regionData[0]?.region || '-', color: '#111827' },
      ],
      chartContainer: chartRef.current,
      chartLegend: legendItems.length > 0 ? legendItems : undefined,
      tableData: { headers, rows },
      filename: 'geographic-allocation',
    });
  };

  if (error) {
    return <ReportError onRetry={reload} />;
  }

  if (isLoading && response === null) {
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

  if (holdings.length === 0) {
    return (
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-8 text-center">
        <p className="text-gray-500 dark:text-gray-400">
          {t('geographicAllocation.empty')}
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Filters & View Toggle */}
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
          <div className="flex items-center gap-2">
            <button
              onClick={() => setViewType('region')}
              className={`px-3 py-1.5 text-sm font-medium rounded-md transition-colors ${
                viewType === 'region'
                  ? 'bg-blue-600 text-white'
                  : 'bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300'
              }`}
            >
              {t('geographicAllocation.viewByRegion')}
            </button>
            <button
              onClick={() => setViewType('exchange')}
              className={`px-3 py-1.5 text-sm font-medium rounded-md transition-colors ${
                viewType === 'exchange'
                  ? 'bg-blue-600 text-white'
                  : 'bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300'
              }`}
            >
              {t('geographicAllocation.viewByExchange')}
            </button>
            <button
              onClick={() => setViewType('country')}
              className={`px-3 py-1.5 text-sm font-medium rounded-md transition-colors ${
                viewType === 'country'
                  ? 'bg-blue-600 text-white'
                  : 'bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300'
              }`}
            >
              {t('geographicAllocation.viewByCountry')}
            </button>
            <RefreshPricesButton
              onRefreshComplete={() => {
                reload();
                reloadCountry();
              }}
            />
            <ExportDropdown onExportPdf={handleExportPdf} />
          </div>
        </div>
      </div>

      {/* Summary Cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-2 sm:gap-4">
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-3 sm:p-4">
          <p className="text-xs sm:text-sm text-gray-500 dark:text-gray-400">{t('geographicAllocation.totalPortfolio')}</p>
          <p className="text-lg sm:text-xl font-bold text-gray-900 dark:text-gray-100">
            {formatCurrency(totalValue, defaultCurrency)}
          </p>
        </div>
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-3 sm:p-4">
          <p className="text-xs sm:text-sm text-gray-500 dark:text-gray-400">{t('geographicAllocation.regions')}</p>
          <p className="text-lg sm:text-xl font-bold text-gray-900 dark:text-gray-100">
            {regionData.length}
          </p>
        </div>
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-3 sm:p-4">
          <p className="text-xs sm:text-sm text-gray-500 dark:text-gray-400">{t('geographicAllocation.exchanges')}</p>
          <p className="text-lg sm:text-xl font-bold text-gray-900 dark:text-gray-100">
            {exchangeData.length}
          </p>
        </div>
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-3 sm:p-4">
          <p className="text-xs sm:text-sm text-gray-500 dark:text-gray-400">{t('geographicAllocation.topRegion')}</p>
          <p className="text-lg sm:text-xl font-bold text-gray-900 dark:text-gray-100">
            {regionData[0]?.region || '-'}
          </p>
        </div>
      </div>

      {/* Chart */}
      {viewType === 'region' ? (
        <div ref={chartRef} className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-3 sm:p-6">
          <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-4">
            {t('geographicAllocation.regionalAllocation')}
          </h3>
          <div style={{ width: '100%', height: 350 }}>
            <ResponsiveContainer minWidth={0}>
              <PieChart>
                <Pie
                  data={regionData}
                  dataKey="marketValue"
                  nameKey="region"
                  cx="50%"
                  cy="50%"
                  innerRadius={60}
                  outerRadius={120}
                  paddingAngle={2}
                >
                  {regionData.map((entry) => (
                    <Cell key={entry.region} fill={entry.color} />
                  ))}
                </Pie>
                <Tooltip content={<CustomTooltip formatCurrencyFull={(v) => formatCurrencyFull(v, defaultCurrency)} holdingLabel={(count) => t('geographicAllocation.holdingCount', { count })} />} />
                <Legend />
              </PieChart>
            </ResponsiveContainer>
          </div>
        </div>
      ) : viewType === 'exchange' ? (
        <div ref={chartRef} className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-3 sm:p-6">
          <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-4">
            {t('geographicAllocation.exchangeAllocation')}
          </h3>
          <div style={{ width: '100%', height: Math.max(300, exchangeData.length * 40 + 60) }}>
            <ResponsiveContainer minWidth={0}>
              <BarChart
                data={exchangeData}
                layout="vertical"
                margin={{ top: 5, right: 10, left: 0, bottom: 5 }}
              >
                <XAxis
                  type="number"
                  tickFormatter={(v: number) => formatCurrencyAxis(v)}
                  tick={{ fill: 'currentColor', fontSize: 11 }}
                />
                <YAxis
                  type="category"
                  dataKey="exchange"
                  width={100}
                  tick={{ fill: 'currentColor', fontSize: 11 }}
                />
                <Tooltip content={<CustomTooltip formatCurrencyFull={(v) => formatCurrencyFull(v, defaultCurrency)} holdingLabel={(count) => t('geographicAllocation.holdingCount', { count })} />} />
                <Bar dataKey="marketValue" fill={chartColors.primary} radius={[0, 4, 4, 0]}>
                  {exchangeData.map((entry, index) => (
                    <Cell key={entry.exchange} fill={COUNTRY_COLOURS[index % COUNTRY_COLOURS.length]} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>
      ) : (
        <div ref={chartRef} className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-3 sm:p-6">
          <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-4">
            {t('geographicAllocation.countryAllocation')}
          </h3>
          <p className="text-sm text-gray-500 dark:text-gray-400 mb-4">
            {t('geographicAllocation.countryLookThroughNote')}
          </p>
          <div style={{ width: '100%', height: 350 }}>
            <ResponsiveContainer minWidth={0}>
              <PieChart>
                <Pie
                  data={countryData}
                  dataKey="marketValue"
                  nameKey="country"
                  cx="50%"
                  cy="50%"
                  innerRadius={60}
                  outerRadius={120}
                  paddingAngle={2}
                >
                  {countryData.map((entry) => (
                    <Cell key={entry.country} fill={entry.color} />
                  ))}
                </Pie>
                <Tooltip formatter={(value) => formatCurrencyFull(Number(value), defaultCurrency)} />
                <Legend />
              </PieChart>
            </ResponsiveContainer>
          </div>
        </div>
      )}

      {/* Data Table */}
      {viewType === 'country' ? (
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 overflow-hidden">
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-gray-200 dark:divide-gray-700">
              <thead className="bg-gray-50 dark:bg-gray-900/50">
                <tr>
                  <SortableHeader<GeoCountrySortField>
                    field="country"
                    sortField={countrySort.sortField}
                    sortDirection={countrySort.sortDirection}
                    onSort={countrySort.handleSort}
                    className="px-4 py-3 text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider"
                  >
                    {t('geographicAllocation.colCountry')}
                  </SortableHeader>
                  <SortableHeader<GeoCountrySortField>
                    field="marketValue"
                    sortField={countrySort.sortField}
                    sortDirection={countrySort.sortDirection}
                    onSort={countrySort.handleSort}
                    align="right"
                    className="px-4 py-3 text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider"
                  >
                    {t('geographicAllocation.colMarketValue')}
                  </SortableHeader>
                  <SortableHeader<GeoCountrySortField>
                    field="percentage"
                    sortField={countrySort.sortField}
                    sortDirection={countrySort.sortDirection}
                    onSort={countrySort.handleSort}
                    align="right"
                    className="px-4 py-3 text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider"
                  >
                    {t('geographicAllocation.colPortfolioPct')}
                  </SortableHeader>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-200 dark:divide-gray-700">
                {sortedCountryData.map((item) => (
                  <tr key={item.country} className="hover:bg-gray-50 dark:hover:bg-gray-700/50">
                    <td className="px-4 py-3 text-sm font-medium text-gray-900 dark:text-gray-100">
                      <div className="flex items-center gap-2">
                        <div
                          className="w-3 h-3 rounded-full flex-shrink-0"
                          style={{ backgroundColor: item.color }}
                        />
                        {item.country}
                      </div>
                    </td>
                    <td className="px-4 py-3 text-sm text-right font-medium text-gray-900 dark:text-gray-100">
                      {formatCurrencyFull(item.marketValue, defaultCurrency)}
                    </td>
                    <td className="px-4 py-3 text-sm text-right text-gray-600 dark:text-gray-400">
                      {item.percentage.toFixed(1)}%
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot className="bg-gray-50 dark:bg-gray-900/50">
                <tr>
                  <td className="px-4 py-3 text-sm font-bold text-gray-900 dark:text-gray-100">
                    {t('geographicAllocation.total')}
                  </td>
                  <td className="px-4 py-3 text-sm text-right font-bold text-gray-900 dark:text-gray-100">
                    {formatCurrencyFull(countryTotalValue, defaultCurrency)}
                  </td>
                  <td className="px-4 py-3 text-sm text-right font-bold text-gray-900 dark:text-gray-100">
                    100%
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>
        </div>
      ) : (
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-gray-200 dark:divide-gray-700">
            <thead className="bg-gray-50 dark:bg-gray-900/50">
              <tr>
                {viewType === 'region' ? (
                  <SortableHeader<GeoRegionSortField>
                    field="region"
                    sortField={regionSort.sortField}
                    sortDirection={regionSort.sortDirection}
                    onSort={regionSort.handleSort}
                    className="px-4 py-3 text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider"
                  >
                    {t('geographicAllocation.colRegion')}
                  </SortableHeader>
                ) : (
                  <SortableHeader<GeoExchangeSortField>
                    field="exchange"
                    sortField={exchangeSort.sortField}
                    sortDirection={exchangeSort.sortDirection}
                    onSort={exchangeSort.handleSort}
                    className="px-4 py-3 text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider"
                  >
                    {t('geographicAllocation.colExchange')}
                  </SortableHeader>
                )}
                {viewType === 'exchange' && (
                  <SortableHeader<GeoExchangeSortField>
                    field="country"
                    sortField={exchangeSort.sortField}
                    sortDirection={exchangeSort.sortDirection}
                    onSort={exchangeSort.handleSort}
                    className="px-4 py-3 text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider"
                  >
                    {t('geographicAllocation.colCountry')}
                  </SortableHeader>
                )}
                {viewType === 'region' ? (
                  <SortableHeader<GeoRegionSortField>
                    field="count"
                    sortField={regionSort.sortField}
                    sortDirection={regionSort.sortDirection}
                    onSort={regionSort.handleSort}
                    align="right"
                    className="px-4 py-3 text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider"
                  >
                    {t('geographicAllocation.colHoldings')}
                  </SortableHeader>
                ) : (
                  <SortableHeader<GeoExchangeSortField>
                    field="count"
                    sortField={exchangeSort.sortField}
                    sortDirection={exchangeSort.sortDirection}
                    onSort={exchangeSort.handleSort}
                    align="right"
                    className="px-4 py-3 text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider"
                  >
                    {t('geographicAllocation.colHoldings')}
                  </SortableHeader>
                )}
                {viewType === 'region' ? (
                  <SortableHeader<GeoRegionSortField>
                    field="marketValue"
                    sortField={regionSort.sortField}
                    sortDirection={regionSort.sortDirection}
                    onSort={regionSort.handleSort}
                    align="right"
                    className="px-4 py-3 text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider"
                  >
                    {t('geographicAllocation.colMarketValue')}
                  </SortableHeader>
                ) : (
                  <SortableHeader<GeoExchangeSortField>
                    field="marketValue"
                    sortField={exchangeSort.sortField}
                    sortDirection={exchangeSort.sortDirection}
                    onSort={exchangeSort.handleSort}
                    align="right"
                    className="px-4 py-3 text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider"
                  >
                    {t('geographicAllocation.colMarketValue')}
                  </SortableHeader>
                )}
                {viewType === 'region' ? (
                  <SortableHeader<GeoRegionSortField>
                    field="percentage"
                    sortField={regionSort.sortField}
                    sortDirection={regionSort.sortDirection}
                    onSort={regionSort.handleSort}
                    align="right"
                    className="px-4 py-3 text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider"
                  >
                    {t('geographicAllocation.colPortfolioPct')}
                  </SortableHeader>
                ) : (
                  <SortableHeader<GeoExchangeSortField>
                    field="percentage"
                    sortField={exchangeSort.sortField}
                    sortDirection={exchangeSort.sortDirection}
                    onSort={exchangeSort.handleSort}
                    align="right"
                    className="px-4 py-3 text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider"
                  >
                    {t('geographicAllocation.colPortfolioPct')}
                  </SortableHeader>
                )}
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-200 dark:divide-gray-700">
              {viewType === 'region'
                ? sortedRegionData.map((item) => (
                    <tr key={item.region} className="hover:bg-gray-50 dark:hover:bg-gray-700/50">
                      <td className="px-4 py-3 text-sm font-medium text-gray-900 dark:text-gray-100">
                        <div className="flex items-center gap-2">
                          <div
                            className="w-3 h-3 rounded-full flex-shrink-0"
                            style={{ backgroundColor: item.color }}
                          />
                          {item.region}
                        </div>
                      </td>
                      <td className="px-4 py-3 text-sm text-right text-gray-600 dark:text-gray-400">
                        {item.count}
                      </td>
                      <td className="px-4 py-3 text-sm text-right font-medium text-gray-900 dark:text-gray-100">
                        {formatCurrencyFull(item.marketValue, defaultCurrency)}
                      </td>
                      <td className="px-4 py-3 text-sm text-right text-gray-600 dark:text-gray-400">
                        {item.percentage.toFixed(1)}%
                      </td>
                    </tr>
                  ))
                : sortedExchangeData.map((item, idx) => (
                    <tr key={item.exchange} className="hover:bg-gray-50 dark:hover:bg-gray-700/50">
                      <td className="px-4 py-3 text-sm font-medium text-gray-900 dark:text-gray-100">
                        <div className="flex items-center gap-2">
                          <div
                            className="w-3 h-3 rounded-full flex-shrink-0"
                            style={{ backgroundColor: COUNTRY_COLOURS[idx % COUNTRY_COLOURS.length] }}
                          />
                          {item.exchange}
                        </div>
                      </td>
                      <td className="px-4 py-3 text-sm text-gray-600 dark:text-gray-400">
                        {item.country}
                      </td>
                      <td className="px-4 py-3 text-sm text-right text-gray-600 dark:text-gray-400">
                        {item.count}
                      </td>
                      <td className="px-4 py-3 text-sm text-right font-medium text-gray-900 dark:text-gray-100">
                        {formatCurrencyFull(item.marketValue, defaultCurrency)}
                      </td>
                      <td className="px-4 py-3 text-sm text-right text-gray-600 dark:text-gray-400">
                        {item.percentage.toFixed(1)}%
                      </td>
                    </tr>
                  ))}
            </tbody>
            <tfoot className="bg-gray-50 dark:bg-gray-900/50">
              <tr>
                <td className="px-4 py-3 text-sm font-bold text-gray-900 dark:text-gray-100">
                  {t('geographicAllocation.total')}
                </td>
                {viewType === 'exchange' && <td />}
                <td className="px-4 py-3 text-sm text-right font-bold text-gray-900 dark:text-gray-100">
                  {holdings.length}
                </td>
                <td className="px-4 py-3 text-sm text-right font-bold text-gray-900 dark:text-gray-100">
                  {formatCurrencyFull(totalValue, defaultCurrency)}
                </td>
                <td className="px-4 py-3 text-sm text-right font-bold text-gray-900 dark:text-gray-100">
                  100%
                </td>
              </tr>
            </tfoot>
          </table>
        </div>
      </div>
      )}
    </div>
  );
}
