'use client';

import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
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
  MonthlyComparisonResponse,
  CategorySpendingSnapshot,
} from '@/types/monthly-comparison';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import { gainLossColor } from '@/lib/format';
import { CHART_COLOURS } from '@/lib/chart-colours';
import { ExportDropdown } from '@/components/ui/ExportDropdown';
import { SortableHeader } from '@/components/ui/SortableHeader';
import { useSortableTable, compareValues } from '@/hooks/useSortableTable';
import { createLogger } from '@/lib/logger';

const logger = createLogger('MonthlyComparisonReport');

type ComparisonSortField = 'category' | 'current' | 'previous' | 'change' | 'changePercent';
type TopMoversSortField = 'symbol' | 'name' | 'price' | 'change' | 'changePercent';

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

function DeltaBadge({ value, percent, invert = false }: { value: number; percent: number; invert?: boolean }) {
  const positive = invert ? value <= 0 : value >= 0;
  const color = positive
    ? 'text-green-600 dark:text-green-400'
    : 'text-red-600 dark:text-red-400';
  const arrow = value >= 0 ? '+' : '';
  return (
    <span className={`text-sm font-medium ${color}`}>
      {arrow}{percent.toFixed(1)}%
    </span>
  );
}

export function MonthlyComparisonReport() {
  const { formatCurrency, formatCurrencyCompact, formatCurrencyAxis, formatSignedPercent } = useNumberFormat();
  const chartRef = useRef<HTMLDivElement>(null);
  const [month, setMonth] = useState(getDefaultMonth);
  const [data, setData] = useState<MonthlyComparisonResponse | null>(null);
  const [isLoading, setIsLoading] = useState(true);
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

  const loadData = useCallback(async () => {
    setIsLoading(true);
    try {
      const response = await builtInReportsApi.getMonthlyComparison(month);
      setData(response);
    } catch (error) {
      logger.error('Failed to load monthly comparison:', error);
    } finally {
      setIsLoading(false);
    }
  }, [month]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  const handleExportPdf = async () => {
    if (!data) return;
    const { exportToPdf } = await import('@/lib/pdf-export');
    const { incomeExpenses, notes: n, expenses: exp, topCategories: topCats, netWorth: netW, investments: inv, currency: cur } = data;
    const savingsColor = incomeExpenses.currentSavings >= 0 ? '#2563eb' : '#ea580c';

    // Summary notes
    const descriptionParts: string[] = [];
    if (n.savingsNote) descriptionParts.push(n.savingsNote);
    if (n.incomeNote) descriptionParts.push(n.incomeNote);

    // Chart legend for expense categories
    const chartLegend = exp.comparison.slice(0, 10).map((item, i) => ({
      color: item.color || CHART_COLOURS[i % CHART_COLOURS.length],
      label: item.categoryName,
    }));

    // Monthly Expenses Comparison (main table - renders right after legend)
    const comparisonTable = exp.comparison.length > 0 ? {
      headers: ['Category', data.currentMonthLabel, data.previousMonthLabel, 'Change', 'Change %'],
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
        title: `Top 5 Categories - ${data.currentMonthLabel}`,
        headers: ['#', 'Category', 'Amount'],
        rows: topCats.currentMonth.map((cat, i) => [
          i + 1,
          cat.categoryName,
          formatCurrency(Math.abs(cat.total), cur),
        ]),
      });
    }
    if (topCats.previousMonth.length > 0) {
      additionalTables.push({
        title: `Top 5 Categories - ${data.previousMonthLabel}`,
        headers: ['#', 'Category', 'Amount'],
        rows: topCats.previousMonth.map((cat, i) => [
          i + 1,
          cat.categoryName,
          formatCurrency(Math.abs(cat.total), cur),
        ]),
      });
    }

    // Net Worth
    if (netW.monthlyHistory.length > 0) {
      const changeSign = netW.netWorthChange >= 0 ? '+' : '';
      additionalTables.push({
        title: 'Net Worth',
        headers: ['Period', 'Net Worth'],
        rows: [
          [data.currentMonthLabel, formatCurrency(netW.currentNetWorth, cur)],
          [data.previousMonthLabel, formatCurrency(netW.currentNetWorth - netW.netWorthChange, cur)],
          ['Change', `${changeSign}${formatCurrency(netW.netWorthChange, cur)} (${changeSign}${netW.netWorthChangePercent.toFixed(1)}%)`],
        ],
      });
    }

    // Top Movers
    if (inv.topMovers.length > 0) {
      additionalTables.push({
        title: 'Top Movers',
        headers: ['Symbol', 'Name', 'Price', 'Change', 'Change %'],
        rows: inv.topMovers.map((mover) => [
          mover.symbol,
          mover.name,
          formatCurrency(mover.currentPrice, cur),
          `${mover.change >= 0 ? '+' : ''}${formatCurrency(mover.change, cur)}`,
          formatSignedPercent(mover.changePercent, 2),
        ]),
      });
    }

    await exportToPdf({
      title: 'Monthly Comparison',
      subtitle: `${data.currentMonthLabel} vs ${data.previousMonthLabel}`,
      description: descriptionParts.length > 0 ? descriptionParts.join('\n') : undefined,
      summaryCards: [
        { label: 'Income', value: formatCurrencyCompact(incomeExpenses.currentIncome, cur), color: '#16a34a' },
        { label: 'Expenses', value: formatCurrencyCompact(incomeExpenses.currentExpenses, cur), color: '#dc2626' },
        { label: 'Savings', value: formatCurrencyCompact(incomeExpenses.currentSavings, cur), color: savingsColor },
      ],
      chartContainer: chartRef.current,
      chartColumns: 2,
      chartLegend,
      tableData: comparisonTable,
      additionalTables: additionalTables.length > 0 ? additionalTables : undefined,
      filename: 'monthly-comparison',
    });
  };

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
          <div className="animate-pulse space-y-4">
            <div className="h-8 bg-gray-200 dark:bg-gray-700 rounded w-1/3" />
            <div className="h-64 bg-gray-200 dark:bg-gray-700 rounded" />
          </div>
        </div>
      </div>
    );
  }

  if (!data) {
    return (
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-8 text-center">
        <p className="text-gray-500 dark:text-gray-400">Failed to load report data.</p>
      </div>
    );
  }

  const { incomeExpenses: ie, notes, expenses, topCategories, netWorth: nw, investments } = data;
  const currency = data.currency;

  return (
    <div ref={chartRef} className="space-y-6">
      {/* Month Picker */}
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-4">
        <div className="flex items-center justify-between">
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
                {data.currentMonthLabel}
              </div>
              <div className="text-sm text-gray-500 dark:text-gray-400">
                vs {data.previousMonthLabel}
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
          <ExportDropdown onExportPdf={handleExportPdf} />
        </div>
      </div>

      {/* Income vs Expenses Summary */}
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 px-2 py-4 sm:p-6">
        <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-4">Income vs Expenses</h2>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {/* Income */}
          <div className="bg-green-50 dark:bg-green-900/20 rounded-lg p-4">
            <div className="text-sm text-green-600 dark:text-green-400 mb-1">Income</div>
            <div className="text-2xl font-bold text-green-700 dark:text-green-300">
              {formatCurrencyCompact(ie.currentIncome, currency)}
            </div>
            <div className="flex items-center gap-2 mt-1">
              <span className="text-xs text-gray-500 dark:text-gray-400">
                {formatCurrencyCompact(ie.previousIncome, currency)} in {data.previousMonthLabel}
              </span>
              <DeltaBadge value={ie.incomeChange} percent={ie.incomeChangePercent} />
            </div>
          </div>
          {/* Expenses */}
          <div className="bg-red-50 dark:bg-red-900/20 rounded-lg p-4">
            <div className="text-sm text-red-600 dark:text-red-400 mb-1">Expenses</div>
            <div className="text-2xl font-bold text-red-700 dark:text-red-300">
              {formatCurrencyCompact(ie.currentExpenses, currency)}
            </div>
            <div className="flex items-center gap-2 mt-1">
              <span className="text-xs text-gray-500 dark:text-gray-400">
                {formatCurrencyCompact(ie.previousExpenses, currency)} in {data.previousMonthLabel}
              </span>
              <DeltaBadge value={ie.expensesChange} percent={ie.expensesChangePercent} invert />
            </div>
          </div>
          {/* Savings */}
          <div className={`rounded-lg p-4 ${ie.currentSavings >= 0 ? 'bg-blue-50 dark:bg-blue-900/20' : 'bg-orange-50 dark:bg-orange-900/20'}`}>
            <div className={`text-sm mb-1 ${ie.currentSavings >= 0 ? 'text-blue-600 dark:text-blue-400' : 'text-orange-600 dark:text-orange-400'}`}>
              Savings
            </div>
            <div className={`text-2xl font-bold ${ie.currentSavings >= 0 ? 'text-blue-700 dark:text-blue-300' : 'text-orange-700 dark:text-orange-300'}`}>
              {formatCurrencyCompact(ie.currentSavings, currency)}
            </div>
            <div className="flex items-center gap-2 mt-1">
              <span className="text-xs text-gray-500 dark:text-gray-400">
                {formatCurrencyCompact(ie.previousSavings, currency)} in {data.previousMonthLabel}
              </span>
              <DeltaBadge value={ie.savingsChange} percent={ie.savingsChangePercent} />
            </div>
          </div>
        </div>
      </div>

      {/* Summary Notes */}
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 px-2 py-4 sm:p-6">
        <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-3">Summary</h2>
        <div className="space-y-2 text-sm text-gray-700 dark:text-gray-300">
          <p>{notes.savingsNote}</p>
          <p>{notes.incomeNote}</p>
        </div>
      </div>

      {/* Monthly Expenses Compared */}
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 px-2 py-4 sm:p-6">
        <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-4">Monthly Expenses Compared</h2>
        {/* Pie Charts */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mb-6">
          <ExpensePieChart
            title={data.currentMonthLabel}
            data={expenses.currentMonth}
            total={expenses.currentTotal}
            currency={currency}
            formatCurrency={formatCurrencyCompact}
          />
          <ExpensePieChart
            title={data.previousMonthLabel}
            data={expenses.previousMonth}
            total={expenses.previousTotal}
            currency={currency}
            formatCurrency={formatCurrencyCompact}
          />
        </div>
        {/* Comparison Table */}
        {expenses.comparison.length > 0 && (
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-gray-200 dark:divide-gray-700">
              <thead>
                <tr>
                  <SortableHeader<ComparisonSortField>
                    field="category"
                    sortField={comparisonSort.sortField}
                    sortDirection={comparisonSort.sortDirection}
                    onSort={comparisonSort.handleSort}
                    className="px-4 py-3 text-xs font-medium text-gray-500 dark:text-gray-400 uppercase"
                  >
                    Category
                  </SortableHeader>
                  <SortableHeader<ComparisonSortField>
                    field="current"
                    sortField={comparisonSort.sortField}
                    sortDirection={comparisonSort.sortDirection}
                    onSort={comparisonSort.handleSort}
                    align="right"
                    className="px-4 py-3 text-xs font-medium text-gray-500 dark:text-gray-400 uppercase"
                  >
                    {data.currentMonthLabel}
                  </SortableHeader>
                  <SortableHeader<ComparisonSortField>
                    field="previous"
                    sortField={comparisonSort.sortField}
                    sortDirection={comparisonSort.sortDirection}
                    onSort={comparisonSort.handleSort}
                    align="right"
                    className="px-4 py-3 text-xs font-medium text-gray-500 dark:text-gray-400 uppercase"
                  >
                    {data.previousMonthLabel}
                  </SortableHeader>
                  <SortableHeader<ComparisonSortField>
                    field="change"
                    sortField={comparisonSort.sortField}
                    sortDirection={comparisonSort.sortDirection}
                    onSort={comparisonSort.handleSort}
                    align="right"
                    className="px-4 py-3 text-xs font-medium text-gray-500 dark:text-gray-400 uppercase"
                  >
                    Change
                  </SortableHeader>
                  <SortableHeader<ComparisonSortField>
                    field="changePercent"
                    sortField={comparisonSort.sortField}
                    sortDirection={comparisonSort.sortDirection}
                    onSort={comparisonSort.handleSort}
                    align="right"
                    className="px-4 py-3 text-xs font-medium text-gray-500 dark:text-gray-400 uppercase"
                  >
                    Change %
                  </SortableHeader>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-200 dark:divide-gray-700">
                {sortedComparison.map((item) => (
                  <tr key={item.categoryId || item.categoryName}>
                    <td className="px-4 py-3 text-sm text-gray-900 dark:text-gray-100 flex items-center gap-2">
                      {item.color && (
                        <span className="w-3 h-3 rounded-full flex-shrink-0" style={{ backgroundColor: item.color }} />
                      )}
                      {item.categoryName}
                    </td>
                    <td className="px-4 py-3 text-sm text-right text-gray-900 dark:text-gray-100">
                      {formatCurrency(item.currentTotal, currency)}
                    </td>
                    <td className="px-4 py-3 text-sm text-right text-gray-900 dark:text-gray-100">
                      {formatCurrency(item.previousTotal, currency)}
                    </td>
                    <td className={`px-4 py-3 text-sm text-right font-medium ${item.change <= 0 ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'}`}>
                      {item.change >= 0 ? '+' : ''}{formatCurrency(item.change, currency)}
                    </td>
                    <td className={`px-4 py-3 text-sm text-right font-medium ${item.changePercent <= 0 ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'}`}>
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
        <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-4">Top 5 Expense Categories</h2>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          <TopCategoriesTable
            title={data.currentMonthLabel}
            categories={topCategories.currentMonth}
            currency={currency}
            formatCurrency={formatCurrency}
          />
          <TopCategoriesTable
            title={data.previousMonthLabel}
            categories={topCategories.previousMonth}
            currency={currency}
            formatCurrency={formatCurrency}
          />
        </div>
      </div>

      {/* Net Worth */}
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 px-2 py-4 sm:p-6">
        <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-4">Your Net Worth</h2>
        {nw.monthlyHistory.length > 0 ? (
          <>
            <div className="h-72">
              <ResponsiveContainer width="100%" height="100%" minWidth={0}>
                <BarChart data={nw.monthlyHistory.map(p => ({
                  name: format(parseMonth(p.month), 'MMM yy'),
                  netWorth: Math.round(p.netWorth),
                }))} margin={{ top: 10, right: 10, left: 0, bottom: 5 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
                  <XAxis dataKey="name" tick={{ fontSize: 12 }} />
                  <YAxis tickFormatter={formatCurrencyAxis} tick={{ fontSize: 12 }} />
                  <Tooltip
                    formatter={(value) => [formatCurrencyCompact(Number(value), currency), 'Net Worth']}
                    contentStyle={{ backgroundColor: 'var(--tooltip-bg, #fff)', borderColor: 'var(--tooltip-border, #e5e7eb)' }}
                  />
                  <Bar dataKey="netWorth" fill="#14b8a6" radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
            <div className="mt-4 p-4 bg-gray-50 dark:bg-gray-700/30 rounded-lg">
              <p className="text-sm text-gray-700 dark:text-gray-300">
                Your net worth in {data.currentMonthLabel} was <span className="font-semibold">{formatCurrency(nw.currentNetWorth, currency)}</span>, which was{' '}
                <span className={`font-semibold ${gainLossColor(nw.netWorthChange)}`}>
                  {nw.netWorthChange >= 0 ? '+' : ''}{formatCurrency(nw.netWorthChange, currency)} ({formatSignedPercent(nw.netWorthChangePercent, 1)})
                </span>{' '}
                compared to {data.previousMonthLabel}.
              </p>
            </div>
          </>
        ) : (
          <p className="text-gray-500 dark:text-gray-400 text-center py-8">No net worth data available.</p>
        )}
      </div>

      {/* Investment Performance */}
      {(investments.accountPerformance.length > 0 || investments.topMovers.length > 0) && (
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 px-2 py-4 sm:p-6">
          <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-4">Investment Performance</h2>

          {investments.accountPerformance.length > 0 && (
            <>
              <div className="h-72 mb-6">
                <ResponsiveContainer width="100%" height="100%" minWidth={0}>
                  <BarChart
                    data={investments.accountPerformance.map(a => ({
                      name: a.accountName,
                      return: Number(a.annualizedReturn.toFixed(2)),
                    }))}
                    margin={{ top: 10, right: 10, left: 0, bottom: 5 }}
                    layout="vertical"
                  >
                    <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
                    <XAxis type="number" tickFormatter={(v: number) => `${v}%`} tick={{ fontSize: 12 }} />
                    <YAxis type="category" dataKey="name" tick={{ fontSize: 12 }} width={90} />
                    <Tooltip formatter={(value) => [`${Number(value).toFixed(2)}%`, 'Annualized Return']} />
                    <Bar
                      dataKey="return"
                      radius={[0, 4, 4, 0]}
                    >
                      {investments.accountPerformance.map((_, i) => (
                        <Cell
                          key={i}
                          fill={investments.accountPerformance[i].annualizedReturn >= 0 ? '#22c55e' : '#ef4444'}
                        />
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </>
          )}

          {investments.topMovers.length > 0 && (
            <div>
              <h3 className="text-base font-medium text-gray-900 dark:text-gray-100 mb-3">Top Movers</h3>
              <div className="overflow-x-auto">
                <table className="min-w-full divide-y divide-gray-200 dark:divide-gray-700">
                  <thead>
                    <tr>
                      <SortableHeader<TopMoversSortField>
                        field="symbol"
                        sortField={topMoversSort.sortField}
                        sortDirection={topMoversSort.sortDirection}
                        onSort={topMoversSort.handleSort}
                        className="px-4 py-3 text-xs font-medium text-gray-500 dark:text-gray-400 uppercase"
                      >
                        Symbol
                      </SortableHeader>
                      <SortableHeader<TopMoversSortField>
                        field="name"
                        sortField={topMoversSort.sortField}
                        sortDirection={topMoversSort.sortDirection}
                        onSort={topMoversSort.handleSort}
                        className="px-4 py-3 text-xs font-medium text-gray-500 dark:text-gray-400 uppercase"
                      >
                        Name
                      </SortableHeader>
                      <SortableHeader<TopMoversSortField>
                        field="price"
                        sortField={topMoversSort.sortField}
                        sortDirection={topMoversSort.sortDirection}
                        onSort={topMoversSort.handleSort}
                        align="right"
                        className="px-4 py-3 text-xs font-medium text-gray-500 dark:text-gray-400 uppercase"
                      >
                        Price
                      </SortableHeader>
                      <SortableHeader<TopMoversSortField>
                        field="change"
                        sortField={topMoversSort.sortField}
                        sortDirection={topMoversSort.sortDirection}
                        onSort={topMoversSort.handleSort}
                        align="right"
                        className="px-4 py-3 text-xs font-medium text-gray-500 dark:text-gray-400 uppercase"
                      >
                        Change
                      </SortableHeader>
                      <SortableHeader<TopMoversSortField>
                        field="changePercent"
                        sortField={topMoversSort.sortField}
                        sortDirection={topMoversSort.sortDirection}
                        onSort={topMoversSort.handleSort}
                        align="right"
                        className="px-4 py-3 text-xs font-medium text-gray-500 dark:text-gray-400 uppercase"
                      >
                        Change %
                      </SortableHeader>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-200 dark:divide-gray-700">
                    {sortedTopMovers.map((mover) => (
                      <tr key={mover.securityId}>
                        <td className="px-4 py-3 text-sm font-medium text-gray-900 dark:text-gray-100">{mover.symbol}</td>
                        <td className="px-4 py-3 text-sm text-gray-700 dark:text-gray-300">{mover.name}</td>
                        <td className="px-4 py-3 text-sm text-right text-gray-900 dark:text-gray-100">
                          {formatCurrency(mover.currentPrice, currency)}
                        </td>
                        <td className={`px-4 py-3 text-sm text-right font-medium ${gainLossColor(mover.change)}`}>
                          {mover.change >= 0 ? '+' : ''}{formatCurrency(mover.change, currency)}
                        </td>
                        <td className={`px-4 py-3 text-sm text-right font-medium ${gainLossColor(mover.changePercent)}`}>
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
  total,
  currency,
  formatCurrency,
}: {
  title: string;
  data: CategorySpendingSnapshot[];
  total: number;
  currency: string;
  formatCurrency: (amount: number, currency?: string) => string;
}) {
  if (data.length === 0) {
    return (
      <div className="text-center">
        <h3 className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">{title}</h3>
        <p className="text-gray-500 dark:text-gray-400 text-sm py-8">No expense data</p>
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
        Total: {formatCurrency(total, currency)}
      </div>
    </div>
  );
}

function TopCategoriesTable({
  title,
  categories,
  currency,
  formatCurrency,
}: {
  title: string;
  categories: CategorySpendingSnapshot[];
  currency: string;
  formatCurrency: (amount: number, currency?: string) => string;
}) {
  return (
    <div>
      <h3 className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">{title}</h3>
      {categories.length === 0 ? (
        <p className="text-gray-500 dark:text-gray-400 text-sm">No data</p>
      ) : (
        <table className="min-w-full divide-y divide-gray-200 dark:divide-gray-700">
          <thead>
            <tr>
              <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">#</th>
              <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">Category</th>
              <th className="px-3 py-2 text-right text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">Amount</th>
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
