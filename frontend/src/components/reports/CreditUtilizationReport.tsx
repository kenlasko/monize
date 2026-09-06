'use client';

import { useMemo, useRef } from 'react';
import {
  BarChart,
  Bar,
  Cell,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  ReferenceLine,
  PieChart,
  Pie,
} from 'recharts';
import { Skeleton } from '@/components/ui/LoadingSkeleton';
import { accountsApi } from '@/lib/accounts';
import {
  computeCreditRows,
  computeCreditTotals,
  type CreditUtilizationRow,
} from '@/lib/credit-utilization';
import { Account } from '@/types/account';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import { useExchangeRates } from '@/hooks/useExchangeRates';
import { useReportData } from '@/hooks/useReportData';
import { usePersistedAccountFilter } from '@/hooks/usePersistedAccountFilter';
import { ReportAccountMultiSelect } from '@/components/reports/ReportAccountMultiSelect';
import { ExportDropdown } from '@/components/ui/ExportDropdown';
import { SortableHeader } from '@/components/ui/SortableHeader';
import { CellLabel } from '@/components/ui/Table';
import { PartialTotal } from '@/components/ui/PartialTotal';
import { useSortableTable, compareValues } from '@/hooks/useSortableTable';
import { ReportError } from '@/components/reports/ReportError';
import { useTranslations } from 'next-intl';
import { chartColors } from '@/lib/chart-colors';

// Only credit cards and lines of credit with a credit limit can have a
// meaningful utilization figure (used / available credit).
const isCreditAccount = (account: Account) =>
  (account.accountType === 'CREDIT_CARD' || account.accountType === 'LINE_OF_CREDIT') &&
  account.creditLimit != null &&
  account.creditLimit > 0 &&
  !account.isClosed;

type CreditUtilizationSortField =
  | 'name'
  | 'limit'
  | 'used'
  | 'available'
  | 'utilization';

/**
 * One sortable column of the data table. The five are declared once, as a
 * record over the sort field union, and rendered by BOTH header rows -- the
 * column header row (from `sm` up) and the phone sort strip -- so the two can
 * never list different fields, and adding a member to the union fails `tsc`
 * rather than stranding a phone with no control for it.
 */
interface SortColumn {
  field: CreditUtilizationSortField;
  label: string;
  /** Money and percent columns are right-aligned in the column header row. */
  align?: 'right';
}

/**
 * The record the two header rows are built from, keyed by sort field.
 *
 * The key is tied to the entry's own `field`, which a plain
 * `Record<CreditUtilizationSortField, SortColumn>` does not do: that forces an
 * entry to EXIST for every member of the union but lets it name a different
 * one, so `used: { field: 'limit', label: colUsed }` type-checks. Both header
 * rows would then render two controls keyed `limit` (a duplicate React key),
 * tapping "Used" would sort by Credit Limit, and "Used" would be unsortable --
 * and a test comparing header LABELS cannot see any of it, because the labels
 * stay right. Here it is a compile error instead.
 */
type SortColumnsByField = {
  [K in CreditUtilizationSortField]: SortColumn & { field: K };
};

// Utilization thresholds drive the bar colour: low (green), moderate (amber),
// high (red). 30% / 75% mirror the common "keep utilization under 30%" guidance.
function utilizationColour(percent: number): string {
  if (percent >= 75) return chartColors.expense;
  if (percent >= 30) return chartColors.warning;
  return chartColors.income;
}

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

