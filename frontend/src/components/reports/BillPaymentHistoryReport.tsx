'use client';

import { useState, useMemo, useRef } from 'react';
import { Skeleton } from '@/components/ui/LoadingSkeleton';
import { useRouter } from 'next/navigation';
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from 'recharts';
import { format } from 'date-fns';
import { builtInReportsApi } from '@/lib/built-in-reports';
import { BillPaymentHistoryResponse } from '@/types/built-in-reports';
import { parseLocalDate } from '@/lib/utils';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import { useDateRange } from '@/hooks/useDateRange';
import { DateRangeSelector } from '@/components/ui/DateRangeSelector';
import { exportToCsv } from '@/lib/csv-export';
import { ExportDropdown } from '@/components/ui/ExportDropdown';
import { SortableHeader } from '@/components/ui/SortableHeader';
import { CellLabel } from '@/components/ui/Table';
import { useSortableTable, compareValues } from '@/hooks/useSortableTable';
import { useTranslations } from 'next-intl';
import { useReportData } from '@/hooks/useReportData';
import { ReportError } from '@/components/reports/ReportError';
import { chartColors } from '@/lib/chart-colors';

type BillSortField = 'bill' | 'count' | 'average' | 'total' | 'lastPayment';

/**
 * One sortable column of the by-bill table. The five are declared once and
 * rendered by BOTH header rows -- the column header row (from `sm` up) and the
 * phone sort strip -- so the two can never list different fields, and each
 * value cell takes its phone caption from the same entry as its header.
 */
interface SortColumn {
  field: BillSortField;
  label: string;
  /** How the column header aligns from `sm` up; the cells restate it. */
  align?: 'right' | 'center';
}

/**
 * The record the two header rows are built from, keyed by sort field.
 *
 * The key is tied to the entry's own `field`, which a plain
 * `Record<BillSortField, SortColumn>` does not do: that forces an entry to
 * EXIST for every member of the union but lets it name a different one, so
 * `average: { field: 'total', ... }` would type-check. Both header rows would
 * then render two controls keyed `total` (a duplicate React key), tapping
 * "Average" would sort by Total Paid, and "Average" would be unsortable --
 * none of which a test comparing header LABELS can see, because the labels
 * stay right. Here it is a compile error instead.
 */
type SortColumnsByField = {
  [K in BillSortField]: SortColumn & { field: K };
};

// Today's header cell, unchanged.
const HEADER_CLASS = 'px-4 py-3 text-xs font-medium text-gray-500 dark:text-gray-400 uppercase';

// The same sort controls in the phone strip: a wrapped row of compact chips.
// Column alignment means nothing there -- the column header row is hidden and
// each data row is a grid -- so every control is left-aligned and self-naming.
// The border is what says "tappable": there is no hover on a touch screen, and
// the chip's own fill is a shade off the header band it sits on (this table's
// `<thead>` keeps its `bg-gray-50` / `dark:bg-gray-900/50`, so the strip is on
// that band rather than on the card, as it is on the sibling tables whose card
// has no header band). (The class is kept identical to those siblings; the
// copies are one of the duplications the converted-table consolidation pass
// folds into one home -- `components/ui/` is not this change's to edit.)
//
// Five chips wrap to three lines at 320px in `en`/`pl`/`ru`/`id` (114px), four
// in `de` (148px) and five in the pseudo-locale (182px) above the first row.
// That is a measured cost, not a reason to drop a control: `reports.bill-
// payment-history.sort` persists any of the five, so a field with no control
// anywhere would leave a phone POINTING at a sort with no pointer back.
const PHONE_HEADER_CLASS =
  'rounded border border-gray-200 bg-white px-2 py-1.5 text-xs font-medium text-gray-500 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-400 uppercase';

