'use client';

import { useState, useEffect, useMemo, useRef } from 'react';
import { gainLossColor } from '@/lib/format';
import { Skeleton } from '@/components/ui/LoadingSkeleton';
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ReferenceLine,
  ResponsiveContainer,
} from 'recharts';
import { budgetsApi } from '@/lib/budgets';
import type { Budget, FlexGroupCategory, FlexGroupStatus } from '@/types/budget';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import { useReportData } from '@/hooks/useReportData';
import { ExportDropdown } from '@/components/ui/ExportDropdown';
import { ReportError } from '@/components/reports/ReportError';
import { SortableHeader } from '@/components/ui/SortableHeader';
import { CellLabel } from '@/components/ui/Table';
import { useSortableTable, compareValues } from '@/hooks/useSortableTable';
import { createLogger } from '@/lib/logger';
import { chartColors } from '@/lib/chart-colors';
import { useTranslations } from 'next-intl';

const logger = createLogger('FlexGroupAnalysisReport');

type FlexGroupSortField = 'category' | 'budgeted' | 'spent' | 'remaining' | 'percentUsed';

// The three-way percent-used colour, written once: over budget is red, close
// to it amber, otherwise green. The group header above the chart and the
// per-category cell in the table below it ask the same question of the same
// kind of figure, and used to spell the same ternary twice.
const percentUsedColor = (percentUsed: number) =>
  percentUsed > 100
    ? 'text-red-600 dark:text-red-400'
    : percentUsed > 80
      ? 'text-yellow-600 dark:text-yellow-400'
      : 'text-green-600 dark:text-green-400';

// What is left of a category's budget. Written once because the cell, the
// sort comparator and the PDF export all state it.
const categoryRemaining = (cat: FlexGroupCategory) => cat.budgeted - cat.spent;

/**
 * One sortable column of a group's category breakdown table. The five are
 * declared once and rendered by BOTH header rows -- the column header row
 * (from `sm` up) and the phone sort strip -- so the two can never list
 * different fields.
 */
