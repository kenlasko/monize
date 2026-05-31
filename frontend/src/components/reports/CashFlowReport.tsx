"use client";

import { useMemo, useRef } from "react";
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
import {
  MonthlyIncomeExpenseItem,
  CategorySpendingItem,
  IncomeSourceItem,
} from "@/types/built-in-reports";
import { useNumberFormat } from "@/hooks/useNumberFormat";
import { useDateRange } from "@/hooks/useDateRange";
import { useReportData } from "@/hooks/useReportData";
import { DateRangeSelector } from "@/components/ui/DateRangeSelector";
import { ExportDropdown } from '@/components/ui/ExportDropdown';
import { ChartTooltip } from "@/components/reports/ChartTooltip";
import { ReportError } from "@/components/reports/ReportError";

interface ChartDataItem {
  name: string;
  fullName: string;
  Income: number;
  Expenses: number;
  Net: number;
  monthStart: string;
  monthEnd: string;
}

export function CashFlowReport() {
  const router = useRouter();
  const chartRef = useRef<HTMLDivElement>(null);
  const { formatCurrencyCompact: formatCurrency, formatCurrencyAxis } =
    useNumberFormat();
  const {
    dateRange,
    setDateRange,
    startDate,
    setStartDate,
    endDate,
    setEndDate,
    resolvedRange,
    isValid,
  } = useDateRange({ defaultRange: "6m", alignment: "month" });

  const { start: rangeStart, end: rangeEnd } = resolvedRange;

  const { data: response, isLoading, error, reload } = useReportData(
    async () => {
      if (!isValid) return null;
      const params = { startDate: rangeStart || undefined, endDate: rangeEnd };
      // Fetch all data in parallel
      const [cashFlowResponse, incomeResponse, spendingResponse] =
        await Promise.all([
          builtInReportsApi.getCashFlow(params),
          builtInReportsApi.getIncomeBySource(params),
          builtInReportsApi.getSpendingByCategory(params),
        ]);
      return { cashFlowResponse, incomeResponse, spendingResponse };
    },
    [isValid, rangeStart, rangeEnd],
  );

  // Map monthly data. `name` must be unique across the dataset (used as
  // the XAxis category key); a non-unique value like "May" causes Recharts
  // to resolve the tooltip's payload to the first matching row, showing data
  // from the wrong year on multi-year ranges.
  const monthlyData = useMemo<ChartDataItem[]>(
    () =>
      (response?.cashFlowResponse.data ?? []).map((item: MonthlyIncomeExpenseItem) => {
        const monthDate = parseISO(item.month + "-01");
        return {
          name: item.month,
          fullName: format(monthDate, "MMM yyyy"),
          Income: Math.round(item.income),
          Expenses: Math.round(item.expenses),
          Net: Math.round(item.net),
          monthStart: format(startOfMonth(monthDate), "yyyy-MM-dd"),
          monthEnd: format(endOfMonth(monthDate), "yyyy-MM-dd"),
        };
      }),
    [response],
  );

  const incomeItems = useMemo<IncomeSourceItem[]>(
    () => response?.incomeResponse.data ?? [],
    [response],
  );
  const expenseItems = useMemo<CategorySpendingItem[]>(
    () => response?.spendingResponse.data ?? [],
    [response],
  );
  const totals = useMemo(
    () => ({
      totalIncome: response?.cashFlowResponse.totals.income ?? 0,
      totalExpenses: response?.cashFlowResponse.totals.expenses ?? 0,
      netCashFlow: response?.cashFlowResponse.totals.net ?? 0,
    }),
    [response],
  );

  const handleExportPdf = async () => {
    const { exportToPdf } = await import("@/lib/pdf-export");

    const inflowRows = incomeItems.map((item) => [item.categoryName, formatCurrency(item.total)]);
    const outflowRows = expenseItems.map((item) => [item.categoryName, formatCurrency(item.total)]);

    await exportToPdf({
      title: "Cash Flow Report",
      summaryCards: [
        { label: "Total Inflows", value: formatCurrency(totals.totalIncome), color: "#16a34a" },
        { label: "Total Outflows", value: formatCurrency(totals.totalExpenses), color: "#dc2626" },
        { label: "Net Cash Flow", value: `${totals.netCashFlow >= 0 ? "+" : ""}${formatCurrency(totals.netCashFlow)}`, color: totals.netCashFlow >= 0 ? "#2563eb" : "#ea580c" },
      ],
      chartContainer: chartRef.current,
      additionalTables: [
        ...(inflowRows.length > 0 ? [{
          title: "Inflows by Category",
          headers: ["Category", "Amount"],
          rows: inflowRows,
          totalRow: ["Total Inflows", formatCurrency(totals.totalIncome)],
        }] : []),
        ...(outflowRows.length > 0 ? [{
          title: "Outflows by Category",
          headers: ["Category", "Amount"],
          rows: outflowRows,
          totalRow: ["Total Outflows", formatCurrency(totals.totalExpenses)],
        }] : []),
      ],
      filename: "cash-flow",
    });
  };

  const handleChartClick = (state: any) => {
    const label = state?.activeLabel;
    if (!label) return;
    const item = monthlyData.find((d) => d.name === label);
    if (item?.monthStart && item?.monthEnd) {
      router.push(
        `/transactions?startDate=${item.monthStart}&endDate=${item.monthEnd}`,
      );
    }
  };

  const handleCategoryClick = (categoryId: string | null) => {
    if (!categoryId) return;
    const { start, end } = resolvedRange;
    const params = new URLSearchParams();
    params.set("categoryId", categoryId);
    if (start) params.set("startDate", start);
    if (end) params.set("endDate", end);
    router.push(`/transactions?${params.toString()}`);
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
      payload: { fullName: string };
    }>;
  }) => (
    <ChartTooltip
      active={active}
      label={payload?.[0]?.payload?.fullName}
      payload={payload}
      formatValue={(v) => formatCurrency(v)}
    />
  );

  if (error) {
    return <ReportError onRetry={reload} />;
  }

  if (isLoading) {
    // Render the controls block too so focus inside DateInput survives
    // reloads triggered by typing in the custom date range.
    return (
      <div className="space-y-6">
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-4">
          <div className="flex flex-wrap gap-4 items-center justify-between">
            <DateRangeSelector
              ranges={["3m", "6m", "1y"]}
              value={dateRange}
              onChange={setDateRange}
              showCustom
              customStartDate={startDate}
              onCustomStartDateChange={setStartDate}
              customEndDate={endDate}
              onCustomEndDateChange={setEndDate}
            />
            <ExportDropdown onExportPdf={handleExportPdf} />
          </div>
        </div>
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-6">
          <div className="space-y-4">
            <Skeleton className="h-8 w-1/3" />
            <Skeleton className="h-64 w-full" />
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Summary Cards */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className="bg-green-50 dark:bg-green-900/20 rounded-lg p-4 sm:p-6">
          <div className="text-sm text-green-600 dark:text-green-400">
            Total Inflows
          </div>
          <div className="text-2xl font-bold text-green-700 dark:text-green-300">
            {formatCurrency(totals.totalIncome)}
          </div>
        </div>
        <div className="bg-red-50 dark:bg-red-900/20 rounded-lg p-4 sm:p-6">
          <div className="text-sm text-red-600 dark:text-red-400">
            Total Outflows
          </div>
          <div className="text-2xl font-bold text-red-700 dark:text-red-300">
            {formatCurrency(totals.totalExpenses)}
          </div>
        </div>
        <div
          className={`rounded-lg p-4 sm:p-6 ${
            totals.netCashFlow >= 0
              ? "bg-blue-50 dark:bg-blue-900/20"
              : "bg-orange-50 dark:bg-orange-900/20"
          }`}
        >
          <div
            className={`text-sm ${
              totals.netCashFlow >= 0
                ? "text-blue-600 dark:text-blue-400"
                : "text-orange-600 dark:text-orange-400"
            }`}
          >
            Net Cash Flow
          </div>
          <div
            className={`text-2xl font-bold ${
              totals.netCashFlow >= 0
                ? "text-blue-700 dark:text-blue-300"
                : "text-orange-700 dark:text-orange-300"
            }`}
          >
            {totals.netCashFlow >= 0 ? "+" : ""}
            {formatCurrency(totals.netCashFlow)}
          </div>
        </div>
      </div>

      {/* Controls */}
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-4">
        <div className="flex flex-wrap gap-4 items-center justify-between">
          <DateRangeSelector
            ranges={["3m", "6m", "1y"]}
            value={dateRange}
            onChange={setDateRange}
            showCustom
            customStartDate={startDate}
            onCustomStartDateChange={setStartDate}
            customEndDate={endDate}
            onCustomEndDateChange={setEndDate}
          />
          <ExportDropdown onExportPdf={handleExportPdf} />
        </div>
      </div>

      {/* Monthly Chart */}
      <div ref={chartRef} className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 px-2 py-4 sm:p-6">
        <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-4 px-1 sm:px-0">
          Monthly Cash Flow
        </h3>
        <div className="h-80">
          <ResponsiveContainer width="100%" height="100%" minWidth={0}>
            <BarChart
              data={monthlyData}
              margin={{ top: 20, right: 10, left: 0, bottom: 5 }}
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
              <ReferenceLine y={0} stroke="#9ca3af" />
              <Bar
                dataKey="Income"
                fill="#22c55e"
                name="Inflows"
                radius={[4, 4, 0, 0]}
              />
              <Bar
                dataKey="Expenses"
                fill="#ef4444"
                name="Outflows"
                radius={[4, 4, 0, 0]}
              />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>

      {/* Breakdown Tables */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Inflows */}
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 overflow-hidden">
          <div className="px-6 py-4 bg-green-50 dark:bg-green-900/20 border-b border-gray-200 dark:border-gray-700">
            <h3 className="text-lg font-semibold text-green-700 dark:text-green-300">
              Inflows by Category
            </h3>
          </div>
          <div className="divide-y divide-gray-200 dark:divide-gray-700 max-h-96 overflow-y-auto">
            {incomeItems.length === 0 ? (
              <p className="px-6 py-4 text-gray-500 dark:text-gray-400">
                No income in this period
              </p>
            ) : (
              incomeItems.map((item, index) => (
                <div
                  key={index}
                  className={`px-6 py-3 flex items-center justify-between ${item.categoryId ? "cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-700/50" : ""}`}
                  onClick={() => handleCategoryClick(item.categoryId)}
                >
                  <span className="text-gray-900 dark:text-gray-100">
                    {item.categoryName}
                  </span>
                  <span className="font-medium text-green-600 dark:text-green-400">
                    {formatCurrency(item.total)}
                  </span>
                </div>
              ))
            )}
          </div>
        </div>

        {/* Outflows */}
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 overflow-hidden">
          <div className="px-6 py-4 bg-red-50 dark:bg-red-900/20 border-b border-gray-200 dark:border-gray-700">
            <h3 className="text-lg font-semibold text-red-700 dark:text-red-300">
              Outflows by Category
            </h3>
          </div>
          <div className="divide-y divide-gray-200 dark:divide-gray-700 max-h-96 overflow-y-auto">
            {expenseItems.length === 0 ? (
              <p className="px-6 py-4 text-gray-500 dark:text-gray-400">
                No expenses in this period
              </p>
            ) : (
              expenseItems.map((item, index) => (
                <div
                  key={index}
                  className={`px-6 py-3 flex items-center justify-between ${item.categoryId ? "cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-700/50" : ""}`}
                  onClick={() => handleCategoryClick(item.categoryId)}
                >
                  <span className="text-gray-900 dark:text-gray-100">
                    {item.categoryName}
                  </span>
                  <span className="font-medium text-red-600 dark:text-red-400">
                    {formatCurrency(item.total)}
                  </span>
                </div>
              ))
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