// A value cell inside a wrapped row: no padding of its own below `sm` and this
// table's own `px-4 py-3` from `sm` up. Smaller type on phones so an
// eight-figure compact amount still fits half the width.
//
// `whitespace-nowrap` is the one property here that CHANGES the desktop
// rendering. It is not the only unprefixed one -- `text-right` applies at every
// width too, and must, because it is the alignment these columns already have
// from `sm` up (the count is the exception and takes it back with
// `sm:text-center`). The nowrap is deliberate: `formatCurrencyCompact` groups
// thousands, and a locale that groups them with a space (`12 345 678 CHF`)
// could otherwise break a figure in
// the middle at any width -- which is what this table does today. Measured
// price: at 800px the identity column gives up 5-7px to the figure columns in
// `en`/`pl`/`de`/`xx` and nothing at all in `ru`/`id`; row heights and every
// column width are unchanged at 1280px. A figure cut in half is worse.
//
// The budget was measured on a hand-written CSS replica in Chromium at the
// insets this table really gets -- the report page's `px-4` and the cell's own
// `px-4`, the card contributing none -- so 256px of content at 320px and 326px
// at 390px. Two EQUAL `minmax(0,1fr)` tracks, resolved off `getComputedStyle`:
// 122px each at 320px and 157px each at 390px. Equal tracks rather than an
// `auto` one for the identity because each `<tr>` is its OWN grid, so an `auto`
// track sized by one row's content would land at a different width in the next
// row and step the figure column left and right down the card.
//
// The formatter is `formatCurrencyCompact` (no decimals) and the widest unit it
// can produce is not a symbol: it asks for `narrowSymbol`, which falls back to
// the three-letter ISO code where a currency has none, so CHF is the worst
// case. Measured at `text-xs`, space-grouped: a seven-figure `1 456 789 CHF` is
// 89px (Average) and an eight-figure `12 345 678 CHF` at `font-medium` is 97px
// (Total Paid, which is a SUM over up to two years and so runs an order of
// magnitude above the average beside it). Both inside the 122px track at 320px,
// with the widest measured overflow across every figure cell in every locale
// being zero. The payment COUNT is bounded and trivial at 23px for `128`.
const MONEY_CELL = 'p-0 text-right text-xs whitespace-nowrap sm:table-cell sm:px-4 sm:py-3 sm:text-sm';

// Last Payment is a WORD-shaped value, not a number: `format(..., 'MMM d,
// yyyy')` renders `Sep 5, 2026` (72px at `text-xs`), or `-` where the bill has
// never been paid. It resolves to the same rendering as a figure cell today --
// including the nowrap, because a date is one label and breaking it after `Sep`
// reads as two values -- and it is spelled out rather than aliased to
// `MONEY_CELL` deliberately: the two hold the same string for different
// reasons, and an alias would carry a money-driven edit (dropping the nowrap
// because a formatter stopped grouping, widening the type for a longer figure)
// silently onto the date. Where the sibling `CategoryPerformanceReport`'s
// `WORD_CELL` drops the nowrap because its word is a translated CATALOGUE
// string that may legitimately wrap, this one is a fixed-shape date and keeps
// it.
const DATE_CELL = 'p-0 text-right text-xs whitespace-nowrap sm:table-cell sm:px-4 sm:py-3 sm:text-sm';

/** Every caption in a wrapped cell is phone-only. */
const CAPTION_CLASS = 'sm:hidden';

