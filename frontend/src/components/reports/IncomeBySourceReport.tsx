'use client';

import { useReportExportMetadata } from '@/hooks/useReportExportMetadata';
import { useReportingBasis, useReportingRouter } from './ReportingBasis';
import { useState, useMemo, useRef } from 'react';
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
import { incomeFundsEntry } from '@/lib/income-by-source-funds';
import { IncomeSourceItem } from '@/types/built-in-reports';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import { useDateRange } from '@/hooks/useDateRange';
import { useReportData } from '@/hooks/useReportData';
import { useSortableTable, compareValues } from '@/hooks/useSortableTable';
import { DateRangeSelector } from '@/components/ui/DateRangeSelector';
import { ChartViewToggle } from '@/components/ui/ChartViewToggle';
import { DonutCenterTotal } from '@/components/ui/DonutCenterTotal';
import { ChartLegend } from '@/components/ui/ChartLegend';
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
import { PartialTotal } from '@/components/ui/PartialTotal';
import { isComplete, reportTotal } from '@/lib/currency-total';
import { CHART_COLOURS_INCOME } from '@/lib/chart-colours';
import { chartColors } from '@/lib/chart-colors';
import type { ChartDatum } from '@/types/chart';
import { useTranslations } from 'next-intl';

type IncomeSourceSortField = 'name' | 'value' | 'percentage';

type ChartDataItem = ChartDatum & {
  id: string;
  colour: string;
  /** The funding entry: a transfer figure, never an income source (spec 11.3). */
  isTagged?: boolean;
};

const ACCOUNTS_STORAGE_KEY = 'monize-reports-income-by-source-accounts';
const INCLUDE_TRANSFERS_STORAGE_KEY = 'monize-reports-income-by-source-include-transfers';

/**
 * One column of the data table, and the record the two header rows are built
 * from -- the shared declarations from `ui/Table`, as eleven sibling reports
 * use them. The alignment is narrowed to `'right'` because that is the only one
 * this table's amount and share columns take.
 */
type SortColumn = TableSortColumn<IncomeSourceSortField, 'right'>;
type SortColumnsByField = TableSortColumnsByField<IncomeSourceSortField, SortColumn>;

// Today's header cell, unchanged (this report's header carries no
// `tracking-wider`, so neither does this constant -- the `sm`-and-up output
// stays identical to today).
const HEADER_CLASS =
  'px-4 py-3 text-xs font-medium text-gray-500 dark:text-gray-400 uppercase';

// Where each column sits on the phone grid for a SOURCE row and for the totals
// footer, written once: both shapes are 1x1 over the same three columns, so the
// footer takes the source row's placement verbatim and a reader finds the share
// in the same corner of both. Line 1 is the identity beside the amount (the
// figure the row is read for), line 2 the share beneath the amount it is a
// share OF. Auto-flow would place them by DOM order and silently re-flow the
// moment a cell became conditional; these are inert from `sm` up.
const CELL_PLACEMENT: Record<IncomeSourceSortField, string> = {
  name: 'col-start-1 row-start-1',
  value: 'col-start-2 row-start-1',
  percentage: 'col-start-2 row-start-2',
};

// A figure cell inside a wrapped card: no padding of its own below `sm` (the row
// supplies it and the grid does the spacing), the table cell's own padding from
// `sm` up, smaller type on phones. `whitespace-nowrap` is the one property here
// that is NOT phone-only, and the single respect in which the `sm`-and-up cell
// differs from today's: a locale grouping thousands with a space could break a
// figure in the middle of a number otherwise, at any width. This report has one
// money column and a percentage, each in its own `minmax(0,1fr)` track, so the
// compact `formatCurrencyCompact` amount and the `100.0%` share sit well inside
// it at every phone width; right alignment is presentation, never containment.
const FIGURE_CELL =
  'p-0 text-right text-xs whitespace-nowrap sm:table-cell sm:px-4 sm:py-3 sm:text-sm';

