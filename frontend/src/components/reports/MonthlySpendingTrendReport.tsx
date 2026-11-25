"use client";

import { useState, useMemo, useRef } from "react";
import { useTranslations } from "next-intl";
import { gainLossColor } from '@/lib/format';
import { Skeleton } from '@/components/ui/LoadingSkeleton';
import { useRouter } from "next/navigation";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Legend,
} from "recharts";
import { parseISO } from "date-fns";
import { builtInReportsApi } from "@/lib/built-in-reports";
import { IncomeExpensePeriodItem } from "@/types/built-in-reports";
import { useNumberFormat } from "@/hooks/useNumberFormat";
import { useChartDateFormat } from "@/hooks/useChartDateFormat";
import { useDateRange } from "@/hooks/useDateRange";
import { useReportData } from "@/hooks/useReportData";
import { useSortableTable, compareValues } from "@/hooks/useSortableTable";
import { DateRangeSelector } from "@/components/ui/DateRangeSelector";
import { ChartViewToggle } from "@/components/ui/ChartViewToggle";
import { ReportToolbarActions } from '@/components/reports/ReportToolbarActions';
import { SortableHeader } from '@/components/ui/SortableHeader';
import { ChartTooltip } from "@/components/reports/ChartTooltip";
import { ReportError } from "@/components/reports/ReportError";
import { PartialDataNotice } from '@/components/reports/PartialDataNotice';
import { PartialTotal } from '@/components/ui/PartialTotal';
import { usePartialTotalNote } from '@/hooks/usePartialTotalNote';
import { exportToCsv } from "@/lib/csv-export";
import { chartColors } from "@/lib/chart-colors";
import { resolvePdfColor } from '@/components/reports/resolve-pdf-color';
import { EmptyState } from '@/components/ui/EmptyState';
import { CHART_GRID_PROPS } from '@/lib/chart-style';
import { ChartActiveDot } from '@/components/ui/ChartActiveDot';
import { CARD_CLASS } from '@/components/ui/Card';

type MonthlySpendingSortField = 'name' | 'income' | 'expenses' | 'net';


interface ChartDataItem {
  name: string;
  fullName: string;
  Expenses: number;
  Income: number;
  Net: number;
  monthStart: string;
  monthEnd: string;
}

interface SpendingTrendTooltipProps {
  active?: boolean;
  payload?: Array<{
    name: string;
    value: number;
    color: string;
    payload?: { fullName?: string };
  }>;
  label?: string;
  formatCurrency: (value: number) => string;
}

function SpendingTrendTooltip({ active, payload, formatCurrency }: SpendingTrendTooltipProps) {
  return (
    <ChartTooltip
      active={active}
      label={payload?.[0]?.payload?.fullName}
      payload={payload}
      formatValue={(v) => formatCurrency(v)}
    />
  );
}

