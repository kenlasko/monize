'use client';

import { useState, useEffect, useMemo, useRef } from 'react';
import { useTranslations } from 'next-intl';
import { Skeleton } from '@/components/ui/LoadingSkeleton';
import { useReportData } from '@/hooks/useReportData';
import { usePersistedAccountFilter } from '@/hooks/usePersistedAccountFilter';
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
import { chartColors, chartSeriesColor } from '@/lib/chart-colors';
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
import { CellLabel } from '@/components/ui/Table';
import { useSortableTable, compareValues } from '@/hooks/useSortableTable';
import { createLogger } from '@/lib/logger';

const logger = createLogger('SectorWeightingsReport');

// Portfolio-summary reports key holdings off the brokerage sub-account, so the
// account picker offers those (the sibling cash account is excluded).
type SectorSortField = 'sector' | 'direct' | 'etf' | 'total' | 'percentage';

/**
 * One column of the data table. The five are declared once, as a record over
 * the sort field union, and rendered by BOTH header rows -- the column header
 * row (from `sm` up) and the phone sort strip -- so the two can never list
 * different fields, and adding a member to the union fails `tsc` rather than
 * stranding a phone with no control for it.
 */
interface SortColumn {
  field: SectorSortField;
  label: string;
  /** Money and percent columns are right-aligned on desktop. */
  align?: 'right';
}

/**
 * The record the two header rows are built from, keyed by sort field.
 *
 * The key is tied to the entry's own `field`, which a plain
 * `Record<SectorSortField, SortColumn>` does not do: that forces an entry to
 * EXIST for every member of the union but lets it name a different one, so
 * `etf: { field: 'direct', label: colEtfValue }` type-checks. Both header rows
 * would then render two controls keyed `direct` (a duplicate React key),
 * tapping "ETF Value" would sort by Direct Value, and "ETF Value" would be
 * unsortable -- and a test comparing header LABELS cannot see any of it,
 * because the labels stay right. Here it is a compile error instead.
 */
type SortColumnsByField = {
  [K in SectorSortField]: SortColumn & { field: K };
};

// Today's header cell, unchanged.
const HEADER_CLASS =
  'px-4 py-3 text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider';

// The same sort controls in the phone strip: a wrapped row of compact chips.
// Column alignment means nothing there -- the column header row is hidden and
// each data row is a grid -- so every control is left-aligned and self-naming.
// The border and card background are what say "tappable": there is no hover on
// a touch screen, and without them the strip reads as another row of the
// captions the cells below carry.
const PHONE_HEADER_CLASS =
  'rounded border border-gray-200 bg-white px-2 py-1.5 text-xs font-medium text-gray-500 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-400 uppercase';

// Where each column sits on the phone grid, written ONCE. The table has three
// row shapes -- a sector row, the optional unclassified row and the totals
// footer -- and all three place their cells from this record, so a reader
// finds the ETF figure in the same corner of every card. Auto-flow would place
// them by DOM order and silently re-flow the moment a cell became conditional.
// The placements are inert from `sm` up, where every row is a table row again.
//
// The grid is SIX tracks (`ROW_GRID`): line 1 gives the sector and its total
// three each, line 2 gives the direct value, the ETF value and the share two
// each -- three figures on one line, as the maintainer asked after the phone
// review of this branch (`FIGURE_CELL` has the budget that trade is made in).
const CELL_PLACEMENT: Record<SectorSortField, string> = {
  sector: 'col-start-1 col-span-3 row-start-1',
  total: 'col-start-4 col-span-3 row-start-1',
  direct: 'col-start-1 col-span-2 row-start-2',
  etf: 'col-start-3 col-span-2 row-start-2',
  percentage: 'col-start-5 col-span-2 row-start-2',
};

// The row's phone grid, shared by all three row shapes so a placement above
// means the same track in each.
const ROW_GRID = 'grid grid-cols-6 items-start gap-x-3 gap-y-1.5 px-4 py-3';