interface SortColumn {
  field: FlexGroupSortField;
  label: string;
  /**
   * This column's cell, as text. The PDF export builds its headings AND its
   * row cells from the same ordered record the table renders, so the export
   * cannot drift from the screen it exports -- reordering the record moves the
   * two together, where a hand-listed export would keep the old order under
   * the new headings. (The export carries one column the table does not: the
   * group name, which the table states in its card heading instead. It is
   * prepended to both the headings and every row, so the pairing still holds.)
   */
  value: (cat: FlexGroupCategory) => string;
  /** The four figure columns are right-aligned in the column header row. */
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
 * `Record<FlexGroupSortField, SortColumn>` does not do: that forces an entry
 * to EXIST for every member of the union but lets it name a different one, so
 * `spent: { field: 'budgeted', ... }` would type-check. Both header rows would
 * then render two controls keyed `budgeted` (a duplicate React key), tapping
 * "Spent" would sort by Budget, and "Spent" would be unsortable -- none of
 * which a test comparing header LABELS can see, because the labels stay right.
 * Here it is a compile error instead.
 */
type SortColumnsByField = {
  [K in FlexGroupSortField]: SortColumn & { field: K };
};

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
//
// This table is drawn once per flex group, so a page with N groups shows N
// strips -- one above each group's own rows, where a reader who has scrolled
// to that group can reach it. All N drive the ONE `sortField`/`sortDirection`
// pair this report holds, exactly as the N column header rows already do on
// desktop: sorting from any group re-sorts every group. Nothing in the strip
// or in `SortableHeader` carries a DOM id, so N copies collide over nothing.
const PHONE_HEADER_CLASS =
  'rounded border border-gray-200 bg-white px-2 py-1.5 text-xs font-medium text-gray-500 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-400 uppercase';

// A money (or percent) cell inside a wrapped row: no padding of its own below
// `sm` and this table's own from `sm` up, which each cell adds through
// `cellPadding` so "which column is last" stays decided in one place. Smaller
// type on phones so a seven-figure amount still fits half the width.
//
// `whitespace-nowrap` is the one property here that is NOT phone-only, and it
// is deliberate: `formatCurrencyCompact` groups thousands, and a locale that
// groups them with a space (`1 234 567 zł`) could otherwise break a figure in
// the middle at any width -- so the ban holds above `sm` too. That is the
// single respect in which the desktop cell differs from today's.
//
// The budget was measured on a hand-written CSS replica in Chromium, at the
// insets this table really gets on a phone (the report page's `px-4` plus the
// group card's `p-6`, which is `p-6` at every width): 240px of content at
// 320px and 310px at 390px. That is the NARROWEST box of the converted report
// family -- the sibling tables sit in a `p-4` card and get 256px -- so the
// figures below are this table's own, not the family's.
//
// Two EQUAL `minmax(0,1fr)` tracks, resolved off `getComputedStyle` rather
// than divided out: 114px each at 320px and 149px each at 390px. Equal tracks
// rather than an `auto` one for the identity, and that is not a stylistic
// choice: each `<tr>` is its OWN grid, so an `auto` track sized by one row's
// content would land at a different width in the next row and step the figure
// column left and right down the card -- a ragged edge only a screenshot
// shows. Equal tracks are what keep the column aligned across rows.
//
// The formatter is `formatCurrencyCompact` (no decimals), and the widest unit
// it can produce is not a symbol: it asks for `narrowSymbol`, which falls back
// to the three-letter ISO code where a currency has none -- so `CHF` is the
// worst case, wider than the weak currencies whose figures run longest (IDR,
// VND and KRW all have a one- or two-character narrow symbol). Measured at
// `text-xs`, a seven-figure `1 456 789 CHF` is 90px, the same figure negative
// (the Remaining column's worst case, which also wears `font-medium`) is 94px,
// an eight-figure `12 345 678 CHF` is 97px, and a NINE-figure
// `-123 456 789 CHF` is 109px -- all inside the 114px track at 320px, with the
// widest measured overflow across every figure cell in every locale being
// zero. In a currency with a narrow symbol the same seven-figure amount is
// 75px. `percentUsed` is the server's own figure and not the short integer an
// English fixture suggests: `computeCategoryActuals` in `budgets.service.ts`
// computes `Math.round((spent / budgeted) * 10000) / 100` per category and
// `getFlexGroupStatus` (in `budget-activity-reports.service.ts`) carries it
// through unchanged, so it has two decimals and no ceiling -- a category
// budgeted 10 with 12,345.678 spent renders `123456.78%`, 77px at `text-xs`.
//
// THREE tracks were measured and rejected: a third of the same box is 72px at
// 320px, which the 90px seven-figure amount overflows by 18px. Two tracks and
// a third line is what this box can hold.
//
// Where a figure does exceed its track it overflows rather than being cut:
// right alignment is not a containment device -- a nowrap amount longer than
// its track overflows past the END edge whatever `text-align` says, measured
// in both tracks -- and `overflow-hidden` here would silently cut a figure,
// which is worse than a crowded one. A TEN-figure `1 234 567 890 CHF` (116px)
// is the first that does it, and the two tracks pay differently: in the LEFT
// track the overflow spends the 12px column gap (2px of it at 320px, so
// nothing reaches the neighbouring figure), while in the RIGHT track it leaves
// the wrapper and reopens its sideways scroll -- measured 246px of content in
// the 240px wrapper at 320px, and nothing at all at 390px. That is a
// documented cost at a magnitude no measured currency reaches in a category
// budget, not a defect. (Today, before this layout, the same reader scrolls at every
// width and in every locale: the five-column table is 463px wide in English
// and 585px with the widest caption per column, inside that 240px box, and its
// figures already wrap in the middle -- `1 234` / `567 CHF` -- for rows 97px
// tall against a 37px one-line row.)
//
// The caption inside the cell wraps even though the cell does not:
// `white-space` is inherited, so `CellLabel` takes `whitespace-normal` back
// for itself. A number must not break; a caption may.
//
// And a caption that CANNOT break is what sizes a layout like this, not the
// money -- so every string in the catalogue for all four captioned columns (69
// strings across 22 locales) was rendered into the 114px a track gets at
// 320px, at `CellLabel`'s own type. NONE of them needs a second line, let
// alone overflows: the widest is the pseudo-locale's `[XX-REMAINING-XX]` at
// 104px, then `% wykorzystania` (pl) at 103px and `% использован` (ru) at
// 96px. So no column takes a spanning track here, unlike the sibling tables
// where a single-word `Gebudgetteerd` or `Запланировано` forced one.
const MONEY_CELL = 'p-0 text-right text-xs whitespace-nowrap sm:table-cell sm:text-sm';

/** Every caption in a wrapped cell is phone-only. */
const CAPTION_CLASS = 'sm:hidden';


export function FlexGroupAnalysisReport() {
  const t = useTranslations('reports');
  const { formatCurrencyCompact: formatCurrency, formatPercentTrimmed } = useNumberFormat();
  const chartRef = useRef<HTMLDivElement>(null);
  const [budgets, setBudgets] = useState<Budget[]>([]);
  const [selectedBudgetId, setSelectedBudgetId] = useState<string>('');
  const { sortField, sortDirection, handleSort } = useSortableTable<FlexGroupSortField>(
    'reports.flex-group-analysis.sort',
    { field: 'spent', direction: 'desc' },
  );

  const { data: response, isLoading, error, reload } = useReportData(
    () =>
      selectedBudgetId
        ? budgetsApi.getFlexGroupStatus(selectedBudgetId)
        : Promise.resolve<FlexGroupStatus[]>([]),
    [selectedBudgetId],
  );

  const flexGroups = useMemo<FlexGroupStatus[]>(() => response ?? [], [response]);

  const sortedFlexGroups = useMemo(() => {
    return flexGroups.map((group) => {
      const sortedCategories = [...group.categories];
      sortedCategories.sort((a, b) => {
        let comparison = 0;
        switch (sortField) {
          case 'category':
            comparison = compareValues(a.categoryName, b.categoryName);
            break;
          case 'budgeted':
            comparison = compareValues(a.budgeted, b.budgeted);
            break;
          case 'spent':
            comparison = compareValues(a.spent, b.spent);
            break;
          case 'remaining':
            comparison = compareValues(categoryRemaining(a), categoryRemaining(b));
            break;
          case 'percentUsed':
            comparison = compareValues(a.percentUsed, b.percentUsed);
            break;
        }
        return sortDirection === 'asc' ? comparison : -comparison;
      });
      return { ...group, categories: sortedCategories };
    });
  }, [flexGroups, sortField, sortDirection]);

  useEffect(() => {
    const loadBudgets = async () => {
      try {
        const budgetList = await budgetsApi.getAll();
        setBudgets(budgetList);
        const active = budgetList.find((b) => b.isActive);
        if (active) {
          setSelectedBudgetId(active.id);
        } else if (budgetList.length > 0) {
          setSelectedBudgetId(budgetList[0].id);
        }
      } catch (error) {
        logger.error('Failed to load budgets:', error);
      }
    };
    loadBudgets();
  }, []);

  // The five sortable columns, keyed by field so the record is exhaustive and
  // each entry must name its own key (see `SortColumnsByField`). Built once
  // for the whole report: every group's table renders from this one record.
  const columns: SortColumnsByField = {
    category: {
      field: 'category',
      label: t('flexGroupAnalysis.colCategory'),
      value: (cat) => cat.categoryName,
    },
    budgeted: {
      field: 'budgeted',
      label: t('flexGroupAnalysis.colBudget'),
      value: (cat) => formatCurrency(cat.budgeted),
      align: 'right',
    },
    spent: {
      field: 'spent',
      label: t('flexGroupAnalysis.colSpent'),
      value: (cat) => formatCurrency(cat.spent),
      align: 'right',
    },
    remaining: {
      field: 'remaining',
      label: t('flexGroupAnalysis.colRemaining'),
      value: (cat) => formatCurrency(categoryRemaining(cat)),
      align: 'right',
    },
    percentUsed: {
      field: 'percentUsed',
      label: t('flexGroupAnalysis.colPercentUsed'),
      value: (cat) => formatPercentTrimmed(cat.percentUsed),
      align: 'right',
      last: true,
    },
  };

  // Their order, rendered by BOTH header rows of EVERY group's table and
  // matched by the cells' DOM order. DERIVED from the record rather than
  // re-listed: a hand-written list beside an exhaustive record is not
  // exhaustive, so a field added to the union would compile and still ship
  // with no sort control in either header. The record's declaration order is
  // the column order. Every body cell takes its `sm`-and-up padding from the
  // same record, so the header and the cells cannot disagree about which
  // column is last and drops its right padding.
  const sortColumns: readonly SortColumn[] = Object.values(columns);

  const handleExportPdf = async () => {
    const { exportToPdf } = await import('@/lib/pdf-export');
    // Headings and row cells both come from the ordered column record, so the
    // export cannot carry the screen's old column order (see `SortColumn`).
    // The group name is the export's own extra leading column -- on screen it
    // is the card's heading rather than a table column -- and it is prepended
    // to the headings and to every row together.
    const headers = [t('flexGroupAnalysis.colGroup'), ...sortColumns.map((col) => col.label)];
    // The ROWS stay in the order the server sent, not the order on screen --
    // deliberately, and as every sibling report export does: the PDF is a
    // report of the period, not a snapshot of a transient sort.
    const rows = flexGroups.flatMap((group) =>
      group.categories.map((cat) => [
        group.groupName,
        ...sortColumns.map((col) => col.value(cat)),
      ]),
    );
    await exportToPdf({
      title: t('flexGroupAnalysis.pdfTitle'),
      chartContainer: chartRef.current,
      tableData: { headers, rows },
      filename: 'flex-group-analysis',
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
          {t('flexGroupAnalysis.noBudgets')}
        </p>
      </div>
    );
  }

  if (flexGroups.length === 0) {
    return (
      <div className="space-y-6">
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-4">
          <select
            value={selectedBudgetId}
            onChange={(e) => setSelectedBudgetId(e.target.value)}
            className="px-3 py-2 text-sm border border-gray-300 dark:border-gray-600 rounded-md bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100"
          >
            {budgets.map((b) => (
              <option key={b.id} value={b.id}>{b.name}</option>
            ))}
          </select>
        </div>
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-6 text-center">
          <p className="text-gray-500 dark:text-gray-400">
            {t('flexGroupAnalysis.noFlexGroups')}
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Controls */}
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-4">
        <div className="flex flex-wrap gap-3 items-center justify-between">
          <select
            value={selectedBudgetId}
            onChange={(e) => setSelectedBudgetId(e.target.value)}
            className="px-3 py-2 text-sm border border-gray-300 dark:border-gray-600 rounded-md bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100"
          >
            {budgets.map((b) => (
              <option key={b.id} value={b.id}>{b.name}</option>
            ))}
          </select>
          <ExportDropdown onExportPdf={handleExportPdf} />
        </div>
      </div>

      {/* Per-group charts */}
      <div ref={chartRef}>
      {sortedFlexGroups.map((group) => {
        const chartData = group.categories.map((cat) => ({
          name: cat.categoryName,
          spent: cat.spent,
          budgeted: cat.budgeted,
        }));

        return (
          <div key={group.groupName} className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-6">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
                {group.groupName}
              </h2>
              <div className="flex items-center gap-3 text-sm">
                <span className="text-gray-500 dark:text-gray-400">
                  {formatCurrency(group.totalSpent)} / {formatCurrency(group.totalBudgeted)}
                </span>
                <span className={`font-medium ${percentUsedColor(group.percentUsed)}`}>
                  {formatPercentTrimmed(group.percentUsed)}
                </span>
              </div>
            </div>

            <div className="h-64">
              <ResponsiveContainer width="100%" height="100%" minWidth={0}>
                <BarChart data={chartData} layout="vertical">
                  <CartesianGrid strokeDasharray="3 3" className="opacity-30" />
                  <XAxis
                    type="number"
                    tickFormatter={(v) => formatCurrency(v)}
                    tick={{ fontSize: 12 }}
                  />
                  <YAxis
                    type="category"
                    dataKey="name"
                    tick={{ fontSize: 12 }}
                    width={120}
                  />
                  <Tooltip
                    content={({ active, payload, label }) => {
                      if (!active || !payload || payload.length === 0) return null;
                      return (
                        <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg shadow-lg p-3">
                          <p className="text-sm font-medium text-gray-900 dark:text-gray-100 mb-1">{label}</p>
                          {payload.map((entry) => (
                            <p key={entry.dataKey as string} className="text-sm" style={{ color: entry.color }}>
                              {entry.name}: {formatCurrency(entry.value as number)}
                            </p>
                          ))}
                        </div>
                      );
                    }}
                  />
                  <Legend />
                  <Bar
                    dataKey="spent"
                    name={t('flexGroupAnalysis.seriesSpent')}
                    fill={chartColors.primary}
                    radius={[0, 4, 4, 0]}
                  />
                  <ReferenceLine
                    x={group.totalBudgeted}
                    stroke={chartColors.expense}
                    strokeWidth={2}
                    strokeDasharray="5 5"
                    label={{ value: t('flexGroupAnalysis.limitLabel', { amount: formatCurrency(group.totalBudgeted) }), position: 'top', fill: chartColors.expense, fontSize: 11 }}
                  />
                </BarChart>
              </ResponsiveContainer>
            </div>

            {/* Category breakdown table.

                Below `sm` the table becomes a block and each row wraps into a
                two-column grid of EQUAL `minmax(0,1fr)` tracks (for the reason
                `MONEY_CELL` measures), so all five columns fit a phone without
                a horizontal scroll, on three lines: the category name and what
                is left of its budget share line 1; the budgeted and spent
                figures share line 2; the percent used sits on line 3 under the
                spend it is a share of. The row is read for what is LEFT -- a
                flex group is money the reader may still move between
                categories -- so that figure is the one beside the name, and
                the two figures it is the difference of sit beneath it. The
                category name is the one cell allowed to wrap, since a compact
                amount never may. No column is dropped and no figure is
                truncated.

                Three lines rather than two because five columns over two
                tracks cannot be fewer, and two tracks is what this box holds:
                the group card is `p-6` at every width, so the table has 240px
                at 320px and a third of it (72px) is 18px short of a
                seven-figure compact amount -- `MONEY_CELL` has the numbers.

                The category name is UNBOUNDED, so it sits in a
                `minmax(0,1fr)` track with `min-w-0`: a track that may be zero
                plus a cell that may be narrower than its own content is what
                lets a long name shrink instead of setting the table's minimum
                width. It is not clamped -- a clamp would CUT the tail of a
                name that no other surface shows in full, and containment here
                does not need one: `break-words` breaks a word too long for the
                track (Russian category names run to 15 characters before a
                space), and the measured 40-character name renders whole on
                four lines at 320px inside a 114px track. `sm:break-normal`
                hands today's wrapping back from `sm` up.

                From `sm` up it is the ordinary table: each cell restores this
                table's own `py-2 pr-4` (and the last column's bare `py-2`)
                through `cellPadding`, and a Chromium replica renders it
                pixel-identically to today at 800px in every locale. The one
                deliberate difference above `sm` is `whitespace-nowrap` on the
                figures, for the reason `MONEY_CELL` gives. The sort controls
                survive as their own phone-only header row, because the column
                header row that carries them on desktop is hidden there -- and
                since this table is drawn once per flex group, a page with N
                groups has N strips, all driving the one sort state this report
                holds (see `PHONE_HEADER_CLASS`).

                Two costs of restyling one tree, both deliberate. Changing the
                display roles drops the table semantics below `sm`, which is
                why the roles are restated explicitly and every figure carries
                a `CellLabel` naming its column -- the category needs none,
                being the row's identity rather than one of its figures. And
                the phone reading order differs from the DOM order, which is
                the desktop column order the grid placement overrides visually.
                Both are properties of the mechanism, not of this table. */}
            <div className="mt-4 overflow-x-auto">
              <table role="table" className="block min-w-full text-sm sm:table">
                <thead role="rowgroup" className="block sm:table-header-group">
                  {/* Phone sort strip: the same five controls, wrapped. */}
                  <tr role="row" className="flex flex-wrap gap-x-2 gap-y-1 pb-2 border-b border-gray-200 dark:border-gray-700 sm:hidden">
                    {sortColumns.map((col) => (
                      <SortableHeader<FlexGroupSortField>
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
                      <SortableHeader<FlexGroupSortField>
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
                  {group.categories.map((cat) => (
                    <tr
                      key={cat.categoryId}
                      role="row"
                      className="grid grid-cols-2 items-start gap-x-3 gap-y-1.5 py-2 border-b border-gray-100 dark:border-gray-700/50 sm:table-row sm:py-0"
                    >
                      <td
                        role="cell"
                        className={`col-start-1 row-start-1 min-w-0 break-words p-0 text-gray-900 dark:text-gray-100 sm:table-cell sm:break-normal ${cellPadding(columns.category)}`}
                      >
                        {columns.category.value(cat)}
                      </td>
                      <td role="cell" className={`col-start-1 row-start-2 text-gray-600 dark:text-gray-400 ${cellPadding(columns.budgeted)} ${MONEY_CELL}`}>
                        <CellLabel className={CAPTION_CLASS}>{columns.budgeted.label}</CellLabel>
                        {columns.budgeted.value(cat)}
                      </td>
                      <td role="cell" className={`col-start-2 row-start-2 text-gray-600 dark:text-gray-400 ${cellPadding(columns.spent)} ${MONEY_CELL}`}>
                        <CellLabel className={CAPTION_CLASS}>{columns.spent.label}</CellLabel>
                        {columns.spent.value(cat)}
                      </td>
                      {/* What is left takes the right of line 1 beside the
                          category: it is the figure the row is read for. */}
                      <td role="cell" className={`col-start-2 row-start-1 font-medium ${gainLossColor(categoryRemaining(cat))} ${cellPadding(columns.remaining)} ${MONEY_CELL}`}>
                        <CellLabel className={CAPTION_CLASS}>{columns.remaining.label}</CellLabel>
                        {columns.remaining.value(cat)}
                      </td>
                      {/* Percent used sits under the spend it is a share of.
                          It is also the last column, so it drops its right
                          padding. */}
                      <td role="cell" className={`col-start-2 row-start-3 font-medium ${percentUsedColor(cat.percentUsed)} ${cellPadding(columns.percentUsed)} ${MONEY_CELL}`}>
                        <CellLabel className={CAPTION_CLASS}>{columns.percentUsed.label}</CellLabel>
                        {columns.percentUsed.value(cat)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        );
      })}
      </div>
    </div>
  );
}
