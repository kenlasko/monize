'use client';

import { useReportExportMetadata } from '@/hooks/useReportExportMetadata';
import { useReportingBasis } from './ReportingBasis';
import { useState, useMemo, useRef } from 'react';
import { useTranslations } from 'next-intl';
import { Skeleton } from '@/components/ui/LoadingSkeleton';
import {
  BarChart,
  Bar,
  PieChart,
  Pie,
  Cell,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from 'recharts';
import { format, subMonths, isAfter, startOfMonth } from 'date-fns';
import { builtInReportsApi } from '@/lib/built-in-reports';
import {
  CategorySpendingSnapshot,
} from '@/types/monthly-comparison';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import { useChartDateFormat } from '@/hooks/useChartDateFormat';
import { gainLossColor } from '@/lib/format';
import { CHART_COLOURS } from '@/lib/chart-colours';
import { chartColors } from '@/lib/chart-colors';
import { ReportToolbarActions } from '@/components/reports/ReportToolbarActions';
import { SortableHeader } from '@/components/ui/SortableHeader';
import { CAPTION_CLASS, CellLabel, PHONE_HEADER_CLASS } from '@/components/ui/Table';
import type {
  SortColumn as TableSortColumn,
  SortColumnsByField as TableSortColumnsByField,
} from '@/components/ui/Table';
import { useSortableTable, compareValues } from '@/hooks/useSortableTable';
import { useReportData } from '@/hooks/useReportData';
import { ReportError } from '@/components/reports/ReportError';
import { UnknownAmount } from '@/components/ui/UnknownAmount';
import { PartialTotal } from '@/components/ui/PartialTotal';
import { partialTotalFor } from '@/lib/net-worth-completeness';
import { periodResultUnknownReason } from '@/components/investments/portfolio-period-result';
import { parseLocalDate } from '@/lib/utils';
import type { InvestmentAccountPerformance } from '@/types/monthly-comparison';

type ComparisonSortField = 'category' | 'current' | 'previous' | 'change' | 'changePercent';
type TopMoversSortField = 'symbol' | 'name' | 'price' | 'change' | 'changePercent';

/**
 * One sortable column of each history table. Declared once, as a record over the
 * sort-field union, and rendered by BOTH header rows -- the column header row
 * (from `sm` up) and the phone sort strip -- so the two can never list different
 * fields, and adding a member to a union fails `tsc` here rather than stranding a
 * phone with no control for it.
 */
type ComparisonSortColumn = TableSortColumn<ComparisonSortField, 'right'>;
type TopMoversSortColumn = TableSortColumn<TopMoversSortField, 'right'>;

// Today's header cell, unchanged: what both tables already render (no
// `tracking-wider`). Kept local -- `PHONE_HEADER_CLASS`/`CAPTION_CLASS`/`CellLabel`
// are shared, but a table's own header and money cells stay per-report.
const HEADER_CLASS = 'px-4 py-3 text-xs font-medium text-gray-500 dark:text-gray-400 uppercase';

// A money (or percentage) cell inside a wrapped row: no padding of its own below
// `sm` (the row supplies it and the grid does the spacing), this table's own
// `px-4 py-3 text-sm` from `sm` up, smaller type on phones.
//
// `whitespace-nowrap` is the one property here that is NOT phone-only, and it is
// the single respect in which the `sm`-and-up cell differs from today's: a locale
// that groups thousands with a space (`1 234 567 zl`) could otherwise break a
// figure in the middle at any width. A number must not break; the caption inside
// takes `whitespace-normal` back for itself (`CellLabel`).
const MONEY_CELL = 'p-0 text-right text-xs whitespace-nowrap sm:table-cell sm:px-4 sm:py-3 sm:text-sm';

function getDefaultMonth(): string {
  const now = new Date();
  const prev = subMonths(now, 1);
  return format(prev, 'yyyy-MM');
}

function parseMonth(month: string): Date {
  const [y, m] = month.split('-').map(Number);
  return new Date(y, m - 1, 1);
}

function canGoForward(month: string): boolean {
  const next = subMonths(new Date(), 1);
  const current = parseMonth(month);
  return !isAfter(startOfMonth(current), startOfMonth(next));
}

function DeltaBadge({
  value,
  percent,
  invert = false,
  formatSignedPercent,
}: {
  value: number;
  percent: number;
  invert?: boolean;
  formatSignedPercent: (value: number, decimals?: number) => string;
}) {
  const positive = invert ? value <= 0 : value >= 0;
  const color = positive
    ? 'text-green-600 dark:text-green-400'
    : 'text-red-600 dark:text-red-400';
  // The sign comes from the amount, never from the percentage: the server
  // reports a flat +100 whenever the previous period was 0, so a decline from
  // zero would otherwise render "+100.0%" in red.
  const signedPercent = value >= 0 ? Math.abs(percent) : -Math.abs(percent);
  return (
    <span className={`text-sm font-medium ${color}`}>
      {formatSignedPercent(signedPercent, 1)}
    </span>
  );
}

export function MonthlyComparisonReport() {
  const { withPdfBasis } = useReportExportMetadata();
  const basis = useReportingBasis();
  const t = useTranslations('reports');
  const { formatCurrency, formatCurrencyCompact, formatCurrencyAxis, formatSignedPercent, formatPercent } = useNumberFormat();
  const formatChartDate = useChartDateFormat();
  const chartRef = useRef<HTMLDivElement>(null);
  const [month, setMonth] = useState(getDefaultMonth);
  const { data, isLoading, error, reload } = useReportData(
    () => builtInReportsApi.getMonthlyComparison(month, ...(basis ? [basis] as const : [])),
    [month, basis],
    { requestKey: JSON.stringify([month, basis]), maskStaleData: true },
  );
  const comparisonSort = useSortableTable<ComparisonSortField>(
    'reports.monthly-comparison.expenses.sort',
    { field: 'current', direction: 'desc' },
  );
  const topMoversSort = useSortableTable<TopMoversSortField>(
    'reports.monthly-comparison.topMovers.sort',
    { field: 'changePercent', direction: 'desc' },
  );

  const sortedComparison = useMemo(() => {
    if (!data) return [];
    const sorted = [...data.expenses.comparison];
    sorted.sort((a, b) => {
      let comparison = 0;
      switch (comparisonSort.sortField) {
        case 'category':
          comparison = compareValues(a.categoryName, b.categoryName);
          break;
        case 'current':
          comparison = compareValues(a.currentTotal, b.currentTotal);
          break;
        case 'previous':
          comparison = compareValues(a.previousTotal, b.previousTotal);
          break;
        case 'change':
          comparison = compareValues(a.change, b.change);
          break;
        case 'changePercent':
          comparison = compareValues(a.changePercent, b.changePercent);
          break;
      }
      return comparisonSort.sortDirection === 'asc' ? comparison : -comparison;
    });
    return sorted;
  }, [data, comparisonSort.sortField, comparisonSort.sortDirection]);

  const sortedTopMovers = useMemo(() => {
    if (!data) return [];
    const sorted = [...data.investments.topMovers];
    sorted.sort((a, b) => {
      let comparison = 0;
      switch (topMoversSort.sortField) {
        case 'symbol':
          comparison = compareValues(a.symbol, b.symbol);
          break;
        case 'name':
          comparison = compareValues(a.name, b.name);
          break;
        case 'price':
          comparison = compareValues(a.currentPrice, b.currentPrice);
          break;
        case 'change':
          comparison = compareValues(a.change, b.change);
          break;
        case 'changePercent':
          comparison = compareValues(a.changePercent, b.changePercent);
          break;
      }
      return topMoversSort.sortDirection === 'asc' ? comparison : -comparison;
    });
    return sorted;
  }, [data, topMoversSort.sortField, topMoversSort.sortDirection]);

  const goBack = () => {
    const d = parseMonth(month);
    const prev = subMonths(d, 1);
    setMonth(format(prev, 'yyyy-MM'));
  };

  const goForward = () => {
    const d = parseMonth(month);
    const next = new Date(d.getFullYear(), d.getMonth() + 1, 1);
    const maxMonth = subMonths(new Date(), 1);
    if (!isAfter(startOfMonth(next), startOfMonth(maxMonth))) {
      setMonth(format(next, 'yyyy-MM'));
    }
  };

  const forwardDisabled = !canGoForward(month) || (() => {
    const d = parseMonth(month);
    const next = new Date(d.getFullYear(), d.getMonth() + 1, 1);
    const maxMonth = subMonths(new Date(), 1);
    return isAfter(startOfMonth(next), startOfMonth(maxMonth));
  })();

  if (error) {
    return <ReportError onRetry={reload} />;
  }

  if (isLoading) {
    return (
      <div className="space-y-6">
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-4">
          <div className="animate-pulse flex items-center justify-center gap-4">
            <div className="h-8 w-8 bg-gray-200 dark:bg-gray-700 rounded" />
            <div className="h-8 w-40 bg-gray-200 dark:bg-gray-700 rounded" />
            <div className="h-8 w-8 bg-gray-200 dark:bg-gray-700 rounded" />
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

  if (!data) {
    return (
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-8 text-center">
        <p className="text-gray-500 dark:text-gray-400">{t('monthlyComparison.loadError')}</p>
      </div>
    );
  }

  const { incomeExpenses: ie, expenses, topCategories, netWorth: nw, investments } = data;
  const currency = data.currency;

  // The net worth block. The four headline figures are `null` when a month could
  // not be fully converted; the `known*` siblings carry the subtotal that did.
  // A subtotal is shown marked, and a change measured from or to one is withheld:
  // never `current - change` on nulls, never a `?? 0`.
  const nwPairs = nw.missingRatePairs ?? [];
  const nwPairsLabel = nwPairs.length > 0 ? nwPairs.join(', ') : t('monthlyComparison.pdfNotAvailable');
  const nwCurrent = nw.currentNetWorth ?? nw.knownCurrentNetWorth ?? null;
  const nwPrevious = nw.previousNetWorth ?? nw.knownPreviousNetWorth ?? null;
  const nwCurrentPartial = nw.currentNetWorth === null || nw.fxComplete === false;
  const nwPreviousPartial = nw.previousNetWorth === null || nw.fxComplete === false;
  const nwChange =
    nw.netWorthChange !== null && nw.netWorthChangePercent !== null && nw.fxComplete !== false
      ? { amount: nw.netWorthChange, percent: nw.netWorthChangePercent }
      : null;

  // A bar is drawn only for a return the server reported; a withheld one is
  // listed with its cause instead, because a zero-length bar reads as 0%.
  const knownReturns = investments.accountPerformance.filter(
    (a): a is InvestmentAccountPerformance & { returnPercent: number } => a.returnPercent !== null,
  );
  const withheldReturns = investments.accountPerformance.filter((a) => a.returnPercent === null);

  // The backend's currentMonthLabel/previousMonthLabel are English, formatted
  // for the AI/MCP tool payloads that share this DTO -- the UI renders its own
  // locale-aware labels from the raw currentMonth/previousMonth (YYYY-MM).
  const currentMonthLabel = formatChartDate(parseMonth(data.currentMonth), 'MMMM yyyy');
  const previousMonthLabel = formatChartDate(parseMonth(data.previousMonth), 'MMMM yyyy');

  const savingsNote = t(
    ie.savingsChange >= 0 ? 'monthlyComparison.savingsNoteMore' : 'monthlyComparison.savingsNoteLess',
    {
      currentMonth: currentMonthLabel,
      previousMonth: previousMonthLabel,
      percent: formatPercent(Math.abs(ie.savingsChangePercent), 1),
      amount: formatCurrency(ie.currentSavings, currency),
    },
  );
  const incomeNote = t(
    ie.incomeChange >= 0 ? 'monthlyComparison.incomeNoteMore' : 'monthlyComparison.incomeNoteLess',
    {
      currentMonth: currentMonthLabel,
      previousMonth: previousMonthLabel,
      amount: formatCurrency(ie.currentIncome, currency),
      diff: formatCurrency(Math.abs(ie.incomeChange), currency),
    },
  );

  const handleExportPdf = async () => {
    const { exportToPdf } = await import('@/lib/pdf-export');
    const { incomeExpenses, expenses: exp, topCategories: topCats, netWorth: netW, investments: inv, currency: cur } = data;
    const savingsColor = incomeExpenses.currentSavings >= 0 ? '#2563eb' : '#ea580c';

    // Summary notes
    const descriptionParts = [savingsNote, incomeNote];

    // Chart legend for expense categories
    const chartLegend = exp.comparison.slice(0, 10).map((item, i) => ({
      color: item.color || CHART_COLOURS[i % CHART_COLOURS.length],
      label: item.categoryName,
    }));

    // Monthly Expenses Comparison (main table - renders right after legend)
    const comparisonTable = exp.comparison.length > 0 ? {
      headers: [t('monthlyComparison.colCategory'), currentMonthLabel, previousMonthLabel, t('monthlyComparison.colChange'), t('monthlyComparison.colChangePercent')],
      rows: exp.comparison.map((item) => [
        item.categoryName,
        formatCurrency(item.currentTotal, cur),
        formatCurrency(item.previousTotal, cur),
        `${item.change >= 0 ? '+' : ''}${formatCurrency(item.change, cur)}`,
        formatSignedPercent(item.changePercent, 1),
      ]),
    } : undefined;

    // Additional tables
    const additionalTables: Array<{ title?: string; headers: string[]; rows: (string | number)[][] }> = [];

    // Top 5 categories
    if (topCats.currentMonth.length > 0) {
      additionalTables.push({
        title: t('monthlyComparison.pdfTop5Categories', { month: currentMonthLabel }),
        headers: [t('monthlyComparison.pdfColHash'), t('monthlyComparison.colCategory'), t('monthlyComparison.colAmount')],
        rows: topCats.currentMonth.map((cat, i) => [
          i + 1,
          cat.categoryName,
          formatCurrency(Math.abs(cat.total), cur),
        ]),
      });
    }
    if (topCats.previousMonth.length > 0) {
      additionalTables.push({
        title: t('monthlyComparison.pdfTop5Categories', { month: previousMonthLabel }),
        headers: [t('monthlyComparison.pdfColHash'), t('monthlyComparison.colCategory'), t('monthlyComparison.colAmount')],
        rows: topCats.previousMonth.map((cat, i) => [
          i + 1,
          cat.categoryName,
          formatCurrency(Math.abs(cat.total), cur),
        ]),
      });
    }

    // Net Worth
    if (netW.monthlyHistory.length > 0) {
      // A subtotal leaves the application labelled as one, and a change that
      // touches one is not printed.
      const pdfAmount = (value: number | null, partial: boolean) =>
        value === null
          ? t('monthlyComparison.pdfNotAvailable')
          : partial
            ? t('monthlyComparison.pdfPartialSuffix', { amount: formatCurrency(value, cur) })
            : formatCurrency(value, cur);
      const rows: string[][] = [
        [currentMonthLabel, pdfAmount(nwCurrent, nwCurrentPartial)],
        [previousMonthLabel, pdfAmount(nwPrevious, nwPreviousPartial)],
        [
          t('monthlyComparison.pdfChange'),
          nwChange
            ? `${nwChange.amount >= 0 ? '+' : ''}${formatCurrency(nwChange.amount, cur)} (${formatSignedPercent(nwChange.percent, 1)})`
            : t('monthlyComparison.pdfNotAvailable'),
        ],
      ];
      if (nwCurrentPartial || nwPreviousPartial) {
        rows.push([t('monthlyComparison.pdfNote'), t('monthlyComparison.pdfPartialNote', { pairs: nwPairsLabel })]);
      }
      additionalTables.push({
        title: t('monthlyComparison.pdfNetWorth'),
        headers: [t('monthlyComparison.pdfPeriod'), t('monthlyComparison.pdfNetWorth')],
        rows,
      });
    }

    // Top Movers
    if (inv.topMovers.length > 0) {
      additionalTables.push({
        title: t('monthlyComparison.topMovers'),
        headers: [t('monthlyComparison.colSymbol'), t('monthlyComparison.colName'), t('monthlyComparison.colPrice'), t('monthlyComparison.colChange'), t('monthlyComparison.colChangePercent')],
        rows: inv.topMovers.map((mover) => [
          mover.symbol,
          mover.name,
          formatCurrency(mover.currentPrice, cur),
          `${mover.change >= 0 ? '+' : ''}${formatCurrency(mover.change, cur)}`,
          formatSignedPercent(mover.changePercent, 2),
        ]),
      });
    }

    await exportToPdf(withPdfBasis({
      title: t('monthlyComparison.pdfTitle'),
      subtitle: t('monthlyComparison.pdfSubtitle', { current: currentMonthLabel, previous: previousMonthLabel }),
      description: descriptionParts.length > 0 ? descriptionParts.join('\n') : undefined,
      summaryCards: [
        { label: t('monthlyComparison.income'), value: formatCurrencyCompact(incomeExpenses.currentIncome, cur), color: '#16a34a' },
        { label: t('monthlyComparison.expenses'), value: formatCurrencyCompact(incomeExpenses.currentExpenses, cur), color: '#dc2626' },
        { label: t('monthlyComparison.savings'), value: formatCurrencyCompact(incomeExpenses.currentSavings, cur), color: savingsColor },
      ],
      chartContainer: chartRef.current,
      chartColumns: 2,
      chartLegend,
      tableData: comparisonTable,
      additionalTables: additionalTables.length > 0 ? additionalTables : undefined,
      filename: 'monthly-comparison',
    }));
  };

  // The comparison table's five sortable columns, keyed by field so the record is
  // exhaustive: adding a member to `ComparisonSortField` is a compile error here
  // rather than a header with no control. Their declaration order is the column
  // (and cell DOM) order, rendered by BOTH the column header row and the phone
  // sort strip from the derived `Object.values`. The two month columns carry the
  // locale-aware month labels the desktop header already showed.
  const comparisonColumns: TableSortColumnsByField<ComparisonSortField, ComparisonSortColumn> = {
    category: { field: 'category', label: t('monthlyComparison.colCategory') },
    current: { field: 'current', label: currentMonthLabel, align: 'right' },
    previous: { field: 'previous', label: previousMonthLabel, align: 'right' },
    change: { field: 'change', label: t('monthlyComparison.colChange'), align: 'right' },
    changePercent: { field: 'changePercent', label: t('monthlyComparison.colChangePercent'), align: 'right' },
  };
  const comparisonSortColumns: readonly ComparisonSortColumn[] = Object.values(comparisonColumns);

  // The top-movers table's five sortable columns, same shape and same rule.
  const topMoversColumns: TableSortColumnsByField<TopMoversSortField, TopMoversSortColumn> = {
    symbol: { field: 'symbol', label: t('monthlyComparison.colSymbol') },
    name: { field: 'name', label: t('monthlyComparison.colName') },
    price: { field: 'price', label: t('monthlyComparison.colPrice'), align: 'right' },
    change: { field: 'change', label: t('monthlyComparison.colChange'), align: 'right' },
    changePercent: { field: 'changePercent', label: t('monthlyComparison.colChangePercent'), align: 'right' },
  };
  const topMoversSortColumns: readonly TopMoversSortColumn[] = Object.values(topMoversColumns);

  return (
    <div ref={chartRef} className="space-y-6">
      {/* Month Picker */}
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-4">
        {/* Wraps, so the actions row lands under the month stepper on a phone
            instead of being squeezed beside it. */}
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-4 flex-1 justify-center">
            <button
              onClick={goBack}
              className="p-2 rounded-md hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors"
            >
              <svg className="h-5 w-5 text-gray-600 dark:text-gray-300" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
              </svg>
            </button>
            <div className="text-center">
              <div className="text-lg font-semibold text-gray-900 dark:text-gray-100">
                {currentMonthLabel}
              </div>
              <div className="text-sm text-gray-500 dark:text-gray-400">
                {t('monthlyComparison.vsMonth', { month: previousMonthLabel })}
              </div>
            </div>
            <button
              onClick={goForward}
              disabled={forwardDisabled}
              className="p-2 rounded-md hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
            >
              <svg className="h-5 w-5 text-gray-600 dark:text-gray-300" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
              </svg>
            </button>
          </div>
          <ReportToolbarActions onExportPdf={handleExportPdf} />
        </div>
      </div>

      {/* Income vs Expenses Summary */}
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 px-2 py-4 sm:p-6">
        <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-4">{t('monthlyComparison.incomeVsExpenses')}</h2>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {/* Income */}
          <div className="bg-green-50 dark:bg-green-900/20 rounded-lg p-4">
            <div className="text-sm text-green-600 dark:text-green-400 mb-1">{t('monthlyComparison.income')}</div>
            <div className="text-2xl font-bold text-green-700 dark:text-green-300">
              {formatCurrencyCompact(ie.currentIncome, currency)}
            </div>
            <div className="flex items-center gap-2 mt-1">
              <span className="text-xs text-gray-500 dark:text-gray-400">
                {t('monthlyComparison.inMonth', { amount: formatCurrencyCompact(ie.previousIncome, currency), month: previousMonthLabel })}
              </span>
              <DeltaBadge value={ie.incomeChange} percent={ie.incomeChangePercent} formatSignedPercent={formatSignedPercent} />
            </div>
          </div>
          {/* Expenses */}
          <div className="bg-red-50 dark:bg-red-900/20 rounded-lg p-4">
            <div className="text-sm text-red-600 dark:text-red-400 mb-1">{t('monthlyComparison.expenses')}</div>
            <div className="text-2xl font-bold text-red-700 dark:text-red-300">
              {formatCurrencyCompact(ie.currentExpenses, currency)}
            </div>
            <div className="flex items-center gap-2 mt-1">
              <span className="text-xs text-gray-500 dark:text-gray-400">
                {t('monthlyComparison.inMonth', { amount: formatCurrencyCompact(ie.previousExpenses, currency), month: previousMonthLabel })}
              </span>
              <DeltaBadge value={ie.expensesChange} percent={ie.expensesChangePercent} invert formatSignedPercent={formatSignedPercent} />
            </div>
          </div>
          {/* Savings */}
          <div className={`rounded-lg p-4 ${ie.currentSavings >= 0 ? 'bg-blue-50 dark:bg-blue-900/20' : 'bg-orange-50 dark:bg-orange-900/20'}`}>
            <div className={`text-sm mb-1 ${ie.currentSavings >= 0 ? 'text-blue-600 dark:text-blue-400' : 'text-orange-600 dark:text-orange-400'}`}>
              {t('monthlyComparison.savings')}
            </div>
            <div className={`text-2xl font-bold ${ie.currentSavings >= 0 ? 'text-blue-700 dark:text-blue-300' : 'text-orange-700 dark:text-orange-300'}`}>
              {formatCurrencyCompact(ie.currentSavings, currency)}
            </div>
            <div className="flex items-center gap-2 mt-1">
              <span className="text-xs text-gray-500 dark:text-gray-400">
                {t('monthlyComparison.inMonth', { amount: formatCurrencyCompact(ie.previousSavings, currency), month: previousMonthLabel })}
              </span>
              <DeltaBadge value={ie.savingsChange} percent={ie.savingsChangePercent} formatSignedPercent={formatSignedPercent} />
            </div>
          </div>
        </div>
      </div>

      {/* Summary Notes */}
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 px-2 py-4 sm:p-6">
        <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-3">{t('monthlyComparison.summary')}</h2>
        <div className="space-y-2 text-sm text-gray-700 dark:text-gray-300">
          <p>{savingsNote}</p>
          <p>{incomeNote}</p>
        </div>
      </div>

      {/* Monthly Expenses Compared */}
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 px-2 py-4 sm:p-6">
        <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-4">{t('monthlyComparison.monthlyExpenses')}</h2>
        {/* Pie Charts */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mb-6">
          <ExpensePieChart
            title={currentMonthLabel}
            data={expenses.currentMonth}
            currency={currency}
            formatCurrency={formatCurrencyCompact}
            noDataLabel={t('monthlyComparison.noExpenseData')}
            totalLabel={t('monthlyComparison.netWorthTotal', { amount: formatCurrencyCompact(expenses.currentTotal, currency) })}
          />
          <ExpensePieChart
            title={previousMonthLabel}
            data={expenses.previousMonth}
            currency={currency}
            formatCurrency={formatCurrencyCompact}
            noDataLabel={t('monthlyComparison.noExpenseData')}
            totalLabel={t('monthlyComparison.netWorthTotal', { amount: formatCurrencyCompact(expenses.previousTotal, currency) })}
          />
        </div>
        {/* Comparison Table */}
        {expenses.comparison.length > 0 && (
          <div className="overflow-x-auto">
            {/* Below `sm` the table becomes a block and each row wraps into a
                three-column grid card so all five columns fit a phone without a
                horizontal scroll, on two lines: the category (the row identity),
                the current-month total and the previous-month total on line 1;
                the change and its percentage under the two months on line 2.
                Nothing is dropped, and no figure is truncated -- a money value
                never wraps (`MONEY_CELL`). From `sm` up it is the ordinary table,
                resolving to today's output in every respect but one (each cell
                restores its own `sm:px-4 sm:py-3 sm:text-sm`; `MONEY_CELL`'s
                `whitespace-nowrap` is unprefixed, so it applies at 640px+ too,
                where the base cell carried no `white-space` class -- deliberate,
                and the constant says why), and the sort controls survive as
                their own phone-only header row because the column header row that
                carries them on desktop is hidden there. Restyling `display`
                strips the implicit table semantics below `sm`, so the roles are
                restated and every bare figure carries a `CellLabel` naming its
                column; the category names itself. DOM order is the desktop column
                order, which the grid placement overrides visually on the phone. */}
            <table role="table" className="block min-w-full divide-y divide-gray-200 dark:divide-gray-700 sm:table">
              <thead role="rowgroup" className="block sm:table-header-group">
                {/* Phone sort strip: the same five controls, wrapped. */}
                <tr role="row" className="flex flex-wrap gap-x-2 gap-y-1 pb-2 sm:hidden">
                  {comparisonSortColumns.map((col) => (
                    <SortableHeader<ComparisonSortField>
                      key={col.field}
                      field={col.field}
                      sortField={comparisonSort.sortField}
                      sortDirection={comparisonSort.sortDirection}
                      onSort={comparisonSort.handleSort}
                      className={PHONE_HEADER_CLASS}
                    >
                      {col.label}
                    </SortableHeader>
                  ))}
                </tr>
                <tr role="row" className="hidden sm:table-row">
                  {comparisonSortColumns.map((col) => (
                    <SortableHeader<ComparisonSortField>
                      key={col.field}
                      field={col.field}
                      sortField={comparisonSort.sortField}
                      sortDirection={comparisonSort.sortDirection}
                      onSort={comparisonSort.handleSort}
                      align={col.align}
                      className={HEADER_CLASS}
                    >
                      {col.label}
                    </SortableHeader>
                  ))}
                </tr>
              </thead>
              <tbody role="rowgroup" className="block divide-y divide-gray-200 dark:divide-gray-700 sm:table-row-group">
                {sortedComparison.map((item) => (
                  <tr
                    key={item.categoryId || item.categoryName}
                    role="row"
                    className="grid grid-cols-3 items-start gap-x-3 gap-y-1.5 py-3 sm:table-row sm:py-0"
                  >
                    {/* Category: the row identity. It wraps unclamped in its own
                        track; the colour dot never shrinks. Kept `flex` at every
                        width (as today), so no `sm:table-cell` -- the grid
                        placement is inert once the row is a table-row. */}
                    <td role="cell" className="col-start-1 row-start-1 flex min-w-0 items-center gap-2 p-0 text-sm text-gray-900 dark:text-gray-100 sm:px-4 sm:py-3">
                      {item.color && (
                        <span className="w-3 h-3 rounded-full flex-shrink-0" style={{ backgroundColor: item.color }} />
                      )}
                      <span className="min-w-0 break-words sm:break-normal">{item.categoryName}</span>
                    </td>
                    <td role="cell" className={`col-start-2 row-start-1 text-gray-900 dark:text-gray-100 ${MONEY_CELL}`}>
                      <CellLabel className={CAPTION_CLASS}>{currentMonthLabel}</CellLabel>
                      {formatCurrency(item.currentTotal, currency)}
                    </td>
                    <td role="cell" className={`col-start-3 row-start-1 text-gray-900 dark:text-gray-100 ${MONEY_CELL}`}>
                      <CellLabel className={CAPTION_CLASS}>{previousMonthLabel}</CellLabel>
                      {formatCurrency(item.previousTotal, currency)}
                    </td>
                    <td role="cell" className={`col-start-2 row-start-2 font-medium ${item.change <= 0 ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'} ${MONEY_CELL}`}>
                      <CellLabel className={CAPTION_CLASS}>{t('monthlyComparison.colChange')}</CellLabel>
                      {item.change >= 0 ? '+' : ''}{formatCurrency(item.change, currency)}
                    </td>
                    <td role="cell" className={`col-start-3 row-start-2 font-medium ${item.changePercent <= 0 ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'} ${MONEY_CELL}`}>
                      <CellLabel className={CAPTION_CLASS}>{t('monthlyComparison.colChangePercent')}</CellLabel>
                      {formatSignedPercent(item.changePercent, 1)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Top 5 Expense Categories */}
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 px-2 py-4 sm:p-6">
        <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-4">{t('monthlyComparison.topExpenseCategories')}</h2>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          <TopCategoriesTable
            title={currentMonthLabel}
            categories={topCategories.currentMonth}
            currency={currency}
            formatCurrency={formatCurrency}
            noDataLabel={t('monthlyComparison.noData')}
            colCategory={t('monthlyComparison.colCategory')}
            colAmount={t('monthlyComparison.colAmount')}
            colHash={t('monthlyComparison.pdfColHash')}
          />
          <TopCategoriesTable
            title={previousMonthLabel}
            categories={topCategories.previousMonth}
            currency={currency}
            formatCurrency={formatCurrency}
            noDataLabel={t('monthlyComparison.noData')}
            colCategory={t('monthlyComparison.colCategory')}
            colAmount={t('monthlyComparison.colAmount')}
            colHash={t('monthlyComparison.pdfColHash')}
          />
        </div>
      </div>

      {/* Net Worth */}
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 px-2 py-4 sm:p-6">
        <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-4">{t('monthlyComparison.netWorth')}</h2>
        {nw.monthlyHistory.length > 0 ? (
          <>
            <div className="h-72">
              <ResponsiveContainer width="100%" height="100%" minWidth={0}>
                <BarChart data={nw.monthlyHistory.map(p => ({
                  name: formatChartDate(parseMonth(p.month), 'MMM yy'),
                  // A month the server could not fully convert is a gap, never a dip.
                  netWorth: p.fxComplete === false ? null : Math.round(p.netWorth),
                }))} margin={{ top: 10, right: 10, left: 0, bottom: 5 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke={chartColors.grid} />
                  <XAxis dataKey="name" tick={{ fontSize: 12 }} />
                  <YAxis tickFormatter={formatCurrencyAxis} tick={{ fontSize: 12 }} />
                  <Tooltip
                    formatter={(value) => [formatCurrencyCompact(Number(value), currency), t('monthlyComparison.tooltipNetWorth')]}
                    contentStyle={{ backgroundColor: 'var(--tooltip-bg, var(--color-white))', borderColor: 'var(--tooltip-border, var(--color-gray-200))' }}
                  />
                  <Bar dataKey="netWorth" fill={chartColors.primary} radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
            <div className="mt-4 p-4 bg-gray-50 dark:bg-gray-700/30 rounded-lg">
              <p className="text-sm text-gray-700 dark:text-gray-300">
                {nwChange && !nwCurrentPartial && nwCurrent !== null ? (
                  t.rich('monthlyComparison.netWorthSummary', {
                    currentMonth: currentMonthLabel,
                    netWorth: formatCurrency(nwCurrent, currency),
                    changeAmount: `${nwChange.amount >= 0 ? '+' : ''}${formatCurrency(nwChange.amount, currency)} (${formatSignedPercent(nwChange.percent, 1)})`,
                    previousMonth: previousMonthLabel,
                    strong: (chunks) => <span className="font-semibold">{chunks}</span>,
                    delta: (chunks) => <span className={`font-semibold ${gainLossColor(nwChange.amount)}`}>{chunks}</span>,
                  })
                ) : (
                  t.rich('monthlyComparison.netWorthSummaryPartial', {
                    currentMonth: currentMonthLabel,
                    // The subtotal marked as one, or unknown where not even a
                    // subtotal came back; the change is withheld either way.
                    netWorth: nwCurrent === null ? '' : formatCurrency(nwCurrent, currency),
                    previousMonth: previousMonthLabel,
                    pairs: nwPairsLabel,
                    strong: (chunks) =>
                      nwCurrent === null ? (
                        <UnknownAmount reason="displayFx" />
                      ) : (
                        <PartialTotal
                          total={partialTotalFor(nwCurrent, nwCurrentPartial ? false : undefined, nwPairs)}
                          displayCurrency={currency}
                        >
                          <span className="font-semibold">{chunks}</span>
                        </PartialTotal>
                      ),
                  })
                )}
              </p>
            </div>
          </>
        ) : (
          <p className="text-gray-500 dark:text-gray-400 text-center py-8">{t('monthlyComparison.noNetWorthData')}</p>
        )}
      </div>

      {/* Investment Performance */}
      {(investments.accountPerformance.length > 0 || investments.topMovers.length > 0) && (
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 px-2 py-4 sm:p-6">
          <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-4">{t('monthlyComparison.investmentPerformance')}</h2>

          {investments.accountPerformance.length > 0 && (
            <>
              <p className="text-sm text-gray-500 dark:text-gray-400 mb-3">
                {t('monthlyComparison.investmentPerformanceCaption', {
                  date: formatChartDate(parseLocalDate(investments.accountPerformance[0].periodEnd), 'MMM d, yyyy'),
                })}
              </p>
              {knownReturns.length > 0 && (
                <div className="h-72 mb-6">
                  <ResponsiveContainer width="100%" height="100%" minWidth={0}>
                    <BarChart
                      data={knownReturns.map(a => ({
                        name: a.accountName,
                        return: a.returnPercent,
                      }))}
                      margin={{ top: 10, right: 10, left: 0, bottom: 5 }}
                      layout="vertical"
                    >
                      <CartesianGrid strokeDasharray="3 3" stroke={chartColors.grid} />
                      {/* Fractional ticks keep a decimal: forcing 0 would print a
                          narrow range (0.4%, 0.9%, 1.2%) as "0%", "1%", "1%". */}
                      <XAxis type="number" tickFormatter={(v: number) => formatPercent(v, Number.isInteger(v) ? 0 : 1)} tick={{ fontSize: 12 }} />
                      <YAxis type="category" dataKey="name" tick={{ fontSize: 12 }} width={90} />
                      <Tooltip formatter={(value) => [formatPercent(Number(value), 2), t('monthlyComparison.trailingYearReturn')]} />
                      <Bar
                        dataKey="return"
                        radius={[0, 4, 4, 0]}
                      >
                        {knownReturns.map((a) => (
                          <Cell
                            key={a.accountId}
                            fill={a.returnPercent >= 0 ? chartColors.income : chartColors.expense}
                          />
                        ))}
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              )}
              {/* A withheld return is listed as unknown with its cause, never
                  drawn as a zero-length bar. */}
              {withheldReturns.length > 0 && (
                <ul className="mb-6 space-y-1 text-sm text-gray-700 dark:text-gray-300" data-testid="withheld-returns">
                  {withheldReturns.map((a) => (
                    <li key={a.accountId} className="flex items-baseline gap-2">
                      <span>{t('monthlyComparison.returnUnavailable', { account: a.accountName })}</span>
                      <UnknownAmount reason={periodResultUnknownReason(a.returnReasons)} />
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}

          {investments.topMovers.length > 0 && (
            <div>
              <h3 className="text-base font-medium text-gray-900 dark:text-gray-100 mb-3">{t('monthlyComparison.topMovers')}</h3>
              <div className="overflow-x-auto">
                {/* Below `sm` the table becomes a block and each row wraps into a
                    three-column, two-line grid card so all five columns fit a
                    phone without a horizontal scroll: line 1 is the symbol (the
                    row identity), its change and its change percentage; line 2 is
                    the security name (a descriptor under its symbol) and the
                    price. Nothing is dropped, and no figure is truncated -- a
                    money value never wraps (`MONEY_CELL`). From `sm` up it is the
                    ordinary table, resolving to today's output in every respect
                    but one -- `MONEY_CELL`'s `whitespace-nowrap` is unprefixed,
                    so it applies at 640px+ too, where the base cell carried no
                    `white-space` class (deliberate; the constant says why) --
                    and the sort controls survive as their own phone-only header
                    row. Restyling
                    `display` strips the table semantics below `sm`, so the roles
                    are restated and every bare figure carries a `CellLabel`; the
                    symbol names itself and the name sits under it. DOM order is
                    the desktop column order, which the grid placement overrides
                    visually on the phone. */}
                <table role="table" className="block min-w-full divide-y divide-gray-200 dark:divide-gray-700 sm:table">
                  <thead role="rowgroup" className="block sm:table-header-group">
                    {/* Phone sort strip: the same five controls, wrapped. */}
                    <tr role="row" className="flex flex-wrap gap-x-2 gap-y-1 pb-2 sm:hidden">
                      {topMoversSortColumns.map((col) => (
                        <SortableHeader<TopMoversSortField>
                          key={col.field}
                          field={col.field}
                          sortField={topMoversSort.sortField}
                          sortDirection={topMoversSort.sortDirection}
                          onSort={topMoversSort.handleSort}
                          className={PHONE_HEADER_CLASS}
                        >
                          {col.label}
                        </SortableHeader>
                      ))}
                    </tr>
                    <tr role="row" className="hidden sm:table-row">
                      {topMoversSortColumns.map((col) => (
                        <SortableHeader<TopMoversSortField>
                          key={col.field}
                          field={col.field}
                          sortField={topMoversSort.sortField}
                          sortDirection={topMoversSort.sortDirection}
                          onSort={topMoversSort.handleSort}
                          align={col.align}
                          className={HEADER_CLASS}
                        >
                          {col.label}
                        </SortableHeader>
                      ))}
                    </tr>
                  </thead>
                  <tbody role="rowgroup" className="block divide-y divide-gray-200 dark:divide-gray-700 sm:table-row-group">
                    {sortedTopMovers.map((mover) => (
                      <tr
                        key={mover.securityId}
                        role="row"
                        className="grid grid-cols-3 items-start gap-x-3 gap-y-1.5 py-3 sm:table-row sm:py-0"
                      >
                        {/* Symbol: the row identity, self-naming. */}
                        <td role="cell" className="col-start-1 row-start-1 p-0 text-xs font-medium break-words text-gray-900 dark:text-gray-100 sm:table-cell sm:px-4 sm:py-3 sm:text-sm sm:break-normal">
                          {mover.symbol}
                        </td>
                        {/* Name: a descriptor under the symbol, so no caption. */}
                        <td role="cell" className="col-start-1 row-start-2 p-0 text-xs break-words text-gray-700 dark:text-gray-300 sm:table-cell sm:px-4 sm:py-3 sm:text-sm sm:break-normal">
                          {mover.name}
                        </td>
                        <td role="cell" className={`col-start-2 row-start-2 text-gray-900 dark:text-gray-100 ${MONEY_CELL}`}>
                          <CellLabel className={CAPTION_CLASS}>{t('monthlyComparison.colPrice')}</CellLabel>
                          {formatCurrency(mover.currentPrice, currency)}
                        </td>
                        {/* Change: the headline, beside the symbol. */}
                        <td role="cell" className={`col-start-2 row-start-1 font-medium ${gainLossColor(mover.change)} ${MONEY_CELL}`}>
                          <CellLabel className={CAPTION_CLASS}>{t('monthlyComparison.colChange')}</CellLabel>
                          {mover.change >= 0 ? '+' : ''}{formatCurrency(mover.change, currency)}
                        </td>
                        <td role="cell" className={`col-start-3 row-start-1 font-medium ${gainLossColor(mover.changePercent)} ${MONEY_CELL}`}>
                          <CellLabel className={CAPTION_CLASS}>{t('monthlyComparison.colChangePercent')}</CellLabel>
                          {formatSignedPercent(mover.changePercent, 2)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function ExpensePieChart({
  title,
  data,
  currency,
  formatCurrency,
  noDataLabel,
  totalLabel,
}: {
  title: string;
  data: CategorySpendingSnapshot[];
  currency: string;
  formatCurrency: (amount: number, currency?: string) => string;
  noDataLabel: string;
  totalLabel: string;
}) {
  if (data.length === 0) {
    return (
      <div className="text-center">
        <h3 className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">{title}</h3>
        <p className="text-gray-500 dark:text-gray-400 text-sm py-8">{noDataLabel}</p>
      </div>
    );
  }

  return (
    <div>
      <h3 className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-2 text-center">{title}</h3>
      <div className="h-56">
        <ResponsiveContainer width="100%" height="100%" minWidth={0}>
          <PieChart>
            <Pie
              data={data.map((d) => ({ name: d.categoryName, value: Math.abs(d.total) }))}
              cx="50%"
              cy="50%"
              innerRadius={50}
              outerRadius={80}
              paddingAngle={2}
              dataKey="value"
            >
              {data.map((d, i) => (
                <Cell key={d.categoryId || i} fill={d.color || CHART_COLOURS[i % CHART_COLOURS.length]} />
              ))}
            </Pie>
            <Tooltip
              formatter={(value, name) => [formatCurrency(Number(value), currency), String(name)]}
            />
          </PieChart>
        </ResponsiveContainer>
      </div>
      <div className="text-center text-sm text-gray-600 dark:text-gray-400">
        {totalLabel}
      </div>
    </div>
  );
}

function TopCategoriesTable({
  title,
  categories,
  currency,
  formatCurrency,
  noDataLabel,
  colCategory,
  colAmount,
  colHash,
}: {
  title: string;
  categories: CategorySpendingSnapshot[];
  currency: string;
  formatCurrency: (amount: number, currency?: string) => string;
  noDataLabel: string;
  colCategory: string;
  colAmount: string;
  colHash: string;
}) {
  return (
    <div>
      <h3 className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">{title}</h3>
      {categories.length === 0 ? (
        <p className="text-gray-500 dark:text-gray-400 text-sm">{noDataLabel}</p>
      ) : (
        <table className="min-w-full divide-y divide-gray-200 dark:divide-gray-700">
          <thead>
            <tr>
              <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">{colHash}</th>
              <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">{colCategory}</th>
              <th className="px-3 py-2 text-right text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">{colAmount}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-200 dark:divide-gray-700">
            {categories.map((cat, i) => (
              <tr key={cat.categoryId || cat.categoryName}>
                <td className="px-3 py-2 text-sm text-gray-500 dark:text-gray-400">{i + 1}</td>
                <td className="px-3 py-2 text-sm text-gray-900 dark:text-gray-100 flex items-center gap-2">
                  {cat.color && (
                    <span className="w-2.5 h-2.5 rounded-full flex-shrink-0" style={{ backgroundColor: cat.color }} />
                  )}
                  {cat.categoryName}
                </td>
                <td className="px-3 py-2 text-sm text-right text-gray-900 dark:text-gray-100">
                  {formatCurrency(Math.abs(cat.total), currency)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