export function MonthlySpendingTrendReport() {
  const t = useTranslations('reports');
  const router = useRouter();
  const chartRef = useRef<HTMLDivElement>(null);
  const { formatCurrencyCompact: formatCurrency, formatCurrencyAxis, defaultCurrency } =
    useNumberFormat();
  const formatChartDate = useChartDateFormat();
  const [viewType, setViewType] = useState<'line' | 'table'>('line');
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
  const { sortField, sortDirection, handleSort } = useSortableTable<MonthlySpendingSortField>(
    'reports.monthly-spending-trend.table.sort',
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
      (response?.data ?? []).map((item: IncomeExpensePeriodItem) => {
        return {
          name: item.period,
          fullName: formatChartDate(parseISO(item.periodStart), "MMM yyyy"),
          // The server's figures as they arrive, at the reporting currency's
          // places: the table, the tooltip and the CSV read these, so they
          // are not rounded to whole units for the chart
          // (docs/specs/report-rounding-and-aggregation.md section 7).
          Expenses: item.expenses,
          Income: item.income,
          Net: item.net,
          // The dates the bucket covers come from the server that chose it.
          monthStart: item.periodStart,
          monthEnd: item.periodEnd,
        };
      }),
    [response, formatChartDate],
  );

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
        case 'net':
          comparison = compareValues(a.Net, b.Net);
          break;
      }
      return sortDirection === 'asc' ? comparison : -comparison;
    });
    return sorted;
  }, [chartData, sortField, sortDirection]);

  // The window's totals are the server's, each the single rounding of its
  // months' exact sum; a sum of the months' figures can sit a unit off it
  // (spec rule 4). The known part is what converted; the notice above names
  // what did not.
  const totals = useMemo(() => {
    const totalExpenses = response?.totals.knownExpenses ?? 0;
    const totalIncome = response?.totals.knownIncome ?? 0;
    const totalNet = response?.totals.knownNet ?? 0;
    const avgExpenses =
      chartData.length > 0 ? totalExpenses / chartData.length : 0;
    const avgIncome = chartData.length > 0 ? totalIncome / chartData.length : 0;
    return { totalExpenses, totalIncome, totalNet, avgExpenses, avgIncome };
  }, [response, chartData.length]);

  // A total over a window with a row left out is a subtotal, and every figure
  // above (and the averages of them) says so, on the screen and in the PDF.
  const completeness = useMemo(
    () => ({
      missingCurrencies: response?.missingCurrencies ?? [],
      excludedCount: response?.excludedCount ?? 0,
    }),
    [response],
  );
  const reportingCurrency = response?.currency ?? defaultCurrency;
  const { noteFor } = usePartialTotalNote();
  const marked = (value: number) => (
    <PartialTotal total={{ value, ...completeness }} displayCurrency={reportingCurrency}>
      {formatCurrency(value)}
    </PartialTotal>
  );

  const handleExportPdf = async () => {
    const { exportToPdf } = await import("@/lib/pdf-export");
    const note = noteFor({ value: totals.totalIncome, ...completeness });
    await exportToPdf({
      title: t('monthlySpendingTrend.pdfTitle'),
      summaryCards: [
        { label: t('monthlySpendingTrend.totalIncome'), value: formatCurrency(totals.totalIncome), color: '#16a34a', note },
        { label: t('monthlySpendingTrend.totalExpenses'), value: formatCurrency(totals.totalExpenses), color: '#dc2626', note },
        { label: t('monthlySpendingTrend.avgMonthlyIncome'), value: formatCurrency(totals.avgIncome), color: '#16a34a', note },
        { label: t('monthlySpendingTrend.avgMonthlyExpenses'), value: formatCurrency(totals.avgExpenses), color: '#dc2626', note },
      ],
      chartContainer: chartRef.current,
      chartLegend: [
        { color: resolvePdfColor(chartColors.expense), label: t('monthlySpendingTrend.seriesExpenses') },
        { color: resolvePdfColor(chartColors.income), label: t('monthlySpendingTrend.seriesIncome') },
      ],
      filename: "monthly-spending-trend",
    });
  };

  const handleExportCsv = () => {
    const headers = [t('monthlySpendingTrend.colMonth'), t('monthlySpendingTrend.colIncome'), t('monthlySpendingTrend.colExpenses'), t('monthlySpendingTrend.colNet')];
    const rows = sortedTableData.map((d) => [d.fullName, d.Income, d.Expenses, d.Net]);
    exportToCsv('monthly-spending-trend', headers, rows);
  };

  const handleChartClick = (state: any) => {
    const label = state?.activeLabel;
    if (!label) return;
    const item = chartData.find((d) => d.name === label);
    if (item?.monthStart && item?.monthEnd) {
      router.push(
        `/transactions?startDate=${item.monthStart}&endDate=${item.monthEnd}`,
      );
    }
  };

  return (
    <div className="space-y-6">
      {/* Controls -- always rendered so focus inside DateInput survives reloads */}
      <div className={`${CARD_CLASS} p-4`}>
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
              onChange={(v) => setViewType(v as 'line' | 'table')}
              options={['line', 'table']}
            />
          </div>
          <ReportToolbarActions
            onExportPdf={handleExportPdf}
            onExportCsv={handleExportCsv}
            disabled={isLoading || !!error || chartData.length === 0}
          />
        </div>
      </div>

      <PartialDataNotice
        missingCurrencies={response?.missingCurrencies ?? []}
        excludedCount={response?.excludedCount ?? 0}
        displayCurrency={response?.currency ?? ''}
      />

      {/* Chart */}
      <div ref={chartRef} className={`${CARD_CLASS} px-2 py-4 sm:p-6`}>
        {isLoading ? (
          <div className="space-y-4">
            <Skeleton className="h-8 w-1/3" />
            <Skeleton className="h-96 w-full" />
          </div>
        ) : error ? (
          <ReportError onRetry={reload} />
        ) : chartData.length === 0 ? (
          <EmptyState title={t('monthlySpendingTrend.noData')} />
        ) : viewType === 'table' ? (
          <>
            <div className="overflow-x-auto">
              <table className="min-w-full divide-y divide-gray-200 dark:divide-gray-700">
                <thead className="bg-gray-50 dark:bg-gray-900/50">
                  <tr>
                    <SortableHeader<MonthlySpendingSortField>
                      field="name"
                      sortField={sortField}
                      sortDirection={sortDirection}
                      onSort={handleSort}
                      className="px-4 py-3 text-xs font-medium text-gray-500 dark:text-gray-400 uppercase"
                    >
                      {t('monthlySpendingTrend.colMonth')}
                    </SortableHeader>
                    <SortableHeader<MonthlySpendingSortField>
                      field="income"
                      sortField={sortField}
                      sortDirection={sortDirection}
                      onSort={handleSort}
                      align="right"
                      className="px-4 py-3 text-xs font-medium text-gray-500 dark:text-gray-400 uppercase"
                    >
                      {t('monthlySpendingTrend.colIncome')}
                    </SortableHeader>
                    <SortableHeader<MonthlySpendingSortField>
                      field="expenses"
                      sortField={sortField}
                      sortDirection={sortDirection}
                      onSort={handleSort}
                      align="right"
                      className="px-4 py-3 text-xs font-medium text-gray-500 dark:text-gray-400 uppercase"
                    >
                      {t('monthlySpendingTrend.colExpenses')}
                    </SortableHeader>
                    <SortableHeader<MonthlySpendingSortField>
                      field="net"
                      sortField={sortField}
                      sortDirection={sortDirection}
                      onSort={handleSort}
                      align="right"
                      className="px-4 py-3 text-xs font-medium text-gray-500 dark:text-gray-400 uppercase"
                    >
                      {t('monthlySpendingTrend.colNet')}
                    </SortableHeader>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-200 dark:divide-gray-700">
                  {sortedTableData.map((row) => (
                    <tr
                      key={row.name}
                      className="cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-700/50"
                      onClick={() =>
                        router.push(
                          `/transactions?startDate=${row.monthStart}&endDate=${row.monthEnd}`,
                        )
                      }
                    >
                      <td className="px-4 py-3 text-sm font-medium text-gray-900 dark:text-gray-100">
                        {row.fullName}
                      </td>
                      <td className="px-4 py-3 text-right text-sm text-green-600 dark:text-green-400">
                        {formatCurrency(row.Income)}
                      </td>
                      <td className="px-4 py-3 text-right text-sm text-red-600 dark:text-red-400">
                        {formatCurrency(row.Expenses)}
                      </td>
                      <td
                        className={`px-4 py-3 text-right text-sm font-medium ${gainLossColor(row.Net)}`}
                      >
                        {formatCurrency(row.Net)}
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot className="bg-gray-50 dark:bg-gray-900/50">
                  <tr>
                    <td className="px-4 py-3 text-sm font-bold text-gray-900 dark:text-gray-100">{t('monthlySpendingTrend.total')}</td>
                    <td className="px-4 py-3 text-right text-sm font-bold text-green-600 dark:text-green-400">
                      {marked(totals.totalIncome)}
                    </td>
                    <td className="px-4 py-3 text-right text-sm font-bold text-red-600 dark:text-red-400">
                      {marked(totals.totalExpenses)}
                    </td>
                    <td
                      className={`px-4 py-3 text-right text-sm font-bold ${gainLossColor(totals.totalNet)}`}
                    >
                      {marked(totals.totalNet)}
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
                <LineChart
                  data={chartData}
                  margin={{ top: 5, right: 10, left: 0, bottom: 5 }}
                  onClick={handleChartClick}
                  style={{ cursor: "pointer" }}
                >
                  <CartesianGrid {...CHART_GRID_PROPS} />
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
                  <Tooltip content={<SpendingTrendTooltip formatCurrency={formatCurrency} />} />
                  <Legend />
                  <Line
                    type="monotone"
                    dataKey="Expenses"
                    stroke={chartColors.expense}
                    strokeWidth={2}
                    dot={{ fill: chartColors.expense, strokeWidth: 2, r: 4 }}
                    activeDot={ChartActiveDot}
                  />
                  <Line
                    type="monotone"
                    dataKey="Income"
                    stroke={chartColors.income}
                    strokeWidth={2}
                    dot={{ fill: chartColors.income, strokeWidth: 2, r: 4 }}
                    activeDot={ChartActiveDot}
                  />
                </LineChart>
              </ResponsiveContainer>
            </div>

            {/* Summary */}
            <div className="mt-6 pt-4 border-t border-gray-200 dark:border-gray-700 grid grid-cols-2 md:grid-cols-4 gap-4 text-center">
              <div>
                <div className="text-sm text-gray-500 dark:text-gray-400">
                  {t('monthlySpendingTrend.totalIncome')}
                </div>
                <div className="text-lg font-semibold text-green-600 dark:text-green-400">
                  {marked(totals.totalIncome)}
                </div>
              </div>
              <div>
                <div className="text-sm text-gray-500 dark:text-gray-400">
                  {t('monthlySpendingTrend.totalExpenses')}
                </div>
                <div className="text-lg font-semibold text-red-600 dark:text-red-400">
                  {marked(totals.totalExpenses)}
                </div>
              </div>
              <div>
                <div className="text-sm text-gray-500 dark:text-gray-400">
                  {t('monthlySpendingTrend.avgMonthlyIncome')}
                </div>
                <div className="text-lg font-semibold text-green-600 dark:text-green-400">
                  {marked(totals.avgIncome)}
                </div>
              </div>
              <div>
                <div className="text-sm text-gray-500 dark:text-gray-400">
                  {t('monthlySpendingTrend.avgMonthlyExpenses')}
                </div>
                <div className="text-lg font-semibold text-red-600 dark:text-red-400">
                  {marked(totals.avgExpenses)}
                </div>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
