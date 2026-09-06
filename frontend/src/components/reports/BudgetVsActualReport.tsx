'use client';

import { useState, useMemo, useRef } from 'react';
import { Skeleton } from '@/components/ui/LoadingSkeleton';
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
  LineChart,
  Line,
} from 'recharts';
import { budgetsApi } from '@/lib/budgets';
import type { BudgetTrendPoint, CategoryTrendSeries } from '@/types/budget';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import { useTranslations } from 'next-intl';
import { useReportData } from '@/hooks/useReportData';
import { BudgetCategoryTrend } from '@/components/budgets/BudgetCategoryTrend';
import { ExportDropdown } from '@/components/ui/ExportDropdown';
import { ReportError } from '@/components/reports/ReportError';
import { SortableHeader } from '@/components/ui/SortableHeader';
import { CellLabel } from '@/components/ui/Table';
import { useSortableTable, compareValues } from '@/hooks/useSortableTable';
import { chartColors } from '@/lib/chart-colors';

type BudgetTrendSortField = 'month' | 'budgeted' | 'actual' | 'variance' | 'percentUsed';

/**
 * One sortable column of the summary table. The five are declared once and
 * rendered by BOTH header rows -- the column header row (from `sm` up) and the
 * phone sort strip -- so the two can never list different fields.
 */
interface SortColumn {
  field: BudgetTrendSortField;
  label: string;
  /**
   * This column's cell, as text. The PDF export builds its headings AND its
   * row cells from the same ordered record the table renders, so the export
   * cannot drift from the screen it exports -- reordering the record moves the
   * two together, where a hand-listed export would keep the old order under
   * the new headings.
   */
  value: (point: BudgetTrendPoint) => string;
  /** Money and percent columns are right-aligned in the column header row. */
  align?: 'right';
  /**
   * The last column carries no right padding, exactly as it does today. This
   * flag is the ONE place that is decided: the header cell and the body cell
   * both read it (`headerClass` / `cellPadding`), so reordering the list
   * cannot leave the two disagreeing about which column drops its `pr-4`.
   */
  last?: boolean;
}

/**
 * The record the two header rows are built from, keyed by sort field.
 *
 * The key is tied to the entry's own `field`, which a plain
 * `Record<BudgetTrendSortField, SortColumn>` does not do: that forces an entry
 * to EXIST for every member of the union but lets it name a different one, so
 * `actual: { field: 'budgeted', ... }` would type-check. Both header rows
 * would then render two controls keyed `budgeted` (a duplicate React key),
 * tapping "Actual" would sort by Budgeted, and "Actual" would be unsortable --
 * none of which a test comparing header LABELS can see, because the labels
 * stay right. Here it is a compile error instead.
 */
type SortColumnsByField = {
  [K in BudgetTrendSortField]: SortColumn & { field: K };
};

// An over-budget variance is prefixed; nothing else is. Written once because
// the wrapped cell, the desktop cell and the PDF export all state it.
const varianceSign = (point: BudgetTrendPoint) => (point.variance > 0 ? '+' : '');

// Today's header cell, unchanged.
const headerClass = (col: SortColumn) =>
  col.last
    ? 'py-2 font-medium text-gray-500 dark:text-gray-400'
    : 'py-2 pr-4 font-medium text-gray-500 dark:text-gray-400';

// Today's body cell padding, restored from `sm` up and absent below it (the
// wrapped row supplies the vertical inset and the grid does the spacing).
const cellPadding = (col: SortColumn) => (col.last ? 'sm:py-2' : 'sm:py-2 sm:pr-4');

// The same sort controls in the phone strip: a wrapped row of compact chips.
// Column alignment means nothing there -- the column header row is hidden and
// each data row is a grid -- so every control is left-aligned and self-naming.
// The border is what says "tappable" here: there is no hover on a touch screen,
// and the strip sits directly on the card, whose background this already is --
// so the border is the whole of the affordance. (The class is kept identical to
// the sibling report tables that ship this strip; the copies are one of the
// duplications the converted-table consolidation pass folds into one home.)
const PHONE_HEADER_CLASS =
  'rounded border border-gray-200 bg-white px-2 py-1.5 text-xs font-medium text-gray-500 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-400 uppercase';

