'use client';

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Skeleton } from '@/components/ui/LoadingSkeleton';
import { builtInReportsApi } from '@/lib/built-in-reports';
import { MonthlyBreakdownCategoryRow } from '@/types/built-in-reports';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import { useDateRange } from '@/hooks/useDateRange';
import { useReportData } from '@/hooks/useReportData';
import { DateRangeSelector } from '@/components/ui/DateRangeSelector';
import { ReportError } from '@/components/reports/ReportError';

// Deviation thresholds (fraction of the non-zero average) mirroring yaffa.
const DEVIATION_LEVEL_1 = 0.05;
const DEVIATION_LEVEL_2 = 0.1;
const DEVIATION_LEVEL_3 = 0.15;

// Minimum non-zero months before deviation highlighting kicks in.
const MIN_NON_ZERO_FOR_DEVIATION = 3;

/**
 * Rotating palette for section headers and subtotal rows. Each entry pairs a
 * header background/text class set with a subtotal accent border so adjacent
 * parent groups stay visually distinct (translated from yaffa's Bootstrap
 * s-section-N classes to Tailwind, dark-mode aware).
 */
const SECTION_PALETTE = [
  'bg-blue-50 text-blue-800 dark:bg-blue-900/30 dark:text-blue-200',
  'bg-orange-50 text-orange-800 dark:bg-orange-900/30 dark:text-orange-200',
  'bg-green-50 text-green-800 dark:bg-green-900/30 dark:text-green-200',
  'bg-teal-50 text-teal-800 dark:bg-teal-900/30 dark:text-teal-200',
  'bg-purple-50 text-purple-800 dark:bg-purple-900/30 dark:text-purple-200',
  'bg-pink-50 text-pink-800 dark:bg-pink-900/30 dark:text-pink-200',
  'bg-amber-50 text-amber-800 dark:bg-amber-900/30 dark:text-amber-200',
  'bg-cyan-50 text-cyan-800 dark:bg-cyan-900/30 dark:text-cyan-200',
];
const OTHER_PALETTE =
  'bg-gray-100 text-gray-700 dark:bg-gray-700/50 dark:text-gray-200';

// Deviation cell background classes. "high" = above average, "low" = below.
const DEVIATION_CLASS: Record<string, string> = {
  'high-1': 'bg-red-50 dark:bg-red-900/20',
  'high-2': 'bg-red-100 dark:bg-red-900/40',
  'high-3': 'bg-red-200 dark:bg-red-900/60',
  'low-1': 'bg-green-50 dark:bg-green-900/20',
  'low-2': 'bg-green-100 dark:bg-green-900/40',
  'low-3': 'bg-green-200 dark:bg-green-900/60',
};

interface ProcessedRow {
  categoryId: string | null;
  displayName: string;
  isIncome: boolean;
  values: Record<string, number>;
  total: number;
  avg: number;
  nonZeroAvg: number;
  nonZeroCount: number;
}

interface Section {
  title: string;
  paletteClass: string;
  rows: ProcessedRow[];
  subtotals: Record<string, number>;
  subtotalSum: number;
  subtotalAvg: number;
  allCategoryIds: string[];
  isIncome: boolean;
}

const SCALE = 10000;
function roundMoney(value: number): number {
  return Math.round(value * SCALE) / SCALE;
}
function sumMoney(values: number[]): number {
  const units = values.reduce(
    (acc, v) => acc + (Number.isFinite(v) ? Math.round(v * SCALE) : 0),
    0,
  );
  return units / SCALE;
}

function processGroup(
  rows: MonthlyBreakdownCategoryRow[],
  months: string[],
  monthCount: number,
): Omit<Section, 'title' | 'paletteClass' | 'isIncome'> {
  const processed: ProcessedRow[] = rows
    .map((row) => {
      const total = sumMoney(months.map((m) => row.valuesByMonth[m] || 0));
      const nonZeroCount = months.filter(
        (m) => (row.valuesByMonth[m] || 0) !== 0,
      ).length;
      const avg = nonZeroCount > 0 ? total / monthCount : 0;
      const nonZeroAvg = nonZeroCount > 0 ? total / nonZeroCount : 0;
      return {
        categoryId: row.categoryId,
        displayName: row.categoryName,
        isIncome: row.isIncome,
        values: row.valuesByMonth,
        total: roundMoney(total),
        avg: roundMoney(avg),
        nonZeroAvg,
        nonZeroCount,
      };
    })
    .sort((a, b) => b.total - a.total);

  const subtotals: Record<string, number> = {};
  for (const m of months) {
    subtotals[m] = sumMoney(processed.map((r) => r.values[m] || 0));
  }
  const subtotalSum = sumMoney(processed.map((r) => r.total));
  const subtotalAvg = roundMoney(subtotalSum / monthCount);
  const allCategoryIds = processed
    .map((r) => r.categoryId)
    .filter((id): id is string => id != null);

  return { rows: processed, subtotals, subtotalSum, subtotalAvg, allCategoryIds };
}

