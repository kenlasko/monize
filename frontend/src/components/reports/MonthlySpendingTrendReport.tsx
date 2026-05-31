"use client";

import { useState, useMemo, useRef } from "react";
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

export function MonthlySpendingTrendReport() {
  const router = useRouter();
  const chartRef = useRef<HTMLDivElement>(null);
  const { formatCurrencyCompact: formatCurrency, formatCurrencyAxis } =
    useNumberFormat();
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
      (response?.data ?? []).map((item: MonthlyIncomeExpenseItem) => {
        const monthDate = parseISO(item.month + "-01");
        return {
          name: item.month,
          fullName: format(monthDate, "MMM yyyy"),
          Expenses: Math.round(item.expenses),
          Income: Math.round(item.income),
          Net: Math.round(item.net),
          monthStart: format(startOfMonth(monthDate), "yyyy-MM-dd"),
          monthEnd: format(endOfMonth(monthDate), "yyyy-MM-dd"),
        };
      }),
    [response],
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

  const totals = useMemo(() => {
    const totalExpenses = chartData.reduce((sum, m) => sum + m.Expenses, 0);
    const totalIncome = chartData.reduce((sum, m) => sum + m.Income, 0);
    const avgExpenses =
      chartData.length > 0 ? totalExpenses / chartData.length : 0;
    const avgIncome = chartData.length > 0 ? totalIncome / chartData.length : 0;
    return { totalExpenses, totalIncome, avgExpenses, avgIncome };
  }, [chartData]);

  const handleExportPdf = async () => {
    const { exportToPdf } = await import("@/lib/pdf-export");
    await exportToPdf({
      title: "Monthly Spending Trend",
      summaryCards: [
        { label: 'Total Income', value: formatCurrency(totals.totalIncome), color: '#16a34a' },
        { label: 'Total Expenses', value: formatCurrency(totals.totalExpenses), color: '#dc2626' },
        { label: 'Avg Monthly Income', value: formatCurrency(totals.avgIncome), color: '#16a34a' },
        { label: 'Avg Monthly Expenses', value: formatCurrency(totals.avgExpenses), color: '#dc2626' },
      ],
      chartContainer: chartRef.current,
      chartLegend: [
        { color: '#ef4444', label: 'Expenses' },
        { color: '#22c55e', label: 'Income' },
      ],
      filename: "monthly-spending-trend",
    });
  };

  const handleExportCsv = () => {
    const headers = ['Month', 'Income', 'Expenses', 'Net'];
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

  const CustomTooltip = ({
    active,
    payload,
  }: {
    active?: boolean;
    payload?: Array<{
      name: string;
      value: number;
      color: string;
      payload?: { fullName?: string };
    }>;
    label?: string;
  }) => (
    <ChartTooltip
      active={active}
      label={payload?.[0]?.payload?.fullName}
      payload={payload}
      formatValue={(v) => formatCurrency(v)}
    />
  );

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
              onChange={(v) => setViewType(v as 'line' | 'table')}
              options={['line', 'table']}
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
          <div className="animate-pulse space-y-4">
            <div className="h-8 bg-gray-200 dark:bg-gray-700 rounded w-1/3" />
            <div className="h-96 bg-gray-200 dark:bg-gray-700 rounded" />
          </div>
        ) : error ? (
          <ReportError onRetry={reload} />
        ) : chartData.length === 0 ? (
          <p className="text-gray-500 dark:text-gray-400 text-center py-8">
            No data for this period.
          </p>
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
                      Month
                    </SortableHeader>
                    <SortableHeader<MonthlySpendingSortField>
                      field="income"
                      sortField={sortField}
                      sortDirection={sortDirection}
                      onSort={handleSort}
                      align="right"
                      className="px-4 py-3 text-xs font-medium text-gray-500 dark:text-gray-400 uppercase"
                    >
                      Income
                    </SortableHeader>
                    <SortableHeader<MonthlySpendingSortField>
                      field="expenses"
                      sortField={sortField}
                      sortDirection={sortDirection}
                      onSort={handleSort}
                      align="right"
                      className="px-4 py-3 text-xs font-medium text-gray-500 dark:text-gray-400 uppercase"
                    >
                      Expenses
                    </SortableHeader>
                    <SortableHeader<MonthlySpendingSortField>
                      field="net"
                      sortField={sortField}
                      sortDirection={sortDirection}
                      onSort={handleSort}
                      align="right"
                      className="px-4 py-3 text-xs font-medium text-gray-500 dark:text-gray-400 uppercase"
                    >
                      Net
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
                        className={`px-4 py-3 text-right text-sm font-medium ${row.Net >= 0 ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'}`}
                      >
                        {formatCurrency(row.Net)}
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot className="bg-gray-50 dark:bg-gray-900/50">
                  <tr>
                    <td className="px-4 py-3 text-sm font-bold text-gray-900 dark:text-gray-100">Total</td>
                    <td className="px-4 py-3 text-right text-sm font-bold text-green-600 dark:text-green-400">
                      {formatCurrency(totals.totalIncome)}
                    </td>
                    <td className="px-4 py-3 text-right text-sm font-bold text-red-600 dark:text-red-400">
                      {formatCurrency(totals.totalExpenses)}
                    </td>
                    <td
                      className={`px-4 py-3 text-right text-sm font-bold ${totals.totalIncome - totals.totalExpenses >= 0 ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'}`}
                    >
                      {formatCurrency(totals.totalIncome - totals.totalExpenses)}
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
                  <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
                  <XAxis
                    dataKey="name"
                    tick={{ fontSize: 12 }}
                    tickFormatter={(value: string) =>
                      format(parseISO(value + "-01"), "MMM")
                    }
                  />
                  <YAxis
                    tickFormatter={formatCurrencyAxis}
                    tick={{ fontSize: 12 }}
                  />
                  <Tooltip content={<CustomTooltip />} />
                  <Legend />
                  <Line
                    type="monotone"
                    dataKey="Expenses"
                    stroke="#ef4444"
                    strokeWidth={2}
                    dot={{ fill: "#ef4444", strokeWidth: 2, r: 4 }}
                    activeDot={{ r: 6 }}
                  />
                  <Line
                    type="monotone"
                    dataKey="Income"
                    stroke="#22c55e"
                    strokeWidth={2}
                    dot={{ fill: "#22c55e", strokeWidth: 2, r: 4 }}
                    activeDot={{ r: 6 }}
                  />
                </LineChart>
              </ResponsiveContainer>
            </div>

            {/* Summary */}
            <div className="mt-6 pt-4 border-t border-gray-200 dark:border-gray-700 grid grid-cols-2 md:grid-cols-4 gap-4 text-center">
              <div>
                <div className="text-sm text-gray-500 dark:text-gray-400">
                  Total Income
                </div>
                <div className="text-lg font-semibold text-green-600 dark:text-green-400">
                  {formatCurrency(totals.totalIncome)}
                </div>
              </div>
              <div>
                <div className="text-sm text-gray-500 dark:text-gray-400">
                  Total Expenses
                </div>
                <div className="text-lg font-semibold text-red-600 dark:text-red-400">
                  {formatCurrency(totals.totalExpenses)}
                </div>
              </div>
              <div>
                <div className="text-sm text-gray-500 dark:text-gray-400">
                  Avg Monthly Income
                </div>
                <div className="text-lg font-semibold text-green-600 dark:text-green-400">
                  {formatCurrency(totals.avgIncome)}
                </div>
              </div>
              <div>
                <div className="text-sm text-gray-500 dark:text-gray-400">
                  Avg Monthly Expenses
                </div>
                <div className="text-lg font-semibold text-red-600 dark:text-red-400">
                  {formatCurrency(totals.avgExpenses)}
                </div>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
