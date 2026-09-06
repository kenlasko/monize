'use client';

import { useState, useMemo } from 'react';
import { useTranslations } from 'next-intl';
import { gainLossColor } from '@/lib/format';
import { Skeleton } from '@/components/ui/LoadingSkeleton';
import { useRouter } from 'next/navigation';
import { format } from 'date-fns';
import { builtInReportsApi } from '@/lib/built-in-reports';
import { UncategorizedTransactionItem } from '@/types/built-in-reports';
import { parseLocalDate } from '@/lib/utils';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import { useDateRange } from '@/hooks/useDateRange';
import { DateRangeSelector } from '@/components/ui/DateRangeSelector';
import { exportToCsv } from '@/lib/csv-export';
import { ExportDropdown } from '@/components/ui/ExportDropdown';
import { SortableHeader } from '@/components/ui/SortableHeader';
import { CellLabel } from '@/components/ui/Table';
import { useSortableTable, compareValues } from '@/hooks/useSortableTable';
import { useReportData } from '@/hooks/useReportData';
import { ReportError } from '@/components/reports/ReportError';

type SortField = 'date' | 'amount' | 'payee' | 'account';

/**
 * One sortable column of the transaction table. The four are declared once and
 * rendered by BOTH header rows -- the column header row (from `sm` up) and the
 * phone sort strip -- so the two can never list different fields, and each
 * captioned value cell takes its phone caption from the same entry as its
 * header.
 */
interface SortColumn {
  field: SortField;
  label: string;
  /** How the column header aligns from `sm` up; the cells restate it. */
  align?: 'right' | 'center';
}

/**
 * The record the two header rows are built from, keyed by sort field.
 *
 * The key is tied to the entry's own `field`, which a plain
 * `Record<SortField, SortColumn>` does not do: that forces an entry to EXIST
 * for every member of the union but lets it name a different one, so
 * `account: { field: 'amount', ... }` would type-check. Both header rows would
 * then render two controls keyed `amount` (a duplicate React key), tapping
 * "Account" would sort by Amount, and "Account" would be unsortable -- none of
 * which a test comparing header LABELS can see, because the labels stay right.
 * Here it is a compile error instead.
 */