// A figure cell inside a wrapped card: no padding of its own below `sm` (the
// row supplies it and the grid does the spacing), the table cell's own padding
// from `sm` up. Smaller type on phones. The colour stays on each cell, because
// the three money cells and the utilization cell are coloured differently.
//
// `whitespace-nowrap` is the one property here that is NOT phone-only, and it
// is the single respect in which the `sm`-and-up cell differs from today's: a
// locale that groups thousands with a space could otherwise break a figure in
// the middle of a number, at any width.
//
// Width budget, measured on a hand-written CSS replica in Chromium at the
// insets this table really gets -- the report page's `px-4` and the row's own
// `px-4`, the card contributing none -- so 256px of track at 320px and 326px
// at 390px. The row is a six-track grid: line 1 gives the account and the
// utilization three tracks each (122px at 320px, 157px at 390px, the same as
// an equal pair); line 2 gives the limit, the used and the available amounts
// two tracks each -- 77px at 320px and 101px at 390px.
//
// The formatter here is the 2dp `formatCurrency`, not the compact one the
// sibling reports use. The maintainer asked for the three amounts on one
// line after the phone review of this branch, knowing the budget: a credit
// limit is typically four or five figures, and `$12,345.00` at `text-xs` is
// about 65px, which fits the 77px track. The widest realistic value, a
// six-figure amount in a currency `narrowSymbol` has no symbol for
// (`123 456,78 CHF`, 97px), does NOT fit at 320px -- three of them need
// 3 x 97 + 2 x 12 = 315px against 256px -- and overflows its track's end
// edge, reopening the wrapper's sideways scroll there; at 390px the same
// figure fits a 101px track. That is the accepted trade: the common case on
// one line, the six-figure ISO-code case scrolling at 320px only.
//
// Right alignment is not a containment device: a nowrap figure longer than its
// track overflows past the END edge whatever `text-align` says, and in the
// right-hand track that reopens the wrapper's sideways scroll. That is the
// deliberate choice -- `overflow-hidden` here would silently cut a figure, and
// a cut figure is worse than a crowded one or an honest scroll.
const FIGURE_CELL =
  'p-0 text-right text-xs whitespace-nowrap sm:table-cell sm:px-4 sm:py-3 sm:text-sm';

/** Every caption in a wrapped cell is phone-only. */
const CAPTION_CLASS = 'sm:hidden';


/** One slice of the total-utilization donut: drawn vs available credit. */
interface TotalUtilizationSlice {
  key: 'used' | 'available';
  name: string;
  /** Amount in the report's display currency. */
  value: number;
  /** Share of the total credit limit. */
  percent: number;
  color: string;
}

const ACCOUNTS_STORAGE_KEY = 'monize-reports-credit-utilization-accounts';

