"use client";

import { useState, useEffect, useMemo, useCallback } from "react";
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
import { DateRangeSelector } from "@/components/ui/DateRangeSelector";
import { createLogger } from "@/lib/logger";

const logger = createLogger("MonthlySpendingTrendReport");

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
  const { formatCurrencyCompact: formatCurrency, formatCurrencyAxis } =
    useNumberFormat();
  const [chartData, setChartData] = useState<ChartDataItem[]>([]);
  const [isLoading, setIsLoading] = useState(true);
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

  const loadData = useCallback(async () => {
    setIsLoading(true);
    try {
      const { start, end } = resolvedRange;
      const response = await builtInReportsApi.getIncomeVsExpenses({
        startDate: start || undefined,
        endDate: end,
      });

      // Map response to chart data
      const data: ChartDataItem[] = response.data.map(
        (item: MonthlyIncomeExpenseItem) => {
          const monthDate = parseISO(item.month + "-01");
          return {
            name: format(monthDate, "MMM"),
            fullName: format(monthDate, "MMM yyyy"),
            Expenses: Math.round(item.expenses),
            Income: Math.round(item.income),
            Net: Math.round(item.net),
            monthStart: format(startOfMonth(monthDate), "yyyy-MM-dd"),
            monthEnd: format(endOfMonth(monthDate), "yyyy-MM-dd"),
          };
        },
      );

      setChartData(data);
    } catch (error) {
      logger.error("Failed to load data:", error);
    } finally {
      setIsLoading(false);
    }
  }, [resolvedRange]);

  useEffect(() => {
    if (isValid) loadData();
  }, [isValid, loadData]);

  const totals = useMemo(() => {
    const totalExpenses = chartData.reduce((sum, m) => sum + m.Expenses, 0);
    const totalIncome = chartData.reduce((sum, m) => sum + m.Income, 0);
    const avgExpenses =
      chartData.length > 0 ? totalExpenses / chartData.length : 0;
    const avgIncome = chartData.length > 0 ? totalIncome / chartData.length : 0;
    return { totalExpenses, totalIncome, avgExpenses, avgIncome };
  }, [chartData]);

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
    label: _label,
  }: {
    active?: boolean;
    payload?: Array<{
      name: string;
      value: number;
      color: string;
      payload?: { fullName?: string };
    }>;
    label?: string;
  }) => {
    if (active && payload && payload.length) {
      const data = payload[0]?.payload;
      return (
        <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg shadow-lg p-3">
          <p className="font-medium text-gray-900 dark:text-gray-100 mb-1">
            {data?.fullName}
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

  if (isLoading) {
    return (
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-6">
        <div className="animate-pulse space-y-4">
          <div className="h-8 bg-gray-200 dark:bg-gray-700 rounded w-1/3" />
          <div className="h-96 bg-gray-200 dark:bg-gray-700 rounded" />
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Controls */}
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-4">
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
      </div>

      {/* Chart */}
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-6">
        {chartData.length === 0 ? (
          <p className="text-gray-500 dark:text-gray-400 text-center py-8">
            No data for this period.
          </p>
        ) : (
          <>
            <div className="h-96">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart
                  data={chartData}
                  margin={{ top: 5, right: 30, left: 20, bottom: 5 }}
                  onClick={handleChartClick}
                  style={{ cursor: "pointer" }}
                >
                  <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
                  <XAxis dataKey="name" tick={{ fontSize: 12 }} />
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
