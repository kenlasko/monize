'use client';

import { useReportExportMetadata } from '@/hooks/useReportExportMetadata';
import { useReportingBasis, useReportingRouter } from './ReportingBasis';
import { useState, useMemo, useRef } from 'react';
import { useTranslations } from 'next-intl';
import { Skeleton } from '@/components/ui/LoadingSkeleton';

import {
  PieChart,
  Pie,
  Cell,
  ResponsiveContainer,
  Tooltip,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
} from 'recharts';
import { builtInReportsApi } from '@/lib/built-in-reports';
import { ReportAccountMultiSelect } from '@/components/reports/ReportAccountMultiSelect';
import { TaggedFundsControls } from '@/components/reports/TaggedFundsControls';
import { TaggedFundsStrip, type FundsFigure } from '@/components/reports/TaggedFundsStrip';
import { useReportAccountScope, nonInvestmentAccounts } from '@/hooks/useReportAccountScope';
import { useTaggedFundsFilter } from '@/hooks/useTaggedFundsFilter';
import { useTaggedFunding } from '@/hooks/useTaggedFunding';
import { spendingFunds } from '@/lib/spending-funds';
import { CategorySpendingItem } from '@/types/built-in-reports';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import { useExchangeRates } from '@/hooks/useExchangeRates';
import { useDateRange } from '@/hooks/useDateRange';
import { useReportData } from '@/hooks/useReportData';
import { useSortableTable, compareValues } from '@/hooks/useSortableTable';
import { CHART_COLOURS } from '@/lib/chart-colours';
import { chartColors } from '@/lib/chart-colors';
import { DateRangeSelector } from '@/components/ui/DateRangeSelector';
import { ChartViewToggle } from '@/components/ui/ChartViewToggle';
import { DonutCenterTotal } from '@/components/ui/DonutCenterTotal';
import { ChartLegend } from '@/components/ui/ChartLegend';
import { PartialTotal } from '@/components/ui/PartialTotal';
import { usePartialTotalNote } from '@/hooks/usePartialTotalNote';
import type { ConvertedTotal } from '@/lib/currency-total';
import { ReportToolbarActions } from '@/components/reports/ReportToolbarActions';
import { SortableHeader } from '@/components/ui/SortableHeader';
import { CAPTION_CLASS, CellLabel, PHONE_HEADER_CLASS } from '@/components/ui/Table';
import type {
  SortColumn as TableSortColumn,
  SortColumnsByField as TableSortColumnsByField,
} from '@/components/ui/Table';
import { INTERACTIVE_ROW_FOCUS_CLASS, activateOnKey } from '@/components/ui/interactive-row';
import { ChartTooltipPanel } from '@/components/reports/ChartTooltip';
import { ReportError } from '@/components/reports/ReportError';
import type { ChartDatum } from '@/types/chart';

type SpendingCategorySortField = 'name' | 'value' | 'percentage';

type ChartDataItem = ChartDatum & { id: string; colour: string };

/**
 * One column of the data table, and the record the two header rows are built
 * from -- the shared declarations from `ui/Table`, as eleven sibling reports
 * use them. The alignment is narrowed to `'right'` because that is the only one
 * this table's amount and percentage columns take. The labels double as the
 * phone captions, so a value reads under exactly the label its column header
 * uses.
 */
type SortColumn = TableSortColumn<SpendingCategorySortField, 'right'>;
type SortColumnsByField = TableSortColumnsByField<SpendingCategorySortField, SortColumn>;

// Today's header cell, unchanged. This report's SortableHeader is not
// upper-tracked, so the local class matches the pre-conversion markup exactly
// (no `tracking-wider`); the `sm`-and-up header is byte-for-byte today's.
const HEADER_CLASS =
  'px-4 py-3 text-xs font-medium text-gray-500 dark:text-gray-400 uppercase';

