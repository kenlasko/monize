'use client';

import { useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from 'recharts';
import { chartSeriesColor } from '@/lib/chart-colors';
import { CellLabel } from '@/components/ui/Table';
import type { CategoryTrendSeries } from '@/types/budget';

interface BudgetCategoryTrendProps {
  data: CategoryTrendSeries[];
  formatCurrency: (amount: number) => string;
}

// A money cell of the averages table inside a wrapped row: no padding of its
// own below `sm` (the row supplies the vertical inset and the grid does the
// spacing) and this table's own from `sm` up. Smaller type on phones.
//
// `whitespace-nowrap` is the one property here that is NOT phone-only, and it
// is deliberate: the compact formatter groups thousands, and a locale that
// groups them with a space (`1 234 567 zł`) could otherwise break a figure in
// the middle at any width -- so the ban holds above `sm` too. That is the
// single respect in which the desktop cell differs from today's.
//
// The budget was measured on a hand-written CSS replica in Chromium at the
// insets this table really gets on a phone (the report page's `px-4` plus this
// card's `p-4`): 256px of content at 320px and 326px at 390px, so the two
// equal tracks are 122px and 157px wide. The formatter is
// `formatCurrencyCompact` (no decimals) and the widest unit it can produce is
// the three-letter ISO code `narrowSymbol` falls back to, so the widest cell
// is the variance, which wears `font-medium` and a `+` sign at once:
// `+1 456 789 CHF` measures 99px at `text-xs` and `+12 345 678 CHF` 107px --
// both inside the 122px track at 320px. Nothing in this table overflows at
// either width; the halved column count is what buys that.
//
// The caption inside the cell wraps even though the cell does not:
// `white-space` is inherited, so `CellLabel` takes `whitespace-normal` back
// for itself. A number must not break; a caption may.
const MONEY_CELL = 'p-0 text-right text-xs whitespace-nowrap sm:table-cell sm:text-sm';

// Today's body cell padding, restored from `sm` up and absent below it. The
// last column (the variance) carries no right padding, exactly as it does
// today, and its header cell says the same thing one line further down.
const CELL_PADDING = 'sm:py-2 sm:pr-4';
const LAST_CELL_PADDING = 'sm:py-2';

/** Every caption in a wrapped cell is phone-only. */
const CAPTION_CLASS = 'sm:hidden';

function CategoryTrendTooltip({
  active,
  payload,
  label,
  formatCurrency,
}: {
  active?: boolean;
  payload?: Array<{
    value: number;
    dataKey: string;
    color: string;
    name: string;
  }>;
  label?: string;
  formatCurrency: (amount: number) => string;
}) {
  if (!active || !payload || payload.length === 0) return null;

  return (
    <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg shadow-lg p-3 max-w-xs">
      <p className="text-sm font-medium text-gray-900 dark:text-gray-100 mb-2">
        {label}
      </p>
      {payload.map((entry) => (
        <div
          key={entry.dataKey}
          className="flex justify-between gap-4 text-sm"
        >
          <span style={{ color: entry.color }}>{entry.name}</span>
          <span className="font-medium text-gray-700 dark:text-gray-300">
            {formatCurrency(entry.value)}
          </span>
        </div>
      ))}
    </div>
  );
}

export function BudgetCategoryTrend({
  data,
  formatCurrency,
}: BudgetCategoryTrendProps) {
  const t = useTranslations('budgets');
  // The four column labels, read once. Both the column header row (from `sm`
  // up) and the per-cell captions that replace it on a phone come from here,
  // so a caption cannot go on naming a column the header has renamed.
  const columnLabels = {
    category: t('categoryTrend.tableHeaders.category'),
    avgBudget: t('categoryTrend.tableHeaders.avgBudget'),
    avgActual: t('categoryTrend.tableHeaders.avgActual'),
    avgVariance: t('categoryTrend.tableHeaders.avgVariance'),
  };
  const [selectedCategories, setSelectedCategories] = useState<Set<string>>(
    () => new Set(data.map((s) => s.categoryId)),
  );

  const chartData = useMemo(() => {
    if (data.length === 0) return [];

    // Collect all months across all series
    const monthSet = new Set<string>();
    for (const series of data) {
      for (const point of series.data) {
        monthSet.add(point.month);
      }
    }

    const months = Array.from(monthSet);

    // Build chart data: one entry per month with each category as a field
    return months.map((month) => {
      const entry: Record<string, unknown> = { month };
      for (const series of data) {
        if (!selectedCategories.has(series.categoryId)) continue;
        const point = series.data.find((p) => p.month === month);
        entry[series.categoryId] = point?.actual ?? 0;
      }
      return entry;
    });
  }, [data, selectedCategories]);

  const toggleCategory = (categoryId: string) => {
    setSelectedCategories((prev) => {
      const next = new Set(prev);
      if (next.has(categoryId)) {
        next.delete(categoryId);
      } else {
        next.add(categoryId);
      }
      return next;
    });
  };

  if (data.length === 0) {
    return (
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-4 sm:p-6">
        <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-4">
          {t('categoryTrend.title')}
        </h2>
        <p className="text-sm text-gray-500 dark:text-gray-400">
          {t('categoryTrend.empty')}
        </p>
      </div>
    );
  }

  return (
    <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-4 sm:p-6">
      <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-4">
        {t('categoryTrend.title')}
      </h2>

      {/* Category toggles */}
      <div className="flex flex-wrap gap-2 mb-4">
        {data.map((series, idx) => {
          const color = chartSeriesColor(idx);
          const isSelected = selectedCategories.has(series.categoryId);
          return (
            <button
              key={series.categoryId}
              onClick={() => toggleCategory(series.categoryId)}
              className={`px-3 py-1 text-xs font-medium rounded-full border transition-colors ${
                isSelected
                  ? 'text-white border-transparent'
                  : 'text-gray-500 dark:text-gray-400 border-gray-300 dark:border-gray-600 bg-transparent'
              }`}
              style={isSelected ? { backgroundColor: color } : undefined}
              data-testid={`category-toggle-${series.categoryId}`}
            >
              {series.categoryName}
            </button>
          );
        })}
      </div>

      {/* Chart */}
      <div className="h-72" data-testid="category-trend-chart">
        <ResponsiveContainer width="100%" height="100%" minWidth={0}>
          <LineChart data={chartData}>
            <CartesianGrid strokeDasharray="3 3" className="opacity-30" />
            <XAxis
              dataKey="month"
              tick={{ fontSize: 12 }}
              className="text-gray-500"
            />
            <YAxis
              tick={{ fontSize: 12 }}
              className="text-gray-500"
              tickFormatter={(value) => formatCurrency(value)}
            />
            <Tooltip
              content={
                <CategoryTrendTooltip formatCurrency={formatCurrency} />
              }
            />
            {/* No `<Legend />`: the toggle pills above the chart already name
                every series in its own colour, and on a phone the recharts
                legend -- one entry per category, wrapped over several lines
                inside a 288px-tall container -- grew taller than the plot and
                was drawn up over those pills, so each name showed twice, one
                on top of the other. The pills are the legend. */}
            {data.map((series, idx) => {
              if (!selectedCategories.has(series.categoryId)) return null;
              const color = chartSeriesColor(idx);
              return (
                <Line
                  key={series.categoryId}
                  type="monotone"
                  dataKey={series.categoryId}
                  stroke={color}
                  strokeWidth={2}
                  dot={{ r: 3 }}
                  name={series.categoryName}
                />
              );
            })}
          </LineChart>
        </ResponsiveContainer>
      </div>

      {/* Summary table.

          Below `sm` the table becomes a block and each row wraps into a
          two-column grid so all four columns fit a phone without a horizontal
          scroll, on two lines: the category and its average variance share
          line 1; the average budget and average actual share line 2. The row
          is read for the variance, so that is the figure beside the identity,
          and the two figures it is the difference of sit beneath it. The
          category name is the one cell allowed to wrap, since a compact amount
          never may.

          The name is UNBOUNDED, so it sits in a `minmax(0,1fr)` track with
          `min-w-0`: a track that may be zero plus a cell that may be narrower
          than its own content is what lets a long name shrink instead of
          setting the table's minimum width. It is not clamped -- a clamp
          would CUT the tail of a name that no other surface shows in full, and
          containment here does not need one: `break-words` breaks a word too
          long for the track (Russian category names run to 15 characters
          before a space), and the measured 40-character name renders whole on
          three lines. `sm:break-normal` hands today's wrapping back from `sm`
          up, where the column is wide enough.

          There is NO phone sort strip, because this header holds no controls:
          these four `<th>`s are plain labels, the table is not sortable at any
          width, and a control row would be an affordance that does nothing.
          The header row is simply hidden below `sm`, and each figure carries a
          `CellLabel` naming its column in its place -- reusing the header's
          own catalogue keys.

          From `sm` up it is the ordinary table: each cell restores this
          table's own `py-2 pr-4` (and the variance column's bare `py-2`), and
          a Chromium replica renders it pixel-identically to today at 800px.
          The one deliberate difference above `sm` is `whitespace-nowrap` on
          the figures, for the reason `MONEY_CELL` gives.

          Two costs of restyling one tree, both deliberate: the display change
          drops the table semantics below `sm`, which is why the roles are
          restated explicitly; and the phone reading order differs from the DOM
          order, which is the desktop column order the grid placement overrides
          visually. */}
      <div className="mt-4 overflow-x-auto">
        <table role="table" className="block min-w-full text-sm sm:table">
          <thead role="rowgroup" className="block sm:table-header-group">
            <tr role="row" className="hidden text-left text-gray-500 dark:text-gray-400 border-b border-gray-200 dark:border-gray-700 sm:table-row">
              <th role="columnheader" className="py-2 pr-4 font-medium">{columnLabels.category}</th>
              <th role="columnheader" className="py-2 pr-4 font-medium text-right">{columnLabels.avgBudget}</th>
              <th role="columnheader" className="py-2 pr-4 font-medium text-right">{columnLabels.avgActual}</th>
              <th role="columnheader" className="py-2 font-medium text-right">{columnLabels.avgVariance}</th>
            </tr>
          </thead>
          <tbody role="rowgroup" className="block sm:table-row-group">
            {data.map((series) => {
              const avgBudgeted =
                series.data.length > 0
                  ? series.data.reduce((s, d) => s + d.budgeted, 0) /
                    series.data.length
                  : 0;
              const avgActual =
                series.data.length > 0
                  ? series.data.reduce((s, d) => s + d.actual, 0) /
                    series.data.length
                  : 0;
              const avgVariance = avgActual - avgBudgeted;

              return (
                <tr
                  key={series.categoryId}
                  role="row"
                  className="grid grid-cols-2 items-start gap-x-3 gap-y-1.5 py-2 border-b border-gray-100 dark:border-gray-700/50 sm:table-row sm:py-0"
                >
                  <td
                    role="cell"
                    className={`col-start-1 row-start-1 min-w-0 break-words p-0 text-gray-900 dark:text-gray-100 sm:table-cell sm:break-normal ${CELL_PADDING}`}
                  >
                    {series.categoryName}
                  </td>
                  <td role="cell" className={`col-start-1 row-start-2 text-gray-600 dark:text-gray-400 ${CELL_PADDING} ${MONEY_CELL}`}>
                    <CellLabel className={CAPTION_CLASS}>{columnLabels.avgBudget}</CellLabel>
                    {formatCurrency(avgBudgeted)}
                  </td>
                  <td role="cell" className={`col-start-2 row-start-2 text-gray-600 dark:text-gray-400 ${CELL_PADDING} ${MONEY_CELL}`}>
                    <CellLabel className={CAPTION_CLASS}>{columnLabels.avgActual}</CellLabel>
                    {formatCurrency(avgActual)}
                  </td>
                  {/* The variance takes the right of line 1 beside the
                      category: it is the figure the row is read for. It is
                      also the last column, so it drops its right padding. */}
                  <td
                    role="cell"
                    className={`col-start-2 row-start-1 font-medium ${
                      avgVariance > 0
                        ? 'text-red-600 dark:text-red-400'
                        : 'text-green-600 dark:text-green-400'
                    } ${LAST_CELL_PADDING} ${MONEY_CELL}`}
                  >
                    <CellLabel className={CAPTION_CLASS}>{columnLabels.avgVariance}</CellLabel>
                    {avgVariance > 0 ? '+' : ''}
                    {formatCurrency(avgVariance)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
