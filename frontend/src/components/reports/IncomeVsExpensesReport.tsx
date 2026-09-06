"use client";

import { useState, useMemo, useRef } from "react";
import { CellLabel } from "@/components/ui/Table";
import { Skeleton } from '@/components/ui/LoadingSkeleton';
import { useRouter } from "next/navigation";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Legend,
  ReferenceLine,
} from "recharts";
import { format, parseISO, startOfMonth, endOfMonth } from "date-fns";
import { builtInReportsApi } from "@/lib/built-in-reports";
import { MonthlyIncomeExpenseItem } from "@/types/built-in-reports";
import { useNumberFormat } from "@/hooks/useNumberFormat";
import { useDateRange } from "@/hooks/useDateRange";
import { useReportData } from "@/hooks/useReportData";
import { useSortableTable, compareValues } from "@/hooks/useSortableTable";
import { DateRangeSelector } from "@/components/ui/DateRangeSelector";
import { ChartViewToggle } from "@/components/ui/ChartViewToggle";
import { ExportDropdown } from '@/components/ui/ExportDropdown';
import { SortableHeader } from '@/components/ui/SortableHeader';
import { ChartTooltip } from "@/components/reports/ChartTooltip";
import { ReportError } from "@/components/reports/ReportError";
import { exportToCsv } from "@/lib/csv-export";
import { chartColors } from "@/lib/chart-colors";
import { useChartDateFormat } from "@/hooks/useChartDateFormat";
import { useTranslations } from 'next-intl';
type IncomeVsExpensesSortField = 'name' | 'income' | 'expenses' | 'savings' | 'savingsRate';

/**
 * One sortable column of the table view. The five are declared once and
 * rendered by BOTH header rows -- the column header row (from `sm` up) and the
 * phone sort strip -- so the two can never list different fields.
 */
interface SortColumn {
  field: IncomeVsExpensesSortField;
  label: string;
  /** Money columns are right-aligned in the column header row. */
  align?: 'right';
}

const HEADER_CLASS =
  'px-4 py-3 text-xs font-medium text-gray-500 dark:text-gray-400 uppercase';

// The same sort controls in the phone strip: a wrapped row of compact chips.
// Column alignment means nothing there -- the column header row is hidden and
// each data row is a grid -- so every control is left-aligned and self-naming.
// The border and card background are what say "tappable": there is no hover on
// a touch screen, and without them the strip reads as another row of the
// captions the cells below carry.
const PHONE_HEADER_CLASS =
  'rounded border border-gray-200 bg-white px-2 py-1.5 text-xs font-medium text-gray-500 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-400 uppercase';

// A money cell inside a wrapped card: no padding of its own below `sm` (the row
// supplies it and the grid does the spacing), the table cell's own padding from
// `sm` up. Smaller type on phones so a six-figure amount still fits a
// half-width column, and `whitespace-nowrap` so a locale that groups thousands
// with a space cannot break in the middle of a number.
//
// The tracks are sized so a compact six-figure amount fits at 320px and a
// seven-figure one at 390px (measured on a hand-CSS replica in Chromium).
// Right alignment is not a containment device: a nowrap amount longer than its
// track overflows past the END edge whatever `text-align` says, and in the
// right-hand track that does reopen the wrapper's sideways scroll (measured:
// a sixteen-character amount at 320px). That is the deliberate choice --
// `overflow-hidden` here would silently truncate a figure, and a scroll that
// appears only for an amount that large is honest.
const MONEY_CELL =
  'p-0 text-right text-xs whitespace-nowrap sm:table-cell sm:px-4 sm:py-3 sm:text-sm';

interface ChartDataItem {
  name: string;
  fullName: string;
  Income: number;
  Expenses: number;
  Savings: number;
  SavingsRate: number;
  monthStart: string;
  monthEnd: string;
}