// A figure cell inside a wrapped card: no padding of its own below `sm` (the
// row supplies it and the grid does the spacing), the table cell's own padding
// from `sm` up. Smaller type on phones. `whitespace-nowrap` is the one property
// here that is NOT phone-only -- the single respect in which the `sm`-and-up
// cell differs from today's -- so a locale that groups thousands with a space
// cannot break a figure in the middle of a number. The amount uses the compact
// formatter, so the two figures share line 2 comfortably at 320px.
const FIGURE_CELL =
  'p-0 text-right text-xs whitespace-nowrap sm:table-cell sm:px-4 sm:py-3 sm:text-sm';

// The row's phone grid: two equal tracks. The category takes the whole of line
// 1 (it is an unbounded name and wraps), the amount and the share split line 2
// -- the amount under the left half, the share under the right. Shared by the
// data rows and the totals footer so a reader finds each figure in the same
// corner of every card. Inert from `sm` up, where each row is a table row again.
const ROW_GRID =
  'grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] items-start gap-x-3 gap-y-1.5 px-4 py-3';

// Where each column sits on the phone grid, written once for the data rows and
// the totals footer: both shapes are the same three cells over the same two
// tracks, so the footer takes a data row's placement verbatim and a reader
// finds each figure in the same corner of both. Writing the placements out at
// each cell instead is how a footer comes to land in different tracks from the
// rows above it. Auto-flow would place them by DOM order and silently re-flow
// the moment a cell became conditional; these are inert from `sm` up, where
// each row is a table row again.
const CELL_PLACEMENT: Record<SpendingCategorySortField, string> = {
  name: 'col-start-1 col-span-2 row-start-1',
  value: 'col-start-1 row-start-2',
  percentage: 'col-start-2 row-start-2',
};

// The identity cell (the coloured dot and the category name), the same box in
// the data rows and the footer. `min-w-0` lets the name shrink in its track;
// the name itself wraps unclamped below `sm` (`break-words`) and takes today's
// `break-normal` back from `sm` up. Keeps `text-sm` on phones -- a category
// name is prose, not a figure.
const IDENTITY_CELL =
  `${CELL_PLACEMENT.name} min-w-0 p-0 text-sm sm:table-cell sm:px-4 sm:py-3`;

interface SpendingCategoryTooltipProps {
  active?: boolean;
  payload?: Array<{ payload: { id: string; name: string; value: number } }>;
  totalExpenses: number;
  formatCurrency: (value: number) => string;
  formatPercent: (value: number, decimals?: number) => string;
}

function SpendingCategoryTooltip({ active, payload, totalExpenses, formatCurrency, formatPercent }: SpendingCategoryTooltipProps) {
  if (!active || !payload || !payload.length) return null;
  const data = payload[0].payload;
  const percentage = totalExpenses > 0 ? (data.value / totalExpenses) * 100 : 0;
  return (
    <ChartTooltipPanel>
      <p className="font-medium text-gray-900 dark:text-gray-100">{data.name}</p>
      <p className="text-gray-600 dark:text-gray-400">
        {formatCurrency(data.value)} ({formatPercent(percentage, 1)})
      </p>
    </ChartTooltipPanel>
  );
}

const ACCOUNTS_STORAGE_KEY = 'monize-reports-spending-by-category-accounts';
const INCLUDE_TRANSFERS_STORAGE_KEY = 'monize-reports-spending-by-category-include-transfers';