// A money (or percent) cell inside a wrapped row: no padding of its own below
// `sm` and this table's own from `sm` up, which each cell adds through
// `cellPadding` so "which column is last" stays decided in one place. Smaller
// type on phones so a seven-figure amount still fits a third of the width.
//
// `whitespace-nowrap` is the one property here that is NOT phone-only, and it
// is deliberate: `formatCurrencyCompact` groups thousands, and a locale that
// groups them with a space (`1 234 567 zł`) could otherwise break a figure in
// the middle at any width -- so the ban holds above `sm` too. That is the
// single respect in which the desktop cell differs from today's.
//
// The budget was measured on a hand-written CSS replica in Chromium, at the
// insets this table really gets on a phone (the report page's `px-4` plus this
// card's `px-2`): 272px of content at 320px and 342px at 390px.
//
// The two money tracks are `minmax(0,1fr)` beside an `auto` identity track,
// NOT three equal thirds, and that is what makes the figures fit. The month is
// the only bounded thing in the row -- the server sends a three-letter English
// month and a four-digit year (`formatPeriodMonth`) -- and its cell carries no
// caption, so an `auto` track costs it the 61px it actually uses instead of a
// third of the width, and hands the difference to the figures. The resolved
// tracks, read off `getComputedStyle` rather than divided out: 61/93/93 at
// 320px and 61/128/128 at 390px, against 83 and 106 on three equal thirds.
//
// Those figures are the SAME in every locale, including the one whose
// spanning Budgeted caption is widest: a grid item spanning an `auto` track
// and a `minmax(0,1fr)` one distributes its contribution to the flexible
// track, so the spanning cell on line 2 does not reopen the identity track.
// (`auto` is otherwise reserved for a slot whose caption AND value are
// bounded, since an `auto` track takes MAX-content; the month cell is both.)
//
// The formatter is `formatCurrencyCompact` (no decimals), and the widest unit
// it can produce is not a symbol: it asks for `narrowSymbol`, which falls back
// to the three-letter ISO code where a currency has none. Measured at
// `text-xs`, the widest cell is the variance, which wears `font-medium` AND a
// `+` sign: `+123 456 CHF` is 88px and `+1 456 789 CHF` is 99px (in a currency
// with a narrow symbol, `+1 456 789 zł` is 85px). So a six-figure amount fits
// the 93px track at 320px with room to spare, a seven-figure one is 6px past
// it, and the measured wrapper still does not scroll at either width in any
// locale, because the overflow spends the column gap rather than the page. An
// eight-figure `+12 345 678 CHF` (107px) is the first that crowds its
// neighbour at 320px; it fits the 128px track at 390px.
//
// Where a figure does exceed its track, it overflows rather than being cut:
// right alignment is not a containment device -- a nowrap amount longer than
// its track overflows past the end edge whatever `text-align` says -- and
// `overflow-hidden` here would silently cut a figure, which is worse than a
// crowded one. (Today, before this layout, the same reader scrolls at every
// width and in every locale: the five-column table is 394px wide in English
// and 575px in Russian, inside that 272px box, and its figures already wrap in
// the middle -- 97px rows in German against a 37px one-line row.)
//
// The caption inside the cell wraps even though the cell does not: `white-space`
// is inherited, so `CellLabel` takes `whitespace-normal` back for itself. A
// number must not break; a caption may.
//
// And a caption that CANNOT break is what actually sizes this layout, not the
// money. Every caption in the catalogue was rendered into the 93px a money
// track gets at 320px, at `CellLabel`'s own type: four of the five fit or wrap
// there in all 23 locales, and `colBudgeted` is the one that does neither --
// `Запланировано` (ru, 96px) and `Gebudgetteerd` (nl, 93px) are single words
// with no break opportunity, and an unbreakable caption block overflows to the
// RIGHT, which is the one kind of overflow that reopens the wrapper's scroll
// (a nowrap figure past its track overflows towards the start edge and does
// not: measured, the 99px variance in a 93px track adds nothing to the table's
// `scrollWidth`, while a 96px caption in the same track added 6px). So the
// spanning slot on line 2 goes to Budgeted rather than to the longest caption:
// `% wykorzystania` is longer at 102px but carries a space, so a 93px track
// wraps it. Measured with Budgeted spanning: no sideways scroll at 320px or
// 390px in pl, ru, id, de, en, the widest-per-key set or the pseudo-locale.
const MONEY_CELL = 'p-0 text-right text-xs whitespace-nowrap sm:table-cell sm:text-sm';

