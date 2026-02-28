"use client";

import { useState, useEffect, useCallback } from "react";
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
import { DateRangeSelector } from "@/components/ui/DateRangeSelector";
import { createLogger } from "@/lib/logger";

const logger = createLogger("IncomeVsExpensesReport");

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
  const router = useRouter();
  const { formatCurrencyCompact: formatCurrency, formatCurrencyAxis } =
    useNumberFormat();
  const [chartData, setChartData] = useState<ChartDataItem[]>([]);
  const [totals, setTotals] = useState({
    totalIncome: 0,
    totalExpenses: 0,
    totalSavings: 0,
    savingsRate: 0,
  });
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
          const savings = item.income - item.expenses;
          const savingsRate =
            item.income > 0 ? Math.round((savings / item.income) * 100) : 0;
          return {
            name: format(monthDate, "MMM"),
            fullName: format(monthDate, "MMM yyyy"),
            Income: Math.round(item.income),
            Expenses: Math.round(item.expenses),
            Savings: Math.round(savings),
            SavingsRate: savingsRate,
            monthStart: format(startOfMonth(monthDate), "yyyy-MM-dd"),
            monthEnd: format(endOfMonth(monthDate), "yyyy-MM-dd"),
          };
        },
      );

      setChartData(data);

      const totalIncome = response.totals.income;
      const totalExpenses = response.totals.expenses;
      const totalSavings = totalIncome - totalExpenses;
      const savingsRate =
        totalIncome > 0 ? (totalSavings / totalIncome) * 100 : 0;
      setTotals({ totalIncome, totalExpenses, totalSavings, savingsRate });
    } catch (error) {
      logger.error("Failed to load data:", error);
    } finally {
      setIsLoading(false);
    }
  }, [resolvedRange]);

  useEffect(() => {
    if (isValid) loadData();
  }, [isValid, loadData]);

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
      payload: { fullName: string; SavingsRate: number };
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
          <p className="text-sm text-gray-600 dark:text-gray-400 mt-1">
            Savings Rate: {data?.SavingsRate}%
          </p>
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
                <BarChart
                  data={chartData}
                  margin={{ top: 20, right: 30, left: 20, bottom: 5 }}
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
                  <ReferenceLine y={0} stroke="#9ca3af" />
                  <Bar
                    dataKey="Income"
                    fill="#22c55e"
                    radius={[4, 4, 0, 0]}
                  />
                  <Bar
                    dataKey="Expenses"
                    fill="#ef4444"
                    radius={[4, 4, 0, 0]}
                  />
                  <Bar
                    dataKey="Savings"
                    fill="#3b82f6"
                    radius={[4, 4, 0, 0]}
                  />
                </BarChart>
              </ResponsiveContainer>
            </div>

            {/* Summary Cards */}
            <div className="mt-6 pt-4 border-t border-gray-200 dark:border-gray-700 grid grid-cols-2 md:grid-cols-4 gap-4">
              <div className="bg-green-50 dark:bg-green-900/20 rounded-lg p-4 text-center">
                <div className="text-sm text-green-600 dark:text-green-400">
                  Total Income
                </div>
                <div className="text-xl font-bold text-green-700 dark:text-green-300">
                  {formatCurrency(totals.totalIncome)}
                </div>
              </div>
              <div className="bg-red-50 dark:bg-red-900/20 rounded-lg p-4 text-center">
                <div className="text-sm text-red-600 dark:text-red-400">
                  Total Expenses
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
                  Total Savings
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
                  Savings Rate
                </div>
                <div
                  className={`text-xl font-bold ${
                    totals.savingsRate >= 0
                      ? "text-purple-700 dark:text-purple-300"
                      : "text-orange-700 dark:text-orange-300"
                  }`}
                >
                  {totals.savingsRate.toFixed(1)}%
                </div>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