/**
 * The identity cell of a source row and of the totals footer: the same box in
 * both, one of the two cells that keep `text-sm` on phones (a source name is
 * prose). A category name is UNBOUNDED, so it sits in a `minmax(0,1fr)` track
 * with `min-w-0` and the name wraps UNCLAMPED with `break-words sm:break-normal`
 * -- a clamp would cut a trailing marker before the tail of the name, and no
 * width assertion sees it, while a grid item with `min-w-0` contributes no
 * minimum width so `break-words` alone keeps the longest token from reopening
 * the sideways scroll. From `sm` up `sm:break-normal` restores today's wrap.
 */
const IDENTITY_CELL =
  `${CELL_PLACEMENT.name} min-w-0 p-0 text-sm sm:table-cell sm:px-4 sm:py-3`;

interface IncomeSourceTooltipProps {
  active?: boolean;
  payload?: Array<{ payload: { id: string; name: string; value: number; isTagged?: boolean } }>;
  totalIncome: number;
  formatCurrency: (value: number) => string;
  formatPercent: (value: number, decimals?: number) => string;
  /** The tagged-transfer entry's caption in place of a share: it is not income (spec 11.3). */
  notIncomeLabel: string;
}

function IncomeSourceTooltip({
  active,
  payload,
  totalIncome,
  formatCurrency,
  formatPercent,
  notIncomeLabel,
}: IncomeSourceTooltipProps) {
  if (!active || !payload || !payload.length) return null;
  const data = payload[0].payload;
  const percentage = totalIncome > 0 ? (data.value / totalIncome) * 100 : 0;
  return (
    <ChartTooltipPanel>
      <p className="font-medium text-gray-900 dark:text-gray-100">{data.name}</p>
      <p className="text-gray-600 dark:text-gray-400">
        {data.isTagged === true
          ? `${formatCurrency(data.value)} (${notIncomeLabel})`
          : `${formatCurrency(data.value)} (${formatPercent(percentage, 1)})`}
      </p>
    </ChartTooltipPanel>
  );
}