// A figure cell inside a wrapped card: no padding of its own below `sm` (the
// row supplies it and the grid does the spacing), the table cell's own padding
// from `sm` up. Smaller type on phones. The colour stays on each cell, because
// the direct, ETF, total and share cells are each coloured differently, and
// the unclassified row dims all four.
//
// `whitespace-nowrap` is the one property here that is NOT phone-only, and it
// is the single respect in which the `sm`-and-up cell differs from today's: a
// locale that groups thousands with a space could otherwise break a figure in
// the middle of a number, at any width.
//
// `FIGURE_CELL` width budget, measured on a hand-written CSS replica in Chromium
// at the insets this table really gets -- the report page's `px-4` and the
// row's own `px-4`, the card contributing none -- so 256px of track at 320px
// and 326px at 390px. The six-track row (`ROW_GRID`, placed by
// `CELL_PLACEMENT`) gives the total on line 1 three tracks -- 122px at 320px
// and 157px at 390px, the same as an equal pair -- and each of the three
// figures on line 2 two tracks: 77px at 320px and 101px at 390px.
//
// The formatter is the 2dp `formatCurrencyFull`, not the compact one the
// summary cards use. The unit is part of the budget and is not always a
// symbol: `narrowSymbol` falls back to the three-letter ISO code where a
// currency has none, so the widest unit is `CHF`. The budget is measured
// against the FOOTER's totals, which are by construction larger than any row
// value and wear `font-bold` on top of it: bold at `text-xs`, `123 456,78
// CHF` is 107px and `2 913 579,10 CHF` is 119px. On line 1 that means six and
// seven figures fit at 320px and eight (128px) is the first to pass. On line
// 2 a 77px track holds a five-figure symbol amount (`$12,345.00` is about
// 65px, bold about 72px) and not a six-figure one: three of them need 3 x 97
// + 2 x 12 = 315px against 256px at 320px, and the bold footer's six-figure
// ISO-code direct or ETF total overflows its track by about 30px there,
// reopening the wrapper's sideways scroll; at 390px the 101px track holds a
// six-figure symbol amount and a bold `123 456,78 CHF` passes it by 6px.
//
// Three figures on one line is the maintainer's call from the phone review of
// this branch, made knowing that budget: the common case fits, and a
// six-figure sleeve in an ISO-code currency scrolls at 320px. The overflow is
// a deliberate choice rather than an oversight, because the alternatives are
// worse: right alignment is not a containment device (a nowrap figure longer
// than its track overflows past the END edge whatever `text-align` says),
// `overflow-hidden` would silently cut a figure, and dropping
// `whitespace-nowrap` would let a locale that groups thousands with a space
// break a number in half. A cut or broken figure is worse than a scroll.
const FIGURE_CELL =
  'p-0 text-right text-xs whitespace-nowrap sm:table-cell sm:px-4 sm:py-3 sm:text-sm';

/**
 * The identity cell: the same box in all three row shapes, and the one cell
 * that keeps `text-sm` on phones -- a sector name is prose, and stepping it
 * down to the figures' `text-xs` would cost the clamp a character a line.
 */
const IDENTITY_CELL =
  `${CELL_PLACEMENT.sector} min-w-0 p-0 text-sm sm:table-cell sm:px-4 sm:py-3`;

/** Every caption in a wrapped cell is phone-only. */
const CAPTION_CLASS = 'sm:hidden';

function CustomTooltip({ active, payload, formatCurrencyFull, defaultCurrency, labelDirect, labelEtf, labelTotal }: {
  active?: boolean;
  payload?: Array<{ payload: { sector: string; direct: number; etf: number; total: number; percentage: number } }>;
  formatCurrencyFull: (v: number, c: string) => string;
  defaultCurrency: string;
  labelDirect: string;
  labelEtf: string;
  labelTotal: string;
}) {
  const { formatPercent } = useNumberFormat();
  if (!active || !payload?.length) return null;
  const d = payload[0].payload;
  return (
    <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg shadow-lg p-3">
      <p className="font-medium text-gray-900 dark:text-gray-100">{d.sector} ({formatPercent(d.percentage, 1)})</p>
      {d.direct > 0 && (
        <p className="text-sm text-blue-600 dark:text-blue-400">{labelDirect.replace('{amount}', formatCurrencyFull(d.direct, defaultCurrency))}</p>
      )}
      {d.etf > 0 && (
        <p className="text-sm text-green-600 dark:text-green-400">{labelEtf.replace('{amount}', formatCurrencyFull(d.etf, defaultCurrency))}</p>
      )}
      <p className="text-sm font-medium text-gray-900 dark:text-gray-100 mt-1">{labelTotal.replace('{amount}', formatCurrencyFull(d.total, defaultCurrency))}</p>
    </div>
  );
}

