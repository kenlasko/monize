'use client';

import { useState, useEffect, useMemo } from 'react';
import { Skeleton } from '@/components/ui/LoadingSkeleton';
import { budgetsApi } from '@/lib/budgets';
import type { Budget, CategoryTrendSeries } from '@/types/budget';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import { useReportData } from '@/hooks/useReportData';
import { ExportDropdown } from '@/components/ui/ExportDropdown';
import { ReportError } from '@/components/reports/ReportError';
import { SortableHeader } from '@/components/ui/SortableHeader';
import { CellLabel } from '@/components/ui/Table';
import { useSortableTable, compareValues } from '@/hooks/useSortableTable';
import { createLogger } from '@/lib/logger';
import { useTranslations } from 'next-intl';

const logger = createLogger('CategoryPerformanceReport');

type CategoryPerformanceSortField =
  | 'name'
  | 'avgBudgeted'
  | 'avgActual'
  | 'avgPercent'
  | 'variance'
  | 'overCount'
  | 'trend'
  | 'status';

/** One category's performance over the requested months, as the table shows it. */
interface CategoryPerformanceRow {
  categoryId: string;
  categoryName: string;
  avgBudgeted: number;
  avgActual: number;
  avgPercent: number;
  totalVariance: number;
  trend: { arrow: string; color: string };
  status: { label: string; className: string };
  overCount: number;
  monthCount: number;
  monthData: CategoryTrendSeries['data'];
}

// The three-way percent-used colour: over budget is red, close to it amber,
// otherwise green. Unchanged from the ternary this cell has always spelled.
const percentUsedColor = (avgPercent: number) =>
  avgPercent > 100
    ? 'text-red-600 dark:text-red-400'
    : avgPercent > 80
      ? 'text-yellow-600 dark:text-yellow-400'
      : 'text-green-600 dark:text-green-400';

// A variance ABOVE zero means the category spent more than it was given, so
// the sign reads the opposite way round to a gain: positive is red.
const varianceColor = (totalVariance: number) =>
  totalVariance > 0
    ? 'text-red-600 dark:text-red-400'
    : 'text-green-600 dark:text-green-400';

/**
 * One sortable column of the table. The eight are declared once and rendered
 * by BOTH header rows -- the column header row (from `sm` up) and the phone
 * sort strip -- so the two can never list different fields.
 */
