"use client";

import { useReportExportMetadata } from "@/hooks/useReportExportMetadata";
import { useReportingBasis } from "./ReportingBasis";
import { useState, useMemo, useRef } from "react";
import { Skeleton } from "@/components/ui/LoadingSkeleton";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
} from "recharts";
import { budgetsApi } from "@/lib/budgets";
import { useNumberFormat } from "@/hooks/useNumberFormat";
import { useDateFormat } from "@/hooks/useDateFormat";
import { useChartMonthFormat } from "@/hooks/useChartMonthFormat";
import { useTranslations } from "next-intl";
import { useReportData } from "@/hooks/useReportData";
import { ReportToolbarActions } from "@/components/reports/ReportToolbarActions";
import { ReportError } from "@/components/reports/ReportError";
import { chartColors } from "@/lib/chart-colors";
import { resolvePdfColor } from "@/components/reports/resolve-pdf-color";

export function BudgetTrendReport() {
  const { withPdfBasis } = useReportExportMetadata();
  const basis = useReportingBasis();
  const t = useTranslations("reports");
  const { formatCurrencyCompact: formatCurrency, formatPercentTrimmed } =
    useNumberFormat();
  // Two month formatters, for two different surfaces: the PDF's month COLUMN
  // follows the user's date-format preference like every other date in a table,
  // while the chart's month AXIS localizes the month name like every other
  // chart. `useChartMonthFormat` explains why swapping them is a defect.
  const { formatMonth } = useDateFormat();
  const formatChartMonth = useChartMonthFormat();
  const chartRef = useRef<HTMLDivElement>(null);
  const [selectedBudgetIdState, setSelectedBudgetId] = useState<string>("");
  const [months, setMonths] = useState(12);

  const {
    data: budgetsData,
    isLoading: budgetsLoading,
    error: budgetsError,
    reload: reloadBudgets,
  } = useReportData(
    () => budgetsApi.getAll(...(basis ? ([basis] as const) : [])),
    [basis],
    { requestKey: JSON.stringify([basis]), maskStaleData: true },
  );

  const budgets = useMemo(() => budgetsData ?? [], [budgetsData]);

  // Auto-select the active budget (or first) until the user picks one. Derived
  // during render rather than via setState-in-effect.
  const autoSelectedBudgetId = useMemo(() => {
    const active = budgets.find((b) => b.isActive);
    return active?.id ?? budgets[0]?.id ?? "";
  }, [budgets]);
  const selectedBudgetId = selectedBudgetIdState || autoSelectedBudgetId;

  const {
    data: trendResponse,
    isLoading: trendLoading,
    error: trendError,
    reload: reloadTrend,
  } = useReportData(
    () =>
      selectedBudgetId
        ? budgetsApi.getTrend(
            selectedBudgetId,
            months,
            ...(basis ? ([basis] as const) : []),
          )
        : Promise.resolve(null),
    [selectedBudgetId, months, basis],
    {
      requestKey: JSON.stringify([selectedBudgetId, months, basis]),
      maskStaleData: true,
    },
  );

  const trendData = useMemo(() => trendResponse ?? [], [trendResponse]);
  const isLoading = budgetsLoading || trendLoading;
  const error = budgetsError || trendError;
  const reload = () => {
    reloadBudgets();
    reloadTrend();
  };

  const handleExportPdf = async () => {
    const { exportToPdf } = await import("@/lib/pdf-export");
    const headers = [
      t("budgetTrend.colMonth"),
      t("budgetTrend.colBudgeted"),
      t("budgetTrend.colActual"),
      t("budgetTrend.colPercentUsed"),
    ];
    const rows = trendData.map((point) => [
      formatMonth(point.monthKey),
      formatCurrency(point.budgeted),
      formatCurrency(point.actual),
      `${formatPercentTrimmed(point.percentUsed)}`,
    ]);
    await exportToPdf(
      withPdfBasis({
        title: t("budgetTrend.pdfTitle"),
        chartContainer: chartRef.current,
        chartLegend: [
          {
            color: resolvePdfColor(chartColors.primary),
            label: t("budgetTrend.seriesBudgeted"),
          },
          {
            color: resolvePdfColor(chartColors.income),
            label: t("budgetTrend.seriesActual"),
          },
        ],
        tableData: { headers, rows },
        filename: "budget-trend",
      }),
    );
  };

  if (error) {
    return <ReportError onRetry={reload} />;
  }

  if (isLoading) {
    return (
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-6">
        <div className="space-y-4">
          <Skeleton className="h-8 w-1/3" />
          <Skeleton className="h-64 w-full" />
        </div>
      </div>
    );
  }

  if (budgets.length === 0) {
    return (
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-6 text-center">
        <p className="text-gray-500 dark:text-gray-400">
          {t("budgetTrend.noBudgets")}
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Controls */}
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-4">
        <div className="flex flex-wrap gap-3 items-center">
          <select
            value={selectedBudgetId}
            onChange={(e) => setSelectedBudgetId(e.target.value)}
            className="px-3 py-2 text-sm border border-gray-300 dark:border-gray-600 rounded-md bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100"
          >
            {budgets.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </select>
          <select
            value={months}
            onChange={(e) => setMonths(Number(e.target.value))}
            className="px-3 py-2 text-sm border border-gray-300 dark:border-gray-600 rounded-md bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100"
          >
            <option value={6}>{t("budgetTrend.months6")}</option>
            <option value={12}>{t("budgetTrend.months12")}</option>
            <option value={24}>{t("budgetTrend.months24")}</option>
          </select>
          <ReportToolbarActions onExportPdf={handleExportPdf} />
        </div>
      </div>

      {/* Chart */}
      <div
        ref={chartRef}
        className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 px-2 py-4 sm:p-6"
      >
        {trendData.length === 0 ? (
          <p className="text-gray-500 dark:text-gray-400 text-center py-8">
            {t("budgetTrend.noData")}
          </p>
        ) : (
          <>
            <div className="h-80">
              <ResponsiveContainer width="100%" height="100%" minWidth={0}>
                <LineChart data={trendData}>
                  <CartesianGrid strokeDasharray="3 3" className="opacity-30" />
                  <XAxis
                    dataKey="monthKey"
                    tick={{ fontSize: 12 }}
                    tickFormatter={(value: string) => formatChartMonth(value)}
                  />
                  <YAxis
                    tickFormatter={(v) => formatCurrency(v)}
                    tick={{ fontSize: 12 }}
                  />
                  <Tooltip
                    content={({ active, payload, label }) => {
                      if (!active || !payload || payload.length === 0)
                        return null;
                      return (
                        <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg shadow-lg p-3">
                          <p className="text-sm font-medium text-gray-900 dark:text-gray-100 mb-1">
                            {formatChartMonth(String(label))}
                          </p>
                          {payload.map((entry) => (
                            <p
                              key={entry.dataKey as string}
                              className="text-sm"
                              style={{ color: entry.color }}
                            >
                              {entry.name}:{" "}
                              {formatCurrency(entry.value as number)}
                            </p>
                          ))}
                        </div>
                      );
                    }}
                  />
                  <Legend />
                  <Line
                    type="monotone"
                    dataKey="budgeted"
                    stroke={chartColors.primary}
                    strokeWidth={2}
                    strokeDasharray="5 5"
                    dot={{ r: 4 }}
                    name={t("budgetTrend.seriesBudgeted")}
                  />
                  <Line
                    type="monotone"
                    dataKey="actual"
                    stroke={chartColors.income}
                    strokeWidth={2}
                    dot={{ r: 4 }}
                    name={t("budgetTrend.seriesActual")}
                  />
                </LineChart>
              </ResponsiveContainer>
            </div>

            {/* Summary stats */}
            <div className="mt-6 grid grid-cols-2 md:grid-cols-4 gap-4">
              {(() => {
                const avgBudgeted =
                  trendData.reduce((s, p) => s + p.budgeted, 0) /
                  trendData.length;
                const avgActual =
                  trendData.reduce((s, p) => s + p.actual, 0) /
                  trendData.length;
                const avgVariance = avgActual - avgBudgeted;
                const improving =
                  trendData.length >= 2 &&
                  trendData[trendData.length - 1].percentUsed <
                    trendData[0].percentUsed;
                return (
                  <>
                    <div className="text-center">
                      <p className="text-xs text-gray-500 dark:text-gray-400">
                        {t("budgetTrend.avgBudgeted")}
                      </p>
                      <p className="text-lg font-semibold text-gray-900 dark:text-gray-100">
                        {formatCurrency(avgBudgeted)}
                      </p>
                    </div>
                    <div className="text-center">
                      <p className="text-xs text-gray-500 dark:text-gray-400">
                        {t("budgetTrend.avgActual")}
                      </p>
                      <p className="text-lg font-semibold text-gray-900 dark:text-gray-100">
                        {formatCurrency(avgActual)}
                      </p>
                    </div>
                    <div className="text-center">
                      <p className="text-xs text-gray-500 dark:text-gray-400">
                        {t("budgetTrend.avgVariance")}
                      </p>
                      <p
                        className={`text-lg font-semibold ${avgVariance > 0 ? "text-red-600 dark:text-red-400" : "text-green-600 dark:text-green-400"}`}
                      >
                        {avgVariance > 0 ? "+" : ""}
                        {formatCurrency(avgVariance)}
                      </p>
                    </div>
                    <div className="text-center">
                      <p className="text-xs text-gray-500 dark:text-gray-400">
                        {t("budgetTrend.trend")}
                      </p>
                      <p
                        className={`text-lg font-semibold ${improving ? "text-green-600 dark:text-green-400" : "text-red-600 dark:text-red-400"}`}
                      >
                        {improving
                          ? t("budgetTrend.improving")
                          : t("budgetTrend.worsening")}
                      </p>
                    </div>
                  </>
                );
              })()}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