export function BillPaymentHistoryReport() {
  const t = useTranslations('reports');
  const router = useRouter();
  const { formatCurrencyCompact: formatCurrency, formatCurrencyAxis } = useNumberFormat();
  const chartRef = useRef<HTMLDivElement>(null);
  const { dateRange, setDateRange, resolvedRange } = useDateRange({ defaultRange: '1y', alignment: 'day' });
  const [viewType, setViewType] = useState<'overview' | 'byBill'>('overview');
  const { sortField, sortDirection, handleSort } = useSortableTable<BillSortField>(
    'reports.bill-payment-history.sort',
    { field: 'total', direction: 'desc' },
  );

  const { start: rangeStart, end: rangeEnd } = resolvedRange;

  const { data: billData, isLoading, error, reload } = useReportData<BillPaymentHistoryResponse | null>(
    () =>
      builtInReportsApi.getBillPaymentHistory({
        startDate: rangeStart,
        endDate: rangeEnd,
      }),
    [rangeStart, rangeEnd],
  );

  const sortedBillPayments = useMemo(() => {
    if (!billData) return [];
    const sorted = [...billData.billPayments];
    sorted.sort((a, b) => {
      let comparison = 0;
      switch (sortField) {
        case 'bill':
          comparison = compareValues(a.scheduledTransactionName, b.scheduledTransactionName);
          break;
        case 'count':
          comparison = compareValues(a.paymentCount, b.paymentCount);
          break;
        case 'average':
          comparison = compareValues(a.averagePayment, b.averagePayment);
          break;
        case 'total':
          comparison = compareValues(a.totalPaid, b.totalPaid);
          break;
        case 'lastPayment':
          comparison = compareValues(a.lastPaymentDate, b.lastPaymentDate);
          break;
      }
      return sortDirection === 'asc' ? comparison : -comparison;
    });
    return sorted;
  }, [billData, sortField, sortDirection]);

  const handleBillClick = () => {
    router.push('/bills');
  };

  // The five sortable columns, keyed by field so the record is exhaustive and
  // each entry must name its own key (see `SortColumnsByField`).
  const columns: SortColumnsByField = {
    bill: { field: 'bill', label: t('billPaymentHistory.colBill') },
    count: { field: 'count', label: t('billPaymentHistory.colPayments'), align: 'center' },
    average: { field: 'average', label: t('billPaymentHistory.colAverage'), align: 'right' },
    total: { field: 'total', label: t('billPaymentHistory.colTotalPaid'), align: 'right' },
    lastPayment: {
      field: 'lastPayment',
      label: t('billPaymentHistory.colLastPayment'),
      align: 'right',
    },
  };

  // Their order, rendered by BOTH header rows and matched by the cells' DOM
  // order. DERIVED from the record rather than re-listed: a hand-written list
  // beside an exhaustive record is not exhaustive, so a field added to the
  // union would compile and still ship with no sort control in either header.
  // The record's declaration order is the column order.
  const sortColumns: readonly SortColumn[] = Object.values(columns);

  const getExportData = () => {
    if (!billData) return null;
    const headers = [t('billPaymentHistory.colBill'), t('billPaymentHistory.colPayee'), t('billPaymentHistory.colPayments'), t('billPaymentHistory.colAverage'), t('billPaymentHistory.colTotalPaid'), t('billPaymentHistory.colLastPayment')];
    const rows = billData.billPayments.map((bp) => [
      bp.scheduledTransactionName,
      bp.payeeName || '',
      bp.paymentCount,
      bp.averagePayment,
      bp.totalPaid,
      bp.lastPaymentDate ? format(parseLocalDate(bp.lastPaymentDate), 'yyyy-MM-dd') : '',
    ]);
    return { headers, rows };
  };

  const handleExportCsv = () => {
    const data = getExportData();
    if (!data) return;
    exportToCsv('bill-payment-history', data.headers, data.rows);
  };

  const handleExportPdf = async () => {
    const data = getExportData();
    if (!data || !billData) return;
    const { exportToPdf } = await import('@/lib/pdf-export');
    await exportToPdf({
      title: t('billPaymentHistory.paymentHistoryByBill'),
      subtitle: `${billData.summary.uniqueBills} ${t('billPaymentHistory.uniqueBills')}, ${billData.summary.totalPayments} ${t('billPaymentHistory.totalPayments').toLowerCase()}`,
      summaryCards: [
        { label: t('billPaymentHistory.totalPaid'), value: formatCurrency(billData.summary.totalPaid), color: '#111827' },
        { label: t('billPaymentHistory.monthlyAverage'), value: formatCurrency(billData.summary.monthlyAverage), color: '#2563eb' },
        { label: t('billPaymentHistory.billsPaid'), value: String(billData.summary.uniqueBills), color: '#111827' },
        { label: t('billPaymentHistory.totalPayments'), value: String(billData.summary.totalPayments), color: '#111827' },
      ],
      chartContainer: chartRef.current,
      tableData: { headers: data.headers, rows: data.rows },
      filename: 'bill-payment-history',
    });
  };

  const CustomTooltip = ({ active, payload, label }: { active?: boolean; payload?: Array<{ value: number }>; label?: string }) => {
    if (active && payload && payload.length) {
      return (
        <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg shadow-lg p-3">
          <p className="font-medium text-gray-900 dark:text-gray-100">{label}</p>
          <p className="text-sm text-gray-600 dark:text-gray-400">
            {formatCurrency(payload[0].value)}
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

  if (!billData) {
    return (
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-6">
        <p className="text-gray-500 dark:text-gray-400 text-center py-8">
          {t('billPaymentHistory.loadError')}
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Summary Cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-4">
          <div className="text-sm text-gray-500 dark:text-gray-400">{t('billPaymentHistory.totalPaid')}</div>
          <div className="text-xl font-bold text-gray-900 dark:text-gray-100">
            {formatCurrency(billData.summary.totalPaid)}
          </div>
        </div>
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-4">
          <div className="text-sm text-gray-500 dark:text-gray-400">{t('billPaymentHistory.monthlyAverage')}</div>
          <div className="text-xl font-bold text-blue-600 dark:text-blue-400">
            {formatCurrency(billData.summary.monthlyAverage)}
          </div>
        </div>
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-4">
          <div className="text-sm text-gray-500 dark:text-gray-400">{t('billPaymentHistory.billsPaid')}</div>
          <div className="text-xl font-bold text-gray-900 dark:text-gray-100">
            {billData.summary.uniqueBills}
          </div>
          <div className="text-xs text-gray-500 dark:text-gray-400">{t('billPaymentHistory.uniqueBills')}</div>
        </div>
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-4">
          <div className="text-sm text-gray-500 dark:text-gray-400">{t('billPaymentHistory.totalPayments')}</div>
          <div className="text-xl font-bold text-gray-900 dark:text-gray-100">
            {billData.summary.totalPayments}
          </div>
        </div>
      </div>

      {/* Controls */}
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-4">
        <div className="flex flex-wrap gap-4 items-center justify-between">
          <DateRangeSelector
            ranges={['6m', '1y', '2y']}
            value={dateRange}
            onChange={setDateRange}
          />
          <div className="flex gap-2 items-center">
            <button
              onClick={() => setViewType('overview')}
              className={`px-3 py-1.5 text-sm font-medium rounded-md transition-colors ${
                viewType === 'overview'
                  ? 'bg-blue-600 text-white'
                  : 'bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300'
              }`}
            >
              {t('billPaymentHistory.overview')}
            </button>
            <button
              onClick={() => setViewType('byBill')}
              className={`px-3 py-1.5 text-sm font-medium rounded-md transition-colors ${
                viewType === 'byBill'
                  ? 'bg-blue-600 text-white'
                  : 'bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300'
              }`}
            >
              {t('billPaymentHistory.byBill')}
            </button>
            <ExportDropdown onExportCsv={handleExportCsv} onExportPdf={handleExportPdf} />
          </div>
        </div>
      </div>

      {billData.billPayments.length === 0 ? (
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-6">
          <p className="text-gray-500 dark:text-gray-400 text-center py-8">
            {t('billPaymentHistory.empty')}
          </p>
        </div>
      ) : viewType === 'overview' ? (
        /* Monthly Overview Chart */
        <div ref={chartRef} className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-6">
          <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-4">
            {t('billPaymentHistory.monthlyBillPayments')}
          </h3>
          <div className="h-80">
            <ResponsiveContainer width="100%" height="100%" minWidth={0}>
              <BarChart data={billData.monthlyTotals}>
                <CartesianGrid strokeDasharray="3 3" stroke={chartColors.grid} />
                <XAxis dataKey="label" tick={{ fontSize: 11 }} />
                <YAxis tickFormatter={formatCurrencyAxis} />
                <Tooltip content={<CustomTooltip />} />
                <Bar dataKey="total" fill={chartColors.primary} name={t('billPaymentHistory.totalPaid')} radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>
      ) : (
        /* By Bill Table */
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 overflow-hidden">
          <div className="px-6 py-4 border-b border-gray-200 dark:border-gray-700">
            <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
              {t('billPaymentHistory.paymentHistoryByBill')}
            </h3>
          </div>
          {/* Below `sm` the table becomes a block and each row wraps into a
              two-column grid of EQUAL `minmax(0,1fr)` tracks (for the reason
              `MONEY_CELL` measures), so all FIVE columns fit a phone without a
              horizontal scroll, on THREE lines:

                1  bill name + payee     | total paid
                2  average               | payments
                3                        | last payment

              Three lines because five cells over two tracks cannot be fewer,
              and two tracks is what this box holds. Measured before: the table
              is 628-686px inside a 288px wrapper at 320px (628-686px inside
              358px at 390px), so three of the five columns -- Average, Total
              Paid and Last Payment -- sit entirely behind a sideways scroll on
              a phone today.

              The pairing is the report's own reading: the row is read for what
              the bill has cost, so the figure that summarises it -- the total
              paid -- sits beside the name, with the average it is made of and
              the count it is made of on line 2, and the recency of the whole
              thing closing the card on line 3.

              Which caption goes in which track is a measurement, not a taste.
              All 80 catalogue strings for the four captioned columns -- the 20
              locales that DEFINE these keys, the pseudo-locale included; 22
              ship a `reports` catalogue, and the two lean regional variants
              (`en-GB`, `en-US`) inherit `en`'s strings per key -- were rendered
              into the 122px a track gets
              at 320px, at `CellLabel`'s own type. NONE overflows, and exactly
              two need a second line, both of them Last Payment: `Pembayaran
              Terakhir` (id, 125px unbroken) and `Lần thanh toán cuối` (vi,
              123px). Those cells are 41px instead of 29px in those two locales,
              which is a documented cost rather than a defect -- a shorter
              catalogue key is not this change's to add. At 390px (157px tracks)
              nothing wraps at all.

              Average takes the LEFT track because its caption is the widest with
              no break opportunity ANYWHERE -- `Durchschnitt` (de) at 82px, ahead
              of Payments' `Pagamentos` (pt/pt-BR) at 72px -- so a future
              translation that outgrows the track spends the 12px column gap
              there rather than reopening the wrapper's sideways scroll on the
              right. Total Paid and Last Payment take the right because neither
              has an unbreakable string in any locale: every one of them carries
              a space or a hyphen, and the CJK captions (`总支付额`, `最終支払い`)
              break between characters. Naming them by length would have been the
              wrong test -- `[XX-Last Payment-XX]` is the longest of the eighty
              and breaks at its hyphens.

              The bill name and the payee sub-line stay in ONE `<td>` -- they
              are the row's identity, not two columns -- and BOTH are unbounded
              in the payload, so the cell sits in a `minmax(0,1fr)` track with
              `min-w-0`: a track that may be zero plus a cell that may be
              narrower than its own content is what lets a long name shrink
              instead of setting the table's minimum width. It is not clamped --
              a clamp would CUT the tail of a name no other surface shows in
              full -- and containment does not need one: `break-words` breaks a
              word too long for the track, and the measured 40-character name
              with a 40-character payee beneath it renders whole, 156px tall at
              320px inside a 122px track. `sm:break-normal` hands today's
              wrapping back from `sm` up. That identity is what makes the
              worst-case row 250px at 320px against the 113px the same content
              measures on the 800px desktop row: no value cell exceeds one
              caption line plus one value line, and the same row is already
              201px tall today, behind the scroll.

              From `sm` up it is the ordinary table: each cell restores this
              table's own `px-4 py-3` and the header row is untouched. A
              Chromium replica renders it pixel-identically to today at 800px in
              every locale once the one deliberate difference is neutralised --
              `whitespace-nowrap` on the four cells that hold a figure or a
              date, for the reason `MONEY_CELL` gives.

              Two costs of restyling one tree, both deliberate. Changing the
              display roles drops the table semantics below `sm`, which is why
              the roles are restated explicitly and every value carries a
              `CellLabel` naming its column -- the identity needs none, being
              the row itself rather than one of its figures. And the phone
              reading order differs from the DOM order, which is the desktop
              column order the grid placement overrides visually. Both are
              properties of the mechanism, not of this table. */}
          <div className="overflow-x-auto">
            <table role="table" className="block min-w-full divide-y divide-gray-200 dark:divide-gray-700 sm:table">
              <thead role="rowgroup" className="block bg-gray-50 dark:bg-gray-900/50 sm:table-header-group">
                {/* Phone sort strip: the same five controls, wrapped. */}
                <tr role="row" className="flex flex-wrap gap-x-2 gap-y-1 px-4 py-2 sm:hidden">
                  {sortColumns.map((col) => (
                    <SortableHeader<BillSortField>
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
                    <SortableHeader<BillSortField>
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
                {sortedBillPayments.map((bp) => (
                  <tr
                    key={bp.scheduledTransactionId}
                    role="row"
                    className="grid grid-cols-2 items-start gap-x-3 gap-y-1.5 px-4 py-3 hover:bg-gray-50 dark:hover:bg-gray-700/50 cursor-pointer sm:table-row"
                    onClick={handleBillClick}
                  >
                    <td
                      role="cell"
                      className="col-start-1 row-start-1 min-w-0 break-words p-0 sm:table-cell sm:break-normal sm:px-4 sm:py-3"
                    >
                      <div className="font-medium text-gray-900 dark:text-gray-100">
                        {bp.scheduledTransactionName}
                      </div>
                      <div className="text-sm text-gray-500 dark:text-gray-400">
                        {bp.payeeName || t('billPaymentHistory.noPayee')}
                      </div>
                    </td>
                    {/* The count is centred from `sm` up, as it is today; on a
                        phone it is right-aligned like every other value in its
                        track. */}
                    <td
                      role="cell"
                      className={`col-start-2 row-start-2 text-gray-900 dark:text-gray-100 sm:text-center ${MONEY_CELL}`}
                    >
                      <CellLabel className={CAPTION_CLASS}>{columns.count.label}</CellLabel>
                      {bp.paymentCount}
                    </td>
                    <td
                      role="cell"
                      className={`col-start-1 row-start-2 text-gray-900 dark:text-gray-100 ${MONEY_CELL}`}
                    >
                      <CellLabel className={CAPTION_CLASS}>{columns.average.label}</CellLabel>
                      {formatCurrency(bp.averagePayment)}
                    </td>
                    {/* Total paid takes the right of line 1 beside the bill: it
                        is the figure the row is read for. */}
                    <td
                      role="cell"
                      className={`col-start-2 row-start-1 font-medium text-gray-900 dark:text-gray-100 ${MONEY_CELL}`}
                    >
                      <CellLabel className={CAPTION_CLASS}>{columns.total.label}</CellLabel>
                      {formatCurrency(bp.totalPaid)}
                    </td>
                    <td
                      role="cell"
                      className={`col-start-2 row-start-3 text-gray-500 dark:text-gray-400 ${DATE_CELL}`}
                    >
                      <CellLabel className={CAPTION_CLASS}>{columns.lastPayment.label}</CellLabel>
                      {bp.lastPaymentDate
                        ? format(parseLocalDate(bp.lastPaymentDate), 'MMM d, yyyy')
                        : '-'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
