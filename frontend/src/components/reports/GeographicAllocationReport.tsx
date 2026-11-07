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
import { ReportToolbarActions } from '@/components/reports/ReportToolbarActions';
import { ReportAccountMultiSelect } from '@/components/reports/ReportAccountMultiSelect';
import { SortableHeader } from '@/components/ui/SortableHeader';
import { CAPTION_CLASS, CellLabel, PHONE_HEADER_CLASS } from '@/components/ui/Table';
import type {
  SortColumn as TableSortColumn,
  SortColumnsByField as TableSortColumnsByField,
} from '@/components/ui/Table';
import { PartialTotal } from '@/components/ui/PartialTotal';
import { useSortableTable, compareValues } from '@/hooks/useSortableTable';
import { useReportData } from '@/hooks/useReportData';
import { usePersistedAccountFilter } from '@/hooks/usePersistedAccountFilter';
import { ReportError } from '@/components/reports/ReportError';
import { WeightingPartialNote } from '@/components/reports/WeightingPartialNote';
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
import { SEGMENTED_GROUP_CLASS, segmentClass } from '@/components/ui/segmented-control';
import { CHART_TOOLTIP_CLASS } from '@/lib/chart-style';

const logger = createLogger('GeographicAllocationReport');

// Holdings are keyed off the brokerage sub-account, so offer those (the
// sibling cash account is excluded from the picker).
type GeoRegionSortField = 'region' | 'count' | 'marketValue' | 'percentage';
type GeoExchangeSortField = 'exchange' | 'country' | 'count' | 'marketValue' | 'percentage';
type GeoCountrySortField = 'country' | 'marketValue' | 'percentage';

interface CountryRow {
  country: string;
  marketValue: number;
  percentage: number;
  color: string;
}

// One column of a data table, declared once as a record over its sort-field
// union and rendered by BOTH header rows -- the column header row (from `sm` up)
// and the phone sort strip -- so the two can never list different fields, and a
// new union member fails `tsc` rather than stranding a phone with no control for
// it. The `SortColumnsByField` alias ties each key to its entry's own `field`,
// so `count: { field: 'percentage', ... }` is a compile error rather than a
// duplicate React key a label-comparing test cannot see. One record per view,
// because the three views carry different sort fields.
type RegionSortColumn = TableSortColumn<GeoRegionSortField, 'right'>;
type RegionColumns = TableSortColumnsByField<GeoRegionSortField, RegionSortColumn>;
type ExchangeSortColumn = TableSortColumn<GeoExchangeSortField, 'right'>;
type ExchangeColumns = TableSortColumnsByField<GeoExchangeSortField, ExchangeSortColumn>;
type CountrySortColumn = TableSortColumn<GeoCountrySortField, 'right'>;
type CountryColumns = TableSortColumnsByField<GeoCountrySortField, CountrySortColumn>;

// Today's header cell, unchanged (previously inlined at every column header).
const HEADER_CLASS =
  'px-4 py-3 text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider';

// Where each column sits on a phone card, written once per view. Auto-flow would
// place cells by DOM order and silently re-flow the moment a column set changed
// between views, so every cell states its own column and line; the placements
// are inert from `sm` up, where every row is an ordinary table row again.
//
// All three grids are two columns. A REGION row is two lines -- the region and
// its market value (the figure the row is read for) on line 1, the share and
// the holdings count on line 2 -- laid out exactly as the Security Type report's
// four-column card. A COUNTRY row gives its unbounded identity the whole of line
// 1 (only three columns, so there is room) and drops its two figures to line 2.
// An EXCHANGE row is three lines: the exchange and its market value on line 1,
// the exchange's country as a descriptor under the identity beside the share on
// line 2, and the holdings count on line 3.
const REGION_PLACEMENT: Record<GeoRegionSortField, string> = {
  region: 'col-start-1 row-start-1',
  marketValue: 'col-start-2 row-start-1',
  percentage: 'col-start-1 row-start-2',
  count: 'col-start-2 row-start-2',
};
const COUNTRY_PLACEMENT: Record<GeoCountrySortField, string> = {
  country: 'col-start-1 col-span-2 row-start-1',
  marketValue: 'col-start-1 row-start-2',
  percentage: 'col-start-2 row-start-2',
};
const EXCHANGE_PLACEMENT: Record<GeoExchangeSortField, string> = {
  exchange: 'col-start-1 row-start-1',
  marketValue: 'col-start-2 row-start-1',
  country: 'col-start-1 row-start-2',
  percentage: 'col-start-2 row-start-2',
  count: 'col-start-2 row-start-3',
};

