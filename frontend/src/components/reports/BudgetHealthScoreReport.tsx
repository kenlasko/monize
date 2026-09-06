'use client';

import { useState, useMemo, useRef } from 'react';
import { Skeleton } from '@/components/ui/LoadingSkeleton';
import { budgetsApi } from '@/lib/budgets';
import { BudgetHealthGauge } from '@/components/budgets/BudgetHealthGauge';
import { ExportDropdown } from '@/components/ui/ExportDropdown';
import { ReportError } from '@/components/reports/ReportError';
import { SortableHeader } from '@/components/ui/SortableHeader';
import { CellLabel } from '@/components/ui/Table';
import { useTranslations } from 'next-intl';
import { useReportData } from '@/hooks/useReportData';
import { useSortableTable, compareValues } from '@/hooks/useSortableTable';
import type { HealthScoreCategoryDetail } from '@/types/budget';

import { useNumberFormat } from '@/hooks/useNumberFormat';
function getImpactColor(impact: number): string {
  if (impact > 0) return 'text-green-600 dark:text-green-400';
  if (impact < 0) return 'text-red-600 dark:text-red-400';
  return 'text-gray-500 dark:text-gray-400';
}

function getGroupColor(group: string | null): string {
  if (group === 'NEED') return 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300';
  if (group === 'WANT') return 'bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-300';
  if (group === 'SAVING') return 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300';
  return 'bg-gray-100 text-gray-700 dark:bg-gray-700 dark:text-gray-300';
}

// An over-budget percentage is red; nothing else is. Written once because the
// wrapped cell and the desktop cell are the same cell.
const percentUsedColor = (percentUsed: number) =>
  percentUsed > 100
    ? 'text-red-600 dark:text-red-400'
    : 'text-gray-600 dark:text-gray-400';

// A positive impact is prefixed; nothing else is. Stated once, inside the
// column record's `value`, which is what both the cell and the PDF export
// render.
const impactSign = (impact: number) => (impact > 0 ? '+' : '');

type CategoryImpactSortField = 'category' | 'group' | 'percentUsed' | 'impact';

/**
 * One sortable column of the category impact table. The four are declared once
 * and rendered by BOTH header rows -- the column header row (from `sm` up) and
 * the phone sort strip -- so the two can never list different fields.
 */