export function IncomeVsExpensesReport() {
  const t = useTranslations('reports');
  const formatChartDate = useChartDateFormat();
  const router = useRouter();
  const chartRef = useRef<HTMLDivElement>(null);
  const { formatCurrencyCompact: formatCurrency, formatCurrencyAxis, formatPercent, formatPercentTrimmed } =
    useNumberFormat();
  const [viewType, setViewType] = useState<'bar' | 'table'>('bar');
  const {
    dateRange,
    setDateRange,
    startDate,
    setStartDate,
    endDate,
    setEndDate,
    resolvedRange,
    isValid,
  } = useDateRange({ defaultRange: "1y", alignment: "month" });
  const { sortField, sortDirection, handleSort } = useSortableTable<IncomeVsExpensesSortField>(
    'reports.income-vs-expenses.table.sort',
    { field: 'name', direction: 'asc' },
  );

  const { start: rangeStart, end: rangeEnd } = resolvedRange;

  const { data: response, isLoading, error, reload } = useReportData(
    () =>
      isValid
        ? builtInReportsApi.getIncomeVsExpenses({
            startDate: rangeStart || undefined,
            endDate: rangeEnd,
          })
        : Promise.resolve(null),
    [isValid, rangeStart, rangeEnd],
  );

  // Map response to chart data. `name` must be unique across the dataset
  // (used as the XAxis category key); a non-unique value like "May" causes
  // Recharts to resolve the tooltip's payload to the first matching row,
  // showing data from the wrong year on multi-year ranges.
  const chartData = useMemo<ChartDataItem[]>(
    () =>
      (response?.data ?? []).map((item: MonthlyIncomeExpenseItem) => {
        const monthDate = parseISO(item.month + "-01");
        const savings = item.income - item.expenses;
        const savingsRate =
          item.income > 0 ? Math.round((savings / item.income) * 100) : 0;
        return {
          name: item.month,
          fullName: formatChartDate(monthDate, "MMM yyyy"),
          Income: Math.round(item.income),
          Expenses: Math.round(item.expenses),
          Savings: Math.round(savings),
          SavingsRate: savingsRate,
          monthStart: format(startOfMonth(monthDate), "yyyy-MM-dd"),
          monthEnd: format(endOfMonth(monthDate), "yyyy-MM-dd"),
        };
      }),
    [response, formatChartDate],
  );

  const totals = useMemo(() => {
    const totalIncome = response?.totals.income ?? 0;
    const totalExpenses = response?.totals.expenses ?? 0;
    const totalSavings = totalIncome - totalExpenses;
    const savingsRate = totalIncome > 0 ? (totalSavings / totalIncome) * 100 : 0;
    return { totalIncome, totalExpenses, totalSavings, savingsRate };
  }, [response]);

  const sortedTableData = useMemo(() => {
    const sorted = [...chartData];
    sorted.sort((a, b) => {
      let comparison = 0;
      switch (sortField) {
        case 'name':
          comparison = compareValues(a.name, b.name);
          break;
        case 'income':
          comparison = compareValues(a.Income, b.Income);
          break;
        case 'expenses':
          comparison = compareValues(a.Expenses, b.Expenses);
          break;
        case 'savings':
          comparison = compareValues(a.Savings, b.Savings);
          break;
        case 'savingsRate':
          comparison = compareValues(a.SavingsRate, b.SavingsRate);
          break;
      }
      return sortDirection === 'asc' ? comparison : -comparison;
    });
    return sorted;
  }, [chartData, sortField, sortDirection]);

  // Exhaustive over the sort field union, so a new field is a compile error
  // rather than a column with no control in either header. The list both
  // header rows render is DERIVED from the record, never re-listed beside it:
  // a hand-written list next to an exhaustive record is not exhaustive. The
  // record's declaration order is the column order.
  const columns: Record<IncomeVsExpensesSortField, SortColumn> = {
    name: { field: 'name', label: t('incomeVsExpenses.colMonth') },
    income: { field: 'income', label: t('incomeVsExpenses.colIncome'), align: 'right' },
    expenses: { field: 'expenses', label: t('incomeVsExpenses.colExpenses'), align: 'right' },
    savings: { field: 'savings', label: t('incomeVsExpenses.colSavings'), align: 'right' },
    savingsRate: { field: 'savingsRate', label: t('incomeVsExpenses.colSavingsRate'), align: 'right' },
  };
  const sortColumns: readonly SortColumn[] = Object.values(columns);

  const handleExportPdf = async () => {
    const { exportToPdf } = await import("@/lib/pdf-export");
    await exportToPdf({
      title: t('page.names.income-vs-expenses' as Parameters<typeof t>[0]),
      summaryCards: [
        { label: t('incomeVsExpenses.totalIncome'), value: formatCurrency(totals.totalIncome), color: "#16a34a" },
        { label: t('incomeVsExpenses.totalExpenses'), value: formatCurrency(totals.totalExpenses), color: "#dc2626" },
        { label: t('incomeVsExpenses.totalSavings'), value: formatCurrency(totals.totalSavings), color: totals.totalSavings >= 0 ? "#2563eb" : "#ea580c" },
        { label: t('incomeVsExpenses.savingsRate'), value: formatPercent(totals.savingsRate, 1), color: totals.savingsRate >= 0 ? "#9333ea" : "#ea580c" },
      ],
      chartContainer: chartRef.current,
      filename: "income-vs-expenses",
    });
  };

  const handleExportCsv = () => {
    const headers = [t('incomeVsExpenses.colMonth'), t('incomeVsExpenses.colIncome'), t('incomeVsExpenses.colExpenses'), t('incomeVsExpenses.colSavings'), t('incomeVsExpenses.colSavingsRate')];
    const rows = sortedTableData.map((d) => [
      d.fullName,
      d.Income,
      d.Expenses,
      d.Savings,
      `${formatPercentTrimmed(d.SavingsRate)}`,
    ]);
    exportToCsv('income-vs-expenses', headers, rows);
  };

  const barClickedRef = useRef(false);

  const handleBarClick = (categoryType: 'income' | 'expense') => (data: { payload?: { monthStart?: string; monthEnd?: string } }) => {
    barClickedRef.current = true;
    const monthStart = data.payload?.monthStart;
    const monthEnd = data.payload?.monthEnd;
    if (monthStart && monthEnd) {
      router.push(
        `/transactions?startDate=${monthStart}&endDate=${monthEnd}&categoryType=${categoryType}`,
      );
    }
  };

  const handleChartClick = (state: any) => {
    if (barClickedRef.current) {
      barClickedRef.current = false;
      return;
    }
    const label = state?.activeLabel;
    if (!label) return;
    const item = chartData.find((d) => d.name === label);
    if (item?.monthStart && item?.monthEnd) {
      router.push(
        `/transactions?startDate=${item.monthStart}&endDate=${item.monthEnd}`,
      );
    }
  };

  const CustomTooltip = ({
    active,
    payload,
  }: {
    active?: boolean;
    payload?: Array<{
      name: string;
      value: number;
      color: string;
      payload: { fullName: string; SavingsRate: number };
    }>;
    label?: string;
  }) => {
    const data = payload?.[0]?.payload;
    return (
      <ChartTooltip
        active={active}
        label={data?.fullName}
        payload={payload}
        formatValue={(v) => formatCurrency(v)}
      >
        {data && (
          <p className="text-sm text-gray-600 dark:text-gray-400 mt-1">
            {t('incomeVsExpenses.savingsRateTooltip', { rate: data.SavingsRate })}
          </p>
        )}
      </ChartTooltip>
    );
  };

  return (
    <div className="space-y-6">
      {/* Controls -- always rendered so focus inside DateInput survives reloads */}
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-4">
        <div className="flex flex-wrap gap-4 items-center justify-between">
          <DateRangeSelector
            ranges={["6m", "1y", "2y"]}
            value={dateRange}
            onChange={setDateRange}
            showCustom
            customStartDate={startDate}
            onCustomStartDateChange={setStartDate}
            customEndDate={endDate}
            onCustomEndDateChange={setEndDate}
          />
          <div className="flex items-center gap-4">
            <ChartViewToggle
              value={viewType}
              onChange={(v) => setViewType(v as 'bar' | 'table')}
              options={['bar', 'table']}
            />
            <ExportDropdown
              onExportPdf={handleExportPdf}
              onExportCsv={handleExportCsv}
              disabled={chartData.length === 0}
            />
          </div>
        </div>
      </div>

      {/* Chart */}
      <div ref={chartRef} className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 px-2 py-4 sm:p-6">
        {isLoading ? (
          <div className="space-y-4">
            <Skeleton className="h-8 w-1/3" />
            <Skeleton className="h-96 w-full" />
          </div>
        ) : error ? (
          <ReportError onRetry={reload} />
        ) : chartData.length === 0 ? (
          <p className="text-gray-500 dark:text-gray-400 text-center py-8">
            {t('incomeVsExpenses.noData')}
          </p>
        ) : viewType === 'table' ? (
          <>
            {/* Below `sm` the table becomes a block and each row wraps into a
                three-column grid so all five columns fit a phone without a
                horizontal scroll, on two lines: the month, its savings and its
                income share line 1; the savings rate (spanning the first two
                tracks) and the expenses share line 2. Each derived figure
                sits under the figure it derives from -- rate under savings,
                expenses under income -- and the month is the one cell allowed
                to wrap, since a compact amount never may. From `sm` up it is
                the ordinary table. The sort controls survive as their own
                phone-only header row, because the column header row that
                carries them on desktop is hidden there.

                Two costs of restyling one tree, both deliberate. Changing the
                display roles drops the table semantics below `sm`, which is
                why every value carries a `CellLabel` naming its column -- a
                phone reader gets labelled values rather than a header
                association. And the phone reading order differs from the DOM
                order, which is the desktop column order the grid placement
                overrides visually. Both are properties of the mechanism, not
                of this table. */}
            <div className="overflow-x-auto">
              {/* Explicit roles: restyling `display` below `sm` strips the implicit
                  table semantics, and these put them back (inert from `sm` up). */}
              <table role="table" className="block min-w-full divide-y divide-gray-200 dark:divide-gray-700 sm:table">
                <thead role="rowgroup" className="block bg-gray-50 dark:bg-gray-900/50 sm:table-header-group">
                  {/* Phone sort strip: the same five controls, wrapped. */}
                  <tr role="row" className="flex flex-wrap gap-x-2 gap-y-1 px-2 py-2 sm:hidden">
                    {sortColumns.map((col) => (
                      <SortableHeader<IncomeVsExpensesSortField>
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
                      <SortableHeader<IncomeVsExpensesSortField>
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
                  {sortedTableData.map((row) => (
                    <tr
                      key={row.name}
                      role="row"
                      className="grid grid-cols-3 items-start gap-x-3 gap-y-1.5 px-4 py-3 cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-700/50 sm:table-row sm:p-0"
                      onClick={() =>
                        router.push(
                          `/transactions?startDate=${row.monthStart}&endDate=${row.monthEnd}`,
                        )
                      }
                    >
                      <td role="cell" className="col-start-1 row-start-1 p-0 text-sm font-medium text-gray-900 dark:text-gray-100 sm:table-cell sm:px-4 sm:py-3">
                        {row.fullName}
                      </td>
                      <td role="cell" className={`col-start-3 row-start-1 text-green-600 dark:text-green-400 ${MONEY_CELL}`}>
                        <CellLabel className="sm:hidden">{t('incomeVsExpenses.colIncome')}</CellLabel>
                        {formatCurrency(row.Income)}
                      </td>
                      <td role="cell" className={`col-start-3 row-start-2 text-red-600 dark:text-red-400 ${MONEY_CELL}`}>
                        <CellLabel className="sm:hidden">{t('incomeVsExpenses.colExpenses')}</CellLabel>
                        {formatCurrency(row.Expenses)}
                      </td>
                      {/* Savings takes the middle of line 1 beside the month:
                          it is the figure the row is read for. */}
                      <td role="cell"
                        className={`col-start-2 row-start-1 font-medium ${row.Savings >= 0 ? 'text-blue-600 dark:text-blue-400' : 'text-orange-600 dark:text-orange-400'} ${MONEY_CELL}`}
                      >
                        <CellLabel className="sm:hidden">{t('incomeVsExpenses.colSavings')}</CellLabel>
                        {formatCurrency(row.Savings)}
                      </td>
                      {/* The rate spans the first two tracks so its caption --
                          the longest in the table in every locale -- has room
                          on one line; right-aligned, it ends under Savings. */}
                      <td role="cell"
                        className={`col-start-1 col-span-2 row-start-2 font-medium ${row.SavingsRate >= 0 ? 'text-purple-600 dark:text-purple-400' : 'text-orange-600 dark:text-orange-400'} ${MONEY_CELL}`}
                      >
                        <CellLabel className="sm:hidden">{t('incomeVsExpenses.colSavingsRate')}</CellLabel>
                        {formatPercentTrimmed(row.SavingsRate)}
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot role="rowgroup" className="block bg-gray-50 dark:bg-gray-900/50 sm:table-footer-group">
                  {/* The totals are the largest figures on the table, so this
                      row wraps the same way a data row does -- the same three
                      tracks and placement, each money cell captioned. */}
                  <tr role="row" className="grid grid-cols-3 items-start gap-x-3 gap-y-1.5 px-4 py-3 sm:table-row sm:p-0">
                    <td role="cell" className="col-start-1 row-start-1 p-0 text-sm font-bold text-gray-900 dark:text-gray-100 sm:table-cell sm:px-4 sm:py-3">{t('incomeVsExpenses.total')}</td>
                    <td role="cell" className={`col-start-3 row-start-1 font-bold text-green-600 dark:text-green-400 ${MONEY_CELL}`}>
                      <CellLabel className="sm:hidden">{t('incomeVsExpenses.colIncome')}</CellLabel>
                      {formatCurrency(totals.totalIncome)}
                    </td>
                    <td role="cell" className={`col-start-3 row-start-2 font-bold text-red-600 dark:text-red-400 ${MONEY_CELL}`}>
                      <CellLabel className="sm:hidden">{t('incomeVsExpenses.colExpenses')}</CellLabel>
                      {formatCurrency(totals.totalExpenses)}
                    </td>
                    <td role="cell"
                      className={`col-start-2 row-start-1 font-bold ${totals.totalSavings >= 0 ? 'text-blue-600 dark:text-blue-400' : 'text-orange-600 dark:text-orange-400'} ${MONEY_CELL}`}
                    >
                      <CellLabel className="sm:hidden">{t('incomeVsExpenses.colSavings')}</CellLabel>
                      {formatCurrency(totals.totalSavings)}
                    </td>
                    <td role="cell"
                      className={`col-start-1 col-span-2 row-start-2 font-bold ${totals.savingsRate >= 0 ? 'text-purple-600 dark:text-purple-400' : 'text-orange-600 dark:text-orange-400'} ${MONEY_CELL}`}
                    >
                      <CellLabel className="sm:hidden">{t('incomeVsExpenses.colSavingsRate')}</CellLabel>
                      {formatPercent(totals.savingsRate, 1)}
                    </td>
                  </tr>
                </tfoot>
              </table>
            </div>
          </>
        ) : (
          <>
            <div className="h-96">
              <ResponsiveContainer width="100%" height="100%" minWidth={0}>
                <BarChart
                  data={chartData}
                  margin={{ top: 20, right: 10, left: 0, bottom: 5 }}
                  onClick={handleChartClick}
                  style={{ cursor: "pointer" }}
                >
                  <CartesianGrid strokeDasharray="3 3" stroke={chartColors.grid} />
                  <XAxis
                    dataKey="name"
                    tick={{ fontSize: 12 }}
                    tickFormatter={(value: string) =>
                      formatChartDate(`${value}-01`, "MMM")
                    }
                  />
                  <YAxis
                    tickFormatter={formatCurrencyAxis}
                    tick={{ fontSize: 12 }}
                  />
                  <Tooltip content={<CustomTooltip />} />
                  <Legend />
                  <ReferenceLine y={0} stroke={chartColors.axis} />
                  <Bar
                    dataKey="Income"
                    name={t('incomeVsExpenses.seriesIncome')}
                    fill={chartColors.income}
                    radius={[4, 4, 0, 0]}
                    cursor="pointer"
                    onClick={handleBarClick('income')}
                  />
                  <Bar
                    dataKey="Expenses"
                    name={t('incomeVsExpenses.seriesExpenses')}
                    fill={chartColors.expense}
                    radius={[4, 4, 0, 0]}
                    cursor="pointer"
                    onClick={handleBarClick('expense')}
                  />
                  <Bar
                    dataKey="Savings"
                    name={t('incomeVsExpenses.seriesSavings')}
                    fill={chartColors.primary}
                    radius={[4, 4, 0, 0]}
                    cursor="pointer"
                  />
                </BarChart>
              </ResponsiveContainer>
            </div>

            {/* Summary Cards */}
            <div className="mt-6 pt-4 border-t border-gray-200 dark:border-gray-700 grid grid-cols-2 md:grid-cols-4 gap-4">
              <div className="bg-green-50 dark:bg-green-900/20 rounded-lg p-4 text-center">
                <div className="text-sm text-green-600 dark:text-green-400">
                  {t('incomeVsExpenses.totalIncome')}
                </div>
                <div className="text-xl font-bold text-green-700 dark:text-green-300">
                  {formatCurrency(totals.totalIncome)}
                </div>
              </div>
              <div className="bg-red-50 dark:bg-red-900/20 rounded-lg p-4 text-center">
                <div className="text-sm text-red-600 dark:text-red-400">
                  {t('incomeVsExpenses.totalExpenses')}
                </div>
                <div className="text-xl font-bold text-red-700 dark:text-red-300">
                  {formatCurrency(totals.totalExpenses)}
                </div>
              </div>
              <div
                className={`rounded-lg p-4 text-center ${
                  totals.totalSavings >= 0
                    ? "bg-blue-50 dark:bg-blue-900/20"
                    : "bg-orange-50 dark:bg-orange-900/20"
                }`}
              >
                <div
                  className={`text-sm ${
                    totals.totalSavings >= 0
                      ? "text-blue-600 dark:text-blue-400"
                      : "text-orange-600 dark:text-orange-400"
                  }`}
                >
                  {t('incomeVsExpenses.totalSavings')}
                </div>
                <div
                  className={`text-xl font-bold ${
                    totals.totalSavings >= 0
                      ? "text-blue-700 dark:text-blue-300"
                      : "text-orange-700 dark:text-orange-300"
                  }`}
                >
                  {formatCurrency(totals.totalSavings)}
                </div>
              </div>
              <div
                className={`rounded-lg p-4 text-center ${
                  totals.savingsRate >= 0
                    ? "bg-purple-50 dark:bg-purple-900/20"
                    : "bg-orange-50 dark:bg-orange-900/20"
                }`}
              >
                <div
                  className={`text-sm ${
                    totals.savingsRate >= 0
                      ? "text-purple-600 dark:text-purple-400"
                      : "text-orange-600 dark:text-orange-400"
                  }`}
                >
                  {t('incomeVsExpenses.savingsRate')}
                </div>
                <div
                  className={`text-xl font-bold ${
                    totals.savingsRate >= 0
                      ? "text-purple-700 dark:text-purple-300"
                      : "text-orange-700 dark:text-orange-300"
                  }`}
                >
                  {formatPercent(totals.savingsRate, 1)}
                </div>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