/** Every caption in a wrapped cell is phone-only. */
const CAPTION_CLASS = 'sm:hidden';

export function BudgetVsActualReport() {
  const t = useTranslations('reports');
  const { formatCurrencyCompact: formatCurrency, formatPercentTrimmed } = useNumberFormat();
  const [selectedBudgetIdState, setSelectedBudgetId] = useState<string>('');
  const [months, setMonths] = useState(6);
  const [viewMode, setViewMode] = useState<'overview' | 'categories'>('overview');
  const chartRef = useRef<HTMLDivElement>(null);
  const { sortField, sortDirection, handleSort } = useSortableTable<BudgetTrendSortField>(
    'reports.budget-vs-actual.trend.sort',
    { field: 'month', direction: 'asc' },
  );

  const {
    data: budgetsData,
    isLoading: budgetsLoading,
    error: budgetsError,
    reload: reloadBudgets,
  } = useReportData(() => budgetsApi.getAll(), []);

  const budgets = useMemo(() => budgetsData ?? [], [budgetsData]);

  // Auto-select the active budget (or first) until the user picks one. Derived
  // during render rather than via setState-in-effect.
  const autoSelectedBudgetId = useMemo(() => {
    const active = budgets.find((b) => b.isActive);
    return active?.id ?? budgets[0]?.id ?? '';
  }, [budgets]);
  const selectedBudgetId = selectedBudgetIdState || autoSelectedBudgetId;

  const {
    data: reportResponse,
    isLoading: reportLoading,
    error: reportError,
    reload: reloadReport,
  } = useReportData(
    () =>
      selectedBudgetId
        ? Promise.all([
            budgetsApi.getTrend(selectedBudgetId, months),
            budgetsApi.getCategoryTrend(selectedBudgetId, months),
          ]).then(([trend, catTrend]) => ({ trend, catTrend }))
        : Promise.resolve(null),
    [selectedBudgetId, months],
  );

  const trendData = useMemo(() => reportResponse?.trend ?? [], [reportResponse]);
  const categoryData = useMemo<CategoryTrendSeries[]>(
    () => reportResponse?.catTrend ?? [],
    [reportResponse],
  );
  const isLoading = budgetsLoading || reportLoading;
  const error = budgetsError || reportError;
  const reload = () => {
    reloadBudgets();
    reloadReport();
  };

  const sortedTrendData = useMemo(() => {
    const sorted = [...trendData];
    sorted.sort((a, b) => {
      let comparison = 0;
      switch (sortField) {
        case 'month':
          comparison = compareValues(a.month, b.month);
          break;
        case 'budgeted':
          comparison = compareValues(a.budgeted, b.budgeted);
          break;
        case 'actual':
          comparison = compareValues(a.actual, b.actual);
          break;
        case 'variance':
          comparison = compareValues(a.variance, b.variance);
          break;
        case 'percentUsed':
          comparison = compareValues(a.percentUsed, b.percentUsed);
          break;
      }
      return sortDirection === 'asc' ? comparison : -comparison;
    });
    return sorted;
  }, [trendData, sortField, sortDirection]);

  // The five sortable columns, keyed by field so the record is exhaustive and
  // each entry must name its own key (see `SortColumnsByField`).
  const columns: SortColumnsByField = {
    month: {
      field: 'month',
      label: t('budgetVsActual.colMonth'),
      value: (point) => point.month,
    },
    budgeted: {
      field: 'budgeted',
      label: t('budgetVsActual.colBudgeted'),
      value: (point) => formatCurrency(point.budgeted),
      align: 'right',
    },
    actual: {
      field: 'actual',
      label: t('budgetVsActual.colActual'),
      value: (point) => formatCurrency(point.actual),
      align: 'right',
    },
    variance: {
      field: 'variance',
      label: t('budgetVsActual.colVariance'),
      value: (point) => `${varianceSign(point)}${formatCurrency(point.variance)}`,
      align: 'right',
    },
    percentUsed: {
      field: 'percentUsed',
      label: t('budgetVsActual.colPercentUsed'),
      value: (point) => formatPercentTrimmed(point.percentUsed),
      align: 'right',
      last: true,
    },
  };

  // Their order, rendered by BOTH header rows and matched by the cells' DOM
  // order. DERIVED from the record rather than re-listed: a hand-written list
  // beside an exhaustive record is not exhaustive, so a field added to the
  // union would compile and still ship with no sort control in either header.
  // The record's declaration order is the column order. Every body cell takes
  // its `sm`-and-up padding from the same record, so the header and the cells
  // cannot disagree about which column is last and drops its right padding.
  const sortColumns: readonly SortColumn[] = Object.values(columns);

  const handleExportPdf = async () => {
    const { exportToPdf } = await import('@/lib/pdf-export');
    // Headings and row cells both come from the ordered column record, so the
    // export cannot carry the screen's old column order (see `SortColumn`).
    // The ROWS stay in the order the server sent, not the order on screen --
    // deliberately, and as every sibling report export does: the PDF is a
    // report of the period, not a snapshot of a transient sort. Each value
    // function is locale-aware (currency through formatCurrency, percent
    // through formatPercentTrimmed), so the export matches the screen.
    const headers = sortColumns.map((col) => col.label);
    const rows = trendData.map((point) => sortColumns.map((col) => col.value(point)));
    await exportToPdf({
      title: t('budgetVsActual.pdfTitle'),
      chartContainer: chartRef.current,
      tableData: { headers, rows },
      filename: 'budget-vs-actual',
    });
  };

  if (error) {
    return <ReportError onRetry={reload} />;
  }

  if (isLoading) {
    return (
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-6">
        <div className="space-y-4">
          <Skeleton className="h-8 w-1/3" />
          <Skeleton className="h-64 w-full" />
        </div>
      </div>
    );
  }

  if (budgets.length === 0) {
    return (
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-6 text-center">
        <p className="text-gray-500 dark:text-gray-400">
          {t('budgetVsActual.noBudgets')}
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Controls */}
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-4">
        <div className="flex flex-wrap gap-4 items-center justify-between">
          <div className="flex items-center gap-3">
            <select
              value={selectedBudgetId}
              onChange={(e) => setSelectedBudgetId(e.target.value)}
              className="px-3 py-2 text-sm border border-gray-300 dark:border-gray-600 rounded-md bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100"
            >
              {budgets.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </select>
            <select
              value={months}
              onChange={(e) => setMonths(Number(e.target.value))}
              className="px-3 py-2 text-sm border border-gray-300 dark:border-gray-600 rounded-md bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100"
            >
              <option value={3}>{t('budgetVsActual.months3')}</option>
              <option value={6}>{t('budgetVsActual.months6')}</option>
              <option value={12}>{t('budgetVsActual.months12')}</option>
              <option value={24}>{t('budgetVsActual.months24')}</option>
            </select>
          </div>
          <div className="flex items-center gap-2">
            <div className="flex gap-1 bg-gray-100 dark:bg-gray-700 rounded-md p-0.5">
              <button
                onClick={() => setViewMode('overview')}
                className={`px-3 py-1.5 text-sm font-medium rounded transition-colors ${
                  viewMode === 'overview'
                    ? 'bg-white dark:bg-gray-600 text-gray-900 dark:text-gray-100 shadow-sm'
                    : 'text-gray-500 dark:text-gray-400'
                }`}
              >
                {t('budgetVsActual.viewOverview')}
              </button>
              <button
                onClick={() => setViewMode('categories')}
                className={`px-3 py-1.5 text-sm font-medium rounded transition-colors ${
                  viewMode === 'categories'
                    ? 'bg-white dark:bg-gray-600 text-gray-900 dark:text-gray-100 shadow-sm'
                    : 'text-gray-500 dark:text-gray-400'
                }`}
              >
                {t('budgetVsActual.viewByCategory')}
              </button>
            </div>
            <ExportDropdown onExportPdf={handleExportPdf} />
          </div>
        </div>
      </div>

      {/* Chart */}
      {viewMode === 'overview' ? (
        <div ref={chartRef} className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 px-2 py-4 sm:p-6">
          {trendData.length === 0 ? (
            <p className="text-gray-500 dark:text-gray-400 text-center py-8">
              {t('budgetVsActual.noData')}
            </p>
          ) : (
            <>
              <div className="h-80">
                <ResponsiveContainer width="100%" height="100%" minWidth={0}>
                  <BarChart data={trendData}>
                    <CartesianGrid strokeDasharray="3 3" className="opacity-30" />
                    <XAxis dataKey="month" tick={{ fontSize: 12 }} />
                    <YAxis tickFormatter={(v) => formatCurrency(v)} tick={{ fontSize: 12 }} />
                    <Tooltip
                      content={({ active, payload, label }) => {
                        if (!active || !payload || payload.length === 0) return null;
                        return (
                          <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg shadow-lg p-3">
                            <p className="text-sm font-medium text-gray-900 dark:text-gray-100 mb-1">{label}</p>
                            {payload.map((entry, idx) => (
                              <p key={(entry.dataKey as string) ?? entry.name ?? idx} className="text-sm" style={{ color: entry.color }}>
                                {entry.name}: {formatCurrency(entry.value as number)}
                              </p>
                            ))}
                          </div>
                        );
                      }}
                    />
                    <Legend />
                    <Bar dataKey="budgeted" name={t('budgetVsActual.seriesBudgeted')} fill={chartColors.primary} radius={[2, 2, 0, 0]} />
                    <Bar dataKey="actual" name={t('budgetVsActual.seriesActual')} fill={chartColors.income} radius={[2, 2, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>

              {/* Variance line */}
              <div className="mt-6">
                <h3 className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-3">{t('budgetVsActual.viewVarianceOverTime')}</h3>
                <div className="h-48">
                  <ResponsiveContainer width="100%" height="100%" minWidth={0}>
                    <LineChart data={trendData}>
                      <CartesianGrid strokeDasharray="3 3" className="opacity-30" />
                      <XAxis dataKey="month" tick={{ fontSize: 12 }} />
                      <YAxis tickFormatter={(v) => formatCurrency(v)} tick={{ fontSize: 12 }} />
                      <Tooltip
                        content={({ active, payload, label }) => {
                          if (!active || !payload) return null;
                          const variance = payload[0]?.value as number;
                          return (
                            <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg shadow-lg p-3">
                              <p className="text-sm font-medium text-gray-900 dark:text-gray-100">{label}</p>
                              <p className={`text-sm font-medium ${variance > 0 ? 'text-red-500' : 'text-green-500'}`}>
                                {t('budgetVsActual.tooltipVariance')} {variance > 0 ? '+' : ''}{formatCurrency(variance)}
                              </p>
                            </div>
                          );
                        }}
                      />
                      <Line
                        type="monotone"
                        dataKey="variance"
                        stroke={chartColors.warning}
                        strokeWidth={2}
                        dot={{ r: 4 }}
                        name={t('budgetVsActual.seriesVariance')}
                      />
                    </LineChart>
                  </ResponsiveContainer>
                </div>
              </div>

              {/* Summary table.

                  Below `sm` the table becomes a block and each row wraps into
                  a three-column grid -- an `auto` track for the month beside
                  two equal `minmax(0,1fr)` money tracks, for the reason
                  `MONEY_CELL` measures -- so all five columns fit a phone
                  without a horizontal scroll, on two lines: the month, its
                  variance and its actual share line 1; the budgeted figure
                  (spanning the first two tracks) and the percent used share
                  line 2. The row is read for the VARIANCE, so that is the
                  figure beside the month, and each figure on line 2 sits under
                  the one it relates to: budgeted ends under the variance it is
                  subtracted from, and percent used sits under the actual it is
                  a share of. The month is the one cell allowed to wrap, since a
                  compact amount never may. No column is dropped and no figure
                  is truncated -- an amount wider than its track overflows the
                  end edge rather than being cut, which `MONEY_CELL` measures
                  and argues for.

                  Which cell gets the spanning track was decided by measuring
                  every caption in the catalogue against the 93px a money track
                  gets at 320px, and Budgeted is the one that neither fits nor
                  breaks (`Запланировано`, `Gebudgetteerd`) -- see `MONEY_CELL`.

                  From `sm` up it is the ordinary table: each cell restores this
                  table's own `py-2 pr-4` (and the last column's bare `py-2`)
                  through `cellPadding`, and a Chromium replica renders it
                  pixel-identically to today at 800px. The one deliberate
                  difference above `sm` is `whitespace-nowrap` on the figures,
                  for the reason `MONEY_CELL` gives. The sort controls survive
                  as their own phone-only header row, because the column header
                  row that carries them on desktop is hidden there.

                  Two costs of restyling one tree, both deliberate. Changing
                  the display roles drops the table semantics below `sm`, which
                  is why the roles are restated explicitly and every figure
                  carries a `CellLabel` naming its column -- the month needs
                  none, being the row's identity rather than one of its
                  figures. And the phone reading order differs from the DOM
                  order, which is the desktop column order the grid placement
                  overrides visually. Both are properties of the mechanism, not
                  of this table. */}
              <div className="mt-6 overflow-x-auto">
                <table role="table" className="block min-w-full text-sm sm:table">
                  <thead role="rowgroup" className="block sm:table-header-group">
                    {/* Phone sort strip: the same five controls, wrapped. */}
                    <tr role="row" className="flex flex-wrap gap-x-2 gap-y-1 pb-2 border-b border-gray-200 dark:border-gray-700 sm:hidden">
                      {sortColumns.map((col) => (
                        <SortableHeader<BudgetTrendSortField>
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
                    <tr role="row" className="hidden border-b border-gray-200 dark:border-gray-700 sm:table-row">
                      {sortColumns.map((col) => (
                        <SortableHeader<BudgetTrendSortField>
                          key={col.field}
                          field={col.field}
                          sortField={sortField}
                          sortDirection={sortDirection}
                          onSort={handleSort}
                          align={col.align}
                          className={headerClass(col)}
                        >
                          {col.label}
                        </SortableHeader>
                      ))}
                    </tr>
                  </thead>
                  <tbody role="rowgroup" className="block sm:table-row-group">
                    {sortedTrendData.map((point) => (
                      <tr
                        key={point.month}
                        role="row"
                        className="grid grid-cols-[auto_minmax(0,1fr)_minmax(0,1fr)] items-start gap-x-3 gap-y-1.5 py-2 border-b border-gray-100 dark:border-gray-700/50 sm:table-row sm:py-0"
                      >
                        <td role="cell" className={`col-start-1 row-start-1 p-0 text-gray-900 dark:text-gray-100 sm:table-cell ${cellPadding(columns.month)}`}>{point.month}</td>
                        <td role="cell" className={`col-start-1 col-span-2 row-start-2 text-gray-600 dark:text-gray-400 ${cellPadding(columns.budgeted)} ${MONEY_CELL}`}>
                          <CellLabel className={CAPTION_CLASS}>{columns.budgeted.label}</CellLabel>
                          {formatCurrency(point.budgeted)}
                        </td>
                        <td role="cell" className={`col-start-3 row-start-1 text-gray-600 dark:text-gray-400 ${cellPadding(columns.actual)} ${MONEY_CELL}`}>
                          <CellLabel className={CAPTION_CLASS}>{columns.actual.label}</CellLabel>
                          {formatCurrency(point.actual)}
                        </td>
                        {/* The variance takes the middle of line 1 beside the
                            month: it is the figure the row is read for. */}
                        <td role="cell" className={`col-start-2 row-start-1 font-medium ${point.variance > 0 ? 'text-red-600 dark:text-red-400' : 'text-green-600 dark:text-green-400'} ${cellPadding(columns.variance)} ${MONEY_CELL}`}>
                          <CellLabel className={CAPTION_CLASS}>{columns.variance.label}</CellLabel>
                          {varianceSign(point)}{formatCurrency(point.variance)}
                        </td>
                        {/* Percent used sits under the actual figure it is a
                            share of. Its caption wraps at its own space in
                            every locale, so a third-width track holds it. */}
                        <td role="cell" className={`col-start-3 row-start-2 text-gray-600 dark:text-gray-400 ${cellPadding(columns.percentUsed)} ${MONEY_CELL}`}>
                          <CellLabel className={CAPTION_CLASS}>{columns.percentUsed.label}</CellLabel>
                          {formatPercentTrimmed(point.percentUsed)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </div>
      ) : (
        <BudgetCategoryTrend data={categoryData} formatCurrency={formatCurrency} />
      )}
    </div>
  );
}
