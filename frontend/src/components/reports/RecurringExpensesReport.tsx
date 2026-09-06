'use client';

import { useState, useMemo, useRef } from 'react';
import { useTranslations } from 'next-intl';
import { Skeleton } from '@/components/ui/LoadingSkeleton';
import { useRouter } from 'next/navigation';
import {
  PieChart,
  Pie,
  Cell,
  ResponsiveContainer,
  Tooltip,
} from 'recharts';
import { format } from 'date-fns';
import { builtInReportsApi } from '@/lib/built-in-reports';
import { RecurringExpenseItem } from '@/types/built-in-reports';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import { chartSeriesColor } from '@/lib/chart-colors';
import { resolvePdfColor } from '@/components/reports/resolve-pdf-color';
import { exportToCsv } from '@/lib/csv-export';
import { ExportDropdown } from '@/components/ui/ExportDropdown';
import { SortableHeader } from '@/components/ui/SortableHeader';
import { CellLabel } from '@/components/ui/Table';
import { useSortableTable, compareValues } from '@/hooks/useSortableTable';
import { useReportData } from '@/hooks/useReportData';
import { ReportError } from '@/components/reports/ReportError';

type RecurringSortField = 'payee' | 'category' | 'frequency' | 'count' | 'average' | 'total' | 'lastPaid';

/**
 * One sortable column of the table. The seven are declared once and rendered by
 * BOTH header rows -- the column header row (from `sm` up) and the phone sort
 * strip -- so the two can never list different fields, each captioned value
 * cell takes its phone caption from the same entry as its header, and the CSV /
 * PDF export builds its headings and its cells from that same ordered record.
 */
interface SortColumn {
  field: RecurringSortField;
  label: string;
  /** How the column header aligns from `sm` up; the cells restate it. */
  align?: 'right' | 'center';
  /**
   * This column's export heading and cell. They are separate from `label`
   * because the catalogue has always carried a second set of keys for the
   * export (`csvCol*`), and this change is a layout change: it moves the
   * export's ORDER onto the record without touching which string the export
   * prints.
   *
   * What the record enforces is that every SORT FIELD is exported: it cannot
   * enforce that every rendered cell is, because the seven value `<td>`s are
   * written out by hand and no type ties them to `sortColumns`. An eighth cell
   * added without a new union member would compile and ship absent from the
   * export; what fails on that is
   * `RecurringExpensesReport.mobileWrapped.test.tsx`, which pins the `<td>`
   * count at seven and against the `<th>` count of each header row.
   */
  csvLabel: string;
  csvValue: (expense: RecurringExpenseItem) => string | number;
}

/**
 * The record the two header rows are built from, keyed by sort field.
 *
 * The key is tied to the entry's own `field`, which a plain
 * `Record<RecurringSortField, SortColumn>` does not do: that forces an entry to
 * EXIST for every member of the union but lets it name a different one, so
 * `average: { field: 'total', ... }` would type-check. Both header rows would
 * then render two controls keyed `total` (a duplicate React key), tapping
 * "Avg Amount" would sort by 6-Mo Total, and "Avg Amount" would be unsortable
 * -- none of which a test comparing header LABELS can see, because the labels
 * stay right. Here it is a compile error instead.
 */
type SortColumnsByField = {
  [K in RecurringSortField]: SortColumn & { field: K };
};

// Today's header cell, unchanged.
const HEADER_CLASS = 'px-4 py-3 text-xs font-medium text-gray-500 dark:text-gray-400 uppercase';