const ACCOUNTS_STORAGE_KEY = 'monize-reports-sector-weightings-accounts';

export function SectorWeightingsReport() {
  const t = useTranslations('reports');
  const { formatCurrencyCompact: formatCurrency, formatCurrency: formatCurrencyFull, formatPercent } = useNumberFormat();
  const { defaultCurrency } = useExchangeRates();
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [securities, setSecurities] = useState<Security[]>([]);
  // Persisted so the report opens on the accounts the user last chose.
  const [selectedAccountIds, setSelectedAccountIds] = usePersistedAccountFilter(
    ACCOUNTS_STORAGE_KEY,
    accounts,
  );
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

  // Exhaustive over the sort field union, so a new field is a compile error
  // rather than a column with no control in either header -- and each entry
  // must name its own key (see `SortColumnsByField`). These are also the phone
  // captions, so a value reads under exactly the label its column header uses.
  const columns: SortColumnsByField = {
    sector: { field: 'sector', label: t('sectorWeightings.colSector') },
    direct: { field: 'direct', label: t('sectorWeightings.colDirectValue'), align: 'right' },
    etf: { field: 'etf', label: t('sectorWeightings.colEtfValue'), align: 'right' },
    total: { field: 'total', label: t('sectorWeightings.colTotalValue'), align: 'right' },
    percentage: { field: 'percentage', label: t('sectorWeightings.colPortfolioPct'), align: 'right' },
  };

  // The column order, rendered by BOTH header rows and matched by the cells'
  // DOM order. DERIVED from the record rather than re-listed: a hand-written
  // list beside an exhaustive record is not exhaustive, so a field added to
  // the union would compile (the record forces an entry) and still ship with
  // no sort control in either header -- exactly the stranding the record
  // exists to prevent. The record's declaration order IS the column order, and
  // it is today's: sector, direct, ETF, total, share. Where a card PLACES each
  // of them is `CELL_PLACEMENT`, deliberately a separate decision.
  const sortColumns: readonly SortColumn[] = Object.values(columns);

  const handleExportPdf = async () => {
    const { exportToPdf } = await import('@/lib/pdf-export');
    // The PDF keeps its own `pdfCol*` keys rather than reading `sortColumns`.
    // They are a duplicate of the `col*` set the table uses (identical in all
    // 23 locales today), and switching the export onto the table's record
    // would change which catalog keys a shipped export reads -- a behaviour
    // change with no layout in it. Logged as a follow-up instead.
    const headers = [
      t('sectorWeightings.pdfColSector'),
      t('sectorWeightings.pdfColDirectValue'),
      t('sectorWeightings.pdfColEtfValue'),
      t('sectorWeightings.pdfColTotalValue'),
      t('sectorWeightings.pdfColPortfolioPct'),
    ];
    const rows = data ? data.items.map(item => [
      item.sector,
      formatCurrencyFull(item.directValue, defaultCurrency),
      formatCurrencyFull(item.etfValue, defaultCurrency),
      formatCurrencyFull(item.totalValue, defaultCurrency),
      formatPercent(item.percentage, 1),
    ]) : [];
    const accountLabel = selectedAccountIds.length > 0
      ? accounts.filter((a) => selectedAccountIds.includes(a.id)).map((a) => a.name).join(', ')
      : t('sectorWeightings.pdfAllAccounts');
    await exportToPdf({
      title: t('sectorWeightings.pdfTitle'),
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
          {t('sectorWeightings.noData')}
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
    color: chartSeriesColor(idx),
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
              mode="portfolio"
            />

            {/* Security Filter */}
            <div className="w-48">
              <MultiSelect
                ariaLabel={t('sectorWeightings.filterBySecurityLabel')}
                placeholder={t('sectorWeightings.allSecuritiesPlaceholder')}
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
                {t('sectorWeightings.clearFilters')}
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
          <p className="text-xs sm:text-sm text-gray-500 dark:text-gray-400">{t('sectorWeightings.totalPortfolio')}</p>
          <p className="text-lg sm:text-xl font-bold text-gray-900 dark:text-gray-100">
            {formatCurrency(data.totalPortfolioValue, defaultCurrency)}
          </p>
        </div>
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-3 sm:p-4">
          <p className="text-xs sm:text-sm text-gray-500 dark:text-gray-400">{t('sectorWeightings.directExposure')}</p>
          <p className="text-lg sm:text-xl font-bold text-blue-600 dark:text-blue-400">
            {formatCurrency(data.totalDirectValue, defaultCurrency)}
          </p>
        </div>
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-3 sm:p-4">
          <p className="text-xs sm:text-sm text-gray-500 dark:text-gray-400">{t('sectorWeightings.etfExposure')}</p>
          <p className="text-lg sm:text-xl font-bold text-green-600 dark:text-green-400">
            {formatCurrency(data.totalEtfValue, defaultCurrency)}
          </p>
        </div>
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-3 sm:p-4">
          <p className="text-xs sm:text-sm text-gray-500 dark:text-gray-400">{t('sectorWeightings.sectors')}</p>
          <p className="text-lg sm:text-xl font-bold text-gray-900 dark:text-gray-100">
            {data.items.length}
          </p>
        </div>
      </div>

      {/* Stacked Bar Chart */}
      <div ref={chartRef} className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-3 sm:p-6">
        <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-4">
          {t('sectorWeightings.sectorAllocation')}
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
              <Tooltip content={<CustomTooltip formatCurrencyFull={formatCurrencyFull} defaultCurrency={defaultCurrency} labelDirect={t.raw('sectorWeightings.tooltipDirect') as string} labelEtf={t.raw('sectorWeightings.tooltipEtf') as string} labelTotal={t.raw('sectorWeightings.tooltipTotal') as string} />} />
              <Legend
                formatter={(value: string) =>
                  value === 'direct' ? t('sectorWeightings.viewDirect') : t('sectorWeightings.viewEtf')
                }
              />
              <Bar dataKey="direct" stackId="a" fill={chartColors.primary} name="direct" />
              <Bar dataKey="etf" stackId="a" fill={chartColors.income} name="etf" radius={[0, 4, 4, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>

      {/* Data Table

          Below `sm` the table becomes a block and each row wraps into a
          six-track grid so all five columns fit a phone without a horizontal
          scroll, on two lines: the sector and its total -- the figure the
          row is read for -- share line 1, three tracks each; the direct
          value, the ETF value and the portfolio share share line 2, two
          tracks each. Two lines rather than three is the maintainer's call
          from the phone review of this branch, made against the measurement
          `FIGURE_CELL` records: five-figure amounts fit a 77px track at
          320px, and a six-figure ISO-code sleeve overflows it there (and a
          bold one by 6px at 390px). Nothing is dropped -- the card
          carries all five columns, the unclassified row included -- and the
          rows stay what they are today: hovering, but NOT clickable. From `sm`
          up it is the ordinary table. The sort controls survive as their own
          phone-only header row, because the column header row that carries
          them on desktop is hidden there.

          Measured before and after on a hand-written CSS replica in Chromium,
          at this table's real insets (the report page's `px-4`; the card adds
          none of its own): today the table is 664px wide in `pl`, 692px in
          `ru` and 585px in the pseudo-locale, inside a 288px wrapper at 320px
          and a 358px one at 390px -- a sideways scroll in every locale at both
          widths. Wrapped, the wrapper's `scrollWidth` equals its `clientWidth`
          at both widths in `pl`, `ru`, `id`, `de` and `xx`, with no cell
          overflowing its track.

          Two properties of restyling one tree, both deliberate. Changing the
          `display` would drop the implicit table semantics below `sm`, so the
          explicit ARIA roles below put them back -- the phone sort strip is
          the header row a phone reader gets, and its five controls sit in the
          data cells' own DOM order, so the column association survives there.
          Every row here exposes all five cells at every width (none is dropped
          below `sm`), so no row needs an `aria-colindex` to say which column a
          cell belongs to. The `CellLabel` captions are therefore REDUNDANT
          with that association rather than a substitute for it, and
          deliberately so: the grid places the cells out of DOM order visually,
          so a sighted phone reader has no header row to look up and needs the
          name beside the value.

          The second is an ACCEPTED, UNMITIGATED trade-off, and the roles are
          not what answers it: they restore the table semantics, and have no
          effect on reading order. The DOM keeps the desktop column order
          (sector, direct, ETF, total, share) while the grid shows the total
          second, so a screen-reader user hears the headline figure fourth --
          the WCAG 1.3.2 tension mechanism A carries. What limits the cost is
          the captions: every value names its own column, so each one is
          self-describing in whatever order it is heard. Both are properties of
          the mechanism, not of this table. */}
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 overflow-hidden">
        <div className="overflow-x-auto">
          {/* Explicit roles: restyling `display` below `sm` strips the implicit
              table semantics, and these put them back (inert from `sm` up). */}
          <table role="table" className="block min-w-full divide-y divide-gray-200 dark:divide-gray-700 sm:table">
            <thead role="rowgroup" className="block bg-gray-50 dark:bg-gray-900/50 sm:table-header-group">
              {/* Phone sort strip: the same five controls, wrapped. */}
              <tr role="row" className="flex flex-wrap gap-x-2 gap-y-1 px-2 py-2 sm:hidden">
                {sortColumns.map((col) => (
                  <SortableHeader<SectorSortField>
                    key={col.field}
                    field={col.field}
                    sortField={sortField}
                    sortDirection={sortDirection}
                    onSort={handleSort}
                    className={PHONE_HEADER_CLASS}
                  >
                    {col.label}
                  </SortableHeader>
                ))}
              </tr>
              <tr role="row" className="hidden sm:table-row">
                {sortColumns.map((col) => (
                  <SortableHeader<SectorSortField>
                    key={col.field}
                    field={col.field}
                    sortField={sortField}
                    sortDirection={sortDirection}
                    onSort={handleSort}
                    align={col.align}
                    className={HEADER_CLASS}
                  >
                    {col.label}
                  </SortableHeader>
                ))}
              </tr>
            </thead>
            <tbody role="rowgroup" className="block divide-y divide-gray-200 dark:divide-gray-700 sm:table-row-group">
              {sortedItems.map((item) => {
                const idx = data.items.indexOf(item);
                return (
                <tr
                  key={item.sector}
                  role="row"
                  className={`${ROW_GRID} hover:bg-gray-50 dark:hover:bg-gray-700/50 sm:table-row sm:p-0`}
                >
                  {/* The identity. A sector name is UNBOUNDED -- "Consumer
                      Discretionary" is 22 characters in English and its
                      Russian GICS name is 46 -- so it sits in a
                      `minmax(0,1fr)` track with `min-w-0`: a track that may be
                      zero lets the name shrink, where a flex item's `min-w-0`
                      still contributes the full width of its text to the row's
                      minimum. The tier cell WRAPS the name today, so the card
                      clamps rather than truncates (a `truncate` would be a
                      regression), and `sm:line-clamp-none` hands the wrap back
                      from `sm` up. Measured rendered identity track: 122px at
                      320px and 157px at 390px, of which the name box is 102px
                      and 137px (the dot and its gap take 20px).

                      THREE lines, not two, and that is measured against two
                      realistic sector names that share a prefix: at a 102px
                      name box a two-line clamp shows 22 characters, and
                      "Потребительские товары длительного пользования" and
                      "Потребительские товары повседневного спроса" BOTH render
                      as "Потребительские товары" -- two different sectors,
                      indistinguishable. Three lines show 34 and 36 characters,
                      which diverge at character 24. (Four would show both
                      whole, at 20px of row height on every long-named row; the
                      invariant is telling two realistic names apart, and three
                      lines meets it.) Containment is unaffected either way -- a
                      wrapping box contributes no minimum width.

                      `break-words` is what the 320px screenshot asked for and
                      the measurements could not see: the Russian name's first
                      word is 15 characters and does not fit the 102px name
                      box, so without it the word overflowed the clamp's
                      `overflow: hidden` and was cut mid-glyph with no ellipsis
                      -- invisible clipping, which every width and overflow
                      number reported as fine. Broken, the same three lines
                      read "Потребитель / ские товары / длительног...", and the
                      ellipsis is where the clamp actually bites. It is scoped
                      to phones (`sm:break-normal` restores today's `normal`
                      pair, which is also the initial value) because from `sm`
                      up the name box is 208px and the word fits.

                      The clamp is load-bearing for containment as well as for
                      length, and the two are easy to separate by accident.
                      This span is a row-direction flex item WITHOUT its own
                      `min-w-0`, so its automatic minimum size would normally
                      be its min-content width -- the unbroken 15-character
                      word, which `break-words` does not shrink. What zeroes
                      that minimum is `line-clamp-3`'s own `overflow: hidden`.
                      Replacing the clamp with any treatment that does not
                      clip (a plain three-line box, `sm:line-clamp-none` leaking
                      down) reopens the 320px overflow, so the two travel
                      together.

                      `title` is therefore NOT the phone's fallback -- it is
                      for the one width where the clamp bites and a pointer
                      exists, a mouse-driven window under 640px. From `sm` up
                      the name wraps in full and the tooltip only repeats what
                      is on screen.

                      The colour dot keeps its index exactly as it is -- the
                      row's position in the UNSORTED `data.items` -- so a
                      sector's swatch is the same whichever way the table is
                      sorted. It is NOT a key to the chart above, which is a
                      stacked bar coloured by SERIES (direct vs ETF) with no
                      per-sector fill; `chartData[].color` is built and never
                      read. Two consequences, both pre-existing and both
                      deliberately unchanged here: the dot is a stable
                      per-sector swatch and nothing more, and because
                      `--chart-1`/`--chart-2` are the same values as
                      `--chart-primary`/`--chart-income`, the first two rows'
                      dots happen to match the two series fills. Logged as a
                      follow-up (`chartSeriesColorAsidePrimary` is the helper
                      that answers it); a layout mode does not re-decide a
                      colour. */}
                  <td role="cell" className={`${IDENTITY_CELL} font-medium text-gray-900 dark:text-gray-100`}>
                    <div className="flex items-center gap-2">
                      <div
                        className="w-3 h-3 rounded-full flex-shrink-0"
                        style={{ backgroundColor: chartSeriesColor(idx) }}
                      />
                      <span className="line-clamp-3 break-words sm:line-clamp-none sm:break-normal" title={item.sector}>{item.sector}</span>
                    </div>
                  </td>
                  <td role="cell" className={`${CELL_PLACEMENT.direct} text-blue-600 dark:text-blue-400 ${FIGURE_CELL}`}>
                    <CellLabel className={CAPTION_CLASS}>{columns.direct.label}</CellLabel>
                    {formatCurrencyFull(item.directValue, defaultCurrency)}
                  </td>
                  <td role="cell" className={`${CELL_PLACEMENT.etf} text-green-600 dark:text-green-400 ${FIGURE_CELL}`}>
                    <CellLabel className={CAPTION_CLASS}>{columns.etf.label}</CellLabel>
                    {formatCurrencyFull(item.etfValue, defaultCurrency)}
                  </td>
                  {/* The total is the headline: it takes the right of line 1
                      beside the sector, because it is what the row is read
                      for. */}
                  <td role="cell" className={`${CELL_PLACEMENT.total} font-medium text-gray-900 dark:text-gray-100 ${FIGURE_CELL}`}>
                    <CellLabel className={CAPTION_CLASS}>{columns.total.label}</CellLabel>
                    {formatCurrencyFull(item.totalValue, defaultCurrency)}
                  </td>
                  {/* The share ends line 2 beside the ETF value, under the
                      right edge of the total it is a share OF. Its value is
                      bounded (`100.0%`) but its CAPTION is not -- `[XX-% of
                      Portfolio-XX]` is 22 characters -- so it takes the same
                      two-track width as the figures rather than an `auto`
                      track sized by that caption; the caption wraps. */}
                  <td role="cell" className={`${CELL_PLACEMENT.percentage} text-gray-600 dark:text-gray-400 ${FIGURE_CELL}`}>
                    <CellLabel className={CAPTION_CLASS}>{columns.percentage.label}</CellLabel>
                    {formatPercent(item.percentage, 1)}
                  </td>
                </tr>
                );
              })}
              {data.unclassifiedValue > 0 && (
                /* The unclassified row is a sector row whose sector is not
                   known, so it wraps with the data row's placement verbatim,
                   keeping its italic label and its tint. The em dashes in the
                   direct and ETF cells stay exactly what they are -- the
                   marker for "this row has no such figure", never a formatted
                   zero -- and they are captioned like any other value, because
                   a bare dash under no heading says nothing at all on a phone
                   where the column header is gone. */
                <tr
                  role="row"
                  className={`${ROW_GRID} hover:bg-gray-50 dark:hover:bg-gray-700/50 bg-gray-50/50 dark:bg-gray-900/20 sm:table-row sm:p-0`}
                >
                  <td role="cell" className={`${IDENTITY_CELL} font-medium text-gray-500 dark:text-gray-400 italic`}>
                    <span className="line-clamp-3 break-words sm:line-clamp-none sm:break-normal" title={t('sectorWeightings.unclassified')}>
                      {t('sectorWeightings.unclassified')}
                    </span>
                  </td>
                  <td role="cell" className={`${CELL_PLACEMENT.direct} text-gray-500 dark:text-gray-400 ${FIGURE_CELL}`}>
                    <CellLabel className={CAPTION_CLASS}>{columns.direct.label}</CellLabel>
                    —
                  </td>
                  <td role="cell" className={`${CELL_PLACEMENT.etf} text-gray-500 dark:text-gray-400 ${FIGURE_CELL}`}>
                    <CellLabel className={CAPTION_CLASS}>{columns.etf.label}</CellLabel>
                    —
                  </td>
                  <td role="cell" className={`${CELL_PLACEMENT.total} font-medium text-gray-500 dark:text-gray-400 ${FIGURE_CELL}`}>
                    <CellLabel className={CAPTION_CLASS}>{columns.total.label}</CellLabel>
                    {formatCurrencyFull(data.unclassifiedValue, defaultCurrency)}
                  </td>
                  <td role="cell" className={`${CELL_PLACEMENT.percentage} text-gray-500 dark:text-gray-400 ${FIGURE_CELL}`}>
                    <CellLabel className={CAPTION_CLASS}>{columns.percentage.label}</CellLabel>
                    {formatPercent(
                      data.totalPortfolioValue > 0
                        ? (data.unclassifiedValue / data.totalPortfolioValue) * 100
                        : 0,
                      1,
                    )}
                  </td>
                </tr>
              )}
            </tbody>
            <tfoot role="rowgroup" className="block bg-gray-50 dark:bg-gray-900/50 sm:table-footer-group">
              {/* The totals are the largest figures on the table, so this row
                  wraps exactly the way a data row does -- the same six tracks
                  and the same placement, each figure captioned -- with "Total"
                  standing in for the sector in the identity track. Every one
                  of the five columns has a total, so no cell leaves the DOM
                  below `sm` and the footer stays a full five-cell row at every
                  width. */}
              <tr role="row" className={`${ROW_GRID} sm:table-row sm:p-0`}>
                <td role="cell" className={`${IDENTITY_CELL} font-bold text-gray-900 dark:text-gray-100`}>
                  {/* The same clamped span the other two shapes use, not a bare
                      label: today's footer labels are short in every locale,
                      but the identity track's containment argument IS the
                      clamp's `overflow: hidden` (see the sector row), so a
                      cell left outside it is one long token away from
                      reopening the sideways scroll -- and nothing would show
                      it until a locale grew one. */}
                  <span className="line-clamp-3 break-words sm:line-clamp-none sm:break-normal" title={t('sectorWeightings.total')}>
                    {t('sectorWeightings.total')}
                  </span>
                </td>
                <td role="cell" className={`${CELL_PLACEMENT.direct} font-bold text-blue-600 dark:text-blue-400 ${FIGURE_CELL}`}>
                  <CellLabel className={CAPTION_CLASS}>{columns.direct.label}</CellLabel>
                  {formatCurrencyFull(data.totalDirectValue, defaultCurrency)}
                </td>
                <td role="cell" className={`${CELL_PLACEMENT.etf} font-bold text-green-600 dark:text-green-400 ${FIGURE_CELL}`}>
                  <CellLabel className={CAPTION_CLASS}>{columns.etf.label}</CellLabel>
                  {formatCurrencyFull(data.totalEtfValue, defaultCurrency)}
                </td>
                <td role="cell" className={`${CELL_PLACEMENT.total} font-bold text-gray-900 dark:text-gray-100 ${FIGURE_CELL}`}>
                  <CellLabel className={CAPTION_CLASS}>{columns.total.label}</CellLabel>
                  {formatCurrencyFull(data.totalPortfolioValue, defaultCurrency)}
                </td>
                <td role="cell" className={`${CELL_PLACEMENT.percentage} font-bold text-gray-900 dark:text-gray-100 ${FIGURE_CELL}`}>
                  <CellLabel className={CAPTION_CLASS}>{columns.percentage.label}</CellLabel>
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