function deviationClass(
  value: number,
  avg: number,
  nonZeroCount: number,
  isIncome: boolean,
): string {
  if (nonZeroCount < MIN_NON_ZERO_FOR_DEVIATION || value === 0 || avg === 0) {
    return '';
  }
  const deviation = (value - avg) / avg;
  // For expenses, above average is bad (red); for income, above is good (green).
  const above = isIncome ? 'low' : 'high';
  const below = isIncome ? 'high' : 'low';

  if (deviation > DEVIATION_LEVEL_3) return DEVIATION_CLASS[`${above}-3`];
  if (deviation > DEVIATION_LEVEL_2) return DEVIATION_CLASS[`${above}-2`];
  if (deviation > DEVIATION_LEVEL_1) return DEVIATION_CLASS[`${above}-1`];
  if (deviation < -DEVIATION_LEVEL_3) return DEVIATION_CLASS[`${below}-3`];
  if (deviation < -DEVIATION_LEVEL_2) return DEVIATION_CLASS[`${below}-2`];
  if (deviation < -DEVIATION_LEVEL_1) return DEVIATION_CLASS[`${below}-1`];
  return '';
}

function formatMonthHeader(month: string): string {
  const [year, mon] = month.split('-');
  return `${mon}.${year}`;
}

export function MonthlyCategoryBreakdownReport() {
  const router = useRouter();
  const { formatCurrency } = useNumberFormat();
  const [showPercentages, setShowPercentages] = useState(false);
  const {
    dateRange,
    setDateRange,
    startDate,
    setStartDate,
    endDate,
    setEndDate,
    resolvedRange,
    isValid,
  } = useDateRange({ defaultRange: '6m' });

  const { start: rangeStart, end: rangeEnd } = resolvedRange;

  const { data, isLoading, error, reload } = useReportData(
    () =>
      isValid
        ? builtInReportsApi.getMonthlyCategoryBreakdown({
            startDate: rangeStart || undefined,
            endDate: rangeEnd,
          })
        : Promise.resolve(null),
    [isValid, rangeStart, rangeEnd],
  );

  const currency = data?.currency;

  const model = useMemo(() => {
    if (!data) return null;
    const months = data.months;
    const monthCount = months.length || 1;
    const rows = data.data;

    // Group categories by parent name; parentless categories go to "Other".
    const groups = new Map<string, MonthlyBreakdownCategoryRow[]>();
    const noParent: MonthlyBreakdownCategoryRow[] = [];
    for (const row of rows) {
      if (row.parentName) {
        const list = groups.get(row.parentName) || [];
        groups.set(row.parentName, [...list, row]);
      } else {
        noParent.push(row);
      }
    }

    // Pre-compute parent totals to sort sections by magnitude descending.
    const parentTotals = new Map<string, number>();
    for (const [parentName, list] of groups) {
      parentTotals.set(
        parentName,
        sumMoney(
          list.flatMap((r) => months.map((m) => r.valuesByMonth[m] || 0)),
        ),
      );
    }
    const sortedParents = Array.from(groups.keys()).sort(
      (a, b) => (parentTotals.get(b) || 0) - (parentTotals.get(a) || 0),
    );

    const sections: Section[] = [];
    sortedParents.forEach((parentName, idx) => {
      const list = groups.get(parentName)!;
      const group = processGroup(list, months, monthCount);
      sections.push({
        title: parentName,
        paletteClass: SECTION_PALETTE[idx % SECTION_PALETTE.length],
        isIncome: list.every((r) => r.isIncome),
        ...group,
      });
    });
    if (noParent.length > 0) {
      const group = processGroup(noParent, months, monthCount);
      sections.push({
        title: "Other expenses",
        paletteClass: OTHER_PALETTE,
        isIncome: noParent.every((r) => r.isIncome),
        ...group,
      });
    }

    // Monthly grand totals, split by income vs expense classification.
    const monthlyExpenses: Record<string, number> = {};
    const monthlyIncome: Record<string, number> = {};
    for (const m of months) {
      monthlyExpenses[m] = sumMoney(
        rows.filter((r) => !r.isIncome).map((r) => r.valuesByMonth[m] || 0),
      );
      monthlyIncome[m] = sumMoney(
        rows.filter((r) => r.isIncome).map((r) => r.valuesByMonth[m] || 0),
      );
    }
    const totalExpensesSum = sumMoney(Object.values(monthlyExpenses));
    const totalIncomeSum = sumMoney(Object.values(monthlyIncome));
    const totalExpensesAvg = roundMoney(totalExpensesSum / monthCount);
    const totalIncomeAvg = roundMoney(totalIncomeSum / monthCount);
    const monthlyBalance: Record<string, number> = {};
    for (const m of months) {
      monthlyBalance[m] = roundMoney(
        (monthlyIncome[m] || 0) - (monthlyExpenses[m] || 0),
      );
    }
    const balanceSum = roundMoney(totalIncomeSum - totalExpensesSum);
    const balanceAvg = roundMoney(balanceSum / monthCount);

    return {
      months,
      sections,
      monthlyExpenses,
      monthlyIncome,
      totalExpensesSum,
      totalIncomeSum,
      totalExpensesAvg,
      totalIncomeAvg,
      monthlyBalance,
      balanceSum,
      balanceAvg,
    };
  }, [data]);

  const lastDayOfMonth = (month: string): string => {
    const [year, mon] = month.split('-').map(Number);
    const lastDay = new Date(year, mon, 0).getDate();
    return `${year}-${String(mon).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;
  };

  const drillDown = (month: string, categoryIds: string[]) => {
    const ids = Array.from(new Set(categoryIds));
    if (ids.length === 0) return;
    const start = `${month}-01`;
    const end = lastDayOfMonth(month);
    const params = new URLSearchParams({
      categoryIds: ids.join(','),
      startDate: start,
      endDate: end,
    });
    router.push(`/transactions?${params.toString()}`);
  };

  // Render a single signed amount cell value (or a percentage in percent mode).
  const formatCell = (
    value: number,
    monthTotal: number,
    isIncome: boolean | null,
  ): string => {
    if (value === 0) return '—';
    const normalized = isIncome === null ? value : isIncome ? value : -value;
    const sign = normalized > 0 ? '+' : '-';
    if (showPercentages && monthTotal > 0) {
      const pct = (Math.abs(normalized) / monthTotal) * 100;
      return `${sign}${pct.toFixed(1)}%`;
    }
    return `${sign} ${formatCurrency(Math.abs(normalized), currency)}`;
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

  const months = model?.months ?? [];
  const hasData = model != null && model.sections.length > 0 && months.length > 0;
  const colSpan = months.length + 3;

  return (
    <div className="space-y-6">
      {/* Controls */}
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-4">
        <div className="flex flex-wrap gap-4 items-center justify-between">
          <DateRangeSelector
            ranges={['3m', '6m', '1y', 'ytd']}
            value={dateRange}
            onChange={setDateRange}
            showCustom
            customStartDate={startDate}
            onCustomStartDateChange={setStartDate}
            customEndDate={endDate}
            onCustomEndDateChange={setEndDate}
          />
          <label className="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300 cursor-pointer">
            <input
              type="checkbox"
              checked={showPercentages}
              onChange={(e) => setShowPercentages(e.target.checked)}
              className="rounded border-gray-300 dark:border-gray-600"
            />
            {"Show percentages"}
          </label>
        </div>
      </div>

      {/* Table */}
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 px-2 py-4 sm:p-6">
        {!hasData ? (
          <p className="text-gray-500 dark:text-gray-400 text-center py-8">
            {"No data for this period."}
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full text-xs border-collapse">
              <thead>
                <tr className="text-gray-500 dark:text-gray-400">
                  <th className="sticky left-0 z-10 bg-white dark:bg-gray-800 px-2 py-2 text-left font-medium min-w-[180px]">
                    {"Category"}
                  </th>
                  {months.map((m) => (
                    <th key={m} className="px-2 py-2 text-right font-medium whitespace-nowrap">
                      {formatMonthHeader(m)}
                    </th>
                  ))}
                  <th className="px-2 py-2 text-right font-medium">
                    {"Total"}
                  </th>
                  <th className="px-2 py-2 text-right font-medium">
                    {"Avg/month"}
                  </th>
                </tr>
              </thead>
              <tbody>
                {model!.sections.map((section, si) => {
                  const sectionMonthTotal = (m: string) =>
                    section.isIncome ? model!.monthlyIncome[m] : model!.monthlyExpenses[m];
                  const sectionSum = section.isIncome ? model!.totalIncomeSum : model!.totalExpensesSum;
                  const sectionAvg = section.isIncome ? model!.totalIncomeAvg : model!.totalExpensesAvg;
                  return (
                    <tbody key={`section-${si}`} className="contents">
                      {/* Section header */}
                      <tr>
                        <td colSpan={colSpan} className={`px-2 py-1.5 font-semibold ${section.paletteClass}`}>
                          {section.title}
                        </td>
                      </tr>
                      {/* Category rows */}
                      {section.rows.map((row) => (
                        <tr key={row.categoryId || row.displayName} className="hover:bg-gray-50 dark:hover:bg-gray-700/40">
                          <td
                            className="sticky left-0 z-10 bg-white dark:bg-gray-800 px-2 py-1 text-gray-900 dark:text-gray-100 truncate max-w-[220px]"
                            title={row.displayName}
                          >
                            {row.displayName}
                          </td>
                          {months.map((m) => {
                            const value = row.values[m] || 0;
                            const cls = deviationClass(value, row.nonZeroAvg, row.nonZeroCount, row.isIncome);
                            return (
                              <td key={m} className={`px-2 py-1 text-right ${cls}`}>
                                {value !== 0 && row.categoryId ? (
                                  <button
                                    type="button"
                                    onClick={() => drillDown(m, [row.categoryId!])}
                                    className="hover:underline"
                                  >
                                    {formatCell(value, sectionMonthTotal(m), row.isIncome)}
                                  </button>
                                ) : value !== 0 ? (
                                  formatCell(value, sectionMonthTotal(m), row.isIncome)
                                ) : (
                                  <span className="text-gray-300 dark:text-gray-600">—</span>
                                )}
                              </td>
                            );
                          })}
                          <td className="px-2 py-1 text-right font-semibold text-gray-900 dark:text-gray-100">
                            {formatCell(row.total, sectionSum, row.isIncome)}
                          </td>
                          <td className="px-2 py-1 text-right text-gray-700 dark:text-gray-300">
                            {formatCell(row.avg, sectionAvg, row.isIncome)}
                          </td>
                        </tr>
                      ))}
                      {/* Section subtotal */}
                      <tr className="font-bold bg-gray-50 dark:bg-gray-900/40 border-t-2 border-gray-300 dark:border-gray-600">
                        <td className="sticky left-0 z-10 bg-gray-50 dark:bg-gray-900/40 px-2 py-1 truncate" title={`${"Subtotal"}: ${section.title}`}>
                          {"Subtotal"}: {section.title}
                        </td>
                        {months.map((m) => {
                          const value = section.subtotals[m] || 0;
                          return (
                            <td key={m} className="px-2 py-1 text-right">
                              {value !== 0 ? (
                                <button
                                  type="button"
                                  onClick={() => drillDown(m, section.allCategoryIds)}
                                  className="hover:underline"
                                >
                                  {formatCell(value, sectionMonthTotal(m), section.isIncome)}
                                </button>
                              ) : (
                                <span className="text-gray-300 dark:text-gray-600">—</span>
                              )}
                            </td>
                          );
                        })}
                        <td className="px-2 py-1 text-right">
                          {formatCell(section.subtotalSum, sectionSum, section.isIncome)}
                        </td>
                        <td className="px-2 py-1 text-right">
                          {formatCell(section.subtotalAvg, sectionAvg, section.isIncome)}
                        </td>
                      </tr>
                    </tbody>
                  );
                })}

                {/* Grand summary */}
                <tr>
                  <td colSpan={colSpan} className="px-2 py-1.5 font-semibold bg-gray-200 text-gray-900 dark:bg-gray-700 dark:text-gray-100">
                    {"Summary"}
                  </td>
                </tr>
                <tr className="font-bold bg-gray-100 dark:bg-gray-900/50 border-t-2 border-gray-400 dark:border-gray-500">
                  <td className="sticky left-0 z-10 bg-gray-100 dark:bg-gray-900/50 px-2 py-1">
                    {"Total expenses"}
                  </td>
                  {months.map((m) => (
                    <td key={m} className="px-2 py-1 text-right">
                      {formatGrand(model!.monthlyExpenses[m] || 0, false, formatCurrency, currency)}
                    </td>
                  ))}
                  <td className="px-2 py-1 text-right">
                    {formatGrand(model!.totalExpensesSum, false, formatCurrency, currency)}
                  </td>
                  <td className="px-2 py-1 text-right">
                    {formatGrand(model!.totalExpensesAvg, false, formatCurrency, currency)}
                  </td>
                </tr>
                <tr className="font-bold bg-gray-100 dark:bg-gray-900/50">
                  <td className="sticky left-0 z-10 bg-gray-100 dark:bg-gray-900/50 px-2 py-1">
                    {"Total income"}
                  </td>
                  {months.map((m) => (
                    <td key={m} className="px-2 py-1 text-right text-green-600 dark:text-green-400">
                      {formatGrand(model!.monthlyIncome[m] || 0, true, formatCurrency, currency)}
                    </td>
                  ))}
                  <td className="px-2 py-1 text-right text-green-600 dark:text-green-400">
                    {formatGrand(model!.totalIncomeSum, true, formatCurrency, currency)}
                  </td>
                  <td className="px-2 py-1 text-right text-green-600 dark:text-green-400">
                    {formatGrand(model!.totalIncomeAvg, true, formatCurrency, currency)}
                  </td>
                </tr>
                <tr className="font-bold bg-gray-100 dark:bg-gray-900/50">
                  <td className="sticky left-0 z-10 bg-gray-100 dark:bg-gray-900/50 px-2 py-1">
                    {"Balance"}
                  </td>
                  {months.map((m) => {
                    const bal = model!.monthlyBalance[m] || 0;
                    return (
                      <td key={m} className={`px-2 py-1 text-right ${bal >= 0 ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'}`}>
                        {formatGrand(bal, null, formatCurrency, currency)}
                      </td>
                    );
                  })}
                  <td className={`px-2 py-1 text-right ${model!.balanceSum >= 0 ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'}`}>
                    {formatGrand(model!.balanceSum, null, formatCurrency, currency)}
                  </td>
                  <td className={`px-2 py-1 text-right ${model!.balanceAvg >= 0 ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'}`}>
                    {formatGrand(model!.balanceAvg, null, formatCurrency, currency)}
                  </td>
                </tr>

                {/* Spacer */}
                <tr>
                  <td colSpan={colSpan} className="h-2" />
                </tr>

                {/* Section subtotals recap */}
                {model!.sections.map((section, si) => {
                  const sectionMonthTotal = (m: string) =>
                    section.isIncome ? model!.monthlyIncome[m] : model!.monthlyExpenses[m];
                  const sectionSum = section.isIncome ? model!.totalIncomeSum : model!.totalExpensesSum;
                  const sectionAvg = section.isIncome ? model!.totalIncomeAvg : model!.totalExpensesAvg;
                  return (
                    <tr key={`recap-${si}`} className="font-bold bg-gray-50 dark:bg-gray-900/40">
                      <td className="sticky left-0 z-10 bg-gray-50 dark:bg-gray-900/40 px-2 py-1 truncate" title={section.title}>
                        {section.title}
                      </td>
                      {months.map((m) => {
                        const value = section.subtotals[m] || 0;
                        return (
                          <td key={m} className="px-2 py-1 text-right">
                            {value !== 0 ? (
                              formatCell(value, sectionMonthTotal(m), section.isIncome)
                            ) : (
                              <span className="text-gray-300 dark:text-gray-600">—</span>
                            )}
                          </td>
                        );
                      })}
                      <td className="px-2 py-1 text-right">
                        {formatCell(section.subtotalSum, sectionSum, section.isIncome)}
                      </td>
                      <td className="px-2 py-1 text-right">
                        {formatCell(section.subtotalAvg, sectionAvg, section.isIncome)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Grand-summary cell formatter. `isIncome` of null renders the raw signed
 * value (used by the balance row); true/false force the sign for income or
 * expense rows respectively.
 */
function formatGrand(
  value: number,
  isIncome: boolean | null,
  formatCurrency: (amount: number, currencyCode?: string) => string,
  currency: string | undefined,
): string {
  if (value === 0) return '—';
  const normalized = isIncome === null ? value : isIncome ? value : -value;
  const sign = normalized > 0 ? '+' : '-';
  return `${sign} ${formatCurrency(Math.abs(normalized), currency)}`;
}