// The same sort controls in the phone strip: a wrapped row of compact chips.
// Column alignment means nothing there -- the column header row is hidden and
// each data row is a grid -- so every control is left-aligned and self-naming.
// The border is what says "tappable": there is no hover on a touch screen, and
// the chip's own fill is a shade off the header band it sits on (this table's
// `<thead>` keeps its `bg-gray-50` / `dark:bg-gray-900/50`). The class is kept
// identical to the sibling report tables that ship this strip; the copies are
// one of the duplications the converted-table consolidation pass folds into one
// home -- `components/ui/` is not this change's to edit.
//
// Seven chips is the second-widest strip of the converted family: measured on
// the Chromium replica at 320px they wrap to four lines in `en`/`pl` (148px),
// five in `ru`/`id`/`de` (182px) and seven in the pseudo-locale (250px) above
// the first row; at 390px, three lines in every real locale. That is a measured
// cost, not a reason to drop a control: `reports.recurring-expenses.sort`
// persists any of the seven, so a field with no control anywhere would leave a
// phone POINTING at a sort with no pointer back.
const PHONE_HEADER_CLASS =
  'rounded border border-gray-200 bg-white px-2 py-1.5 text-xs font-medium text-gray-500 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-400 uppercase';

// A value cell inside a wrapped row: no padding of its own below `sm` and this
// table's own `px-4 py-3` from `sm` up. Smaller type on phones so a
// seven-figure compact amount still fits half the width.
//
// `whitespace-nowrap` is the one property here that CHANGES the desktop
// rendering. It is not the only unprefixed one -- `text-right` applies at every
// width too, and must, because it is the alignment these columns already have
// from `sm` up (Count is the exception and takes its centring back with
// `sm:text-center`). The nowrap is deliberate: `formatCurrencyCompact` groups
// thousands, and a locale that groups them with a space (`1 456 789 CHF`) could
// otherwise break a figure in the middle at any width, which is what this table
// does today. Measured price at 800px on the replica: the rendering is
// pixel-identical to today in `pl`/`ru`/`id`/`de` (their figures already fit
// one line) and differs only in `en` and the pseudo-locale, where the figure
// stops wrapping and the identity columns give the width back. A figure cut in
// half is worse.
//
// The budget was measured on a hand-written CSS replica in Chromium at the
// insets this table really gets -- the report page's `px-4` and the cell's own
// `px-4`, the card contributing NONE (it is `overflow-hidden` with a heading
// row above and no padding) -- so 256px of content at 320px and 326px at 390px.
// Two EQUAL `minmax(0,1fr)` tracks, resolved off `getComputedStyle`: 122px each
// at 320px and 157px each at 390px. Equal tracks rather than an `auto` one for
// the identity because each `<tr>` is its OWN grid, so an `auto` track sized by
// one row's content would land at a different width in the next row and step
// the figure column left and right down the card.
//
// The formatter is `formatCurrencyCompact` (no decimals) and the widest unit it
// can produce is not a symbol: it asks for `narrowSymbol`, which falls back to
// the three-letter ISO code where a currency has none, so CHF is the worst
// case. The two money cells do NOT share a worst case: the server computes
// `averageAmount = totalAmount / occurrences` over at least the two occurrences
// the minimum-occurrences selector floors at, so the 6-Mo Total beside it is
// never narrower than the average and runs from twice it at that floor to
// about twenty-six times it on a weekly row -- a digit or two more, on the one
// of the pair that is also bold. So the budget is stated on the TOTAL, at
// `text-xs` and `font-medium`,
// space-grouped: seven figures `1 456 789 CHF` 89px, eight 97px, nine 104px,
// ten `1 234 567 890 CHF` 116px -- all inside the 122px track at 320px -- and
// eleven 124px, the first past it by 2px. Ten figures of CHF is the stated
// ceiling at 320px; at 390px (157px tracks) even twelve fits at 131px. The
// widest measured value overflow across every figure cell in every locale at
// the seven-figure worst case is zero. The occurrence COUNT is a count over six
// months: `128` is 23px.
//
// THREE tracks were measured and rejected: a third of the same box is 77px at
// 320px, which the 89px seven-figure amount overflows by 12px -- in EVERY
// locale, and for BOTH money cells -- and a right-track figure past its track
// reopens the wrapper's sideways scroll. Two tracks, and therefore four lines
// for seven columns, is what this box can hold.
const MONEY_CELL = 'p-0 text-right text-xs whitespace-nowrap sm:table-cell sm:px-4 sm:py-3 sm:text-sm';

