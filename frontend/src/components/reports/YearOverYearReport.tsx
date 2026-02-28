"use client";

import { useState, useEffect, useMemo, useCallback } from "react";
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
import { CHART_COLOURS } from "@/lib/chart-colours";
import { createLogger } from "@/lib/logger";

const logger = createLogger("YearOverYearReport");

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
  const { formatCurrencyCompact: formatCurrency, formatCurrencyAxis } =
    useNumberFormat();
  const [yearData, setYearData] = useState<YearData[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [yearsToCompare, setYearsToCompare] = useState(2);
  const [metric, setMetric] = useState<"expenses" | "income" | "savings">(
    "expenses",
  );

  const years = useMemo(() => yearData.map((yd) => yd.year), [yearData]);

  const loadData = useCallback(async () => {
    setIsLoading(true);
    try {
      const response = await builtInReportsApi.getYearOverYear(yearsToCompare);
      setYearData(response.data);
    } catch (error) {
      logger.error("Failed to load data:", error);
    } finally {
      setIsLoading(false);
    }
  }, [yearsToCompare]);

  useEffect(() => {
    loadData();
  }, [loadData]);

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
          <div className="flex gap-2">
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

      {/* Monthly Comparison Chart */}
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-6">
        <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-4">
          Monthly {metric.charAt(0).toUpperCase() + metric.slice(1)} Comparison
        </h3>
        <div className="h-96">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart
              data={chartData}
              margin={{ top: 20, right: 30, left: 20, bottom: 5 }}
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
                  onClick={(data: { name: string }) =>
                    handleBarClick(year, data)
                  }
                />
              ))}
            </BarChart>
          </ResponsiveContainer>
        </div>
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
                            ({changePercent >= 0 ? "+" : ""}
                            {changePercent.toFixed(1)}%)
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