export function CreditUtilizationReport() {
  const t = useTranslations('reports');
  const tCommon = useTranslations('common');
  const { formatCurrency, formatPercent, formatPercentTrimmed } = useNumberFormat();
  const { convert, defaultCurrency } = useExchangeRates();
  const chartRef = useRef<HTMLDivElement>(null);

  const { sortField, sortDirection, handleSort } = useSortableTable<CreditUtilizationSortField>(
    'reports.credit-utilization.sort',
    { field: 'utilization', direction: 'desc' },
  );

  const {
    data: accountsData,
    isLoading,
    error,
    reload,
  } = useReportData(
    () => accountsApi.getAll().then((all) => all.filter(isCreditAccount)),
    [],
  );

  const creditAccounts = useMemo(() => accountsData ?? [], [accountsData]);

  // Persisted so the report opens on the accounts the user last chose.
  const [selectedAccountIds, setSelectedAccountIds] = usePersistedAccountFilter(
    ACCOUNTS_STORAGE_KEY,
    creditAccounts,
  );

  // An empty selection means "all credit accounts", matching the other reports.
  const activeAccounts = useMemo(
    () =>
      selectedAccountIds.length > 0
        ? creditAccounts.filter((a) => selectedAccountIds.includes(a.id))
        : creditAccounts,
    [creditAccounts, selectedAccountIds],
  );

  // When every selected account shares one currency, report in that currency;
  // any mix falls back to the user's home currency.
  const displayCurrency = useMemo(() => {
    const currencies = new Set(activeAccounts.map((a) => a.currencyCode));
    return currencies.size === 1 ? [...currencies][0] : defaultCurrency;
  }, [activeAccounts, defaultCurrency]);

  const isConverted = activeAccounts.some((a) => a.currencyCode !== displayCurrency);

  // The dashboard credit widgets share these helpers; the report uses the same
  // ones rather than a second copy of the null-exclusion logic.
  const rows = useMemo(
    () => computeCreditRows(activeAccounts, convert, displayCurrency),
    [activeAccounts, convert, displayCurrency],
  );

  /** A money figure, or a short "no rate" marker in its place. */
  const fmtOrUnknown = (value: number | null) =>
    value === null
      ? t('creditUtilization.noRate')
      : formatCurrency(value, displayCurrency);

  const totals = useMemo(() => computeCreditTotals(rows), [rows]);

  // The partial-total marker the money summary cards share.
  const totalsMarker = {
    missingCurrencies: totals.missingCurrencies,
    excludedCount: totals.excludedCount,
  };

  const sortedRows = useMemo(() => {
    const sorted = [...rows];
    sorted.sort((a, b) => {
      let comparison = 0;
      switch (sortField) {
        case 'name':
          comparison = compareValues(a.name, b.name);
          break;
        case 'limit':
          comparison = compareValues(a.limit, b.limit);
          break;
        case 'used':
          comparison = compareValues(a.used, b.used);
          break;
        case 'available':
          comparison = compareValues(a.available, b.available);
          break;
        case 'utilization':
          comparison = compareValues(a.utilizationPercent, b.utilizationPercent);
          break;
      }
      return sortDirection === 'asc' ? comparison : -comparison;
    });
    return sorted;
  }, [rows, sortField, sortDirection]);

  // Exhaustive over the sort field union, so a new field is a compile error
  // rather than a column with no control in either header -- and each entry
  // must name its own key (see `SortColumnsByField`).
  const columns: SortColumnsByField = {
    name: { field: 'name', label: t('creditUtilization.colAccount') },
    limit: { field: 'limit', label: t('creditUtilization.colCreditLimit'), align: 'right' },
    used: { field: 'used', label: t('creditUtilization.colUsed'), align: 'right' },
    available: { field: 'available', label: t('creditUtilization.colAvailable'), align: 'right' },
    utilization: { field: 'utilization', label: t('creditUtilization.colUtilization'), align: 'right' },
  };

  // Their order, rendered by BOTH header rows and matched by the cells' DOM
  // order. DERIVED from the record rather than re-listed: a hand-written list
  // beside an exhaustive record is not exhaustive, so a field added to the
  // union would compile (the record forces an entry) and still ship with no
  // sort control in either header -- exactly the stranding the record exists to
  // prevent. The record's declaration order is the column order.
  const sortColumns: readonly SortColumn[] = Object.values(columns);

  const accountTypeLabel = (type: Account['accountType']) =>
    type === 'LINE_OF_CREDIT'
      ? t('creditUtilization.typeLineOfCredit')
      : t('creditUtilization.typeCreditCard');

  const handleExportPdf = async () => {
    const { exportToPdf } = await import('@/lib/pdf-export');
    const headers = [
      t('creditUtilization.colAccount'),
      t('creditUtilization.colType'),
      t('creditUtilization.colCreditLimit'),
      t('creditUtilization.colUsed'),
      t('creditUtilization.colAvailable'),
      t('creditUtilization.colUtilization'),
    ];
    const exportRows = sortedRows.map((r) => [
      r.name,
      accountTypeLabel(r.accountType),
      fmtOrUnknown(r.limit),
      fmtOrUnknown(r.used),
      fmtOrUnknown(r.available),
      formatPercent(r.utilizationPercent, 1),
    ]);
    // A card with no rate is excluded from the totals, so the PDF marks them
    // partial rather than printing a subtotal as the whole.
    const pdfPartialSuffix =
      totals.excludedCount > 0 ? ` ${tCommon('partialTotal.srSuffix')}` : '';
    await exportToPdf({
      title: t('creditUtilization.pdfTitle'),
      summaryCards: [
        { label: t('creditUtilization.totalLimit'), value: `${formatCurrency(totals.limit, displayCurrency)}${pdfPartialSuffix}`, color: '#2563eb' },
        { label: t('creditUtilization.totalUsed'), value: `${formatCurrency(totals.used, displayCurrency)}${pdfPartialSuffix}`, color: '#dc2626' },
        { label: t('creditUtilization.totalAvailable'), value: `${formatCurrency(totals.available, displayCurrency)}${pdfPartialSuffix}`, color: '#16a34a' },
        { label: t('creditUtilization.overallUtilization'), value: `${formatPercent(totals.utilizationPercent, 1)}${pdfPartialSuffix}`, color: '#ea580c' },
      ],
      chartContainer: chartRef.current,
      tableData: { headers, rows: exportRows },
      filename: 'credit-utilization',
    });
  };

  if (error) {
    return <ReportError onRetry={reload} />;
  }

  if (isLoading && accountsData === null) {
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

  if (creditAccounts.length === 0) {
    return (
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-8 text-center">
        <p className="text-gray-500 dark:text-gray-400">
          {t('creditUtilization.empty')}
        </p>
      </div>
    );
  }

  // Scales with the account count; the chart container also stretches to fill
  // the row, so with few accounts the bars use the full height of the donut
  // column instead of leaving empty space below.
  const chartMinHeight = Math.max(200, sortedRows.length * 52);

  // The donut shows drawn credit (coloured by the same thresholds as the bars)
  // against remaining available credit (muted). Available is clamped at zero
  // so an over-limit balance still renders as a fully used pie.
  const availableForPie = Math.max(totals.available, 0);
  const totalPieData: TotalUtilizationSlice[] = [
    {
      key: 'used',
      name: t('creditUtilization.tooltipUsed'),
      value: totals.used,
      percent: totals.utilizationPercent,
      color: utilizationColour(totals.utilizationPercent),
    },
    {
      key: 'available',
      name: t('creditUtilization.tooltipAvailable'),
      value: availableForPie,
      percent: totals.limit > 0 ? (availableForPie / totals.limit) * 100 : 0,
      color: chartColors.grid,
    },
  ];

  return (
    <div className="space-y-6">
      {/* Account Filter */}
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-4">
        <div className="flex flex-wrap gap-3 items-center justify-between">
          <ReportAccountMultiSelect
            accounts={creditAccounts}
            value={selectedAccountIds}
            onChange={setSelectedAccountIds}
            filter={() => true}
          />
          <ExportDropdown onExportPdf={handleExportPdf} />
        </div>
      </div>

      {/* Summary Cards. A card with no rate is excluded from the money totals
          and the utilisation ratio, so the figures are marked partial rather
          than reporting an improved ratio the excluded card would have worsened. */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-2 sm:gap-4">
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-3 sm:p-4">
          <p className="text-xs sm:text-sm text-gray-500 dark:text-gray-400">{t('creditUtilization.totalLimit')}</p>
          <p className="text-lg sm:text-xl font-bold text-gray-900 dark:text-gray-100">
            <PartialTotal total={{ value: totals.limit, ...totalsMarker }} displayCurrency={displayCurrency}>
              {formatCurrency(totals.limit, displayCurrency)}
            </PartialTotal>
          </p>
        </div>
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-3 sm:p-4">
          <p className="text-xs sm:text-sm text-gray-500 dark:text-gray-400">{t('creditUtilization.totalUsed')}</p>
          <p className="text-lg sm:text-xl font-bold text-red-600 dark:text-red-400">
            <PartialTotal total={{ value: totals.used, ...totalsMarker }} displayCurrency={displayCurrency}>
              {formatCurrency(totals.used, displayCurrency)}
            </PartialTotal>
          </p>
        </div>
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-3 sm:p-4">
          <p className="text-xs sm:text-sm text-gray-500 dark:text-gray-400">{t('creditUtilization.totalAvailable')}</p>
          <p className="text-lg sm:text-xl font-bold text-green-600 dark:text-green-400">
            <PartialTotal total={{ value: totals.available, ...totalsMarker }} displayCurrency={displayCurrency}>
              {formatCurrency(totals.available, displayCurrency)}
            </PartialTotal>
          </p>
        </div>
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-3 sm:p-4">
          <p className="text-xs sm:text-sm text-gray-500 dark:text-gray-400">{t('creditUtilization.overallUtilization')}</p>
          <p className="text-lg sm:text-xl font-bold text-gray-900 dark:text-gray-100">
            {formatPercent(totals.utilizationPercent, 1)}
            {totals.excludedCount > 0 && (
              <span className="text-amber-600 dark:text-amber-400" aria-hidden="true"> *</span>
            )}
          </p>
        </div>
      </div>
      {totals.missingCurrencies.length > 0 && (
        <p className="text-xs text-amber-600 dark:text-amber-400">
          {tCommon('partialTotal.explanation', {
            count: totals.excludedCount,
            displayCurrency,
            currencies: totals.missingCurrencies.join(', '),
          })}
        </p>
      )}

      {isConverted && (
        <p className="text-xs text-gray-500 dark:text-gray-400">
          {t('creditUtilization.convertedNote', { currency: displayCurrency })}
        </p>
      )}

      {/* Utilization Charts */}
      <div ref={chartRef} className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-3 sm:p-6">
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          <div className="min-w-0 lg:col-span-2 flex flex-col">
            <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-4">
              {t('creditUtilization.utilizationByAccount')}
            </h3>
            {/* The absolutely positioned inner div lets ResponsiveContainer
                track the stretched flex height without a feedback loop. */}
            <div className="relative flex-1" style={{ minHeight: chartMinHeight }}>
              <div className="absolute inset-0">
                <ResponsiveContainer minWidth={0}>
                  <BarChart data={sortedRows} layout="vertical" margin={{ left: 8, right: 24 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke={chartColors.grid} horizontal={false} />
                    <XAxis
                      type="number"
                      domain={[0, 100]}
                      tickFormatter={(value: number) => `${formatPercentTrimmed(value)}`}
                      tick={{ fontSize: 12 }}
                    />
                    <YAxis
                      type="category"
                      dataKey="name"
                      width={120}
                      tick={{ fontSize: 12 }}
                    />
                    <Tooltip
                      content={({ active, payload }) => {
                        if (!active || !payload?.length) return null;
                        const row = payload[0].payload as CreditUtilizationRow;
                        return (
                          <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg shadow-lg p-3">
                            <p className="font-medium text-gray-900 dark:text-gray-100">{row.name}</p>
                            <p className="text-sm text-gray-600 dark:text-gray-400">
                              {t('creditUtilization.tooltipUtilization')}: {formatPercent(row.utilizationPercent, 1)}
                            </p>
                            <p className="text-sm text-gray-600 dark:text-gray-400">
                              {t('creditUtilization.tooltipUsed')}: {fmtOrUnknown(row.used)}
                            </p>
                            <p className="text-sm text-gray-600 dark:text-gray-400">
                              {t('creditUtilization.tooltipAvailable')}: {fmtOrUnknown(row.available)}
                            </p>
                          </div>
                        );
                      }}
                    />
                    <ReferenceLine x={100} stroke={chartColors.axis} strokeDasharray="4 4" />
                    <Bar dataKey="utilizationPercent" radius={[0, 4, 4, 0]} maxBarSize={32}>
                      {sortedRows.map((row) => (
                        <Cell key={row.id} fill={utilizationColour(row.utilizationPercent)} />
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </div>
          </div>
          <div className="min-w-0">
            <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-4">
              {t('creditUtilization.totalUtilization')}
            </h3>
            <div className="relative mx-auto w-full max-w-xs" style={{ height: 240 }}>
              <ResponsiveContainer minWidth={0}>
                <PieChart>
                  <Pie
                    data={totalPieData}
                    cx="50%"
                    cy="50%"
                    innerRadius="62%"
                    outerRadius="92%"
                    startAngle={90}
                    endAngle={-270}
                    paddingAngle={2}
                    dataKey="value"
                  >
                    {totalPieData.map((slice) => (
                      <Cell key={slice.key} fill={slice.color} />
                    ))}
                  </Pie>
                  <Tooltip
                    content={({ active, payload }) => {
                      if (!active || !payload?.length) return null;
                      const slice = payload[0].payload as TotalUtilizationSlice;
                      return (
                        <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg shadow-lg p-3">
                          <p className="font-medium text-gray-900 dark:text-gray-100">{slice.name}</p>
                          <p className="text-sm text-gray-600 dark:text-gray-400">
                            {formatCurrency(slice.value, displayCurrency)} ({formatPercent(slice.percent, 1)})
                          </p>
                        </div>
                      );
                    }}
                  />
                </PieChart>
              </ResponsiveContainer>
              <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                <span className="text-2xl font-bold text-gray-900 dark:text-gray-100">
                  {formatPercent(totals.utilizationPercent, 1)}
                </span>
              </div>
            </div>
            <div className="mt-4 space-y-2">
              {totalPieData.map((slice) => (
                <div key={slice.key} className="flex items-center gap-2 text-sm">
                  <span className="w-3 h-3 rounded-sm shrink-0" style={{ backgroundColor: slice.color }} />
                  <span className="flex-1 text-gray-600 dark:text-gray-400">{slice.name}</span>
                  <span className="font-medium text-gray-900 dark:text-gray-100">
                    {formatCurrency(slice.value, displayCurrency)}
                  </span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* Data Table

          Below `sm` the table becomes a block and each row wraps into a
          six-track grid so all five columns fit a phone without a horizontal
          scroll, on two lines: the account and its utilization -- the figure
          the row is read for -- share line 1, three tracks each; the credit
          limit, the amount used and the amount available share line 2, two
          tracks each. Two lines rather than three is the maintainer's call
          from the phone review of this branch, made against the measurement
          `FIGURE_CELL` records: typical four- and five-figure limits fit a
          77px track at 320px, and a six-figure ISO-code amount overflows it
          there (and only there). Nothing is dropped -- the card carries
          all five columns -- and the row stays what it is today: hovering, but
          NOT clickable. From `sm` up it is the ordinary table. The sort
          controls survive as their own phone-only header row, because the
          column header row that carries them on desktop is hidden there.

          Two properties of restyling one tree, both deliberate. Changing the
          `display` would drop the implicit table semantics below `sm`, so the
          explicit ARIA roles below put them back -- the phone sort strip is the
          header row a phone reader gets, and its five controls sit in the
          cells' own DOM order, so the column association survives. The
          `CellLabel` captions are therefore REDUNDANT with that association
          rather than a substitute for it, and deliberately so: the grid places
          the cells out of DOM order visually, so a sighted phone reader has no
          header row to look up and needs the name beside the value.

          The second is an ACCEPTED, UNMITIGATED trade-off, and the roles are
          not what answers it: they restore the table semantics, and have no
          effect on reading order. The DOM keeps the desktop column order
          (account, limit, used, available, utilization) while the grid shows
          utilization second, so a screen-reader user hears
          the headline figure fifth -- the WCAG 1.3.2 tension mechanism A
          carries. What limits the cost is the captions: every value names its
          own column, so each one is self-describing in whatever order it is
          heard. Both are properties of the mechanism, not of this table. */}
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 overflow-hidden">
        <div className="overflow-x-auto">
          {/* Explicit roles: restyling `display` below `sm` strips the implicit
              table semantics, and these put them back (inert from `sm` up). */}
          <table role="table" className="block min-w-full divide-y divide-gray-200 dark:divide-gray-700 sm:table">
            <thead role="rowgroup" className="block bg-gray-50 dark:bg-gray-900/50 sm:table-header-group">
              {/* Phone sort strip: the same five controls, wrapped. */}
              <tr role="row" className="flex flex-wrap gap-x-2 gap-y-1 px-2 py-2 sm:hidden">
                {sortColumns.map((col) => (
                  <SortableHeader<CreditUtilizationSortField>
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
                  <SortableHeader<CreditUtilizationSortField>
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
              {sortedRows.map((row) => (
                <tr
                  key={row.id}
                  role="row"
                  className="grid grid-cols-6 items-start gap-x-3 gap-y-1.5 px-4 py-3 hover:bg-gray-50 dark:hover:bg-gray-700/50 sm:table-row sm:p-0"
                >
                  {/* The identity. An account name is unbounded (40-plus
                      characters is ordinary), so it sits in a `minmax(0,1fr)`
                      track with `min-w-0`: a track that may be zero lets the
                      name shrink, where a flex item's `min-w-0` still
                      contributes the full width of its text to the row's
                      minimum. The tier cell WRAPS the name today, so the card
                      clamps rather than truncates (a `truncate` would be a
                      regression), and `sm:line-clamp-none` hands the wrap back
                      from `sm` up. Measured rendered width: 122px at 320px and
                      157px at 390px.

                      THREE lines, not two, and that is measured: at 122px a
                      two-line clamp shows about 25 characters, so two cards
                      differing only after "Scotiabank Momentum Visa " read as
                      the same account -- and `title` is a hover affordance a
                      touch screen does not have, so there is no second way to
                      tell them apart. Three lines show the whole of a
                      40-character name at both widths. Containment is
                      unaffected either way (a wrapping box contributes no
                      minimum width); the cost is 20px of row height, and only
                      on the rows whose name actually needs it.

                      `title` is therefore NOT the phone's fallback -- it is for
                      the one width where the clamp bites and a pointer exists,
                      a mouse-driven window under 640px. From `sm` up the name
                      wraps in full and the tooltip only repeats what is on
                      screen.

                      The account-type sub-line is bounded (22 characters at its
                      longest, in the pseudo-locale) and is left to wrap on its
                      own, so the `flex flex-col` markup below is exactly
                      today's. */}
                  <td role="cell" className="col-start-1 col-span-3 row-start-1 min-w-0 p-0 text-sm font-medium text-gray-900 dark:text-gray-100 sm:table-cell sm:px-4 sm:py-3">
                    <div className="flex flex-col">
                      <span className="line-clamp-3 break-words sm:line-clamp-none sm:break-normal" title={row.name}>{row.name}</span>
                      <span className="text-xs text-gray-500 dark:text-gray-400">
                        {accountTypeLabel(row.accountType)}
                      </span>
                    </div>
                  </td>
                  <td role="cell" className={`col-start-1 col-span-2 row-start-2 text-gray-600 dark:text-gray-400 ${FIGURE_CELL}`}>
                    <CellLabel className={CAPTION_CLASS}>{columns.limit.label}</CellLabel>
                    {fmtOrUnknown(row.limit)}
                  </td>
                  <td role="cell" className={`col-start-3 col-span-2 row-start-2 text-gray-600 dark:text-gray-400 ${FIGURE_CELL}`}>
                    <CellLabel className={CAPTION_CLASS}>{columns.used.label}</CellLabel>
                    {fmtOrUnknown(row.used)}
                  </td>
                  {/* Available ends line 2, beside Used: three amounts on one
                      line, two tracks each (see `FIGURE_CELL` for what fits). */}
                  <td role="cell" className={`col-start-5 col-span-2 row-start-2 text-gray-600 dark:text-gray-400 ${FIGURE_CELL}`}>
                    <CellLabel className={CAPTION_CLASS}>{columns.available.label}</CellLabel>
                    {fmtOrUnknown(row.available)}
                  </td>
                  {/* Utilization is the headline: it takes the right of line 1
                      beside the account, because it is what the row is read
                      for. Its threshold colouring is unchanged. */}
                  <td role="cell" className={`col-start-4 col-span-3 row-start-1 font-medium ${FIGURE_CELL}`} style={{ color: utilizationColour(row.utilizationPercent) }}>
                    <CellLabel className={CAPTION_CLASS}>{columns.utilization.label}</CellLabel>
                    {formatPercent(row.utilizationPercent, 1)}
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot role="rowgroup" className="block bg-gray-50 dark:bg-gray-900/50 sm:table-footer-group">
              {/* The totals are the largest figures on the table, so this row
                  wraps exactly the way a data row does -- the same six tracks
                  and the same placement, each figure captioned -- with "Total"
                  standing in for the account in the identity track. */}
              <tr role="row" className="grid grid-cols-6 items-start gap-x-3 gap-y-1.5 px-4 py-3 sm:table-row sm:p-0">
                <td role="cell" className="col-start-1 col-span-3 row-start-1 min-w-0 p-0 text-sm font-bold text-gray-900 dark:text-gray-100 sm:table-cell sm:px-4 sm:py-3">
                  {t('creditUtilization.total')}
                </td>
                <td role="cell" className={`col-start-1 col-span-2 row-start-2 font-bold text-gray-900 dark:text-gray-100 ${FIGURE_CELL}`}>
                  <CellLabel className={CAPTION_CLASS}>{columns.limit.label}</CellLabel>
                  {formatCurrency(totals.limit, displayCurrency)}
                </td>
                <td role="cell" className={`col-start-3 col-span-2 row-start-2 font-bold text-gray-900 dark:text-gray-100 ${FIGURE_CELL}`}>
                  <CellLabel className={CAPTION_CLASS}>{columns.used.label}</CellLabel>
                  {formatCurrency(totals.used, displayCurrency)}
                </td>
                <td role="cell" className={`col-start-5 col-span-2 row-start-2 font-bold text-gray-900 dark:text-gray-100 ${FIGURE_CELL}`}>
                  <CellLabel className={CAPTION_CLASS}>{columns.available.label}</CellLabel>
                  {formatCurrency(totals.available, displayCurrency)}
                </td>
                <td role="cell" className={`col-start-4 col-span-3 row-start-1 font-bold text-gray-900 dark:text-gray-100 ${FIGURE_CELL}`}>
                  <CellLabel className={CAPTION_CLASS}>{columns.utilization.label}</CellLabel>
                  {formatPercent(totals.utilizationPercent, 1)}
                </td>
              </tr>
            </tfoot>
          </table>
        </div>
      </div>
    </div>
  );
}