export function IncomeBySourceReport() {
  const { exportCsvWithBasis, withPdfBasis } = useReportExportMetadata();
  const basis = useReportingBasis();
  const t = useTranslations('reports');
  const router = useReportingRouter();
  const chartRef = useRef<HTMLDivElement>(null);
  const { formatCurrencyCompact: formatCurrency, formatPercent, defaultCurrency } = useNumberFormat();
  const tCommon = useTranslations('common');
  const { dateRange, setDateRange, startDate, setStartDate, endDate, setEndDate, resolvedRange, isValid } = useDateRange({ defaultRange: '1y', alignment: 'day' });
  const [viewType, setViewType] = useState<'pie' | 'bar' | 'table'>('pie');
  const { sortField, sortDirection, handleSort } = useSortableTable<IncomeSourceSortField>(
    'reports.income-by-source.table.sort',
    { field: 'value', direction: 'desc' },
  );

  const { start: rangeStart, end: rangeEnd } = resolvedRange;

  const scope = useReportAccountScope(ACCOUNTS_STORAGE_KEY);
  const { selectedAccountIds, accountIdsKey } = scope;
  const fundsFilter = useTaggedFundsFilter(INCLUDE_TRANSFERS_STORAGE_KEY, {
    valueRequired: true,
  });

  const { data: response, isLoading, error, reload } = useReportData(
    () =>
      isValid
        ? builtInReportsApi.getIncomeBySource({
            ...(basis ? { basis } : {}),
            startDate: rangeStart || undefined,
            endDate: rangeEnd,
            ...(selectedAccountIds.length > 0 ? { accountIds: selectedAccountIds } : {}),
          })
        : Promise.resolve(null),
    [isValid, rangeStart, rangeEnd, accountIdsKey, basis],
    { requestKey: JSON.stringify([isValid, rangeStart, rangeEnd, accountIdsKey, basis]), maskStaleData: true },
  );

  // The funding fetch of the other reports: the same window and the same
  // accounts, only while a key, a value and the switch are all set (spec F1).
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
    return response.data.map((item: IncomeSourceItem) => {
      let colour = item.color || '';
      if (!colour) {
        colour = CHART_COLOURS_INCOME[colourIndex % CHART_COLOURS_INCOME.length];
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

  // The server withholds `totalIncome` when a row could not be converted, so
  // what is shown is the part that did convert, marked as a subtotal. It is also
  // the denominator: percentages are shares of what is on screen.
  const incomeTotal = reportTotal(response?.totalIncome ?? response?.knownIncome ?? 0, response);
  const totalIncome = incomeTotal.value;
  const reportingCurrency = response?.currency ?? defaultCurrency;

  // Available funds = total income + the value's net tagged inflow. A transfer
  // is not income: the entry rides beside the sources and stays out of every
  // share (INV-REPORT-003, spec 11.3).
  const fundsEntry = useMemo(
    () => (funding.window ? incomeFundsEntry(totalIncome, funding.window) : null),
    [funding.window, totalIncome],
  );
  const taggedItem = useMemo<ChartDataItem | null>(
    () =>
      fundsEntry
        ? {
            id: '',
            name: t('tagBreakdown.fundsTagged', { value: fundsFilter.tagValue }),
            value: fundsEntry.netTagged,
            colour: chartColors.inflow,
            isTagged: true,
          }
        : null,
    [fundsEntry, fundsFilter.tagValue, t],
  );
  // What the charts and legend draw; the table lists the tagged entry itself.
  const plotData = useMemo(
    () => (taggedItem ? [...chartData, taggedItem] : chartData),
    [chartData, taggedItem],
  );
  const fundsFigures: FundsFigure[] = fundsEntry
    ? [
        { key: 'income', label: t('tagBreakdown.fundsIncome'), value: totalIncome, kind: 'money', tone: 'green' },
        { key: 'tagged', label: t('tagBreakdown.fundsTagged', { value: fundsFilter.tagValue }), value: fundsEntry.netTagged, kind: 'money', tone: 'indigo', completeness: fundsEntry.entryTotal },
        { key: 'available', label: t('tagBreakdown.fundsAvailable'), value: fundsEntry.availableFunds, kind: 'money', tone: 'blue', completeness: fundsEntry.availableTotal },
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
          const pa = totalIncome > 0 ? (a.value / totalIncome) * 100 : 0;
          const pb = totalIncome > 0 ? (b.value / totalIncome) * 100 : 0;
          comparison = compareValues(pa, pb);
          break;
        }
      }
      return sortDirection === 'asc' ? comparison : -comparison;
    });
    return sorted;
  }, [chartData, sortField, sortDirection, totalIncome]);

  // Exhaustive over the sort field union, so a new field is a compile error
  // rather than a column with no control in either header -- and each entry must
  // name its own key (see `SortColumnsByField`). These labels are also the phone
  // captions, so a value reads under exactly the label its column header uses.
  const columns: SortColumnsByField = {
    name: { field: 'name', label: t('incomeBySource.colSource') },
    value: { field: 'value', label: t('incomeBySource.colAmount'), align: 'right' },
    percentage: { field: 'percentage', label: t('incomeBySource.colPercentOfTotal'), align: 'right' },
  };

  // The column order, rendered by BOTH header rows and matched by the cells' DOM
  // order. DERIVED from the record rather than re-listed: a hand-written list
  // beside an exhaustive record is not exhaustive, so a field added to the union
  // would compile (the record forces an entry) and still ship with no sort
  // control in either header. The record's declaration order IS the column
  // order, and it is today's; where a card PLACES each column is
  // `CELL_PLACEMENT`, a separate decision.
  const sortColumns: readonly SortColumn[] = Object.values(columns);

  const handleExportPdf = async () => {
    const { exportToPdf } = await import('@/lib/pdf-export');

    const legendItems = plotData.map((item) => {
      if (item.isTagged) {
        return { color: item.colour, label: `${item.name} - ${formatCurrency(item.value)}` };
      }
      const percentage = totalIncome > 0 ? (item.value / totalIncome) * 100 : 0;
      return {
        color: item.colour,
        label: `${item.name} - ${formatCurrency(item.value)} (${formatPercent(percentage, 1)})`,
      };
    });

    await exportToPdf(withPdfBasis({
      title: t('page.names.income-by-source' as Parameters<typeof t>[0]),
      summaryCards: [
        {
          // A figure in a file has no tooltip, so the label carries the marker.
          label: isComplete(incomeTotal)
            ? t('incomeBySource.totalIncome')
            : `${t('incomeBySource.totalIncome')} ${tCommon('partialTotal.srSuffix')}`,
          value: formatCurrency(totalIncome),
          color: '#16a34a',
        },
        ...(fundsEntry
          ? [{ label: t('tagBreakdown.fundsAvailable'), value: formatCurrency(fundsEntry.availableFunds), color: '#2563eb' }]
          : []),
      ],
      chartContainer: chartRef.current,
      chartLegend: legendItems.length > 0 ? legendItems : undefined,
      filename: 'income-by-source',
    }));
  };

  const handleExportCsv = () => {
    const headers = [t('incomeBySource.colSource'), t('incomeBySource.colAmount'), t('incomeBySource.colPercentOfTotal')];
    const rows = sortedTableData.map((item) => {
      const percentage = totalIncome > 0 ? (item.value / totalIncome) * 100 : 0;
      return [item.name, item.value, formatPercent(percentage, 2)];
    });
    // The funding rows follow the sources with an empty share: they are not income.
    const fundsRows = fundsEntry
      ? [
          [t('tagBreakdown.fundsTagged', { value: fundsFilter.tagValue }), fundsEntry.netTagged, ''],
          [t('tagBreakdown.fundsAvailable'), fundsEntry.availableFunds, ''],
        ]
      : [];
    exportCsvWithBasis('income-by-source', headers, [...rows, ...fundsRows]);
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

      {fundsFilter.include && (
        <TaggedFundsStrip
          status={funding.status === 'off' ? 'loading' : funding.status}
          figures={fundsFigures}
          currency={funding.response?.currency ?? ''}
          note={
            funding.status === 'ready' && !fundsEntry ? t('tagBreakdown.noNetTagged') : undefined
          }
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
            {t('incomeBySource.noData')}
          </p>
        ) : viewType === 'table' ? (
          /* Data Table

             Below `sm` the table becomes a block and each row wraps into a
             two-column grid so all three columns fit a phone without a
             horizontal scroll, on two lines: the source name beside its amount
             -- the figure the row is read for -- then the share beneath the
             amount it is a share OF. Nothing is dropped -- the card carries all
             three columns -- and the rows stay what they are today: a row for a
             real category is clickable (it opens that category's transactions),
             an uncategorised row is not. From `sm` up it is the ordinary table.
             The sort controls survive as their own phone-only header row,
             because the column header row that carries them on desktop is
             hidden there.

             Two properties of restyling one tree, both deliberate. Changing the
             `display` drops the implicit table semantics below `sm`, so the
             explicit ARIA roles below put them back; the phone sort strip is the
             header row a phone reader gets, and its three controls sit in the
             data cells' own DOM order, so the column association survives there.
             Every row exposes all three cells at every width (none is dropped
             below `sm`), so no row needs an `aria-colindex`, and the `CellLabel`
             captions are REDUNDANT with that association rather than a
             substitute for it: the grid paints the cells out of DOM order, so a
             sighted phone reader needs the name beside the value. The second
             property is an ACCEPTED trade-off the roles do not answer -- they
             restore semantics, not reading order -- and the captions limit its
             cost, since every value names its own column. */
          <>
            <div className="overflow-x-auto">
              {/* Explicit roles: restyling `display` below `sm` strips the
                  implicit table semantics, and these put them back (inert from
                  `sm` up). */}
              <table role="table" className="block min-w-full divide-y divide-gray-200 dark:divide-gray-700 sm:table">
                <thead role="rowgroup" className="block bg-gray-50 dark:bg-gray-900/50 sm:table-header-group">
                  {/* Phone sort strip: the same three controls, wrapped. */}
                  <tr role="row" className="flex flex-wrap gap-x-2 gap-y-1 px-2 py-2 sm:hidden">
                    {sortColumns.map((col) => (
                      <SortableHeader<IncomeSourceSortField>
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
                      <SortableHeader<IncomeSourceSortField>
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
                    const percentage = totalIncome > 0 ? (item.value / totalIncome) * 100 : 0;
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
                        className={`grid grid-cols-2 items-start gap-x-3 gap-y-1.5 px-4 py-3 ${categoryId ? `cursor-pointer ${INTERACTIVE_ROW_FOCUS_CLASS}` : ''} hover:bg-gray-50 dark:hover:bg-gray-700/50 sm:table-row sm:p-0`}
                        onClick={() => categoryId && handleCategoryClick(categoryId)}
                        onKeyDown={
                          categoryId
                            ? activateOnKey(() => handleCategoryClick(categoryId))
                            : undefined
                        }
                      >
                        {/* The identity; the `<tr>` around it stays the click
                            target at every width. The colour dot and the name
                            are exactly today's, the name wrapped in an unclamped
                            span that shares the grid cell's containment. */}
                        <td role="cell" className={`${IDENTITY_CELL} font-medium text-gray-900 dark:text-gray-100`}>
                          <div className="flex items-center gap-2 min-w-0">
                            <div className="w-3 h-3 rounded-full flex-shrink-0" style={{ backgroundColor: item.colour }} />
                            <span className="min-w-0 break-words sm:break-normal" title={item.name}>{item.name}</span>
                          </div>
                        </td>
                        {/* The amount is the headline: the right of line 1,
                            beside the source, because it is what the row is read
                            for. */}
                        <td role="cell" className={`${CELL_PLACEMENT.value} text-green-600 dark:text-green-400 ${FIGURE_CELL}`}>
                          <CellLabel className={CAPTION_CLASS}>{columns.value.label}</CellLabel>
                          {formatCurrency(item.value)}
                        </td>
                        {/* The share opens line 2, beneath the amount it is a
                            share OF. Its value is bounded (`100.0%`) but its
                            CAPTION is not, so it takes a full `minmax(0,1fr)`
                            track; the caption wraps, the value never does. */}
                        <td role="cell" className={`${CELL_PLACEMENT.percentage} text-gray-600 dark:text-gray-400 ${FIGURE_CELL}`}>
                          <CellLabel className={CAPTION_CLASS}>{columns.percentage.label}</CellLabel>
                          {formatPercent(percentage, 1)}
                        </td>
                      </tr>
                    );
                  })}
                  {taggedItem && (
                    <tr role="row" className="grid grid-cols-2 items-start gap-x-3 gap-y-1.5 px-4 py-3 sm:table-row sm:p-0">
                      <td role="cell" className={`${IDENTITY_CELL} font-medium text-indigo-700 dark:text-indigo-300`}>
                        <div className="flex items-center gap-2 min-w-0">
                          <div className="w-3 h-3 rounded-full flex-shrink-0" style={{ backgroundColor: taggedItem.colour }} />
                          <span className="min-w-0 break-words sm:break-normal" title={taggedItem.name}>{taggedItem.name}</span>
                        </div>
                      </td>
                      <td role="cell" className={`${CELL_PLACEMENT.value} text-indigo-600 dark:text-indigo-400 ${FIGURE_CELL}`}>
                        <CellLabel className={CAPTION_CLASS}>{columns.value.label}</CellLabel>
                        {fundsEntry && (
                          <PartialTotal total={fundsEntry.entryTotal} displayCurrency={funding.response?.currency ?? ''}>
                            {formatCurrency(taggedItem.value)}
                          </PartialTotal>
                        )}
                      </td>
                      <td role="cell" className={`${CELL_PLACEMENT.percentage} text-gray-500 dark:text-gray-400 ${FIGURE_CELL}`}>
                        <CellLabel className={CAPTION_CLASS}>{columns.percentage.label}</CellLabel>
                        {t('tagBreakdown.notIncome')}
                      </td>
                    </tr>
                  )}
                </tbody>
                <tfoot role="rowgroup" className="block bg-gray-50 dark:bg-gray-900/50 sm:table-footer-group">
                  {/* The totals are the largest figures on the table, so this
                      row wraps exactly the way a source row does -- the same two
                      tracks, the same placement, each figure captioned -- with
                      "Total" standing in for the source. Every column has a
                      total, so no cell leaves the DOM below `sm`: three cells at
                      every width, and no `aria-colindex` is owed. */}
                  <tr role="row" className="grid grid-cols-2 items-start gap-x-3 gap-y-1.5 px-4 py-3 sm:table-row sm:p-0">
                    <td role="cell" className={`${IDENTITY_CELL} font-bold text-gray-900 dark:text-gray-100`}>
                      <span className="break-words sm:break-normal" title={t('incomeBySource.total')}>{t('incomeBySource.total')}</span>
                    </td>
                    <td role="cell" className={`${CELL_PLACEMENT.value} font-bold text-green-600 dark:text-green-400 ${FIGURE_CELL}`}>
                      <CellLabel className={CAPTION_CLASS}>{columns.value.label}</CellLabel>
                      <PartialTotal total={incomeTotal} displayCurrency={reportingCurrency}>
                        {formatCurrency(totalIncome)}
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
                      data={plotData}
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
                      {plotData.map((entry, index) => (
                        <Cell key={`cell-${index}`} fill={entry.colour} />
                      ))}
                    </Pie>
                    <Tooltip content={<IncomeSourceTooltip totalIncome={totalIncome} formatCurrency={formatCurrency} formatPercent={formatPercent} notIncomeLabel={t('tagBreakdown.notIncome')} />} />
                  </PieChart>
                </ResponsiveContainer>
                {/* The aggregate belongs in the donut's hole. */}
                <DonutCenterTotal
                  label={t('incomeBySource.totalIncome')}
                  value={
                    <span className="text-green-600 dark:text-green-400">
                      <PartialTotal total={incomeTotal} displayCurrency={reportingCurrency}>
                        {formatCurrency(totalIncome)}
                      </PartialTotal>
                    </span>
                  }
                />
              </div>
            ) : (
              <div className="h-96">
                <ResponsiveContainer width="100%" height="100%" minWidth={0}>
                  <BarChart data={plotData} layout="vertical" margin={{ left: 10 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke={chartColors.grid} />
                    <XAxis type="number" tickFormatter={(value) => formatCurrency(value)} />
                    <YAxis type="category" dataKey="name" tick={{ fontSize: 12 }} width={80} />
                    <Tooltip content={<IncomeSourceTooltip totalIncome={totalIncome} formatCurrency={formatCurrency} formatPercent={formatPercent} notIncomeLabel={t('tagBreakdown.notIncome')} />} />
                    <Bar
                      dataKey="value"
                      cursor="pointer"
                      onClick={(data) => data.id && handleCategoryClick(data.id)}
                    >
                      {plotData.map((entry, index) => (
                        <Cell key={`cell-${index}`} fill={entry.colour} />
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>
            )}

            {/* Legend -- one vertical column on a phone, dense grid from `sm` up. */}
            <ChartLegend
              className="mt-6"
              columnsClassName="sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4"
              items={plotData.map((item, index) => {
                const percentage = totalIncome > 0 ? (item.value / totalIncome) * 100 : 0;
                return {
                  key: String(index),
                  name: item.name,
                  color: item.colour,
                  detail: item.isTagged
                    ? `${formatCurrency(item.value)} (${t('tagBreakdown.notIncome')})`
                    : `${formatCurrency(item.value)} (${formatPercent(percentage, 1)})`,
                  onClick: () => handleCategoryClick(item.id),
                  disabled: !item.id,
                };
              })}
            />

            {/* The bar view has no hole to carry the total, so it keeps a total
                line beneath the legend; the pie view shows it in the donut centre. */}
            {viewType === 'bar' && (
              <div className="mt-6 pt-4 border-t border-gray-200 dark:border-gray-700 text-center">
                <div className="text-sm text-gray-500 dark:text-gray-400">{t('incomeBySource.totalIncome')}</div>
                <div className="text-2xl font-bold text-green-600 dark:text-green-400">
                  <PartialTotal total={incomeTotal} displayCurrency={reportingCurrency}>
                    {formatCurrency(totalIncome)}
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