interface SortColumn {
  field: CategoryImpactSortField;
  label: string;
  /**
   * This column's cell, as text -- rendered by the `<td>` AND by the PDF
   * export, which also takes its headings from this record. So the export
   * cannot drift from the screen it exports in either respect: reordering the
   * record moves headings and cells together, and a change to how a column
   * prints (rounding a percentage, dropping a sign) reaches both because there
   * is one function, not a cell and an export copy of it. The mechanism is
   * this single call site pair, not the test -- though
   * `BudgetHealthScoreReport.mobileWrapped.test.tsx` asserts the association
   * as well.
   *
   * A column whose cell carries MARKUP renders that markup around this text
   * (the group pill), never a second derivation of the value.
   */
  value: (cat: HealthScoreCategoryDetail) => string;
  /** The two figure columns are right-aligned in the column header row. */
  align?: 'right';
  /** The two text columns state today's explicit left alignment. */
  headerAlign?: 'left';
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
 * `Record<CategoryImpactSortField, SortColumn>` does not do: that forces an
 * entry to EXIST for every member of the union but lets it name a different
 * one, so `impact: { field: 'percentUsed', ... }` would type-check. Both
 * header rows would then render two controls keyed `percentUsed` (a duplicate
 * React key), tapping "Score impact" would sort by "% used", and the impact
 * column would be unsortable -- none of which a test comparing header LABELS
 * can see, because the labels stay right. Here it is a compile error instead.
 */
type SortColumnsByField = {
  [K in CategoryImpactSortField]: SortColumn & { field: K };
};

// Today's header cell, unchanged: the two text columns are explicitly
// left-aligned and the last column drops its right padding.
const headerClass = (col: SortColumn) =>
  [
    col.last ? 'py-2' : 'py-2 pr-4',
    col.headerAlign === 'left' ? 'text-left' : '',
    'font-medium text-gray-500 dark:text-gray-400',
  ]
    .filter(Boolean)
    .join(' ');

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

// A figure cell (`% used`, `Score impact`) inside a wrapped row: no padding of
// its own below `sm` and this table's own from `sm` up, which each cell adds
// through `cellPadding` so "which column is last" stays decided in one place.
// Smaller type on phones, matching the sibling report tables.
//
// `whitespace-nowrap` is the one property here that is NOT phone-only, and it
// is deliberate: it is the single respect in which the desktop cell differs
// from today's. Both figures carry two decimals (see below), and a break at
// the decimal separator is exactly the kind of mid-number split the sibling
// tables ban on money; `white-space` also keeps a caption from dragging its
// value onto a second line.
//
// The budget was measured on a hand-written CSS replica in Chromium, at the
// insets this table really gets on a phone (the report page's `px-4` plus this
// card's `p-4`): 256px of content at 320px and 326px at 390px.
//
// Neither VALUE is the short integer it looks like in English fixtures, and
// only one of them is bounded. `percentUsed` is
// `Math.round((spent / budgeted) * 10000) / 100` in `budgets.service.ts`, so
// it carries two decimals and has no ceiling: a category budgeted 10 with
// 12,345.678 spent renders `123456.78%`, 63px at `text-xs`. `impact` is
// `roundToDecimals(impact, 2)` in `budget-health-reports.service.ts`, bounded
// by its own caps to [-15, +3] -- `Math.min(overagePercent * 0.3 * weight, 15)`
// against `Math.min((100 - percentUsed) * 0.05, 3)` -- so `-14.85` (37px) is
// its widest form, sign included.
//
// Their CAPTIONS are what actually size the layout, though, since an `auto`
// track is sized by its caption rather than by its value. So the row is two
// EQUAL `minmax(0,1fr)` tracks: 122px each at 320px and 157px at 390px, read
// off `getComputedStyle` -- room for both figures at their widest measured
// forms with the caption on its own line above.
//
// Which caption could have forced a spanning track was decided by rendering
// EVERY string in the catalogue for both captioned columns (40 strings across
// 22 locales) into that 122px track at `CellLabel`'s own type: none of them
// overflows it. `% used` is a space away from a break in every locale (it
// begins with `% `), and the longest score-impact captions -- `Impacto en la
// puntuación` (es), `Impatto sul punteggio` (it), `Impacto na Pontuação`
// (pt, pt-BR) -- all wrap at a space onto a second 12.5px line, which costs
// that cell 41px instead of 29px at 320px and nothing at 390px. A caption too
// long for the track is a documented cost; an UNBREAKABLE one would not be,
// since it would overflow to the right and reopen the wrapper's scroll, and
// this table has none.
const FIGURE_CELL =
  'p-0 text-right text-xs font-medium whitespace-nowrap sm:table-cell sm:text-sm';

/** Every caption in a wrapped cell is phone-only. */
const CAPTION_CLASS = 'sm:hidden';

export function BudgetHealthScoreReport() {
  const t = useTranslations('reports');
  const { formatPercentTrimmed } = useNumberFormat();
  const chartRef = useRef<HTMLDivElement>(null);

  const getGroupLabel = (group: string | null): string => {
    if (group === 'NEED') return t('budgetHealthScore.groupNeed');
    if (group === 'WANT') return t('budgetHealthScore.groupWant');
    if (group === 'SAVING') return t('budgetHealthScore.groupSaving');
    return t('budgetHealthScore.groupUncategorized');
  };
  const [selectedBudgetIdState, setSelectedBudgetId] = useState<string>('');
  const { sortField, sortDirection, handleSort } = useSortableTable<CategoryImpactSortField>(
    'reports.budget-health-score.categoryImpact.sort',
    { field: 'impact', direction: 'asc' },
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
    data: healthScore,
    isLoading: scoreLoading,
    error: scoreError,
    reload: reloadScore,
  } = useReportData(
    () =>
      selectedBudgetId
        ? budgetsApi.getHealthScore(selectedBudgetId)
        : Promise.resolve(null),
    [selectedBudgetId],
  );

  const isLoading = budgetsLoading || scoreLoading;
  const error = budgetsError || scoreError;
  const reload = () => {
    reloadBudgets();
    reloadScore();
  };

  const sortedCategoryScores = useMemo(() => {
    if (!healthScore) return [];
    const sorted = [...healthScore.categoryScores].sort((a, b) => {
      let comparison = 0;
      switch (sortField) {
        case 'category':
          comparison = compareValues(a.categoryName, b.categoryName);
          break;
        case 'group':
          comparison = compareValues(a.categoryGroup, b.categoryGroup);
          break;
        case 'percentUsed':
          comparison = compareValues(a.percentUsed, b.percentUsed);
          break;
        case 'impact':
          comparison = compareValues(a.impact, b.impact);
          break;
      }
      return sortDirection === 'asc' ? comparison : -comparison;
    });
    return sorted;
  }, [healthScore, sortField, sortDirection]);

  // The four sortable columns, keyed by field so the record is exhaustive and
  // each entry must name its own key (see `SortColumnsByField`).
  const columns: SortColumnsByField = {
    category: {
      field: 'category',
      label: t('budgetHealthScore.colCategory'),
      value: (cat) => cat.categoryName,
      headerAlign: 'left',
    },
    group: {
      field: 'group',
      label: t('budgetHealthScore.colGroup'),
      value: (cat) => getGroupLabel(cat.categoryGroup),
      headerAlign: 'left',
    },
    percentUsed: {
      field: 'percentUsed',
      label: t('budgetHealthScore.colPercentUsed'),
      value: (cat) => formatPercentTrimmed(cat.percentUsed),
      align: 'right',
    },
    impact: {
      field: 'impact',
      label: t('budgetHealthScore.colScoreImpact'),
      value: (cat) => `${impactSign(cat.impact)}${cat.impact}`,
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
    // The ROW order is this export's own, unchanged: by impact ascending
    // rather than by the transient sort on screen. Sorted on a COPY: the
    // response array is what the table renders, and `sort` in place made an
    // export silently re-order the tie groups of a Group- or %-sorted table.
    const headers = sortColumns.map((col) => col.label);
    const rows = healthScore
      ? [...healthScore.categoryScores]
          .sort((a, b) => a.impact - b.impact)
          .map((cat) => sortColumns.map((col) => col.value(cat)))
      : [];
    const scoreColor = healthScore
      ? healthScore.score >= 80 ? '#16a34a' : healthScore.score >= 60 ? '#ca8a04' : '#dc2626'
      : '#111827';
    await exportToPdf({
      title: t('budgetHealthScore.pdfTitle'),
      summaryCards: healthScore ? [
        { label: t('budgetHealthScore.finalScore'), value: `${healthScore.score}/100`, color: scoreColor },
      ] : undefined,
      tableData: healthScore ? {
        headers: [t('budgetHealthScore.colCategory'), t('budgetHealthScore.colScoreImpact')],
        rows: [
          [t('budgetHealthScore.baseScore'), String(healthScore.breakdown.baseScore)],
          [t('budgetHealthScore.overBudgetDeductions'), `-${healthScore.breakdown.overBudgetDeductions}`],
          [t('budgetHealthScore.essentialPenalty'), `-${healthScore.breakdown.essentialWeightPenalty}`],
          [t('budgetHealthScore.underBudgetBonus'), `+${healthScore.breakdown.underBudgetBonus}`],
          [t('budgetHealthScore.improvingBonus'), `+${healthScore.breakdown.trendBonus}`],
          [t('budgetHealthScore.finalScore'), String(healthScore.score)],
        ],
      } : undefined,
      additionalTables: rows.length > 0 ? [{
        title: t('budgetHealthScore.categoryImpact'),
        headers,
        rows,
      }] : undefined,
      filename: 'budget-health-score',
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
          <div className="h-40 w-40 bg-gray-200 dark:bg-gray-700 rounded-full mx-auto" />
          <Skeleton className="h-32 w-full" />
        </div>
      </div>
    );
  }

  if (budgets.length === 0) {
    return (
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-6 text-center">
        <p className="text-gray-500 dark:text-gray-400">
          {t('budgetHealthScore.noBudgets')}
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Budget selector */}
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-4">
        <div className="flex flex-wrap gap-3 items-center justify-between">
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
          <ExportDropdown onExportPdf={handleExportPdf} />
        </div>
      </div>

      {healthScore && (
        <>
          {/* Gauge */}
          <div ref={chartRef} className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <BudgetHealthGauge score={healthScore.score} />

            {/* Score Breakdown */}
            <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-4 sm:p-6">
              <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-4">
                {t('budgetHealthScore.scoreBreakdown')}
              </h2>
              <div className="space-y-3">
                <div className="flex justify-between text-sm">
                  <span className="text-gray-600 dark:text-gray-400">{t('budgetHealthScore.baseScore')}</span>
                  <span className="font-medium text-gray-900 dark:text-gray-100">
                    {healthScore.breakdown.baseScore}
                  </span>
                </div>
                <div className="flex justify-between text-sm">
                  <span className="text-gray-600 dark:text-gray-400">{t('budgetHealthScore.overBudgetDeductions')}</span>
                  <span className="font-medium text-red-600 dark:text-red-400">
                    -{healthScore.breakdown.overBudgetDeductions}
                  </span>
                </div>
                <div className="flex justify-between text-sm">
                  <span className="text-gray-600 dark:text-gray-400">{t('budgetHealthScore.essentialPenalty')}</span>
                  <span className="font-medium text-red-600 dark:text-red-400">
                    -{healthScore.breakdown.essentialWeightPenalty}
                  </span>
                </div>
                <div className="flex justify-between text-sm">
                  <span className="text-gray-600 dark:text-gray-400">{t('budgetHealthScore.underBudgetBonus')}</span>
                  <span className="font-medium text-green-600 dark:text-green-400">
                    +{healthScore.breakdown.underBudgetBonus}
                  </span>
                </div>
                <div className="flex justify-between text-sm">
                  <span className="text-gray-600 dark:text-gray-400">{t('budgetHealthScore.improvingBonus')}</span>
                  <span className="font-medium text-green-600 dark:text-green-400">
                    +{healthScore.breakdown.trendBonus}
                  </span>
                </div>
                <div className="pt-2 border-t border-gray-200 dark:border-gray-700 flex justify-between text-sm font-semibold">
                  <span className="text-gray-900 dark:text-gray-100">{t('budgetHealthScore.finalScore')}</span>
                  <span className="text-gray-900 dark:text-gray-100">{healthScore.score}</span>
                </div>
              </div>
            </div>
          </div>

          {/* Per-Category Impact */}
          <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-4 sm:p-6">
            <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-4">
              {t('budgetHealthScore.categoryImpact')}
            </h2>
            {healthScore.categoryScores.length === 0 ? (
              <p className="text-sm text-gray-500 dark:text-gray-400">
                {t('budgetHealthScore.noCategories')}
              </p>
            ) : (
              <div className="overflow-x-auto">
                {/* Category impact table.

                  Below `sm` the table becomes a block and each row wraps into
                  a two-column, two-line grid of EQUAL `minmax(0,1fr)` tracks
                  (for the reason `FIGURE_CELL` measures), so all four columns
                  fit a phone without a horizontal scroll: the category name
                  and its score impact share line 1; the group pill and the
                  percent used share line 2. The row is read for its IMPACT on
                  the score -- that is what this report is -- so that figure
                  sits beside the name, and the percent used it is derived from
                  sits under it. No column is dropped and no figure is
                  truncated.

                  The name and the pill are two separate columns, so they are
                  two grid items and cannot share one area: the pill takes the
                  line below the name rather than sitting beside it. It carries
                  no caption -- a coloured group chip names itself -- and below
                  `sm` it becomes an inline BLOCK capped at the track, so a
                  label too wide for a 122px track (`Belum Dikategorikan`,
                  `Nicht kategorisiert`) wraps inside ONE rounded rectangle
                  instead of splitting into two ragged inline fragments. That
                  pair of classes is phone-only; from `sm` up the pill's markup
                  resolves exactly as it does today.

                  The category name is UNBOUNDED, so it sits in a
                  `minmax(0,1fr)` track with `min-w-0`: a track that may be
                  zero plus a cell that may be narrower than its own content is
                  what lets a long name shrink instead of setting the table's
                  minimum width. It is not clamped -- a clamp would CUT the
                  tail of a name that no other surface shows in full, and
                  containment here does not need one: `break-words` breaks a
                  word too long for the track, and the measured 40-character
                  name renders whole on three lines at 320px.
                  `sm:break-normal` hands today's wrapping back from `sm` up.

                  From `sm` up it is the ordinary table: each cell restores
                  this table's own `py-2 pr-4` (and the last column's bare
                  `py-2`) through `cellPadding`, and a Chromium replica renders
                  it pixel-identically to today at 800px. The one deliberate
                  difference above `sm` is `whitespace-nowrap` on the two
                  figures, for the reason `FIGURE_CELL` gives. The sort
                  controls survive as their own phone-only header row, because
                  the column header row that carries them on desktop is hidden
                  there.

                  Two costs of restyling one tree, both deliberate. Changing
                  the display roles drops the table semantics below `sm`, which
                  is why the roles are restated explicitly and each figure
                  carries a `CellLabel` naming its column -- the name needs
                  none, being the row's identity rather than one of its
                  figures. And the phone reading order differs from the DOM
                  order, which is the desktop column order the grid placement
                  overrides visually. Both are properties of the mechanism, not
                  of this table. */}
                <table role="table" className="block min-w-full text-sm sm:table">
                  <thead role="rowgroup" className="block sm:table-header-group">
                    {/* Phone sort strip: the same four controls, wrapped. */}
                    <tr role="row" className="flex flex-wrap gap-x-2 gap-y-1 pb-2 border-b border-gray-200 dark:border-gray-700 sm:hidden">
                      {sortColumns.map((col) => (
                        <SortableHeader<CategoryImpactSortField>
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
                        <SortableHeader<CategoryImpactSortField>
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
                    {sortedCategoryScores.map((cat) => (
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
                          <td role="cell" className={`col-start-1 row-start-2 min-w-0 p-0 sm:table-cell ${cellPadding(columns.group)}`}>
                            <span className={`px-2 py-0.5 text-xs font-medium rounded max-sm:inline-block max-sm:max-w-full ${getGroupColor(cat.categoryGroup)}`}>
                              {columns.group.value(cat)}
                            </span>
                          </td>
                          {/* Percent used sits under the impact it is the
                              reason for. */}
                          <td className={`col-start-2 row-start-2 ${percentUsedColor(cat.percentUsed)} ${cellPadding(columns.percentUsed)} ${FIGURE_CELL}`} role="cell">
                            <CellLabel className={CAPTION_CLASS}>{columns.percentUsed.label}</CellLabel>
                            {columns.percentUsed.value(cat)}
                          </td>
                          {/* The score impact takes the right of line 1 beside
                              the category: it is the figure the row is read
                              for. It is also the last column, so it drops its
                              right padding. */}
                          <td className={`col-start-2 row-start-1 ${getImpactColor(cat.impact)} ${cellPadding(columns.impact)} ${FIGURE_CELL}`} role="cell">
                            <CellLabel className={CAPTION_CLASS}>{columns.impact.label}</CellLabel>
                            {columns.impact.value(cat)}
                          </td>
                        </tr>
                      ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
