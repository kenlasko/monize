"use client";

import { useReportExportMetadata } from '@/hooks/useReportExportMetadata';
import { useReportingBasis, useReportingRouter } from './ReportingBasis';
import { useState, useMemo, useRef } from "react";
import { useTranslations } from "next-intl";
import { Skeleton } from '@/components/ui/LoadingSkeleton';

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
import { useChartDateFormat } from "@/hooks/useChartDateFormat";
import { useSortableTable, compareValues } from "@/hooks/useSortableTable";
import { chartColors, chartSeriesColor } from "@/lib/chart-colors";
import { resolvePdfColor } from "@/components/reports/resolve-pdf-color";
import { ReportToolbarActions } from '@/components/reports/ReportToolbarActions';
import { ChartViewToggle } from "@/components/ui/ChartViewToggle";
import { SortableHeader } from "@/components/ui/SortableHeader";
import { useReportData } from "@/hooks/useReportData";
import { ReportError } from "@/components/reports/ReportError";
import { PartialDataNotice } from "@/components/reports/PartialDataNotice";
import { PartialTotal } from "@/components/ui/PartialTotal";
import { UnknownAmount } from "@/components/ui/UnknownAmount";
import { reportTotal, type ConvertedTotal } from "@/lib/currency-total";

type YearOverYearSortField = string; // 'name' or any year as a string

type YearMetric = "income" | "expenses" | "savings";

/** The `known*` sibling the server sends beside each year total. */
const KNOWN_FIELD = {
  income: "knownIncome",
  expenses: "knownExpenses",
  savings: "knownSavings",
} as const;

/**
 * One year's figure for one metric: the part that converted, whether the server
 * knew the whole, and what to mark it with. A year's total is `null` when a row
 * of THAT year could not be converted, and another year's gap does not blank
 * it -- so a change between two years is a number only when both are known.
 */
interface YearMetricTotal {
  /** False when the server withheld the total (`null`). */
  known: boolean;
  total: ConvertedTotal;
}

/**
 * The transactions range a clicked month bar links to, or `null` when the datum
 * does not name a month.
 *
 * `payload` is optional on recharts' `BarRectangleItem`, so a click can arrive
 * without one and `Number(undefined)` is NaN -- which passes a bare
 * `< 0 || > 11` range check and makes `new Date(year, NaN, 1)` an Invalid Date
 * that `format` throws on. `Number.isInteger` rejects it. Exported because the
 * throw happens inside a React event handler, where the test harness swallows
 * it: only a direct call can hold this rule.
 */
export function monthClickRange(
  year: number,
  monthIndex: number,
): { startDate: string; endDate: string } | null {
  if (!Number.isInteger(monthIndex) || monthIndex < 0 || monthIndex > 11) {
    return null;
  }
  return {
    startDate: `${year}-${String(monthIndex + 1).padStart(2, "0")}-01`,
    endDate: format(endOfMonth(new Date(year, monthIndex, 1)), "yyyy-MM-dd"),
  };
}

interface YearOverYearTooltipProps {
  active?: boolean;
  payload?: Array<{ name: string; value: number; color: string }>;
  label?: string;
  formatCurrency: (value: number) => string;
}

function YearOverYearTooltip({ active, payload, label, formatCurrency }: YearOverYearTooltipProps) {
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
}