export function SpendingByCategoryReport() {
  const { exportCsvWithBasis, withPdfBasis } = useReportExportMetadata();
  const basis = useReportingBasis();
  const t = useTranslations('reports');
  const router = useReportingRouter();
  const chartRef = useRef<HTMLDivElement>(null);
  const { formatCurrencyCompact: formatCurrency, formatPercent } = useNumberFormat();
  const { defaultCurrency } = useExchangeRates();
  const [viewType, setViewType] = useState<'pie' | 'bar' | 'table'>('pie');
  const { dateRange, setDateRange, startDate, setStartDate, endDate, setEndDate, resolvedRange, isValid } =
    useDateRange({ defaultRange: '3m' });
  const { sortField, sortDirection, handleSort } = useSortableTable<SpendingCategorySortField>(
    'reports.spending-by-category.table.sort',
    { field: 'value', direction: 'desc' },
  );

  const { start: rangeStart, end: rangeEnd } = resolvedRange;

  const scope = useReportAccountScope(ACCOUNTS_STORAGE_KEY);
  const { selectedAccountIds, accountIdsKey } = scope;
  const fundsFilter = useTaggedFundsFilter(INCLUDE_TRANSFERS_STORAGE_KEY);
  // A key AND a value narrow the report itself to that value's rows (spec
  // 11.4); either alone sends nothing, so the request is today's.
  const tagFilter = fundsFilter.active
    ? { tagKey: fundsFilter.tagKey, tagValue: fundsFilter.tagValue }
    : {};

  const { data: response, isLoading, error, reload } = useReportData(
    () =>
      isValid
        ? builtInReportsApi.getSpendingByCategory({
            ...(basis ? { basis } : {}),
            startDate: rangeStart || undefined,
            endDate: rangeEnd,
            ...(selectedAccountIds.length > 0 ? { accountIds: selectedAccountIds } : {}),
            ...tagFilter,
          })
        : Promise.resolve(null),
    [isValid, rangeStart, rangeEnd, accountIdsKey, fundsFilter.active, fundsFilter.tagKey, fundsFilter.tagValue, basis],
    { requestKey: JSON.stringify([isValid, rangeStart, rangeEnd, accountIdsKey, fundsFilter.active, fundsFilter.tagKey, fundsFilter.tagValue, basis]), maskStaleData: true },
  );

  // The Available funds / Spent / Balance strip: only with the switch on, from
  // the Income vs Expenses answer for the same window and accounts.
  const funding = useTaggedFunding({
    enabled: isValid && fundsFilter.include,
    tagKey: fundsFilter.tagKey,
    tagValue: fundsFilter.tagValue,
    startDate: rangeStart || undefined,
    endDate: rangeEnd,
    accountIds: selectedAccountIds,
    transferScope: scope.transferScope,
  });

  const chartData = useMemo<ChartDataItem[]>(() => {
    if (!response) return [];
    let colourIndex = 0;
    return response.data.map((item: CategorySpendingItem) => {
      let colour = item.color || '';
      if (!colour) {
        colour = CHART_COLOURS[colourIndex % CHART_COLOURS.length];
        colourIndex++;
      }
      return {
        id: item.categoryId || '',
        name: item.categoryName,
        value: item.total,
        colour,
      };
    });
  }, [response]);

  // The server withholds `totalSpending` when a row could not be converted, so
  // what is shown is the part that did convert, marked as a subtotal. It is also
  // the denominator: percentages are shares of what is on screen, and dividing
  // by a total that includes rows no slice represents would leave them summing
  // to less than 100% with nothing saying why.
  const spendingTotal: ConvertedTotal = useMemo(
    () => ({
      value: response?.knownSpending ?? 0,
      missingCurrencies: response?.missingCurrencies ?? [],
      excludedCount: response?.excludedCount ?? 0,
    }),
    [response],
  );
  const totalExpenses = spendingTotal.value;
  const reportingCurrency = response?.currency ?? defaultCurrency;
  // The screen wraps the total in `PartialTotal`; the PDF card carries the same
  // fact as a note, since a document has no hover.
  const { noteFor } = usePartialTotalNote();

  const funds = useMemo(
    () => (funding.window && response ? spendingFunds(response, funding.window) : null),
    [funding.window, response],
  );
  const fundsFigures: FundsFigure[] = funds
    ? [
        { key: 'income', label: t('tagBreakdown.fundsIncome'), value: funds.income, kind: 'money', tone: 'green', completeness: funds.incomeTotal },
        { key: 'tagged', label: t('tagBreakdown.fundsTagged', { value: fundsFilter.tagValue }), value: funds.netTagged, kind: 'money', tone: 'indigo', completeness: funds.taggedTotal },
        { key: 'available', label: t('tagBreakdown.fundsAvailable'), value: funds.availableFunds, kind: 'money', tone: 'blue', completeness: funds.availableTotal },
        { key: 'spent', label: t('tagBreakdown.fundsSpent'), value: funds.spent, kind: 'money', tone: 'red', completeness: funds.spentTotal },
        { key: 'balance', label: t('tagBreakdown.balance'), value: funds.balance, kind: 'money', tone: funds.balance !== null && funds.balance < 0 ? 'red' : 'gray', completeness: funds.balanceTotal },
        { key: 'balancePercent', label: t('tagBreakdown.balancePercent'), value: funds.balancePercent, kind: 'percent', tone: 'purple' },
      ]
    : [];

  const sortedTableData = useMemo(() => {
    const sorted = [...chartData];
    sorted.sort((a, b) => {
      let comparison = 0;
      switch (sortField) {
        case 'name':
          comparison = compareValues(a.name, b.name);
          break;
        case 'value':
          comparison = compareValues(a.value, b.value);
          break;
        case 'percentage': {
          const pa = totalExpenses > 0 ? (a.value / totalExpenses) * 100 : 0;
          const pb = totalExpenses > 0 ? (b.value / totalExpenses) * 100 : 0;
          comparison = compareValues(pa, pb);
          break;
        }
      }
      return sortDirection === 'asc' ? comparison : -comparison;
    });
    return sorted;
  }, [chartData, sortField, sortDirection, totalExpenses]);

  // Exhaustive over the sort field union, so a new field is a compile error
  // rather than a column with no control in either header -- and each entry
  // must name its own key (see `SortColumnsByField`). These labels are also the
  // phone captions, so a value reads under exactly the label its column header
  // uses.
  const columns: SortColumnsByField = {
    name: { field: 'name', label: t('spendingByCategory.colCategory') },
    value: { field: 'value', label: t('spendingByCategory.colAmount'), align: 'right' },
    percentage: { field: 'percentage', label: t('spendingByCategory.colPctOfTotal'), align: 'right' },
  };

  // Their order, rendered by BOTH header rows and matched by the cells' DOM
  // order. DERIVED from the record rather than re-listed, so a field added to
  // the union cannot ship with no sort control in either header. The record's
  // declaration order IS the column order, and it is today's: category, amount,
  // share.
  const sortColumns: readonly SortColumn[] = Object.values(columns);

  const handleExportPdf = async () => {
    const { exportToPdf } = await import('@/lib/pdf-export');

    const legendItems = chartData.map((item) => {
      const percentage = totalExpenses > 0 ? (item.value / totalExpenses) * 100 : 0;
      return {
        color: item.colour,
        label: `${item.name} - ${formatCurrency(item.value)} (${formatPercent(percentage, 1)})`,
      };
    });

    await exportToPdf(withPdfBasis({
      title: t('spendingByCategory.pdfTitle'),
      summaryCards: [
        { label: t('spendingByCategory.totalExpenses'), value: formatCurrency(totalExpenses), color: '#dc2626', note: noteFor(spendingTotal) },
        ...(funds && funds.availableFunds !== null
          ? [{ label: t('tagBreakdown.fundsAvailable'), value: formatCurrency(funds.availableFunds), color: '#2563eb' }]
          : []),
      ],
      chartContainer: chartRef.current,
      chartLegend: legendItems.length > 0 ? legendItems : undefined,
      filename: 'spending-by-category',
    }));
  };

  const handleExportCsv = () => {
    const headers = [
      t('spendingByCategory.csvColCategory'),
      t('spendingByCategory.csvColAmount'),
      t('spendingByCategory.csvColPercentage'),
    ];
    const rows = sortedTableData.map((item) => {
      const percentage = totalExpenses > 0 ? (item.value / totalExpenses) * 100 : 0;
      return [item.name, item.value, formatPercent(percentage, 2)];
    });
    exportCsvWithBasis('spending-by-category', headers, rows);
  };

  const handleCategoryClick = (categoryId: string) => {
    if (categoryId) {
      const { start, end } = resolvedRange;
      router.push(`/transactions?categoryId=${categoryId}&startDate=${start}&endDate=${end}`);
    }
  };

  return (
    <div className="space-y-6">
      {/* Controls -- always rendered so focus inside DateInput survives reloads */}
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-4">
        <div className="flex flex-wrap gap-4 items-center justify-between">
          <ReportAccountMultiSelect
            accounts={scope.offeredAccounts}
            value={selectedAccountIds}
            onChange={scope.setSelectedAccountIds}
            filter={nonInvestmentAccounts}
          />
          <DateRangeSelector
            ranges={['1m', '3m', '6m', '1y', 'ytd']}
            value={dateRange}
            onChange={setDateRange}
            showCustom
            customStartDate={startDate}
            onCustomStartDateChange={setStartDate}
            customEndDate={endDate}
            onCustomEndDateChange={setEndDate}
          />
          <TaggedFundsControls filter={fundsFilter} />
          <div className="flex items-center gap-4">
            <ChartViewToggle
              value={viewType}
              onChange={(v) => setViewType(v as 'pie' | 'bar' | 'table')}
              options={['pie', 'bar', 'table']}
            />
          </div>
          <ReportToolbarActions
            onExportPdf={handleExportPdf}
            onExportCsv={handleExportCsv}
            disabled={isLoading || !!error || chartData.length === 0}
          />
        </div>
      </div>

      {fundsFilter.include && !error && (
        <TaggedFundsStrip
          status={
            funding.status === 'error'
              ? 'error'
              : funding.status !== 'ready' || isLoading || !funds
                ? 'loading'
                : 'ready'
          }
          figures={fundsFigures}
          currency={reportingCurrency}
        />
      )}

      {/* Chart -- loading and error render here rather than in place of the
          whole report, so the controls above (and the date field being typed
          into) stay mounted across a reload. */}
      <div ref={chartRef} className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 px-2 py-4 sm:p-6">
        {error ? (
          <ReportError onRetry={reload} />
        ) : isLoading ? (
          <div className="space-y-4">
            <Skeleton className="h-8 w-1/3" />
            <Skeleton className="h-64 w-full" />
          </div>
        ) : chartData.length === 0 ? (
          <p className="text-gray-500 dark:text-gray-400 text-center py-8">
            {t('spendingByCategory.noData')}
          </p>
        ) : viewType === 'table' ? (
          <>
            {/* Data Table

                Below `sm` the table becomes a block and each row wraps into a
                two-track grid so all three columns fit a phone without a
                horizontal scroll, on two lines: the category takes line 1 (it
                is an unbounded name and wraps freely), the amount and the
                portfolio share share line 2. Nothing is dropped -- the card
                carries all three columns -- and the row stays what it is today:
                hovering, and clickable when it names a category. From `sm` up it
                is the ordinary table. The sort controls survive as their own
                phone-only header row, because the column header row that carries
                them on desktop is hidden there.

                Restyling `display` below `sm` strips the implicit table
                semantics, so the explicit ARIA roles put them back (inert from
                `sm` up). Every row exposes all three cells at every width, so no
                cell leaves the DOM and no `aria-colindex` is owed. The
                `CellLabel` captions name each figure's column for a sighted
                phone reader, who has no column header to look up. */}
            <div className="overflow-x-auto">
              {/* Explicit roles: restyling `display` below `sm` strips the
                  implicit table semantics, and these put them back (inert from
                  `sm` up). */}
              <table role="table" className="block min-w-full divide-y divide-gray-200 dark:divide-gray-700 sm:table">
                <thead role="rowgroup" className="block bg-gray-50 dark:bg-gray-900/50 sm:table-header-group">
                  {/* Phone sort strip: the same three controls, wrapped. */}
                  <tr role="row" className="flex flex-wrap gap-x-2 gap-y-1 px-2 py-2 sm:hidden">
                    {sortColumns.map((col) => (
                      <SortableHeader<SpendingCategorySortField>
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
                      <SortableHeader<SpendingCategorySortField>
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
                  {sortedTableData.map((item) => {
                    const percentage = totalExpenses > 0 ? (item.value / totalExpenses) * 100 : 0;
                    // The row is the click target where it names a category, so
                    // it is also a KEYBOARD target there (WCAG 2.1.1) --
                    // `tabIndex`, the focus ring and the key handler only when
                    // the click does something, because a focus stop that does
                    // nothing on Enter is a tab stop the reader has to escape.
                    // The ring and the handler come from the one shared module
                    // rather than a per-report copy.
                    const categoryId = item.id;
                    return (
                      <tr
                        key={categoryId || item.name}
                        role="row"
                        tabIndex={categoryId ? 0 : undefined}
                        className={`${ROW_GRID} ${categoryId ? `cursor-pointer ${INTERACTIVE_ROW_FOCUS_CLASS}` : ''} hover:bg-gray-50 dark:hover:bg-gray-700/50 sm:table-row sm:p-0`}
                        onClick={() => categoryId && handleCategoryClick(categoryId)}
                        onKeyDown={
                          categoryId
                            ? activateOnKey(() => handleCategoryClick(categoryId))
                            : undefined
                        }
                      >
                        {/* The identity. A category name is unbounded, so it
                            takes the whole of line 1 and wraps unclamped
                            (`break-words`), taking today's wrapping back from
                            `sm` up. */}
                        <td role="cell" className={`${IDENTITY_CELL} font-medium text-gray-900 dark:text-gray-100`}>
                          <div className="flex items-center gap-2">
                            <div className="w-3 h-3 rounded-full flex-shrink-0" style={{ backgroundColor: item.colour }} />
                            <span className="min-w-0 break-words sm:break-normal">{item.name}</span>
                          </div>
                        </td>
                        {/* The amount is the headline: the left of line 2. */}
                        <td role="cell" className={`${CELL_PLACEMENT.value} text-gray-900 dark:text-gray-100 ${FIGURE_CELL}`}>
                          <CellLabel className={CAPTION_CLASS}>{columns.value.label}</CellLabel>
                          {formatCurrency(item.value)}
                        </td>
                        {/* The share ends line 2, under the amount it is a share
                            of. Its value is bounded (`100.0%`) but its caption is
                            not, so it takes the same track as the amount rather
                            than an `auto` one sized by the caption. */}
                        <td role="cell" className={`${CELL_PLACEMENT.percentage} text-gray-600 dark:text-gray-400 ${FIGURE_CELL}`}>
                          <CellLabel className={CAPTION_CLASS}>{columns.percentage.label}</CellLabel>
                          {formatPercent(percentage, 1)}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
                <tfoot role="rowgroup" className="block bg-gray-50 dark:bg-gray-900/50 sm:table-footer-group">
                  {/* The totals are the largest figures on the table, so this
                      row wraps exactly the way a data row does -- the same two
                      tracks and the same placement, each figure captioned --
                      with "Total" standing in for the category in the identity
                      track. Every column has a total, so no cell leaves the DOM
                      below `sm` and the footer stays a full three-cell row at
                      every width. */}
                  <tr role="row" className={`${ROW_GRID} sm:table-row sm:p-0`}>
                    <td role="cell" className={`${IDENTITY_CELL} font-bold text-gray-900 dark:text-gray-100`}>
                      <span className="min-w-0 break-words sm:break-normal">{t('spendingByCategory.total')}</span>
                    </td>
                    <td role="cell" className={`${CELL_PLACEMENT.value} font-bold text-gray-900 dark:text-gray-100 ${FIGURE_CELL}`}>
                      <CellLabel className={CAPTION_CLASS}>{columns.value.label}</CellLabel>
                      <PartialTotal total={spendingTotal} displayCurrency={reportingCurrency}>
                        {formatCurrency(totalExpenses)}
                      </PartialTotal>
                    </td>
                    <td role="cell" className={`${CELL_PLACEMENT.percentage} font-bold text-gray-900 dark:text-gray-100 ${FIGURE_CELL}`}>
                      <CellLabel className={CAPTION_CLASS}>{columns.percentage.label}</CellLabel>
                      100%
                    </td>
                  </tr>
                </tfoot>
              </table>
            </div>
          </>
        ) : (
          <>
            {viewType === 'pie' ? (
              <div className="relative h-96">
                <ResponsiveContainer width="100%" height="100%" minWidth={0}>
                  <PieChart>
                    <Pie
                      data={chartData}
                      cx="50%"
                      cy="50%"
                      innerRadius={80}
                      outerRadius={140}
                      paddingAngle={2}
                      dataKey="value"
                      cursor="pointer"
                      onClick={(data) => {
                        const { id } = data as typeof data & { id?: string };
                        if (id) handleCategoryClick(id);
                      }}
                    >
                      {chartData.map((entry, index) => (
                        <Cell key={`cell-${index}`} fill={entry.colour} />
                      ))}
                    </Pie>
                    <Tooltip content={<SpendingCategoryTooltip totalExpenses={totalExpenses} formatCurrency={formatCurrency} formatPercent={formatPercent} />} />
                  </PieChart>
                </ResponsiveContainer>
                {/* The aggregate belongs in the donut's hole. */}
                <DonutCenterTotal
                  label={t('spendingByCategory.totalExpenses')}
                  value={
                    <PartialTotal total={spendingTotal} displayCurrency={reportingCurrency}>
                      {formatCurrency(totalExpenses)}
                    </PartialTotal>
                  }
                />
              </div>
            ) : (
              <div className="h-96">
                <ResponsiveContainer width="100%" height="100%" minWidth={0}>
                  <BarChart data={chartData} layout="vertical" margin={{ left: 10 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke={chartColors.grid} />
                    <XAxis type="number" tickFormatter={(value) => formatCurrency(value)} />
                    <YAxis type="category" dataKey="name" tick={{ fontSize: 12 }} width={80} />
                    <Tooltip content={<SpendingCategoryTooltip totalExpenses={totalExpenses} formatCurrency={formatCurrency} formatPercent={formatPercent} />} />
                    <Bar
                      dataKey="value"
                      cursor="pointer"
                      onClick={(data) => data.id && handleCategoryClick(data.id)}
                    >
                      {chartData.map((entry, index) => (
                        <Cell key={`cell-${index}`} fill={entry.colour} />
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>
            )}

            {/* Legend -- two columns on a phone (category names are short and
                a full-width column of them is a long scroll past the chart),
                denser still from `sm` up. */}
            <ChartLegend
              className="mt-6"
              phoneColumns={2}
              columnsClassName="sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4"
              items={chartData.map((item, index) => {
                const percentage = totalExpenses > 0 ? (item.value / totalExpenses) * 100 : 0;
                return {
                  key: String(index),
                  name: item.name,
                  color: item.colour,
                  detail: `${formatCurrency(item.value)} (${formatPercent(percentage, 1)})`,
                  onClick: () => handleCategoryClick(item.id),
                  disabled: !item.id,
                };
              })}
            />

            {/* The bar view has no hole to carry the total, so it keeps a total
                line beneath the legend; the pie view shows it in the donut centre. */}
            {viewType === 'bar' && (
              <div className="mt-6 pt-4 border-t border-gray-200 dark:border-gray-700 text-center">
                <div className="text-sm text-gray-500 dark:text-gray-400">{t('spendingByCategory.totalExpenses')}</div>
                <div className="text-2xl font-bold text-gray-900 dark:text-gray-100">
                  <PartialTotal total={spendingTotal} displayCurrency={reportingCurrency}>
                    {formatCurrency(totalExpenses)}
                  </PartialTotal>
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