// The phone card's row grid, shared by all three views' body and footer rows so
// a placement above means the same track in each. Inert from `sm` up.
const ROW_GRID = 'grid grid-cols-2 items-start gap-x-3 gap-y-1.5 px-4 py-3';

// A figure cell inside a wrapped card: no padding of its own below `sm` (the row
// supplies it and the grid does the spacing), the table cell's own padding from
// `sm` up, smaller type on phones. Every original cell here is `text-sm`, so
// `sm:text-sm` reproduces the desktop cell exactly. `whitespace-nowrap` is the
// one property that is NOT phone-only and the single respect in which the
// `sm`-and-up cell differs from today's: a locale grouping thousands with a
// space could otherwise break a figure in the middle of a number, at any width.
const FIGURE_CELL =
  'p-0 text-right text-xs whitespace-nowrap sm:table-cell sm:px-4 sm:py-3 sm:text-sm';

// A left-aligned text cell (the exchange's country descriptor): reproduces the
// desktop `px-4 py-3 text-sm` from `sm` up, wraps unclamped below it in its
// `minmax(0,1fr)` track so a long country name cannot set the table's width.
const TEXT_CELL =
  'min-w-0 p-0 text-xs break-words sm:table-cell sm:px-4 sm:py-3 sm:text-sm sm:break-normal';

// The identity cell of a data row and of the totals footer, sharing this box in
// every view: the one cell that keeps `text-sm` on phones (a name is prose, and
// the figures' `text-xs` would cost the clamp a character a line). Its placement
// is prepended per view, because the identity column differs between them.
const IDENTITY_CELL = 'min-w-0 p-0 text-sm sm:table-cell sm:px-4 sm:py-3';

// The two header rows every view draws: a phone-only sort strip of compact chips
// (the column header row is hidden below `sm`, so its controls must return
// somewhere a phone can reach) and the ordinary column header row from `sm` up.
// Both are rendered from ONE `columns` list, so they cannot list different
// fields. Generic over the view's sort field, so a control cannot address a
// column the rows do not render.
function SortHeaderRows<F extends string>({
  columns,
  sortField,
  sortDirection,
  onSort,
}: {
  columns: readonly TableSortColumn<F, 'right'>[];
  sortField: F;
  sortDirection: 'asc' | 'desc';
  onSort: (field: F) => void;
}) {
  return (
    <>
      {/* Phone sort strip: the same controls, wrapped and self-naming. The
          border and card background are what say "tappable" -- there is no hover
          on a touch screen. */}
      <tr role="row" className="flex flex-wrap gap-x-2 gap-y-1 px-2 py-2 sm:hidden">
        {columns.map((col) => (
          <SortableHeader<F>
            key={col.field}
            field={col.field}
            sortField={sortField}
            sortDirection={sortDirection}
            onSort={onSort}
            className={PHONE_HEADER_CLASS}
          >
            {col.label}
          </SortableHeader>
        ))}
      </tr>
      <tr role="row" className="hidden sm:table-row">
        {columns.map((col) => (
          <SortableHeader<F>
            key={col.field}
            field={col.field}
            sortField={sortField}
            sortDirection={sortDirection}
            onSort={onSort}
            align={col.align}
            className={HEADER_CLASS}
          >
            {col.label}
          </SortableHeader>
        ))}
      </tr>
    </>
  );
}