interface SortColumn {
  field: CategoryPerformanceSortField;
  label: string;
  /**
   * This column's cell, as text. The PDF export builds its headings AND its
   * row cells from the same ordered record the table renders, so the export
   * cannot drift from the screen it exports -- reordering the record moves the
   * two together, where a hand-listed export would keep the old order under
   * the new headings.
   */
  value: (row: CategoryPerformanceRow) => string;
  /** How the column header and its cells align from `sm` up. */
  align?: 'right' | 'center';
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
 * `Record<CategoryPerformanceSortField, SortColumn>` does not do: that forces
 * an entry to EXIST for every member of the union but lets it name a different
 * one, so `avgActual: { field: 'avgBudgeted', ... }` would type-check. Both
 * header rows would then render two controls keyed `avgBudgeted` (a duplicate
 * React key), tapping "Avg Actual" would sort by Avg Budget, and "Avg Actual"
 * would be unsortable -- none of which a test comparing header LABELS can see,
 * because the labels stay right. Here it is a compile error instead.
 */
type SortColumnsByField = {
  [K in CategoryPerformanceSortField]: SortColumn & { field: K };
};

// Today's header cell, unchanged.
const headerClass = (col: SortColumn) =>
  col.last
    ? 'py-2 font-medium text-gray-500 dark:text-gray-400'
    : 'py-2 pr-4 font-medium text-gray-500 dark:text-gray-400';

// Today's body cell padding, restored from `sm` up and absent below it (the
// wrapped row supplies the vertical inset and the grid does the spacing).
// Note the asymmetry this table has always had and which the restoration
// reproduces exactly: the HEADER cells are `py-2`, the BODY cells `py-2.5`.
const cellPadding = (col: SortColumn) => (col.last ? 'sm:py-2.5' : 'sm:py-2.5 sm:pr-4');

// The same sort controls in the phone strip: a wrapped row of compact chips.
// Column alignment means nothing there -- the column header row is hidden and
// each data row is a grid -- so every control is left-aligned and self-naming.
// The border is what says "tappable" here: there is no hover on a touch screen,
// and the strip sits directly on the card, whose background this already is --
// so the border is the whole of the affordance. (The class is kept identical to
// the sibling report tables that ship this strip; the copies are one of the
// duplications the converted-table consolidation pass folds into one home.)
//
// This is the WIDEST strip of the converted family: eight fields, against the
// five and six the sibling reports carry. In a long-caption locale that is
// seven wrapped lines at 320px. Dropping controls is not the alternative --
// `reports.category-performance.sort` persists any of the eight, so a field
// with no control anywhere would leave a phone POINTING at a sort with no
// pointer back. What the strip restores is the tap; it inherits
// `SortableHeader`'s pre-existing gap for a keyboard or switch user (a `<th>`
// with an `onClick` and no `tabIndex`, `role` or key handler), which is shared
// by every report table and is a separate fix.
const PHONE_HEADER_CLASS =
  'rounded border border-gray-200 bg-white px-2 py-1.5 text-xs font-medium text-gray-500 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-400 uppercase';

// A figure cell inside a wrapped row: no padding of its own below `sm` and
// this table's own from `sm` up, which each cell adds through `cellPadding` so
// "which column is last" stays decided in one place. Smaller type on phones so
// an eight-figure amount still fits half the width.
//
// `whitespace-nowrap` is the one property here that is NOT phone-only, and it
// is deliberate: `formatCurrencyCompact` groups thousands, and a locale that
// groups them with a space (`1 234 567 CHF`) could otherwise break a figure in
// the middle at any width -- which is exactly what this table does today, at
// every width including the desktop one. That is the single respect in which
// the `sm`-and-up cell differs from today's, and it has a measured price:
// refusing to break a figure raises the table's own minimum width, so at 800px
// the wrapper starts scrolling sooner (704px of table in a 704px box before,
// 823px after, with the worst-case content below). A figure cut in half is
// worse than a wrapper that scrolls, and the wrapper is there for it.
//
// The budget was measured on a hand-written CSS replica in Chromium, at the
// insets this table really gets (the report page's `px-4` plus the card's
// `p-4`): 256px of content at 320px and 326px at 390px. Two EQUAL
// `minmax(0,1fr)` tracks, resolved off `getComputedStyle` rather than divided
// out: 122px each at 320px and 157px each at 390px. Equal tracks rather than
// an `auto` one for the identity, and that is not a stylistic choice: each
// `<tr>` is its OWN grid, so an `auto` track sized by one row's content would
// land at a different width in the next row and step the figure column left
// and right down the card -- a ragged edge only a screenshot shows.
//
// The formatter is `formatCurrencyCompact` (no decimals), and the widest unit
// it can produce is not a symbol: it asks for `narrowSymbol`, which falls back
// to the three-letter ISO code where a currency has none -- so CHF is the
// worst case, wider than the weak currencies whose figures run longest (IDR,
// VND and KRW all have a one- or two-character narrow symbol). Measured at
// `text-xs`: a seven-figure `1 456 789 CHF` is 89px, a NEGATIVE seven-figure
// one 94px, and `+12 345 678 CHF` -- the worst case for Total Variance, which
// is a SUM over up to twelve months and so runs an order of magnitude above
// the averages beside it -- is 107px. All inside the 122px track at 320px,
// with the widest measured overflow across every figure cell in every locale
// being zero. A TEN-figure `1 234 567 890 CHF` is 116px and still fits.
//
// The figures are the server's, not an English fixture's: `avgPercent` is
// `Math.round(avgPercent * 10) / 10` with NO ceiling, so a category budgeted
// 10 against 12,345.68 spent renders `123456.8%` (69px); `overCount/monthCount`
// runs to `12/12` (35px, the months selector offers 3/6/12); and the trend is
// a catalogue WORD rather than a glyph -- `Стабильно` is 68px and the
// pseudo-locale's `[XX-Down-XX]` 84px.
//
// THREE tracks were measured and rejected twice over: a third of the same box
// is 77px at 320px, which the 89px seven-figure amount overflows by 12px and
// the 107px variance by 30px -- and twelve catalogue captions overflow it too
// (`Dépassement/Total` by 36px, `% wykorzystania` by 12px). Two tracks, and
// therefore four lines for eight columns, is what this box can hold.
//
// The caption inside the cell wraps even though the cell does not:
// `white-space` is inherited, so `CellLabel` takes `whitespace-normal` back
// for itself. A number must not break; a caption may.
//
// And a caption that CANNOT break is what sizes a layout like this, not the
// money -- so every string in the catalogue for all six captioned columns (120
// strings across 20 locales) was rendered into the 122px a track gets at
// 320px, at `CellLabel`'s own type. NONE of them overflows, and the six that
// need a second line are named here in full so a catalogue edit can be
// re-measured against a list rather than against a count: `Presupuesto
// promedio` (es, Avg Budget), `Середнє планування` (uk, Avg Budget),
// `Загальне відхилення` (uk, Total Variance), `[XX-Total Variance-XX]` (xx),
// and the two -- measured, not assumed -- that Chromium breaks after the
// solidus, `Przekroczone/Łącznie` (pl) and `Перевищення/Разом` (uk), both
// Over/Total. So no column takes a spanning track. Those six cells are 41px
// instead of 29px at 320px in their own locales, which is a documented cost
// rather than a defect: rule 2 forbids the shorter catalogue key that would
// avoid it. Over/Total is nonetheless placed in the LEFT track, because a
// caption that one day loses its break opportunity spends the 12px column gap
// there rather than reopening the wrapper's sideways scroll.
const FIGURE_CELL = 'p-0 text-right text-xs whitespace-nowrap sm:table-cell sm:text-sm';

// The Trend cell is laid out like a figure and is NOT one: it renders a
// translated word (`Up`, `Стабильно`, `Bez zmian`, `A descer`) or the `--` a
// series of fewer than two points produces. `FIGURE_CELL`'s nowrap exists so a
// space-grouped THOUSANDS separator cannot split a number, and a word is not a
// number -- applying it here would forbid a wrap this table allows today and
// widen the desktop table's own minimum for nothing. So the trend keeps every
// other property of a figure cell and lets its word wrap, exactly as it does
// now. On a phone it never has to: the widest trend string in the catalogue,
// the pseudo-locale's `[XX-Down-XX]`, is 84px in a 122px track at 320px.
const WORD_CELL = 'p-0 text-right text-xs sm:table-cell sm:text-sm';

/** Every caption in a wrapped cell is phone-only. */
const CAPTION_CLASS = 'sm:hidden';

export function CategoryPerformanceReport() {
  const t = useTranslations('reports');
  const { formatCurrencyCompact: formatCurrency, formatPercentTrimmed } = useNumberFormat();

  const getTrendArrow = (values: number[]): { arrow: string; color: string } => {
    if (values.length < 2) return { arrow: '--', color: 'text-gray-400' };
    const recent = values.slice(-3);
    const earlier = values.slice(0, Math.max(1, values.length - 3));
    const recentAvg = recent.reduce((s, v) => s + v, 0) / recent.length;
    const earlierAvg = earlier.reduce((s, v) => s + v, 0) / earlier.length;
    if (earlierAvg === 0) return { arrow: '--', color: 'text-gray-400' };
    const change = ((recentAvg - earlierAvg) / earlierAvg) * 100;
    if (change > 10) return { arrow: t('categoryPerformance.trendUp'), color: 'text-red-600 dark:text-red-400' };
    if (change < -10) return { arrow: t('categoryPerformance.trendDown'), color: 'text-green-600 dark:text-green-400' };
    return { arrow: t('categoryPerformance.trendFlat'), color: 'text-gray-500 dark:text-gray-400' };
  };

  const getStatusBadge = (avgPercent: number): { label: string; className: string } => {
    if (avgPercent <= 80) {
      return { label: t('categoryPerformance.statusUnderBudget'), className: 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300' };
    }
    if (avgPercent <= 100) {
      return { label: t('categoryPerformance.statusOnTrack'), className: 'bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-300' };
    }
    return { label: t('categoryPerformance.statusOverBudget'), className: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300' };
  };
  const [budgets, setBudgets] = useState<Budget[]>([]);
  const [selectedBudgetId, setSelectedBudgetId] = useState<string>('');
  const [months, setMonths] = useState(6);
  const { sortField, sortDirection, handleSort } = useSortableTable<CategoryPerformanceSortField>(
    'reports.category-performance.sort',
    { field: 'avgPercent', direction: 'desc' },
  );

  useEffect(() => {
    const loadBudgets = async () => {
      try {
        const data = await budgetsApi.getAll();
        setBudgets(data);
        const active = data.find((b) => b.isActive);
        if (active) {
          setSelectedBudgetId(active.id);
        } else if (data.length > 0) {
          setSelectedBudgetId(data[0].id);
        }
      } catch (error) {
        logger.error('Failed to load budgets:', error);
      }
    };
    loadBudgets();
  }, []);

  const { data: response, isLoading, error, reload } = useReportData(
    () =>
      selectedBudgetId
        ? budgetsApi.getCategoryTrend(selectedBudgetId, months)
        : Promise.resolve<CategoryTrendSeries[]>([]),
    [selectedBudgetId, months],
  );

  const categoryData = useMemo<CategoryTrendSeries[]>(() => response ?? [], [response]);

  const processedData = useMemo<CategoryPerformanceRow[]>(() => {
    return categoryData.map((series) => {
      const monthData = series.data;
      const avgBudgeted = monthData.length > 0
        ? monthData.reduce((s, d) => s + d.budgeted, 0) / monthData.length
        : 0;
      const avgActual = monthData.length > 0
        ? monthData.reduce((s, d) => s + d.actual, 0) / monthData.length
        : 0;
      const avgPercent = avgBudgeted > 0
        ? (avgActual / avgBudgeted) * 100
        : 0;
      const totalVariance = monthData.reduce((s, d) => s + (d.actual - d.budgeted), 0);
      const percentages = monthData.map((d) =>
        d.budgeted > 0 ? (d.actual / d.budgeted) * 100 : 0,
      );
      const trend = getTrendArrow(percentages);
      const status = getStatusBadge(avgPercent);
      const overCount = monthData.filter((d) => d.actual > d.budgeted).length;

      return {
        categoryId: series.categoryId,
        categoryName: series.categoryName,
        avgBudgeted,
        avgActual,
        avgPercent: Math.round(avgPercent * 10) / 10,
        totalVariance,
        trend,
        status,
        overCount,
        monthCount: monthData.length,
        monthData,
      };
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [categoryData, t]);

  const sortedData = useMemo(() => {
    const sorted = [...processedData];
    sorted.sort((a, b) => {
      let comparison = 0;
      switch (sortField) {
        case 'name':
          comparison = compareValues(a.categoryName, b.categoryName);
          break;
        case 'avgBudgeted':
          comparison = compareValues(a.avgBudgeted, b.avgBudgeted);
          break;
        case 'avgActual':
          comparison = compareValues(a.avgActual, b.avgActual);
          break;
        case 'avgPercent':
          comparison = compareValues(a.avgPercent, b.avgPercent);
          break;
        case 'variance':
          comparison = compareValues(a.totalVariance, b.totalVariance);
          break;
        case 'overCount':
          comparison = compareValues(a.overCount, b.overCount);
          break;
        case 'trend':
          comparison = compareValues(a.trend.arrow, b.trend.arrow);
          break;
        case 'status':
          comparison = compareValues(a.status.label, b.status.label);
          break;
      }
      return sortDirection === 'asc' ? comparison : -comparison;
    });
    return sorted;
  }, [processedData, sortField, sortDirection]);

  // The eight sortable columns, keyed by field so the record is exhaustive and
  // each entry must name its own key (see `SortColumnsByField`).
  const columns: SortColumnsByField = {
    name: {
      field: 'name',
      label: t('categoryPerformance.colCategory'),
      value: (row) => row.categoryName,
    },
    avgBudgeted: {
      field: 'avgBudgeted',
      label: t('categoryPerformance.colAvgBudget'),
      value: (row) => formatCurrency(row.avgBudgeted),
      align: 'right',
    },
    avgActual: {
      field: 'avgActual',
      label: t('categoryPerformance.colAvgActual'),
      value: (row) => formatCurrency(row.avgActual),
      align: 'right',
    },
    avgPercent: {
      field: 'avgPercent',
      label: t('categoryPerformance.colPercentUsed'),
      value: (row) => formatPercentTrimmed(row.avgPercent),
      align: 'right',
    },
    variance: {
      field: 'variance',
      label: t('categoryPerformance.colTotalVariance'),
      value: (row) => `${row.totalVariance > 0 ? '+' : ''}${formatCurrency(row.totalVariance)}`,
      align: 'right',
    },
    overCount: {
      field: 'overCount',
      label: t('categoryPerformance.colOverTotal'),
      value: (row) => `${row.overCount}/${row.monthCount}`,
      align: 'center',
    },
    trend: {
      field: 'trend',
      label: t('categoryPerformance.colTrend'),
      value: (row) => row.trend.arrow,
      align: 'center',
    },
    status: {
      field: 'status',
      label: t('categoryPerformance.colStatus'),
      value: (row) => row.status.label,
      align: 'center',
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
    // Each value function is locale-aware (currency through formatCurrency,
    // percent through formatPercentTrimmed), so the export matches the screen.
    const headers = sortColumns.map((col) => col.label);
    const rows = sortedData.map((row) => sortColumns.map((col) => col.value(row)));
    await exportToPdf({
      title: t('page.names.category-performance' as Parameters<typeof t>[0]),
      tableData: { headers, rows },
      filename: 'category-performance',
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
          {t('categoryPerformance.noBudgets')}
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Controls */}
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-4">
        <div className="flex flex-wrap gap-3 items-center">
          <select
            value={selectedBudgetId}
            onChange={(e) => setSelectedBudgetId(e.target.value)}
            className="px-3 py-2 text-sm border border-gray-300 dark:border-gray-600 rounded-md bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100"
          >
            {budgets.map((b) => (
              <option key={b.id} value={b.id}>{b.name}</option>
            ))}
          </select>
          <select
            value={months}
            onChange={(e) => setMonths(Number(e.target.value))}
            className="px-3 py-2 text-sm border border-gray-300 dark:border-gray-600 rounded-md bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100"
          >
            <option value={3}>{t('categoryPerformance.months3')}</option>
            <option value={6}>{t('categoryPerformance.months6')}</option>
            <option value={12}>{t('categoryPerformance.months12')}</option>
          </select>
          <div className="ml-auto">
            <ExportDropdown onExportPdf={handleExportPdf} />
          </div>
        </div>
      </div>

      {/* Table */}
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-4 sm:p-6">
        {sortedData.length === 0 ? (
          <p className="text-gray-500 dark:text-gray-400 text-center py-8">
            {t('categoryPerformance.noData')}
          </p>
        ) : (
          /* Below `sm` the table becomes a block and each row wraps into a
             two-column grid of EQUAL `minmax(0,1fr)` tracks (for the reason
             `FIGURE_CELL` measures), so all EIGHT columns fit a phone without a
             horizontal scroll, on FOUR lines:

               1  category name          | total variance
               2  avg budget             | avg actual
               3  over/total months      | % used
               4  status pill            | trend

             Four lines rather than three because eight columns over two tracks
             cannot be fewer, and two tracks is what this box holds -- a third
             track is 77px at 320px, which both the money and twelve catalogue
             captions overflow (`FIGURE_CELL` has the numbers). It is the
             widest table this layout has carried.

             The pairing is the report's own reading: the row is read for what
             the category cost against what it was given, so the money figure
             the whole row summarises -- the total variance -- sits beside the
             name, with the two averages it is the difference of on line 2 and
             the two ways of expressing the same overrun on line 3 (how many
             months went over, and how much of the budget was used). The two
             verdicts derived from all of it close the card on line 4. Each
             right-hand cell sits under the one it derives from: % used under
             avg actual, trend under % used.

             The status pill and the trend are separate columns, so they are
             two grid items and cannot share one area with the name: the pill
             takes the left of line 4. It carries no caption -- a coloured
             status chip names itself -- and below `sm` it becomes an inline
             BLOCK capped at the track, so a label too wide for a 122px track
             (`Au-dessus du budget`, `Melebihi Anggaran`) wraps inside ONE
             rounded rectangle instead of splitting into two ragged inline
             fragments. That pair of classes is phone-only; from `sm` up the
             pill's markup resolves exactly as it does today.

             The category name is UNBOUNDED (the server sends `Parent: Child`),
             so it sits in a `minmax(0,1fr)` track with `min-w-0`: a track that
             may be zero plus a cell that may be narrower than its own content
             is what lets a long name shrink instead of setting the table's
             minimum width. It is not clamped -- a clamp would CUT the tail of
             a name that no other surface shows in full, and containment here
             does not need one: `break-words` breaks a word too long for the
             track (Russian category names run to 15 characters before a
             space), and the measured 40-character name renders whole on three
             lines at 320px inside a 122px track. `sm:break-normal` hands
             today's wrapping back from `sm` up.

             From `sm` up it is the ordinary table: each cell restores this
             table's own `py-2.5 pr-4` (and the last column's bare `py-2.5`)
             through `cellPadding`, against `py-2` on the header cells --
             an asymmetry this table has always had. A Chromium replica renders
             it pixel-identically to today at 800px in every locale. The one
             deliberate difference above `sm` is `whitespace-nowrap` on the
             five cells that hold a NUMBER, for the reason `FIGURE_CELL` gives
             -- the trend, which holds a word, keeps today's wrapping
             (`WORD_CELL`). The sort controls survive as their own phone-only
             header row, because the column header row that carries them on
             desktop is hidden there.

             Two costs of restyling one tree, both deliberate. Changing the
             display roles drops the table semantics below `sm`, which is why
             the roles are restated explicitly and every figure carries a
             `CellLabel` naming its column -- the category needs none, being
             the row's identity rather than one of its figures, and neither
             does the status pill. And the phone reading order differs from the
             DOM order, which is the desktop column order the grid placement
             overrides visually. Both are properties of the mechanism, not of
             this table. */
          <div className="overflow-x-auto">
            <table role="table" className="block min-w-full text-sm sm:table">
              <thead role="rowgroup" className="block sm:table-header-group">
                {/* Phone sort strip: the same eight controls, wrapped. */}
                <tr role="row" className="flex flex-wrap gap-x-2 gap-y-1 pb-2 border-b border-gray-200 dark:border-gray-700 sm:hidden">
                  {sortColumns.map((col) => (
                    <SortableHeader<CategoryPerformanceSortField>
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
                    <SortableHeader<CategoryPerformanceSortField>
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
                {sortedData.map((row) => (
                  <tr
                    key={row.categoryId}
                    role="row"
                    className="grid grid-cols-2 items-start gap-x-3 gap-y-1.5 py-2.5 border-b border-gray-100 dark:border-gray-700/50 sm:table-row sm:py-0"
                  >
                    <td
                      role="cell"
                      className={`col-start-1 row-start-1 min-w-0 break-words p-0 text-gray-900 dark:text-gray-100 font-medium sm:table-cell sm:break-normal ${cellPadding(columns.name)}`}
                    >
                      {columns.name.value(row)}
                    </td>
                    <td role="cell" className={`col-start-1 row-start-2 text-gray-600 dark:text-gray-400 ${cellPadding(columns.avgBudgeted)} ${FIGURE_CELL}`}>
                      <CellLabel className={CAPTION_CLASS}>{columns.avgBudgeted.label}</CellLabel>
                      {columns.avgBudgeted.value(row)}
                    </td>
                    <td role="cell" className={`col-start-2 row-start-2 text-gray-600 dark:text-gray-400 ${cellPadding(columns.avgActual)} ${FIGURE_CELL}`}>
                      <CellLabel className={CAPTION_CLASS}>{columns.avgActual.label}</CellLabel>
                      {columns.avgActual.value(row)}
                    </td>
                    {/* Percent used sits under the actual it is a share of. */}
                    <td role="cell" className={`col-start-2 row-start-3 font-medium ${percentUsedColor(row.avgPercent)} ${cellPadding(columns.avgPercent)} ${FIGURE_CELL}`}>
                      <CellLabel className={CAPTION_CLASS}>{columns.avgPercent.label}</CellLabel>
                      {columns.avgPercent.value(row)}
                    </td>
                    {/* The total variance takes the right of line 1 beside the
                        category: it is the figure the row is read for. */}
                    <td role="cell" className={`col-start-2 row-start-1 font-medium ${varianceColor(row.totalVariance)} ${cellPadding(columns.variance)} ${FIGURE_CELL}`}>
                      <CellLabel className={CAPTION_CLASS}>{columns.variance.label}</CellLabel>
                      {columns.variance.value(row)}
                    </td>
                    {/* Over/Total and Trend are centred columns from `sm` up;
                        on a phone they are right-aligned like every other
                        figure in their track. */}
                    <td role="cell" className={`col-start-1 row-start-3 text-gray-600 dark:text-gray-400 sm:text-center ${cellPadding(columns.overCount)} ${FIGURE_CELL}`}>
                      <CellLabel className={CAPTION_CLASS}>{columns.overCount.label}</CellLabel>
                      {columns.overCount.value(row)}
                    </td>
                    <td role="cell" className={`col-start-2 row-start-4 font-medium ${row.trend.color} sm:text-center ${cellPadding(columns.trend)} ${WORD_CELL}`}>
                      <CellLabel className={CAPTION_CLASS}>{columns.trend.label}</CellLabel>
                      {columns.trend.value(row)}
                    </td>
                    <td role="cell" className={`col-start-1 row-start-4 min-w-0 p-0 sm:table-cell sm:text-center ${cellPadding(columns.status)}`}>
                      <span className={`px-2 py-0.5 text-xs font-medium rounded max-sm:inline-block max-sm:max-w-full ${row.status.className}`}>
                        {columns.status.value(row)}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