type SortColumnsByField = {
  [K in SortField]: SortColumn & { field: K };
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
// Four chips, one of them a COMPOUND label -- which is why a low chip count
// says little about the strip's height here. Measured on the Chromium replica
// at 320px: two lines (80px) in `en`/`pl`, three in `ru`/`id` (114px) and `de`
// (130px, whose `Zahlungsempfänger / Beschreibung` is 214px on its own), four
// in the pseudo-locale (148px); at 390px, two lines in every real locale but
// `de`. That is a measured cost, not a reason to drop a control:
// `reports.uncategorized-transactions.sort` persists any of the four, so a
// field with no control anywhere would leave a phone POINTING at a sort with no
// pointer back.
const PHONE_HEADER_CLASS =
  'rounded border border-gray-200 bg-white px-2 py-1.5 text-xs font-medium text-gray-500 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-400 uppercase';

// The amount cell inside a wrapped row: no padding of its own below `sm` and
// this table's own `px-4 py-3` from `sm` up. Smaller type on phones so a
// six-figure 2dp amount still fits half the width.
//
// NOTHING here changes the desktop rendering: `text-right` and
// `whitespace-nowrap` are both what this cell already carries at every width
// today, and the nowrap is what keeps a locale that groups thousands with a
// space (`123 456,78 CHF`) from breaking a figure in the middle. Measured on
// the replica, the 800px and 1280px renderings are pixel-identical to today in
// every locale, with every column width and row height unchanged.
//
// The budget was measured on a hand-written CSS replica in Chromium at the
// insets this table really gets -- the report page's `px-4` and the cell's own
// `px-4`, the card contributing NONE (it is `overflow-hidden`, with a heading
// row above the table and no padding of its own) -- so 256px of content at
// 320px and 326px at 390px. Two EQUAL `minmax(0,1fr)` tracks, resolved off
// `getComputedStyle`: 122px each at 320px and 157px each at 390px. Equal tracks
// rather than an `auto` one for the identity because each `<tr>` is its OWN
// grid, so an `auto` track sized by one row's content would land at a different
// width in the next row and step the figure column left and right down the
// card.
//
// The formatter is `formatCurrency` -- TWO decimals, which is worth 30-40px per
// cell against the compact formatter the sibling report tables use -- and the
// widest unit it can produce is not a symbol: it asks for `narrowSymbol`, which
// falls back to the three-letter ISO code where a currency has none, so CHF is
// the worst case, and the sign counts too (this column carries both). Measured
// at `text-xs`, space-grouped: a negative six-figure `-123 456,78 CHF` is
// 101px, a seven-figure `-1 234 567,89 CHF` 113px and an eight-figure
// `-12 345 678,90 CHF` 120px -- all inside the 122px track at 320px, and nine
// figures (128px) is the first past it. At 390px (157px tracks) nine fits with
// 29px to spare. The widest measured overflow across every figure cell in every
// locale is zero, checked with a `Range` rect against the cell box rather than
// `scrollWidth` alone, because a right-track figure that bleeds past its track
// reopens the wrapper's sideways scroll and the scroll probe cannot see it.
//
// THREE tracks were rejected on the same measurement: a third of the same box
// is 77px at 320px, which the 101px six-figure amount overflows by 24px in
// every locale. Two tracks it is, and four cells over two tracks is a two-line
// card.
const MONEY_CELL = 'p-0 text-right text-xs whitespace-nowrap sm:table-cell sm:px-4 sm:py-3 sm:text-sm';

// The date is a fixed-shape label, not a number: `format(..., 'MMM d, yyyy')`
// renders `Dec 25, 2025` (72px at `text-xs`). It keeps the `whitespace-nowrap`
// it wears today, because a date is one label and breaking it after `Dec` reads
// as two values, and it is spelled out rather than aliased to `MONEY_CELL`
// deliberately: the two hold nearly the same string for different reasons, and
// an alias would carry a money-driven edit (a wider type for a longer figure)
// silently onto the date. The one difference is the alignment -- this table's
// Date column is LEFT-aligned from `sm` up, unlike its Amount, so the phone's
// right alignment inside the right-hand track is scoped `max-sm:` and the
// desktop is untouched.
const DATE_CELL = 'p-0 text-xs whitespace-nowrap max-sm:text-right sm:table-cell sm:px-4 sm:py-3 sm:text-sm';

/** Every caption in a wrapped cell is phone-only. */
const CAPTION_CLASS = 'sm:hidden';

export function UncategorizedTransactionsReport() {
  const t = useTranslations('reports');
  const router = useRouter();
  const { formatCurrency } = useNumberFormat();
  const { dateRange, setDateRange, resolvedRange, isValid } = useDateRange({ defaultRange: '3m', alignment: 'day' });
  const { sortField, sortDirection, handleSort } = useSortableTable<SortField>(
    'reports.uncategorized-transactions.sort',
    { field: 'date', direction: 'desc' },
  );
  const [filterType, setFilterType] = useState<'all' | 'income' | 'expense'>('all');

  const { start: rangeStart, end: rangeEnd } = resolvedRange;

  const { data: reportData, isLoading, error, reload } = useReportData(
    () =>
      isValid
        ? builtInReportsApi.getUncategorizedTransactions({
            startDate: rangeStart || undefined,
            endDate: rangeEnd,
            limit: 500,
          })
        : Promise.resolve(null),
    [isValid, rangeStart, rangeEnd],
  );

  const filteredAndSortedTransactions = useMemo(() => {
    if (!reportData) return [];

    let filtered = [...reportData.transactions];

    // Apply type filter
    if (filterType === 'income') {
      filtered = filtered.filter((tx) => tx.amount > 0);
    } else if (filterType === 'expense') {
      filtered = filtered.filter((tx) => tx.amount < 0);
    }

    // Apply sort
    filtered.sort((a, b) => {
      let comparison = 0;
      switch (sortField) {
        case 'date':
          comparison = compareValues(a.transactionDate, b.transactionDate);
          break;
        case 'amount':
          comparison = compareValues(Math.abs(a.amount), Math.abs(b.amount));
          break;
        case 'payee':
          comparison = compareValues((a.payeeName || '').toLowerCase(), (b.payeeName || '').toLowerCase());
          break;
        case 'account':
          comparison = compareValues((a.accountName || '').toLowerCase(), (b.accountName || '').toLowerCase());
          break;
      }
      return sortDirection === 'asc' ? comparison : -comparison;
    });

    return filtered;
  }, [reportData, filterType, sortField, sortDirection]);

  // The four sortable columns, keyed by field so the record is exhaustive and
  // each entry must name its own key (see `SortColumnsByField`).
  const columns: SortColumnsByField = {
    date: { field: 'date', label: t('uncategorizedTransactions.colDate') },
    payee: { field: 'payee', label: t('uncategorizedTransactions.colPayeeDescription') },
    account: { field: 'account', label: t('uncategorizedTransactions.colAccount') },
    amount: { field: 'amount', label: t('uncategorizedTransactions.colAmount'), align: 'right' },
  };

  // Their order, rendered by BOTH header rows and matched by the cells' DOM
  // order. DERIVED from the record rather than re-listed: a hand-written list
  // beside an exhaustive record is not exhaustive, so a field added to the
  // union would compile and still ship with no sort control in either header.
  // The record's declaration order is the column order.
  const sortColumns: readonly SortColumn[] = Object.values(columns);

  const handleTransactionClick = (tx: UncategorizedTransactionItem) => {
    const params = new URLSearchParams();
    params.set('categoryIds', 'uncategorized');
    params.set('accountIds', tx.accountId);
    const search = tx.payeeName || tx.description;
    if (search) params.set('search', search);
    router.push(`/transactions?${params.toString()}`);
  };

  const getExportData = () => {
    const headers = [
      t('uncategorizedTransactions.csvColDate'),
      t('uncategorizedTransactions.csvColPayee'),
      t('uncategorizedTransactions.csvColDescription'),
      t('uncategorizedTransactions.csvColAccount'),
      t('uncategorizedTransactions.csvColAmount'),
    ];
    const rows = filteredAndSortedTransactions.map((tx) => [
      format(parseLocalDate(tx.transactionDate), 'yyyy-MM-dd'),
      tx.payeeName || t('uncategorizedTransactions.unknownPayee'),
      tx.description || '',
      tx.accountName || t('uncategorizedTransactions.unknownAccount'),
      tx.amount,
    ]);
    return { headers, rows };
  };

  const handleExportCsv = () => {
    const { headers, rows } = getExportData();
    exportToCsv('uncategorized-transactions', headers, rows);
  };

  const handleExportPdf = async () => {
    const { exportToPdf } = await import('@/lib/pdf-export');
    const { headers, rows } = getExportData();
    await exportToPdf({
      title: t('uncategorizedTransactions.pdfTitle'),
      subtitle: t('uncategorizedTransactions.pdfSubtitle', { count: filteredAndSortedTransactions.length }),
      tableData: { headers, rows },
      filename: 'uncategorized-transactions',
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

  const summary = reportData?.summary || {
    totalCount: 0,
    expenseCount: 0,
    expenseTotal: 0,
    incomeCount: 0,
    incomeTotal: 0,
  };

  return (
    <div className="space-y-6">
      {/* Summary Cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-4">
          <div className="text-sm text-gray-500 dark:text-gray-400">{t('uncategorizedTransactions.totalUncategorized')}</div>
          <div className="text-2xl font-bold text-orange-600 dark:text-orange-400">
            {summary.totalCount}
          </div>
        </div>
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-4">
          <div className="text-sm text-gray-500 dark:text-gray-400">{t('uncategorizedTransactions.uncategorizedExpenses')}</div>
          <div className="text-xl font-bold text-red-600 dark:text-red-400">
            {summary.expenseCount}
          </div>
          <div className="text-sm text-gray-500 dark:text-gray-400">
            {formatCurrency(summary.expenseTotal)}
          </div>
        </div>
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-4">
          <div className="text-sm text-gray-500 dark:text-gray-400">{t('uncategorizedTransactions.uncategorizedIncome')}</div>
          <div className="text-xl font-bold text-green-600 dark:text-green-400">
            {summary.incomeCount}
          </div>
          <div className="text-sm text-gray-500 dark:text-gray-400">
            {formatCurrency(summary.incomeTotal)}
          </div>
        </div>
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-4">
          <div className="text-sm text-gray-500 dark:text-gray-400">{t('uncategorizedTransactions.showing')}</div>
          <div className="text-xl font-bold text-gray-900 dark:text-gray-100">
            {filteredAndSortedTransactions.length}
          </div>
          <div className="text-sm text-gray-500 dark:text-gray-400">
            {t('uncategorizedTransactions.transactions')}
          </div>
        </div>
      </div>

      {/* Controls */}
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-4">
        <div className="flex flex-wrap gap-4 items-center justify-between">
          <DateRangeSelector
            ranges={['1m', '3m', '6m', '1y', 'all']}
            value={dateRange}
            onChange={setDateRange}
          />
          <div className="flex gap-2">
            <button
              onClick={() => setFilterType('all')}
              className={`px-3 py-1.5 text-sm font-medium rounded-md transition-colors ${
                filterType === 'all'
                  ? 'bg-blue-600 text-white'
                  : 'bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300'
              }`}
            >
              {t('uncategorizedTransactions.filterAll')}
            </button>
            <button
              onClick={() => setFilterType('expense')}
              className={`px-3 py-1.5 text-sm font-medium rounded-md transition-colors ${
                filterType === 'expense'
                  ? 'bg-red-600 text-white'
                  : 'bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300'
              }`}
            >
              {t('uncategorizedTransactions.filterExpenses')}
            </button>
            <button
              onClick={() => setFilterType('income')}
              className={`px-3 py-1.5 text-sm font-medium rounded-md transition-colors ${
                filterType === 'income'
                  ? 'bg-green-600 text-white'
                  : 'bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300'
              }`}
            >
              {t('uncategorizedTransactions.filterIncome')}
            </button>
          </div>
        </div>
      </div>

      {/* Transactions Table */}
      {summary.totalCount === 0 ? (
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-6">
          <div className="text-center py-8">
            <svg className="h-12 w-12 mx-auto text-green-500 mb-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            <p className="text-gray-500 dark:text-gray-400">
              {t('uncategorizedTransactions.allCategorized')}
            </p>
          </div>
        </div>
      ) : (
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 overflow-hidden">
          <div className="px-6 py-4 border-b border-gray-200 dark:border-gray-700 flex items-center justify-between">
            <div>
              <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
                {t('uncategorizedTransactions.tableTitle')}
              </h3>
              <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
                {t('uncategorizedTransactions.tableSubtitle')}
              </p>
            </div>
            <ExportDropdown onExportCsv={handleExportCsv} onExportPdf={handleExportPdf} />
          </div>
          {/* Below `sm` the table becomes a block and each row wraps into a
              two-column grid of EQUAL `minmax(0,1fr)` tracks (for the reason
              `MONEY_CELL` measures), so all FOUR columns fit a phone without a
              horizontal scroll, on TWO lines:

                1  payee + description  | amount
                2  account              | date

              Two lines because four cells over two tracks cannot be fewer, and
              two tracks is what this box holds. Measured before: the table is
              950-974px inside a 288px wrapper at 320px (and inside 358px at
              390px), so the account and the amount -- the figure the row is
              read for -- sit entirely behind a sideways scroll on a phone
              today, the identity column is cut mid-name by the same scroll, and
              the description is clipped by its own `truncate max-w-xs` a further
              125px beyond that.

              The left track carries what the row IS -- who was paid, what the
              entry says, and which ledger it sits in -- and the right what it
              was and when. The amount takes the right of line 1 beside the
              identity because it is the figure the row is read for; the date
              closes the card under it.

              The account is a separate `<td>` (so it is its own grid item and
              cannot join the identity's line) but reads as a DESCRIPTOR of the
              identity, so it takes the identity's track on line 2. It KEEPS its
              caption: an account name is not self-describing beside a payee --
              `Visa` under `Corner Store` could be read as either -- where the
              payee and the description are the row itself and need none.

              Which caption goes in which track is a measurement, not a taste.
              All 60 catalogue strings for the three captioned columns -- the 20
              locales that DEFINE these keys, the pseudo-locale included; the two
              lean regional variants (`en-GB`, `en-US`) inherit `en`'s strings
              per key -- were rendered into the 122px a track gets at 320px, at
              `CellLabel`'s own type. NONE overflows and NONE needs a second
              line, in either track, at either width. The two widest strings
              with no break opportunity anywhere are Amount's `Montante` (pt) at
              58px and Account's `Rekening` (nl) at 54px -- 64px and 68px of
              headroom in a 122px track -- so rule 3's "least-breakable caption
              in the left track" cannot bind here, and the semantic placement
              above (the amount beside the identity, the account under it) wins
              rather than fighting it.

              Both text columns are unbounded in the payload, so each sits in a
              `minmax(0,1fr)` track with `min-w-0`: a track that may be zero plus
              a cell that may be narrower than its own content is what lets a
              long name shrink instead of setting the table's minimum width, and
              `break-words` breaks a word too long for the track.
              `sm:break-normal` hands today's wrapping back from `sm` up, and the
              account's `sm:whitespace-nowrap` hands back the nowrap it wears
              today -- which it must NOT wear on a phone, where a 40-character
              account name would set a minimum width no track could hold.

              The description keeps its desktop `truncate max-w-xs` from `sm` up
              and WRAPS below it. That is the one place this layout deliberately
              renders more than the desktop does, and it is not decoration: where
              a row has no payee the identity falls back to `Unknown` and the
              description is the only thing naming the transaction -- it is also
              the string the row's click sends as the register's search term. At
              a 122px track a truncation would show about 18 of its characters
              against the ~55 the 320px desktop cap shows, so truncating here
              would hide the identity of exactly the rows this report exists to
              fix.

              Measured cost, at 320px with a 40-character payee, a 60-character
              description and a 40-character account: a 271px row (215px at
              390px) against the 65px the same content measures on the 800px
              desktop row -- but that 65px is reached only by clipping the
              description and hiding two whole columns behind the scroll, and the
              same row is already 65px-and-unreadable today. No VALUE cell
              exceeds one caption line plus one value line (29px) in any locale;
              the two cells above it are the two unbounded text columns, by
              design. A row with no description and ordinary names is 88px.

              From `sm` up it is the ordinary table, and unlike the sibling
              conversions there is no deliberate desktop delta at all. The
              mechanism is that every declaration this table resolves at >= 640px
              today is restored by an `sm:` variant here: the padding by
              `sm:px-4 sm:py-3`, the account's nowrap by `sm:whitespace-nowrap`,
              the description's cap and ellipsis by `sm:truncate sm:max-w-xs`,
              all THREE cells that drop to `text-xs` below `sm` (the date, the
              amount and the account) by `sm:text-sm`, and the wrapping by
              `sm:break-normal`. The unprefixed classes are then either what the
              cell already carried at every width (the amount's `text-right`,
              both figures' `whitespace-nowrap`) or inert once the row is a
              `table-row` again (the grid, its gaps and the explicit
              placements). So a Chromium replica renders it pixel-identically to
              today at 800px in all six measured locales, with every column width
              and row height unchanged at 800px and 1280px.

              Two costs of restyling one tree, both deliberate. Changing the
              display roles drops the table semantics below `sm`, which is why
              the roles are restated explicitly and every bare figure and date
              carries a `CellLabel` naming its column. And the phone reading
              order differs from the DOM order, which is the desktop column order
              the grid placement overrides visually. Both are properties of the
              mechanism, not of this table. */}
          <div className="overflow-x-auto">
            <table role="table" className="block min-w-full divide-y divide-gray-200 dark:divide-gray-700 sm:table">
              <thead role="rowgroup" className="block bg-gray-50 dark:bg-gray-900/50 sm:table-header-group">
                {/* Phone sort strip: the same four controls, wrapped. */}
                <tr role="row" className="flex flex-wrap gap-x-2 gap-y-1 px-4 py-2 sm:hidden">
                  {sortColumns.map((col) => (
                    <SortableHeader<SortField>
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
                    <SortableHeader<SortField>
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
                {filteredAndSortedTransactions.slice(0, 100).map((tx) => (
                  <tr
                    key={tx.id}
                    role="row"
                    className="grid grid-cols-2 items-start gap-x-3 gap-y-1.5 px-4 py-3 hover:bg-gray-50 dark:hover:bg-gray-700/50 cursor-pointer sm:table-row"
                    onClick={() => handleTransactionClick(tx)}
                  >
                    <td
                      role="cell"
                      className={`col-start-2 row-start-2 text-gray-900 dark:text-gray-100 ${DATE_CELL}`}
                    >
                      <CellLabel className={CAPTION_CLASS}>{columns.date.label}</CellLabel>
                      {format(parseLocalDate(tx.transactionDate), 'MMM d, yyyy')}
                    </td>
                    <td
                      role="cell"
                      className="col-start-1 row-start-1 min-w-0 break-words p-0 text-sm sm:table-cell sm:break-normal sm:px-4 sm:py-3"
                    >
                      <div className="font-medium text-gray-900 dark:text-gray-100">
                        {tx.payeeName || t('uncategorizedTransactions.unknownPayee')}
                      </div>
                      {tx.description && (
                        <div className="text-gray-500 dark:text-gray-400 sm:truncate sm:max-w-xs">
                          {tx.description}
                        </div>
                      )}
                    </td>
                    <td
                      role="cell"
                      className="col-start-1 row-start-2 min-w-0 break-words p-0 text-xs text-gray-500 dark:text-gray-400 sm:table-cell sm:break-normal sm:whitespace-nowrap sm:px-4 sm:py-3 sm:text-sm"
                    >
                      <CellLabel className={CAPTION_CLASS}>{columns.account.label}</CellLabel>
                      {tx.accountName || t('uncategorizedTransactions.unknownAccount')}
                    </td>
                    <td
                      role="cell"
                      className={`col-start-2 row-start-1 font-medium ${gainLossColor(tx.amount)} ${MONEY_CELL}`}
                    >
                      <CellLabel className={CAPTION_CLASS}>{columns.amount.label}</CellLabel>
                      {formatCurrency(tx.amount)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {filteredAndSortedTransactions.length > 100 && (
            <div className="px-6 py-4 border-t border-gray-200 dark:border-gray-700 text-center">
              <p className="text-sm text-gray-500 dark:text-gray-400">
                {t('uncategorizedTransactions.showingFirst', { count: filteredAndSortedTransactions.length })}
              </p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
