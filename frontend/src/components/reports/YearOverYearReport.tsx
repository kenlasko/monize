"use client";

import { useState, useMemo, useRef } from "react";
import { Skeleton } from '@/components/ui/LoadingSkeleton';
import { useRouter } from "next/navigation";
import { endOfMonth, format } from "date-fns";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Legend,
} from "recharts";
import { builtInReportsApi } from "@/lib/built-in-reports";
import { YearData } from "@/types/built-in-reports";
import { useNumberFormat } from "@/hooks/useNumberFormat";
import { useSortableTable, compareValues } from "@/hooks/useSortableTable";
import { CHART_COLOURS } from "@/lib/chart-colours";
import { ChartViewToggle } from "@/components/ui/ChartViewToggle";
import { ExportDropdown } from "@/components/ui/ExportDropdown";
import { SortableHeader } from "@/components/ui/SortableHeader";
import { exportToCsv } from "@/lib/csv-export";
import { useReportData } from "@/hooks/useReportData";
import { ReportError } from "@/components/reports/ReportError";

type YearOverYearSortField = string; // 'name' or any year as a string

const MONTH_NAMES = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

export function YearOverYearReport() {
  const router = useRouter();
  const { formatCurrencyCompact: formatCurrency, formatCurrencyAxis, formatSignedPercent } =
    useNumberFormat();
  const chartRef = useRef<HTMLDivElement>(null);
  const [yearsToCompare, setYearsToCompare] = useState(2);
  const [metric, setMetric] = useState<"expenses" | "income" | "savings">(
    "expenses",
  );
  const [viewType, setViewType] = useState<'bar' | 'table'>('bar');
  const { sortField, sortDirection, handleSort } = useSortableTable<YearOverYearSortField>(
    'reports.year-over-year.table.sort',
    { field: 'name', direction: 'asc' },
  );

  const { data: response, isLoading, error, reload } = useReportData(
    () => builtInReportsApi.getYearOverYear(yearsToCompare),
    [yearsToCompare],
  );

  const yearData = useMemo<YearData[]>(() => response?.data ?? [], [response]);

  const years = useMemo(() => yearData.map((yd) => yd.year), [yearData]);

  const chartData = useMemo(() => {
    return MONTH_NAMES.map((monthName, monthIndex) => {
      const data: { name: string; [key: string]: number | string } = {
        name: monthName,
      };

      yearData.forEach((yd) => {
        const monthData = yd.months.find((m) => m.month === monthIndex + 1);
        if (monthData) {
          data[`${yd.year}`] = Math.round(monthData[metric]);
        } else {
          data[`${yd.year}`] = 0;
        }
      });

      return data;
    });
  }, [yearData, metric]);

  const sortedTableData = useMemo(() => {
    const sorted = [...chartData];
    sorted.sort((a, b) => {
      let comparison = 0;
      if (sortField === 'name') {
        // Default to calendar order for the month column
        const ai = MONTH_NAMES.indexOf(a.name);
        const bi = MONTH_NAMES.indexOf(b.name);
        comparison = compareValues(ai, bi);
      } else {
        comparison = compareValues(a[sortField] as number, b[sortField] as number);
      }
      return sortDirection === 'asc' ? comparison : -comparison;
    });
    return sorted;
  }, [chartData, sortField, sortDirection]);

  const yearTotals = useMemo(() => {
    const totals: Record<
      number,
      { income: number; expenses: number; savings: number }
    > = {};

    yearData.forEach((yd) => {
      totals[yd.year] = {
        income: yd.totals.income,
        expenses: yd.totals.expenses,
        savings: yd.totals.savings,
      };
    });

    return totals;
  }, [yearData]);

  const handleBarClick = (year: number, data: { name: string }) => {
    const monthIndex = MONTH_NAMES.indexOf(data.name);
    if (monthIndex === -1) return;
    const startDate = `${year}-${String(monthIndex + 1).padStart(2, "0")}-01`;
    const lastDay = format(
      endOfMonth(new Date(year, monthIndex, 1)),
      "yyyy-MM-dd",
    );
    router.push(`/transactions?startDate=${startDate}&endDate=${lastDay}`);
  };

  const handleExportPdf = async () => {
    const { exportToPdf } = await import("@/lib/pdf-export");

    const cards = years.map((year, index) => ({
      label: String(year),
      value: formatCurrency(yearTotals[year]?.[metric] || 0),
      color: CHART_COLOURS[index % CHART_COLOURS.length],
    }));

    // Build YoY change table
    const tableHeaders = ["Metric", ...years.slice(1).map((year, index) => `${years[index]} vs ${year}`)];
    const tableRows = (["income", "expenses", "savings"] as const).map((m) => {
      const label = m.charAt(0).toUpperCase() + m.slice(1);
      const cells = years.slice(1).map((_year, index) => {
        const prevValue = yearTotals[years[index]]?.[m] || 0;
        const currValue = yearTotals[_year]?.[m] || 0;
        const change = currValue - prevValue;
        const changePercent = prevValue !== 0 ? (change / Math.abs(prevValue)) * 100 : 0;
        return `${change >= 0 ? "+" : ""}${formatCurrency(change)} (${formatSignedPercent(changePercent, 1)})`;
      });
      return [label, ...cells];
    });

    // Build yearly summary table
    const summaryHeaders = ["Year", "Income", "Expenses", "Net"];
    const summaryRows = years.map((year) => [
      String(year),
      formatCurrency(yearTotals[year]?.income || 0),
      formatCurrency(yearTotals[year]?.expenses || 0),
      formatCurrency(yearTotals[year]?.savings || 0),
    ]);

    await exportToPdf({
      title: "Year Over Year Comparison",
      subtitle: `${metric.charAt(0).toUpperCase() + metric.slice(1)} | ${years[0]} - ${years[years.length - 1]}`,
      summaryCards: cards,
      chartContainer: chartRef.current,
      tableData: years.length >= 2 ? { headers: tableHeaders, rows: tableRows } : undefined,
      additionalTables: [{
        title: "Yearly Summary",
        headers: summaryHeaders,
        rows: summaryRows,
      }],
      filename: "year-over-year",
    });
  };

  const handleExportCsv = () => {
    const headers = ['Month', ...years.map(String)];
    const rows = sortedTableData.map((row) => [
      row.name,
      ...years.map((year) => Number(row[year]) || 0),
    ]);
    exportToCsv(`year-over-year-${metric}`, headers, rows);
  };

  const CustomTooltip = ({
    active,
    payload,
    label,
  }: {
    active?: boolean;
    payload?: Array<{ name: string; value: number; color: string }>;
    label?: string;
  }) => {
    if (active && payload && payload.length) {
      return (
        <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg shadow-lg p-3">
          <p className="font-medium text-gray-900 dark:text-gray-100 mb-1">
            {label}
          </p>
          {payload.map((entry, index) => (
            <p key={index} className="text-sm" style={{ color: entry.color }}>
              {entry.name}: {formatCurrency(entry.value)}
            </p>
          ))}
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
          <Skeleton className="h-96 w-full" />
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Controls */}
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-4">
        <div className="flex flex-wrap gap-6 items-center">
          <div className="flex items-center gap-2">
            <label className="text-sm font-medium text-gray-700 dark:text-gray-300">
              Compare:
            </label>
            <select
              value={yearsToCompare}
              onChange={(e) => setYearsToCompare(Number(e.target.value))}
              className="rounded-md border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100 text-sm font-sans"
            >
              <option value={2} className="font-sans">
                2 Years
              </option>
              <option value={3} className="font-sans">
                3 Years
              </option>
              <option value={4} className="font-sans">
                4 Years
              </option>
              <option value={5} className="font-sans">
                5 Years
              </option>
            </select>
          </div>
          <div className="flex gap-2 items-center">
            {(["expenses", "income", "savings"] as const).map((m) => (
              <button
                key={m}
                onClick={() => setMetric(m)}
                className={`px-3 py-1.5 text-sm font-medium rounded-md transition-colors capitalize ${
                  metric === m
                    ? "bg-blue-600 text-white"
                    : "bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-600"
                }`}
              >
                {m}
              </button>
            ))}
          </div>
          <div className="ml-auto flex items-center gap-3">
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

      {/* Year Summary Cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-5 gap-4">
        {years.map((year, index) => (
          <div
            key={year}
            className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-4"
            style={{
              borderLeft: `4px solid ${CHART_COLOURS[index % CHART_COLOURS.length]}`,
            }}
          >
            <div className="text-lg font-bold text-gray-900 dark:text-gray-100">
              {year}
            </div>
            <div className="mt-2 space-y-1 text-sm">
              <div className="flex justify-between">
                <span className="text-gray-500 dark:text-gray-400">Income</span>
                <span className="text-green-600 dark:text-green-400">
                  {formatCurrency(yearTotals[year]?.income || 0)}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-500 dark:text-gray-400">
                  Expenses
                </span>
                <span className="text-red-600 dark:text-red-400">
                  {formatCurrency(yearTotals[year]?.expenses || 0)}
                </span>
              </div>
              <div className="flex justify-between pt-1 border-t border-gray-200 dark:border-gray-700">
                <span className="text-gray-500 dark:text-gray-400">Net</span>
                <span
                  className={
                    (yearTotals[year]?.savings || 0) >= 0
                      ? "text-blue-600 dark:text-blue-400"
                      : "text-orange-600 dark:text-orange-400"
                  }
                >
                  {formatCurrency(yearTotals[year]?.savings || 0)}
                </span>
              </div>
            </div>
          </div>
        ))}
      </div>

      {/* Monthly Comparison Chart or Table */}
      <div ref={chartRef} className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 px-2 py-4 sm:p-6">
        <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-4">
          Monthly {metric.charAt(0).toUpperCase() + metric.slice(1)} Comparison
        </h3>
        {viewType === 'table' ? (
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-gray-200 dark:divide-gray-700">
              <thead className="bg-gray-50 dark:bg-gray-900/50">
                <tr>
                  <SortableHeader<YearOverYearSortField>
                    field="name"
                    sortField={sortField}
                    sortDirection={sortDirection}
                    onSort={handleSort}
                    className="px-4 py-3 text-xs font-medium text-gray-500 dark:text-gray-400 uppercase"
                  >
                    Month
                  </SortableHeader>
                  {years.map((year, index) => (
                    <SortableHeader<YearOverYearSortField>
                      key={year}
                      field={`${year}`}
                      sortField={sortField}
                      sortDirection={sortDirection}
                      onSort={handleSort}
                      align="right"
                      className="px-4 py-3 text-xs font-medium text-gray-500 dark:text-gray-400 uppercase"
                    >
                      <span style={{ color: CHART_COLOURS[index % CHART_COLOURS.length] }}>{year}</span>
                    </SortableHeader>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-200 dark:divide-gray-700">
                {sortedTableData.map((row) => (
                  <tr key={row.name} className="hover:bg-gray-50 dark:hover:bg-gray-700/50">
                    <td className="px-4 py-3 text-sm font-medium text-gray-900 dark:text-gray-100">
                      {row.name}
                    </td>
                    {years.map((year) => {
                      const value = Number(row[year]) || 0;
                      return (
                        <td
                          key={year}
                          className="px-4 py-3 text-right text-sm text-gray-900 dark:text-gray-100 cursor-pointer"
                          onClick={() => handleBarClick(year, { name: row.name })}
                        >
                          {formatCurrency(value)}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
              <tfoot className="bg-gray-50 dark:bg-gray-900/50">
                <tr>
                  <td className="px-4 py-3 text-sm font-bold text-gray-900 dark:text-gray-100">Total</td>
                  {years.map((year) => (
                    <td key={year} className="px-4 py-3 text-right text-sm font-bold text-gray-900 dark:text-gray-100">
                      {formatCurrency(yearTotals[year]?.[metric] || 0)}
                    </td>
                  ))}
                </tr>
              </tfoot>
            </table>
          </div>
        ) : (
          <div className="h-96">
            <ResponsiveContainer width="100%" height="100%" minWidth={0}>
              <BarChart
                data={chartData}
                margin={{ top: 20, right: 10, left: 0, bottom: 5 }}
              >
                <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
                <XAxis dataKey="name" tick={{ fontSize: 12 }} />
                <YAxis
                  tickFormatter={formatCurrencyAxis}
                  tick={{ fontSize: 12 }}
                />
                <Tooltip content={<CustomTooltip />} />
                <Legend />
                {years.map((year, index) => (
                  <Bar
                    key={year}
                    dataKey={`${year}`}
                    fill={CHART_COLOURS[index % CHART_COLOURS.length]}
                    radius={[4, 4, 0, 0]}
                    name={`${year}`}
                    cursor="pointer"
                    onClick={(data) =>
                      handleBarClick(year, { name: data.name ?? '' })
                    }
                  />
                ))}
              </BarChart>
            </ResponsiveContainer>
          </div>
        )}
      </div>

      {/* Year-over-Year Change */}
      {years.length >= 2 && (
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-6">
          <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-4">
            Year-over-Year Change
          </h3>
          <div className="overflow-x-auto">
            <table className="min-w-full">
              <thead>
                <tr className="border-b border-gray-200 dark:border-gray-700">
                  <th className="py-2 px-4 text-left text-sm font-medium text-gray-500 dark:text-gray-400">
                    Metric
                  </th>
                  {years.slice(1).map((year, index) => (
                    <th
                      key={year}
                      className="py-2 px-4 text-right text-sm font-medium text-gray-500 dark:text-gray-400"
                    >
                      {years[index]} vs {year}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {(["income", "expenses", "savings"] as const).map((m) => (
                  <tr
                    key={m}
                    className="border-b border-gray-200 dark:border-gray-700"
                  >
                    <td className="py-3 px-4 text-sm font-medium text-gray-900 dark:text-gray-100 capitalize">
                      {m}
                    </td>
                    {years.slice(1).map((year, index) => {
                      const prevYear = years[index];
                      const prevValue = yearTotals[prevYear]?.[m] || 0;
                      const currValue = yearTotals[year]?.[m] || 0;
                      const change = currValue - prevValue;
                      const changePercent =
                        prevValue !== 0
                          ? (change / Math.abs(prevValue)) * 100
                          : 0;
                      const isPositive =
                        m === "expenses" ? change < 0 : change > 0;

                      return (
                        <td key={year} className="py-3 px-4 text-right">
                          <div
                            className={`text-sm font-medium ${
                              isPositive
                                ? "text-green-600 dark:text-green-400"
                                : "text-red-600 dark:text-red-400"
                            }`}
                          >
                            {change >= 0 ? "+" : ""}
                            {formatCurrency(change)}
                          </div>
                          <div
                            className={`text-xs ${
                              isPositive ? "text-green-500" : "text-red-500"
                            }`}
                          >
                            ({formatSignedPercent(changePercent, 1)})
                          </div>
                        </td>
                      );
                    })}
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