export function YearOverYearReport() {
  const { exportCsvWithBasis, withPdfBasis } = useReportExportMetadata();
  const basis = useReportingBasis();
  const t = useTranslations('reports');
  const router = useReportingRouter();
  const { formatCurrencyCompact: formatCurrency, formatCurrencyAxis, formatSignedPercent, defaultCurrency } =
    useNumberFormat();
  const tCommon = useTranslations('common');
  const formatChartDate = useChartDateFormat();
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
    () => builtInReportsApi.getYearOverYear(yearsToCompare, ...(basis ? [basis] as const : [])),
    [yearsToCompare, basis],
    { requestKey: JSON.stringify([yearsToCompare, basis]), maskStaleData: true },
  );

  const yearData = useMemo<YearData[]>(() => response?.data ?? [], [response]);

  const years = useMemo(() => yearData.map((yd) => yd.year), [yearData]);

  const chartData = useMemo(() => {
    return Array.from({ length: 12 }, (_, monthIndex) => {
      const data: { name: string; monthIndex: number; [key: string]: number | string } = {
        name: formatChartDate(new Date(2000, monthIndex, 1), 'MMM'),
        monthIndex,
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
  }, [yearData, metric, formatChartDate]);

  const sortedTableData = useMemo(() => {
    const sorted = [...chartData];
    sorted.sort((a, b) => {
      let comparison = 0;
      if (sortField === 'name') {
        // Default to calendar order for the month column
        comparison = compareValues(a.monthIndex, b.monthIndex);
      } else {
        comparison = compareValues(a[sortField] as number, b[sortField] as number);
      }
      return sortDirection === 'asc' ? comparison : -comparison;
    });
    return sorted;
  }, [chartData, sortField, sortDirection]);

  const yearTotals = useMemo(() => {
    const totals: Record<number, Record<YearMetric, YearMetricTotal>> = {};
    const metricOf = (yd: YearData, m: YearMetric): YearMetricTotal => {
      const exact = yd.totals[m];
      // A total the server withheld is shown as the part that converted, marked
      // with the response's own gaps; a total it sent is complete.
      return exact === null
        ? { known: false, total: reportTotal(yd.totals[KNOWN_FIELD[m]], response) }
        : { known: true, total: { value: exact, missingCurrencies: [], excludedCount: 0 } };
    };

    yearData.forEach((yd) => {
      totals[yd.year] = {
        income: metricOf(yd, "income"),
        expenses: metricOf(yd, "expenses"),
        savings: metricOf(yd, "savings"),
      };
    });

    return totals;
  }, [yearData, response]);
  const reportingCurrency = response?.currency ?? defaultCurrency;
  const valueOf = (year: number, m: YearMetric) => yearTotals[year]?.[m].total.value ?? 0;
  const totalOf = (year: number, m: YearMetric): ConvertedTotal =>
    yearTotals[year]?.[m].total ?? { value: 0, missingCurrencies: [], excludedCount: 0 };
  const isKnown = (year: number, m: YearMetric) => yearTotals[year]?.[m].known ?? true;
  // A figure in a file or an image has no tooltip, so the text itself carries
  // the marker.
  const moneyText = (year: number, m: YearMetric) =>
    isKnown(year, m)
      ? formatCurrency(valueOf(year, m))
      : `${formatCurrency(valueOf(year, m))} ${tCommon("partialTotal.srSuffix")}`;

  const handleBarClick = (year: number, monthIndex: number) => {
    const range = monthClickRange(year, monthIndex);
    if (!range) return;
    router.push(
      `/transactions?startDate=${range.startDate}&endDate=${range.endDate}`,
    );
  };

  const handleExportPdf = async () => {
    const { exportToPdf } = await import("@/lib/pdf-export");

    const cards = years.map((year, index) => ({
      label: String(year),
      value: moneyText(year, metric),
      color: resolvePdfColor(chartSeriesColor(index)),
    }));

    // Build YoY change table
    const tableHeaders = [t('yearOverYear.colMetric'), ...years.slice(1).map((year, index) => t('yearOverYear.yearsCompare', { prevYear: years[index], year }))];
    const tableRows = (["income", "expenses", "savings"] as const).map((m) => {
      const label = t(`yearOverYear.${m}`);
      const cells = years.slice(1).map((_year, index) => {
        // The change between two years is a number only when both are known.
        if (!isKnown(years[index], m) || !isKnown(_year, m)) return tCommon("unknownAmount.marker");
        const prevValue = valueOf(years[index], m);
        const currValue = valueOf(_year, m);
        const change = currValue - prevValue;
        const changePercent = prevValue !== 0 ? (change / Math.abs(prevValue)) * 100 : 0;
        return `${change >= 0 ? "+" : ""}${formatCurrency(change)} (${formatSignedPercent(changePercent, 1)})`;
      });
      return [label, ...cells];
    });

    // Build yearly summary table
    const summaryHeaders = [t('yearOverYear.pdfColYear'), t('yearOverYear.pdfColIncome'), t('yearOverYear.pdfColExpenses'), t('yearOverYear.pdfColNet')];
    const summaryRows = years.map((year) => [
      String(year),
      moneyText(year, "income"),
      moneyText(year, "expenses"),
      moneyText(year, "savings"),
    ]);

    await exportToPdf(withPdfBasis({
      title: t('yearOverYear.pdfTitle'),
      subtitle: `${t(`yearOverYear.${metric}`)} | ${years[0]} - ${years[years.length - 1]}`,
      summaryCards: cards,
      chartContainer: chartRef.current,
      tableData: years.length >= 2 ? { headers: tableHeaders, rows: tableRows } : undefined,
      additionalTables: [{
        title: t('yearOverYear.pdfYearlySummaryTitle'),
        headers: summaryHeaders,
        rows: summaryRows,
      }],
      filename: "year-over-year",
    }));
  };

  const handleExportCsv = () => {
    const headers = [t('yearOverYear.colMonth'), ...years.map(String)];
    const rows = sortedTableData.map((row) => [
      row.name,
      ...years.map((year) => Number(row[year]) || 0),
    ]);
    exportCsvWithBasis(`year-over-year-${metric}`, headers, rows);
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
              {t('yearOverYear.compareLabel')}
            </label>
            <select
              value={yearsToCompare}
              onChange={(e) => setYearsToCompare(Number(e.target.value))}
              className="rounded-md border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100 text-sm font-sans"
            >
              <option value={2} className="font-sans">
                {t('yearOverYear.years2')}
              </option>
              <option value={3} className="font-sans">
                {t('yearOverYear.years3')}
              </option>
              <option value={4} className="font-sans">
                {t('yearOverYear.years4')}
              </option>
              <option value={5} className="font-sans">
                {t('yearOverYear.years5')}
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
                {t(`yearOverYear.${m}`)}
              </button>
            ))}
          </div>
          {/* `ml-auto` from `sm` up only. On a phone the groups wrap onto
              lines of their own, and pushing this one to the right edge left it
              hanging under two left-aligned rows; on one line it is still the
              trailing group. */}
          <div className="flex items-center gap-3 sm:ml-auto">
            <ChartViewToggle
              value={viewType}
              onChange={(v) => setViewType(v as 'bar' | 'table')}
              options={['bar', 'table']}
            />
          </div>
          <ReportToolbarActions
            onExportPdf={handleExportPdf}
            onExportCsv={handleExportCsv}
            disabled={chartData.length === 0}
          />
        </div>
      </div>

      <PartialDataNotice
        missingCurrencies={response?.missingCurrencies ?? []}
        excludedCount={response?.excludedCount ?? 0}
        displayCurrency={reportingCurrency}
      />

      {/* Year Summary Cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-5 gap-4">
        {years.map((year, index) => (
          <div
            key={year}
            className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-4"
            style={{
              borderLeft: `4px solid ${chartSeriesColor(index)}`,
            }}
          >
            <div className="text-lg font-bold text-gray-900 dark:text-gray-100">
              {year}
            </div>
            <div className="mt-2 space-y-1 text-sm">
              <div className="flex justify-between">
                <span className="text-gray-500 dark:text-gray-400">{t('yearOverYear.income')}</span>
                <span className="text-green-600 dark:text-green-400">
                  <PartialTotal total={totalOf(year, "income")} displayCurrency={reportingCurrency}>
                    {formatCurrency(valueOf(year, "income"))}
                  </PartialTotal>
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-500 dark:text-gray-400">
                  {t('yearOverYear.expenses')}
                </span>
                <span className="text-red-600 dark:text-red-400">
                  <PartialTotal total={totalOf(year, "expenses")} displayCurrency={reportingCurrency}>
                    {formatCurrency(valueOf(year, "expenses"))}
                  </PartialTotal>
                </span>
              </div>
              <div className="flex justify-between pt-1 border-t border-gray-200 dark:border-gray-700">
                <span className="text-gray-500 dark:text-gray-400">{t('yearOverYear.net')}</span>
                <span
                  className={
                    valueOf(year, "savings") >= 0
                      ? "text-blue-600 dark:text-blue-400"
                      : "text-orange-600 dark:text-orange-400"
                  }
                >
                  <PartialTotal total={totalOf(year, "savings")} displayCurrency={reportingCurrency}>
                    {formatCurrency(valueOf(year, "savings"))}
                  </PartialTotal>
                </span>
              </div>
            </div>
          </div>
        ))}
      </div>

      {/* Monthly Comparison Chart or Table */}
      <div ref={chartRef} className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 px-2 py-4 sm:p-6">
        <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-4">
          {t('yearOverYear.monthlyComparisonTitle', { metric: t(`yearOverYear.${metric}`) })}
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
                    {t('yearOverYear.colMonth')}
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
                      <span style={{ color: chartSeriesColor(index) }}>{year}</span>
                    </SortableHeader>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-200 dark:divide-gray-700">
                {sortedTableData.map((row) => (
                  <tr key={row.monthIndex} className="hover:bg-gray-50 dark:hover:bg-gray-700/50">
                    <td className="px-4 py-3 text-sm font-medium text-gray-900 dark:text-gray-100">
                      {row.name}
                    </td>
                    {years.map((year) => {
                      const value = Number(row[year]) || 0;
                      return (
                        <td
                          key={year}
                          className="px-4 py-3 text-right text-sm text-gray-900 dark:text-gray-100 cursor-pointer"
                          onClick={() => handleBarClick(year, row.monthIndex)}
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
                  <td className="px-4 py-3 text-sm font-bold text-gray-900 dark:text-gray-100">{t('yearOverYear.total')}</td>
                  {years.map((year) => (
                    <td key={year} className="px-4 py-3 text-right text-sm font-bold text-gray-900 dark:text-gray-100">
                      <PartialTotal total={totalOf(year, metric)} displayCurrency={reportingCurrency}>
                        {formatCurrency(valueOf(year, metric))}
                      </PartialTotal>
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
                <CartesianGrid strokeDasharray="3 3" stroke={chartColors.grid} />
                <XAxis dataKey="name" tick={{ fontSize: 12 }} />
                <YAxis
                  tickFormatter={formatCurrencyAxis}
                  tick={{ fontSize: 12 }}
                />
                <Tooltip content={<YearOverYearTooltip formatCurrency={formatCurrency} />} />
                <Legend />
                {years.map((year, index) => (
                  <Bar
                    key={year}
                    dataKey={`${year}`}
                    fill={chartSeriesColor(index)}
                    radius={[4, 4, 0, 0]}
                    name={`${year}`}
                    cursor="pointer"
                    onClick={(data) =>
                      handleBarClick(year, Number(data.payload?.monthIndex))
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
            {t('yearOverYear.yearOverYearChange')}
          </h3>
          <div className="overflow-x-auto">
            <table className="min-w-full">
              <thead>
                <tr className="border-b border-gray-200 dark:border-gray-700">
                  <th className="py-2 px-4 text-left text-sm font-medium text-gray-500 dark:text-gray-400">
                    {t('yearOverYear.colMetric')}
                  </th>
                  {years.slice(1).map((year, index) => (
                    <th
                      key={year}
                      className="py-2 px-4 text-right text-sm font-medium text-gray-500 dark:text-gray-400"
                    >
                      {t('yearOverYear.yearsCompare', { prevYear: years[index], year })}
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
                      {t(`yearOverYear.${m}`)}
                    </td>
                    {years.slice(1).map((year, index) => {
                      const prevYear = years[index];
                      // The change over a year whose total is unknown is not a
                      // number: the known parts of two years differ by what each
                      // left out, not by what the reader earned or spent.
                      if (!isKnown(prevYear, m) || !isKnown(year, m)) {
                        return (
                          <td key={year} className="py-3 px-4 text-right">
                            <UnknownAmount reason="displayFx" />
                          </td>
                        );
                      }
                      const prevValue = valueOf(prevYear, m);
                      const currValue = valueOf(year, m);
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