function CustomTooltip({ active, payload, formatCurrencyFull, holdingLabel }: {
  active?: boolean;
  payload?: Array<{ payload: RegionAllocation | ExchangeAllocation }>;
  formatCurrencyFull: (v: number) => string;
  holdingLabel: (count: number) => string;
}) {
  const { formatPercent } = useNumberFormat();
  if (!active || !payload?.length) return null;
  const d = payload[0].payload;
  const label = 'region' in d && !('exchange' in d) ? (d as RegionAllocation).region : (d as ExchangeAllocation).exchange;
  return (
    <div className={CHART_TOOLTIP_CLASS}>
      <p className="font-medium text-gray-900 dark:text-gray-100">{label}</p>
      <p className="text-sm text-gray-600 dark:text-gray-400">
        {formatCurrencyFull(d.marketValue)} ({formatPercent(('percentage' in d ? d.percentage : 0), 1)})
      </p>
      <p className="text-sm text-gray-500 dark:text-gray-400">{holdingLabel(d.count)}</p>
    </div>
  );
}

const ACCOUNTS_STORAGE_KEY = 'monize-reports-geographic-allocation-accounts';

export function GeographicAllocationReport() {
  const t = useTranslations('reports');
  const tCommon = useTranslations('common');
  const { formatCurrencyCompact: formatCurrency, formatCurrency: formatCurrencyFull, formatCurrencyAxis, formatPercent } = useNumberFormat();
  const { defaultCurrency, convertToDefault } = useExchangeRates();
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [securities, setSecurities] = useState<Security[]>([]);
  // Persisted so the report opens on the accounts the user last chose.
  const [selectedAccountIds, setSelectedAccountIds] = usePersistedAccountFilter(
    ACCOUNTS_STORAGE_KEY,
    accounts,
  );
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
  const {
    data: countryResp,
    isLoading: countryLoading,
    error: countryError,
    reload: reloadCountry,
  } = useReportData(
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

  const { exchangeData, regionData, totalValue, missingCurrencies, excludedCount } = useMemo(
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
    const total = countryResp.totalPortfolioValue ?? countryResp.knownSubtotal ?? 0;
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

  // `null` until the country request has answered: not a portfolio of zero.
  // While the server withholds the total, the footer shows the known subtotal under
  // its own label; percentages are shares of that subtotal.
  const countryPartial = countryResp?.valuationComplete === false;
  const countryTotalValue = countryResp
    ? (countryResp.totalPortfolioValue ?? countryResp.knownSubtotal ?? null)
    : null;
  // The country view draws from its own request, which the hook keeps the last
  // answer of through a pending or failed reload (another account filter's).
  // While it is either, the view shows that state and the export is off.
  const countryUnavailable = viewType === 'country' && (countryLoading || !!countryError);

  // What the "Total Portfolio" card on screen reads, which is what a PDF under
  // the same caption carries in every view: the holdings total, marked partial
  // when a holding was left out of it.
  const totalPortfolioCardValue = `${formatCurrency(totalValue, defaultCurrency)}${
    excludedCount > 0 ? ` ${tCommon('partialTotal.srSuffix')}` : ''
  }`;

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

  // Exhaustive over each view's sort-field union, so a new field is a compile
  // error rather than a column with no control in either header. Declaration
  // order IS the column (and DOM) order, and it is today's; these labels are
  // also the phone captions, so a value reads under exactly its column header.
  const regionColumns: RegionColumns = {
    region: { field: 'region', label: t('geographicAllocation.colRegion') },
    count: { field: 'count', label: t('geographicAllocation.colHoldings'), align: 'right' },
    marketValue: { field: 'marketValue', label: t('geographicAllocation.colMarketValue'), align: 'right' },
    percentage: { field: 'percentage', label: t('geographicAllocation.colPortfolioPct'), align: 'right' },
  };
  const exchangeColumns: ExchangeColumns = {
    exchange: { field: 'exchange', label: t('geographicAllocation.colExchange') },
    country: { field: 'country', label: t('geographicAllocation.colCountry') },
    count: { field: 'count', label: t('geographicAllocation.colHoldings'), align: 'right' },
    marketValue: { field: 'marketValue', label: t('geographicAllocation.colMarketValue'), align: 'right' },
    percentage: { field: 'percentage', label: t('geographicAllocation.colPortfolioPct'), align: 'right' },
  };
  const countryColumns: CountryColumns = {
    country: { field: 'country', label: t('geographicAllocation.colCountry') },
    marketValue: { field: 'marketValue', label: t('geographicAllocation.colMarketValue'), align: 'right' },
    percentage: { field: 'percentage', label: t('geographicAllocation.colPortfolioPct'), align: 'right' },
  };
  // The column order, rendered by both header rows and matched by the cells' DOM
  // order. DERIVED from each record rather than re-listed: a hand-written list
  // beside an exhaustive record is not itself exhaustive.
  const regionSortColumns: readonly RegionSortColumn[] = Object.values(regionColumns);
  const exchangeSortColumns: readonly ExchangeSortColumn[] = Object.values(exchangeColumns);
  const countrySortColumns: readonly CountrySortColumn[] = Object.values(countryColumns);

  const handleExportPdf = async () => {
    if (viewType === 'country') {
      const { exportToPdf } = await import('@/lib/pdf-export');
      await exportToPdf({
        title: t('page.names.geographic-allocation' as Parameters<typeof t>[0]),
        subtitle: t('geographicAllocation.viewByCountry'),
        summaryCards: [
          { label: t('geographicAllocation.totalPortfolio'), value: totalPortfolioCardValue, color: '#111827' },
        ],
        chartContainer: chartRef.current,
        chartLegend: countryData.map((item) => ({
          color: resolvePdfColor(item.color),
          label: `${item.country} - ${formatCurrencyFull(item.marketValue, defaultCurrency)} (${formatPercent(item.percentage, 1)})`,
        })),
        tableData: {
          headers: [t('geographicAllocation.colCountry'), t('geographicAllocation.colMarketValue'), t('geographicAllocation.colPortfolioPct')],
          rows: sortedCountryData.map((item) => [
            item.country,
            formatCurrencyFull(item.marketValue, defaultCurrency),
            formatPercent(item.percentage, 1),
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
          formatPercent(item.percentage, 1),
        ])
      : exchangeData.map(item => [
          item.exchange,
          item.country,
          String(item.count),
          formatCurrencyFull(item.marketValue, defaultCurrency),
          formatPercent(item.percentage, 1),
        ]);

    const legendItems = viewType === 'region'
      ? regionData.map((item) => ({
          color: resolvePdfColor(item.color),
          label: `${item.region} - ${formatCurrencyFull(item.marketValue, defaultCurrency)} (${formatPercent(item.percentage, 1)})`,
        }))
      : exchangeData.map((item, idx) => ({
          color: resolvePdfColor(COUNTRY_COLOURS[idx % COUNTRY_COLOURS.length]),
          label: `${item.exchange} - ${formatCurrencyFull(item.marketValue, defaultCurrency)} (${formatPercent(item.percentage, 1)})`,
        }));

    await exportToPdf({
      title: t('page.names.geographic-allocation' as Parameters<typeof t>[0]),
      subtitle: viewType === 'region' ? t('geographicAllocation.viewByRegion') : t('geographicAllocation.viewByExchange'),
      summaryCards: [
        {
          label: t('geographicAllocation.totalPortfolio'),
          value: totalPortfolioCardValue,
          color: '#111827',
        },
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
          {/* Full width on a phone, the toolbar's fixed width from `sm` up. */}
          <div className="flex w-full flex-wrap gap-3 items-center sm:w-auto">
            <ReportAccountMultiSelect
              accounts={accounts}
              value={selectedAccountIds}
              onChange={setSelectedAccountIds}
              mode="portfolio"
              className="w-full sm:w-48"
            />
          </div>
          {/* Five controls: they wrap on a phone rather than carrying the
              export off the right of the card. */}
          <div
            className={`${SEGMENTED_GROUP_CLASS} flex-wrap`}
            role="group"
            aria-label={t('reportPage.viewLabel')}
          >
            <button
              type="button"
              onClick={() => setViewType('region')}
              aria-pressed={viewType === 'region'}
              className={segmentClass(viewType === 'region')}
            >
              {t('geographicAllocation.viewByRegion')}
            </button>
            <button
              type="button"
              onClick={() => setViewType('exchange')}
              aria-pressed={viewType === 'exchange'}
              className={segmentClass(viewType === 'exchange')}
            >
              {t('geographicAllocation.viewByExchange')}
            </button>
            <button
              type="button"
              onClick={() => setViewType('country')}
              aria-pressed={viewType === 'country'}
              className={segmentClass(viewType === 'country')}
            >
              {t('geographicAllocation.viewByCountry')}
            </button>
          </div>
          <ReportToolbarActions
            onRefreshComplete={() => {
              reload();
              reloadCountry();
            }}
            onExportPdf={handleExportPdf}
            disabled={isLoading || countryUnavailable}
          />
        </div>
      </div>

      {/* Summary Cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-2 sm:gap-4">
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-3 sm:p-4">
          <p className="text-xs sm:text-sm text-gray-500 dark:text-gray-400">{t('geographicAllocation.totalPortfolio')}</p>
          <p className="text-lg sm:text-xl font-bold text-gray-900 dark:text-gray-100">
            {/* An unpriced or unconvertible holding is left out of this total, so
                mark it a subtotal rather than presenting the smaller figure as
                the whole portfolio. */}
            <PartialTotal
              total={{ value: totalValue, missingCurrencies, excludedCount }}
              displayCurrency={defaultCurrency}
            >
              {formatCurrency(totalValue, defaultCurrency)}
            </PartialTotal>
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
      {countryUnavailable ? (
        countryError ? (
          <ReportError onRetry={reloadCountry} />
        ) : (
          <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-6">
            <div className="space-y-4">
              <Skeleton className="h-8 w-1/3" />
              <Skeleton className="h-64 w-full" />
            </div>
          </div>
        )
      ) : viewType === 'region' ? (
        <div ref={chartRef} className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 px-2 py-4 sm:p-6">
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
        <div ref={chartRef} className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 px-2 py-4 sm:p-6">
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
        <div ref={chartRef} className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 px-2 py-4 sm:p-6">
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

      {/* Data Table

          Below `sm` each table becomes a block and every row wraps into a grid
          card so all its columns fit a phone without a horizontal scroll --
          `REGION_PLACEMENT`, `EXCHANGE_PLACEMENT` and `COUNTRY_PLACEMENT` hold
          where each column lands. Nothing is dropped: every row carries all its
          columns at every width, from `sm` up it is the ordinary table, and the
          sort controls survive as a phone-only header strip because the column
          header row that carries them on desktop is hidden there.

          Two properties of restyling one tree, both deliberate. Changing the
          `display` drops the implicit table semantics below `sm`, so the
          explicit ARIA roles put them back. And the DOM keeps the desktop column
          order while the grid paints the cells out of that order, so a
          screen-reader user hears the column order rather than the painted one
          (the WCAG 1.3.2 tension mechanism A carries); the `CellLabel` captions
          limit the cost, since every value names its own column. */}
      {countryUnavailable ? null : viewType === 'country' ? (
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 overflow-hidden">
          <div className="px-4 pt-3 empty:hidden">
            <WeightingPartialNote result={countryResp} />
          </div>
          <div className="overflow-x-auto">
            <table role="table" className="block min-w-full divide-y divide-gray-200 dark:divide-gray-700 sm:table">
              <thead role="rowgroup" className="block bg-gray-50 dark:bg-gray-900/50 sm:table-header-group">
                <SortHeaderRows
                  columns={countrySortColumns}
                  sortField={countrySort.sortField}
                  sortDirection={countrySort.sortDirection}
                  onSort={countrySort.handleSort}
                />
              </thead>
              <tbody role="rowgroup" className="block divide-y divide-gray-200 dark:divide-gray-700 sm:table-row-group">
                {sortedCountryData.map((item) => (
                  <tr
                    key={item.country}
                    role="row"
                    className={`${ROW_GRID} hover:bg-gray-50 dark:hover:bg-gray-700/50 sm:table-row sm:p-0`}
                  >
                    {/* The country identity spans the whole of line 1, so unlike
                        the region/exchange identities -- which share their line
                        with the market value and clamp for containment and row
                        height -- it wraps UNCLAMPED: a full-width `min-w-0` track
                        contains an unbreakable token through `break-words` alone,
                        the same treatment the Security Type report gives its
                        full-line holding identity. */}
                    <td role="cell" className={`${COUNTRY_PLACEMENT.country} ${IDENTITY_CELL} break-words sm:break-normal font-medium text-gray-900 dark:text-gray-100`}>
                      <div className="flex items-center gap-2">
                        <div
                          className="w-3 h-3 rounded-full flex-shrink-0"
                          style={{ backgroundColor: item.color }}
                        />
                        <span title={item.country}>{item.country}</span>
                      </div>
                    </td>
                    <td role="cell" className={`${COUNTRY_PLACEMENT.marketValue} font-medium text-gray-900 dark:text-gray-100 ${FIGURE_CELL}`}>
                      <CellLabel className={CAPTION_CLASS}>{countryColumns.marketValue.label}</CellLabel>
                      {formatCurrencyFull(item.marketValue, defaultCurrency)}
                    </td>
                    <td role="cell" className={`${COUNTRY_PLACEMENT.percentage} text-gray-600 dark:text-gray-400 ${FIGURE_CELL}`}>
                      <CellLabel className={CAPTION_CLASS}>{countryColumns.percentage.label}</CellLabel>
                      {formatPercent(item.percentage, 1)}
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot role="rowgroup" className="block bg-gray-50 dark:bg-gray-900/50 sm:table-footer-group">
                {/* Every column has a total, so no footer cell hides below `sm`
                    and none owes an `aria-colindex`. */}
                <tr role="row" className={`${ROW_GRID} sm:table-row sm:p-0`}>
                  <td role="cell" className={`${COUNTRY_PLACEMENT.country} ${IDENTITY_CELL} break-words sm:break-normal font-bold text-gray-900 dark:text-gray-100`}>
                    <span title={countryPartial ? t('partialData.knownValue') : t('geographicAllocation.total')}>
                      {countryPartial ? t('partialData.knownValue') : t('geographicAllocation.total')}
                    </span>
                  </td>
                  <td role="cell" className={`${COUNTRY_PLACEMENT.marketValue} font-bold text-gray-900 dark:text-gray-100 ${FIGURE_CELL}`}>
                    <CellLabel className={CAPTION_CLASS}>{countryColumns.marketValue.label}</CellLabel>
                    {/* NOT `totalValue`, and NOT wrapped in `PartialTotal`: this is the
                        server's look-through total, so it reads the server's own
                        `valuationComplete` (the footer label and the note above),
                        never the client conversion's `missingCurrencies`. */}
                    {countryTotalValue === null ? '-' : formatCurrencyFull(countryTotalValue, defaultCurrency)}
                  </td>
                  <td role="cell" className={`${COUNTRY_PLACEMENT.percentage} font-bold text-gray-900 dark:text-gray-100 ${FIGURE_CELL}`}>
                    <CellLabel className={CAPTION_CLASS}>{countryColumns.percentage.label}</CellLabel>
                    100%
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>
        </div>
      ) : viewType === 'region' ? (
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 overflow-hidden">
          <div className="overflow-x-auto">
            <table role="table" className="block min-w-full divide-y divide-gray-200 dark:divide-gray-700 sm:table">
              <thead role="rowgroup" className="block bg-gray-50 dark:bg-gray-900/50 sm:table-header-group">
                <SortHeaderRows
                  columns={regionSortColumns}
                  sortField={regionSort.sortField}
                  sortDirection={regionSort.sortDirection}
                  onSort={regionSort.handleSort}
                />
              </thead>
              <tbody role="rowgroup" className="block divide-y divide-gray-200 dark:divide-gray-700 sm:table-row-group">
                {sortedRegionData.map((item) => (
                  <tr
                    key={item.region}
                    role="row"
                    className={`${ROW_GRID} hover:bg-gray-50 dark:hover:bg-gray-700/50 sm:table-row sm:p-0`}
                  >
                    {/* DOM order stays the desktop column order (region, count,
                        market value, share); the grid only repositions. */}
                    <td role="cell" className={`${REGION_PLACEMENT.region} ${IDENTITY_CELL} font-medium text-gray-900 dark:text-gray-100`}>
                      <div className="flex items-center gap-2">
                        <div
                          className="w-3 h-3 rounded-full flex-shrink-0"
                          style={{ backgroundColor: item.color }}
                        />
                        <span className="line-clamp-3 break-words sm:line-clamp-none sm:break-normal" title={item.region}>{item.region}</span>
                      </div>
                    </td>
                    <td role="cell" className={`${REGION_PLACEMENT.count} text-gray-600 dark:text-gray-400 ${FIGURE_CELL}`}>
                      <CellLabel className={CAPTION_CLASS}>{regionColumns.count.label}</CellLabel>
                      {item.count}
                    </td>
                    <td role="cell" className={`${REGION_PLACEMENT.marketValue} font-medium text-gray-900 dark:text-gray-100 ${FIGURE_CELL}`}>
                      <CellLabel className={CAPTION_CLASS}>{regionColumns.marketValue.label}</CellLabel>
                      {formatCurrencyFull(item.marketValue, defaultCurrency)}
                    </td>
                    <td role="cell" className={`${REGION_PLACEMENT.percentage} text-gray-600 dark:text-gray-400 ${FIGURE_CELL}`}>
                      <CellLabel className={CAPTION_CLASS}>{regionColumns.percentage.label}</CellLabel>
                      {formatPercent(item.percentage, 1)}
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot role="rowgroup" className="block bg-gray-50 dark:bg-gray-900/50 sm:table-footer-group">
                <tr role="row" className={`${ROW_GRID} sm:table-row sm:p-0`}>
                  <td role="cell" className={`${REGION_PLACEMENT.region} ${IDENTITY_CELL} font-bold text-gray-900 dark:text-gray-100`}>
                    <span className="line-clamp-3 break-words sm:line-clamp-none sm:break-normal" title={t('geographicAllocation.total')}>
                      {t('geographicAllocation.total')}
                    </span>
                  </td>
                  <td role="cell" className={`${REGION_PLACEMENT.count} font-bold text-gray-900 dark:text-gray-100 ${FIGURE_CELL}`}>
                    <CellLabel className={CAPTION_CLASS}>{regionColumns.count.label}</CellLabel>
                    {holdings.length}
                  </td>
                  <td role="cell" className={`${REGION_PLACEMENT.marketValue} font-bold text-gray-900 dark:text-gray-100 ${FIGURE_CELL}`}>
                    <CellLabel className={CAPTION_CLASS}>{regionColumns.marketValue.label}</CellLabel>
                    {/* The same `totalValue` the summary card marks, under a
                        header reading "Total": an unpriced or unconvertible
                        holding is left out of it, so it wears the marker here
                        too rather than reading 20,000 directly below a card
                        reading 20,000 with an asterisk. */}
                    <PartialTotal
                      total={{ value: totalValue, missingCurrencies, excludedCount }}
                      displayCurrency={defaultCurrency}
                    >
                      {formatCurrencyFull(totalValue, defaultCurrency)}
                    </PartialTotal>
                  </td>
                  <td role="cell" className={`${REGION_PLACEMENT.percentage} font-bold text-gray-900 dark:text-gray-100 ${FIGURE_CELL}`}>
                    <CellLabel className={CAPTION_CLASS}>{regionColumns.percentage.label}</CellLabel>
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
            <table role="table" className="block min-w-full divide-y divide-gray-200 dark:divide-gray-700 sm:table">
              <thead role="rowgroup" className="block bg-gray-50 dark:bg-gray-900/50 sm:table-header-group">
                <SortHeaderRows
                  columns={exchangeSortColumns}
                  sortField={exchangeSort.sortField}
                  sortDirection={exchangeSort.sortDirection}
                  onSort={exchangeSort.handleSort}
                />
              </thead>
              <tbody role="rowgroup" className="block divide-y divide-gray-200 dark:divide-gray-700 sm:table-row-group">
                {sortedExchangeData.map((item, idx) => (
                  <tr
                    key={item.exchange}
                    role="row"
                    className={`${ROW_GRID} hover:bg-gray-50 dark:hover:bg-gray-700/50 sm:table-row sm:p-0`}
                  >
                    {/* DOM order stays the desktop column order (exchange,
                        country, count, market value, share); the grid only
                        repositions. The country sits under the exchange
                        identity as a descriptor and so carries no caption. */}
                    <td role="cell" className={`${EXCHANGE_PLACEMENT.exchange} ${IDENTITY_CELL} font-medium text-gray-900 dark:text-gray-100`}>
                      <div className="flex items-center gap-2">
                        <div
                          className="w-3 h-3 rounded-full flex-shrink-0"
                          style={{ backgroundColor: COUNTRY_COLOURS[idx % COUNTRY_COLOURS.length] }}
                        />
                        <span className="line-clamp-3 break-words sm:line-clamp-none sm:break-normal" title={item.exchange}>{item.exchange}</span>
                      </div>
                    </td>
                    <td role="cell" className={`${EXCHANGE_PLACEMENT.country} ${TEXT_CELL} text-gray-600 dark:text-gray-400`}>
                      {item.country}
                    </td>
                    <td role="cell" className={`${EXCHANGE_PLACEMENT.count} text-gray-600 dark:text-gray-400 ${FIGURE_CELL}`}>
                      <CellLabel className={CAPTION_CLASS}>{exchangeColumns.count.label}</CellLabel>
                      {item.count}
                    </td>
                    <td role="cell" className={`${EXCHANGE_PLACEMENT.marketValue} font-medium text-gray-900 dark:text-gray-100 ${FIGURE_CELL}`}>
                      <CellLabel className={CAPTION_CLASS}>{exchangeColumns.marketValue.label}</CellLabel>
                      {formatCurrencyFull(item.marketValue, defaultCurrency)}
                    </td>
                    <td role="cell" className={`${EXCHANGE_PLACEMENT.percentage} text-gray-600 dark:text-gray-400 ${FIGURE_CELL}`}>
                      <CellLabel className={CAPTION_CLASS}>{exchangeColumns.percentage.label}</CellLabel>
                      {formatPercent(item.percentage, 1)}
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot role="rowgroup" className="block bg-gray-50 dark:bg-gray-900/50 sm:table-footer-group">
                {/* The country column has no total, so the footer keeps the same
                    empty spacer the desktop table does -- placed on the phone
                    grid, unpadded, and inert at `sm` up so it is byte-identical
                    to today's bare `<td/>` there. It is never hidden below `sm`,
                    so it owes no `aria-colindex`. */}
                <tr role="row" className={`${ROW_GRID} sm:table-row sm:p-0`}>
                  <td role="cell" className={`${EXCHANGE_PLACEMENT.exchange} ${IDENTITY_CELL} font-bold text-gray-900 dark:text-gray-100`}>
                    <span className="line-clamp-3 break-words sm:line-clamp-none sm:break-normal" title={t('geographicAllocation.total')}>
                      {t('geographicAllocation.total')}
                    </span>
                  </td>
                  <td role="cell" className={`${EXCHANGE_PLACEMENT.country} p-0 sm:table-cell`} />
                  <td role="cell" className={`${EXCHANGE_PLACEMENT.count} font-bold text-gray-900 dark:text-gray-100 ${FIGURE_CELL}`}>
                    <CellLabel className={CAPTION_CLASS}>{exchangeColumns.count.label}</CellLabel>
                    {holdings.length}
                  </td>
                  <td role="cell" className={`${EXCHANGE_PLACEMENT.marketValue} font-bold text-gray-900 dark:text-gray-100 ${FIGURE_CELL}`}>
                    <CellLabel className={CAPTION_CLASS}>{exchangeColumns.marketValue.label}</CellLabel>
                    {/* `totalValue` again, so the same marker again -- the two
                        footers and the card report one figure and must agree
                        about whether it is whole. */}
                    <PartialTotal
                      total={{ value: totalValue, missingCurrencies, excludedCount }}
                      displayCurrency={defaultCurrency}
                    >
                      {formatCurrencyFull(totalValue, defaultCurrency)}
                    </PartialTotal>
                  </td>
                  <td role="cell" className={`${EXCHANGE_PLACEMENT.percentage} font-bold text-gray-900 dark:text-gray-100 ${FIGURE_CELL}`}>
                    <CellLabel className={CAPTION_CLASS}>{exchangeColumns.percentage.label}</CellLabel>
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