// Last Paid is a WORD-shaped value, not a number: `format(..., 'MMM d')`
// renders `Sep 5` (34px at `text-xs`). It resolves to the same rendering as a
// figure cell today -- including the nowrap, because a date is one label and
// breaking it after `Sep` reads as two values -- and it is spelled out rather
// than aliased to `MONEY_CELL` deliberately: the two hold the same string for
// different reasons, and an alias would carry a money-driven edit (dropping the
// nowrap because a formatter stopped grouping, widening the type for a longer
// figure) silently onto the date.
const DATE_CELL = 'p-0 text-right text-xs whitespace-nowrap sm:table-cell sm:px-4 sm:py-3 sm:text-sm';

/** Every caption in a wrapped cell is phone-only. */
const CAPTION_CLASS = 'sm:hidden';

export function RecurringExpensesReport() {
  const t = useTranslations('reports');
  const router = useRouter();
  const { formatCurrencyCompact: formatCurrency } = useNumberFormat();
  const chartRef = useRef<HTMLDivElement>(null);
  const [minOccurrences, setMinOccurrences] = useState(3);
  const { sortField, sortDirection, handleSort } = useSortableTable<RecurringSortField>(
    'reports.recurring-expenses.sort',
    { field: 'total', direction: 'desc' },
  );

  const { data: recurringData, isLoading, error, reload } = useReportData(
    () => builtInReportsApi.getRecurringExpenses(minOccurrences),
    [minOccurrences],
  );

  const sortedExpenses = useMemo(() => {
    if (!recurringData) return [];
    const sorted = [...recurringData.data].sort((a, b) => {
      let comparison = 0;
      switch (sortField) {
        case 'payee':
          comparison = compareValues(a.payeeName, b.payeeName);
          break;
        case 'category':
          comparison = compareValues(a.categoryName, b.categoryName);
          break;
        case 'frequency':
          comparison = compareValues(a.frequency, b.frequency);
          break;
        case 'count':
          comparison = compareValues(a.occurrences, b.occurrences);
          break;
        case 'average':
          comparison = compareValues(a.averageAmount, b.averageAmount);
          break;
        case 'total':
          comparison = compareValues(a.totalAmount, b.totalAmount);
          break;
        case 'lastPaid':
          comparison = compareValues(a.lastTransactionDate, b.lastTransactionDate);
          break;
      }
      return sortDirection === 'asc' ? comparison : -comparison;
    });
    return sorted;
  }, [recurringData, sortField, sortDirection]);

  const chartData = useMemo(() => {
    if (!recurringData) return [];
    return recurringData.data.slice(0, 10).map((item, index) => ({
      ...item,
      color: chartSeriesColor(index),
    }));
  }, [recurringData]);

  // The seven sortable columns, keyed by field so the record is exhaustive and
  // each entry must name its own key (see `SortColumnsByField`).
  const columns: SortColumnsByField = {
    payee: {
      field: 'payee',
      label: t('recurringExpenses.colPayee'),
      csvLabel: t('recurringExpenses.csvColPayee'),
      csvValue: (e) => e.payeeName,
    },
    category: {
      field: 'category',
      label: t('recurringExpenses.colCategory'),
      csvLabel: t('recurringExpenses.csvColCategory'),
      csvValue: (e) => e.categoryName,
    },
    frequency: {
      field: 'frequency',
      label: t('recurringExpenses.colFrequency'),
      align: 'center',
      csvLabel: t('recurringExpenses.csvColFrequency'),
      csvValue: (e) => e.frequency,
    },
    count: {
      field: 'count',
      label: t('recurringExpenses.colCount'),
      align: 'center',
      csvLabel: t('recurringExpenses.csvColCount'),
      csvValue: (e) => e.occurrences,
    },
    average: {
      field: 'average',
      label: t('recurringExpenses.colAvgAmount'),
      align: 'right',
      csvLabel: t('recurringExpenses.csvColAvgAmount'),
      csvValue: (e) => e.averageAmount,
    },
    total: {
      field: 'total',
      label: t('recurringExpenses.colSixMonthTotal'),
      align: 'right',
      csvLabel: t('recurringExpenses.csvColSixMonthTotal'),
      csvValue: (e) => e.totalAmount,
    },
    lastPaid: {
      field: 'lastPaid',
      label: t('recurringExpenses.colLastPaid'),
      align: 'right',
      csvLabel: t('recurringExpenses.csvColLastPaid'),
      // The export's own date format, unchanged. Both this and the cell's
      // `MMM d` parse the server's `YYYY-MM-DD` through `new Date(...)`, which
      // reads it as UTC midnight and then formats it LOCALLY: a negative
      // offset pushes it back into the previous day, so every reader WEST of
      // Greenwich sees the date before the one the server sent. `parseLocalDate`
      // (`@/lib/utils`) is what the sibling report tables use for exactly this.
      // The defect is pre-existing on both paths and is reported rather than
      // fixed inside a layout change, so that neither hides the other.
      csvValue: (e) => format(new Date(e.lastTransactionDate), 'yyyy-MM-dd'),
    },
  };

  // Their order, rendered by BOTH header rows, matched by the cells' DOM order
  // and by the export's columns. DERIVED from the record rather than re-listed:
  // a hand-written list beside an exhaustive record is not exhaustive, so a
  // field added to the union would compile and still ship with no sort control
  // in either header. The record's declaration order is the column order.
  const sortColumns: readonly SortColumn[] = Object.values(columns);

  const getExportData = () => {
    if (!recurringData) return null;
    const headers = sortColumns.map((col) => col.csvLabel);
    // The export is the SERVER's order, as it has always been -- the table's
    // sort is a view of the same rows, not a different set of them.
    const rows = recurringData.data.map((e) => sortColumns.map((col) => col.csvValue(e)));
    return { headers, rows };
  };

  const handleExportCsv = () => {
    const data = getExportData();
    if (!data) return;
    exportToCsv('recurring-expenses', data.headers, data.rows);
  };

  const handleExportPdf = async () => {
    const expData = getExportData();
    if (!expData || !recurringData) return;
    const { exportToPdf } = await import('@/lib/pdf-export');
    await exportToPdf({
      title: t('recurringExpenses.pdfTitle'),
      subtitle: t('recurringExpenses.pdfSubtitle', { count: recurringData.summary.uniquePayees }),
      summaryCards: [
        { label: t('recurringExpenses.recurringExpenses'), value: String(recurringData.summary.uniquePayees), color: '#111827' },
        { label: t('recurringExpenses.sixMonthTotal'), value: formatCurrency(recurringData.summary.totalRecurring), color: '#dc2626' },
        { label: t('recurringExpenses.monthlyEstimate'), value: formatCurrency(recurringData.summary.monthlyEstimate), color: '#ea580c' },
      ],
      chartContainer: chartRef.current,
      chartLegend: chartData.map((item) => ({
        color: resolvePdfColor(item.color),
        label: `${item.payeeName}: ${formatCurrency(item.totalAmount)}`,
      })),
      tableData: { headers: expData.headers, rows: expData.rows },
      filename: 'recurring-expenses',
    });
  };

  const handlePayeeClick = (payeeId: string | null) => {
    if (payeeId) {
      router.push(`/transactions?payeeId=${payeeId}`);
    }
  };

  const CustomTooltip = ({ active, payload }: { active?: boolean; payload?: Array<{ payload: RecurringExpenseItem & { color: string } }> }) => {
    if (active && payload && payload.length) {
      const data = payload[0].payload;
      return (
        <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg shadow-lg p-3">
          <p className="font-medium text-gray-900 dark:text-gray-100">{data.payeeName}</p>
          <p className="text-sm text-gray-600 dark:text-gray-400">
            {t('recurringExpenses.tooltipTransactions', { count: data.occurrences, frequency: data.frequency })}
          </p>
          <p className="text-sm text-gray-900 dark:text-gray-100 mt-1">
            {t('recurringExpenses.tooltipTotal', { amount: formatCurrency(data.totalAmount) })}
          </p>
          <p className="text-sm text-gray-600 dark:text-gray-400">
            {t('recurringExpenses.tooltipAvg', { amount: formatCurrency(data.averageAmount) })}
          </p>
        </div>
      );
    }
    return null;
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

  if (!recurringData) {
    return (
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-6">
        <p className="text-gray-500 dark:text-gray-400 text-center py-8">
          {t('recurringExpenses.failedToLoad')}
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Summary Cards */}
      <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-4">
          <div className="text-sm text-gray-500 dark:text-gray-400">{t('recurringExpenses.recurringExpenses')}</div>
          <div className="text-xl font-bold text-gray-900 dark:text-gray-100">
            {recurringData.summary.uniquePayees}
          </div>
          <div className="text-xs text-gray-500 dark:text-gray-400">{t('recurringExpenses.identifiedPayees')}</div>
        </div>
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-4">
          <div className="text-sm text-gray-500 dark:text-gray-400">{t('recurringExpenses.sixMonthTotal')}</div>
          <div className="text-xl font-bold text-red-600 dark:text-red-400">
            {formatCurrency(recurringData.summary.totalRecurring)}
          </div>
        </div>
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-4">
          <div className="text-sm text-gray-500 dark:text-gray-400">{t('recurringExpenses.monthlyEstimate')}</div>
          <div className="text-xl font-bold text-orange-600 dark:text-orange-400">
            {formatCurrency(recurringData.summary.monthlyEstimate)}
          </div>
        </div>
      </div>

      {/* Controls */}
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-4">
        <div className="flex items-center gap-3">
          <label className="text-sm text-gray-700 dark:text-gray-300 whitespace-nowrap">
            {t('recurringExpenses.minOccurrencesLabel')}
          </label>
          <select
            value={minOccurrences}
            onChange={(e) => setMinOccurrences(Number(e.target.value))}
            className="w-16 rounded-md border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100 text-sm"
          >
            <option value={2}>2+</option>
            <option value={3}>3+</option>
            <option value={4}>4+</option>
            <option value={5}>5+</option>
            <option value={6}>6+</option>
          </select>
          <span className="text-sm text-gray-500 dark:text-gray-400 whitespace-nowrap">
            {t('recurringExpenses.inLast6Months')}
          </span>
          <div className="ml-auto shrink-0">
            <ExportDropdown onExportCsv={handleExportCsv} onExportPdf={handleExportPdf} />
          </div>
        </div>
      </div>

      {recurringData.data.length === 0 ? (
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-6">
          <p className="text-gray-500 dark:text-gray-400 text-center py-8">
            {t('recurringExpenses.noRecurring', { count: minOccurrences })}
          </p>
        </div>
      ) : (
        <>
          {/* Chart */}
          <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-6">
            <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-4">
              {t('recurringExpenses.top10ChartTitle')}
            </h3>
            <div ref={chartRef} className="h-80">
              <ResponsiveContainer width="100%" height="100%" minWidth={0}>
                <PieChart>
                  <Pie
                    data={chartData}
                    cx="50%"
                    cy="50%"
                    innerRadius={60}
                    outerRadius={120}
                    paddingAngle={2}
                    dataKey="totalAmount"
                    cursor="pointer"
                    onClick={(data) => handlePayeeClick(data.payeeId)}
                  >
                    {chartData.map((entry, index) => (
                      <Cell key={`cell-${index}`} fill={entry.color} />
                    ))}
                  </Pie>
                  <Tooltip content={<CustomTooltip />} />
                </PieChart>
              </ResponsiveContainer>
            </div>
          </div>

          {/* Table */}
          <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 overflow-hidden">
            <div className="px-6 py-4 border-b border-gray-200 dark:border-gray-700">
              <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
                {t('recurringExpenses.allRecurringTitle')}
              </h3>
            </div>
            {/* Below `sm` the table becomes a block and each row wraps into a
                two-column grid of EQUAL `minmax(0,1fr)` tracks (for the reason
                `MONEY_CELL` measures), so all SEVEN columns fit a phone without
                a horizontal scroll, on FOUR lines:

                  1  payee          | 6-mo total
                  2  category       | avg amount
                  3  frequency pill | last paid
                  4  count          |

                Four lines because seven cells over two tracks cannot be fewer,
                and two tracks is what this box holds. Measured before: the
                table is 817-905px inside a 288px wrapper at 320px (and inside
                358px at 390px), so FIVE of the seven columns -- frequency,
                count, avg amount, 6-mo total and last paid -- sit entirely
                behind a sideways scroll on a phone today, and the two that are
                visible are squeezed to 127px and 133px, wrapping a 40-character
                payee and a 40-character category to four lines each for a 105px
                row.

                The left track carries what the row IS -- who was paid, what it
                was filed under, how often, and how many times -- and the right
                what it COST. The two unbounded text columns are separate
                `<td>`s, so they are two grid items and cannot share one line:
                the category takes its own line directly under the payee, in the
                same track, which is the sub-line shape the sibling tables
                render inside one identity cell. Neither is clamped -- a clamp
                would cut the tail of a name no other surface shows in full --
                and containment does not need one: each sits in a
                `minmax(0,1fr)` track with `min-w-0`, and `break-words` breaks a
                word too long for the track. The measured 40-character pair
                renders whole, 80px each at 320px inside a 122px track, for a
                260px worst-case row against the 105px the same content measures
                on the 800px desktop row -- and against the 105px it already
                measures TODAY at 320px, behind the scroll. `sm:break-normal`
                hands today's wrapping back from `sm` up.

                Which caption goes in which track is a measurement, not a taste.
                All 80 catalogue strings for the four captioned columns -- the
                20 locales that DEFINE these keys, the pseudo-locale included;
                the two lean regional variants (`en-GB`, `en-US`) inherit `en`'s
                strings per key -- were rendered into the 122px a track gets at
                320px, at `CellLabel`'s own type. NONE overflows and NONE needs a
                second line, in either track, at either width.

                Count takes the LEFT track because its caption is the only one of
                the four that is a single unbreakable word in the long locales --
                `Количество` (ru), `Кількість` (uk), `Contagem` (pt), `Anzahl`
                (de) -- while every catalogue string for Avg Amount, 6-Mo Total
                and Last Paid carries a space, a hyphen or a CJK break
                opportunity. So a future translation that outgrows the track
                spends the 12px column gap there rather than reopening the
                wrapper's sideways scroll on the right. It also lands where it
                belongs: the server derives the frequency label FROM the
                occurrence count, so the two sit one above the other.

                The frequency pill is its OWN column, not a badge inside the
                identity cell, so it cannot join the payee's line; it takes the
                left track's third line and no caption, being self-describing.
                `max-sm:inline-block max-sm:max-w-full` is what keeps it ONE
                background fragment: measured on the replica, an inline pill
                whose label outgrows the track paints two ragged halves, and the
                `sm`+ markup is untouched.

                From `sm` up it is the ordinary table: each cell restores this
                table's own `px-4 py-3` and the column header row is unchanged.
                A Chromium replica renders it pixel-identically to today at 800px
                in every locale once the one deliberate difference is
                neutralised -- `whitespace-nowrap` on the four cells that hold a
                figure, a count or a date, for the reason `MONEY_CELL` gives.

                Two costs of restyling one tree, both deliberate. Changing the
                display roles drops the table semantics below `sm`, which is why
                the roles are restated explicitly and every bare number and date
                carries a `CellLabel` naming its column -- the payee, the
                category and the pill need none, being words that describe
                themselves. And the phone reading order differs from the DOM
                order, which is the desktop column order the grid placement
                overrides visually. Both are properties of the mechanism, not of
                this table. */}
            <div className="overflow-x-auto">
              <table role="table" className="block min-w-full divide-y divide-gray-200 dark:divide-gray-700 sm:table">
                <thead role="rowgroup" className="block bg-gray-50 dark:bg-gray-900/50 sm:table-header-group">
                  {/* Phone sort strip: the same seven controls, wrapped. */}
                  <tr role="row" className="flex flex-wrap gap-x-2 gap-y-1 px-4 py-2 sm:hidden">
                    {sortColumns.map((col) => (
                      <SortableHeader<RecurringSortField>
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
                      <SortableHeader<RecurringSortField>
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
                  {sortedExpenses.map((expense, index) => (
                    <tr
                      // `key={index}` is pre-existing and stays: the payload
                      // carries no stable id for a merged payee, and swapping
                      // the key inside a layout change would hide both.
                      key={index}
                      role="row"
                      className={`grid grid-cols-2 items-start gap-x-3 gap-y-1.5 px-4 py-3 hover:bg-gray-50 dark:hover:bg-gray-700/50 sm:table-row ${expense.payeeId ? 'cursor-pointer' : ''}`}
                      onClick={() => handlePayeeClick(expense.payeeId)}
                    >
                      <td
                        role="cell"
                        className="col-start-1 row-start-1 min-w-0 break-words p-0 text-sm font-medium text-gray-900 dark:text-gray-100 sm:table-cell sm:break-normal sm:px-4 sm:py-3"
                      >
                        {expense.payeeName}
                      </td>
                      <td
                        role="cell"
                        className="col-start-1 row-start-2 min-w-0 break-words p-0 text-sm text-gray-500 dark:text-gray-400 sm:table-cell sm:break-normal sm:px-4 sm:py-3"
                      >
                        {expense.categoryName}
                      </td>
                      {/* The pill is centred from `sm` up, as it is today; on a
                          phone it starts at its track's left edge. */}
                      <td
                        role="cell"
                        className="col-start-1 row-start-3 min-w-0 p-0 text-sm sm:table-cell sm:px-4 sm:py-3 sm:text-center"
                      >
                        <span className={`px-2 py-0.5 rounded-full text-xs font-medium max-sm:inline-block max-sm:max-w-full ${
                          expense.frequency === 'Weekly'
                            ? 'bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-400'
                            : expense.frequency === 'Bi-weekly'
                            ? 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400'
                            : expense.frequency === 'Monthly'
                            ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400'
                            : 'bg-gray-100 text-gray-700 dark:bg-gray-700 dark:text-gray-400'
                        }`}>
                          {expense.frequency}
                        </span>
                      </td>
                      {/* The count is centred from `sm` up, as it is today; on a
                          phone it is right-aligned like every other value. */}
                      <td
                        role="cell"
                        className={`col-start-1 row-start-4 text-gray-900 dark:text-gray-100 sm:text-center ${MONEY_CELL}`}
                      >
                        <CellLabel className={CAPTION_CLASS}>{columns.count.label}</CellLabel>
                        {expense.occurrences}
                      </td>
                      <td
                        role="cell"
                        className={`col-start-2 row-start-2 text-gray-900 dark:text-gray-100 ${MONEY_CELL}`}
                      >
                        <CellLabel className={CAPTION_CLASS}>{columns.average.label}</CellLabel>
                        {formatCurrency(expense.averageAmount)}
                      </td>
                      {/* The six-month total takes the right of line 1 beside
                          the payee: it is the figure the row is read for. */}
                      <td
                        role="cell"
                        className={`col-start-2 row-start-1 font-medium text-red-600 dark:text-red-400 ${MONEY_CELL}`}
                      >
                        <CellLabel className={CAPTION_CLASS}>{columns.total.label}</CellLabel>
                        {formatCurrency(expense.totalAmount)}
                      </td>
                      <td
                        role="cell"
                        className={`col-start-2 row-start-3 text-gray-500 dark:text-gray-400 ${DATE_CELL}`}
                      >
                        <CellLabel className={CAPTION_CLASS}>{columns.lastPaid.label}</CellLabel>
                        {format(new Date(expense.lastTransactionDate), 'MMM d')}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
