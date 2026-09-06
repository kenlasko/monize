'use client';

import { useState, useEffect, useMemo, useRef } from 'react';
import { useTranslations } from 'next-intl';
import { gainLossColor } from '@/lib/format';
import { Skeleton } from '@/components/ui/LoadingSkeleton';
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ReferenceLine,
  ResponsiveContainer,
} from 'recharts';
import { budgetsApi } from '@/lib/budgets';
import { chartColors } from '@/lib/chart-colors';
import type { Budget, SavingsRatePoint } from '@/types/budget';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import { ExportDropdown } from '@/components/ui/ExportDropdown';
import { SortableHeader } from '@/components/ui/SortableHeader';
import { CellLabel } from '@/components/ui/Table';
import { useSortableTable, compareValues } from '@/hooks/useSortableTable';
import { useReportData } from '@/hooks/useReportData';
import { ReportError } from '@/components/reports/ReportError';
import { createLogger } from '@/lib/logger';

const logger = createLogger('SavingsRateReport');

type SavingsRateSortField = 'month' | 'income' | 'expenses' | 'savings' | 'rate';

/**
 * One sortable column of the monthly-breakdown table. The five are declared
 * once and rendered by BOTH header rows -- the column header row (from `sm`
 * up) and the phone sort strip -- so the two can never list different fields.
 */
interface SortColumn {
  field: SavingsRateSortField;
  label: string;
  /** Money columns are right-aligned in the column header row. */
  align?: 'right';
  /**
   * The last column carries no right padding, exactly as it does today. This
   * flag is the ONE place that is decided: the header cell and the body cell
   * both read it (`headerClass` / `cellPadding`), so reordering the list
   * cannot leave the two disagreeing about which column drops its `pr-4`.
   */
  last?: boolean;
}

// Today's header cell, unchanged.
const headerClass = (col: SortColumn) =>
  col.last
    ? 'py-2 font-medium text-gray-500 dark:text-gray-400'
    : 'py-2 pr-4 font-medium text-gray-500 dark:text-gray-400';

// Today's body cell padding, restored from `sm` up and absent below it (the
// wrapped row supplies the vertical inset and the grid does the spacing).
const cellPadding = (col: SortColumn) => (col.last ? 'sm:py-2' : 'sm:py-2 sm:pr-4');

// The same sort controls in the phone strip: a wrapped row of compact chips.
// Column alignment means nothing there -- the column header row is hidden and
// each data row is a grid -- so every control is left-aligned and self-naming.
// The border is what says "tappable" here: there is no hover on a touch screen,
// and the strip sits directly on the card, whose background this already is --
// so the border is the whole of the affordance. (The class is kept identical to
// the two sibling report tables that ship this strip, where the background does
// separate the chip from a tinted header; the three copies are one of the
// duplications the converted-table consolidation pass folds into one home.)
const PHONE_HEADER_CLASS =
  'rounded border border-gray-200 bg-white px-2 py-1.5 text-xs font-medium text-gray-500 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-400 uppercase';

// A money (or rate) cell inside a wrapped row: no padding of its own below
// `sm` and this table's own from `sm` up, which each cell adds through
// `cellPadding` so "which column is last" stays decided in one place. Smaller
// type on phones so a seven-figure amount still fits a third of the width.
//
// `whitespace-nowrap` is the one property here that is NOT phone-only, and it
// is deliberate: `formatCurrencyCompact` groups thousands, and a locale that
// groups them with a space (`1 234 567 zł`) could otherwise break a figure in
// the middle at any width -- so the ban holds above `sm` too. That is the
// single respect in which the desktop cell differs from today's.
//
// The budget was measured on a hand-written CSS replica in Chromium, at the
// insets this table really gets on a phone (the report page's `px-4` plus the
// card's `p-4`): the three equal tracks are 77px at 320px and 101px at 390px,
// which holds a seven-figure `pl-PL` amount (`1 234 567 zł`, 77px at
// `text-xs`) at both widths, and a six-figure one with room to spare.
//
// The unit is part of that budget, and it is not always a symbol:
// `formatCurrencyCompact` asks for `narrowSymbol`, which falls back to the ISO
// code where a currency has none (`1 439 000 CHF`, 89px). A seven-figure
// amount in such a currency overflows the third track by 12px at 320px and
// reopens the wrapper's sideways scroll; at 390px it fits. That is the
// deliberate failure, not a missed case: right alignment is not a containment
// device -- a nowrap amount longer than its track overflows past the end edge
// whatever `text-align` says -- and `overflow-hidden` here would silently cut
// a figure, which is worse than a crowded one or an honest scroll. (Today,
// before this layout, the same reader scrolled at every width: the five-column
// table is 470px wide in that 256px box.)
//
// The caption inside the cell wraps even though the cell does not: `white-space`
// is inherited, so `CellLabel` takes `whitespace-normal` back for itself (a
// caption with no space in it, `[XX-Expenses-XX]` in the pseudo-locale, once
// overflowed the third track by 20px at 320px -- the very scroll this layout
// removes). A number must not break; a caption may.
const MONEY_CELL = 'p-0 text-right text-xs whitespace-nowrap sm:table-cell sm:text-sm';

/** Every caption in a wrapped cell is phone-only. */
const CAPTION_CLASS = 'sm:hidden';

export function SavingsRateReport() {
  const t = useTranslations('reports');
  const { formatCurrencyCompact: formatCurrency, formatPercent, formatPercentTrimmed } = useNumberFormat();
  const chartRef = useRef<HTMLDivElement>(null);
  const [budgets, setBudgets] = useState<Budget[]>([]);
  const [selectedBudgetId, setSelectedBudgetId] = useState<string>('');
  const [months, setMonths] = useState(12);
  const [targetRate, setTargetRate] = useState(20);
  const { sortField, sortDirection, handleSort } = useSortableTable<SavingsRateSortField>(
    'reports.savings-rate.sort',
    { field: 'month', direction: 'asc' },
  );

  const { data: response, isLoading, error, reload } = useReportData(
    () =>
      selectedBudgetId
        ? budgetsApi.getSavingsRate(selectedBudgetId, months)
        : Promise.resolve(null),
    [selectedBudgetId, months],
  );

  const data = useMemo<SavingsRatePoint[]>(() => response ?? [], [response]);

  const sortedData = useMemo(() => {
    const sorted = [...data];
    sorted.sort((a, b) => {
      let comparison = 0;
      switch (sortField) {
        case 'month':
          comparison = compareValues(a.month, b.month);
          break;
        case 'income':
          comparison = compareValues(a.income, b.income);
          break;
        case 'expenses':
          comparison = compareValues(a.expenses, b.expenses);
          break;
        case 'savings':
          comparison = compareValues(a.savings, b.savings);
          break;
        case 'rate':
          comparison = compareValues(a.savingsRate, b.savingsRate);
          break;
      }
      return sortDirection === 'asc' ? comparison : -comparison;
    });
    return sorted;
  }, [data, sortField, sortDirection]);

  // The five sortable columns, keyed by field so the record is exhaustive:
  // adding a member to `SavingsRateSortField` is a compile error here rather
  // than a body cell that renders `undefined` in place of its padding.
  const columns: Record<SavingsRateSortField, SortColumn> = {
    month: { field: 'month', label: t('savingsRate.colMonth') },
    income: { field: 'income', label: t('savingsRate.colIncome'), align: 'right' },
    expenses: { field: 'expenses', label: t('savingsRate.colExpenses'), align: 'right' },
    savings: { field: 'savings', label: t('savingsRate.colSavings'), align: 'right' },
    rate: { field: 'rate', label: t('savingsRate.colRate'), align: 'right', last: true },
  };

  // Their order, rendered by BOTH header rows and matched by the cells' DOM
  // order. DERIVED from the record rather than re-listed: a hand-written list
  // beside an exhaustive record is not exhaustive, so a field added to the
  // union would compile and still ship with no sort control in either header.
  // The record's declaration order is the column order. Every body cell takes
  // its `sm`-and-up padding from the same record, so the header and the cells
  // cannot disagree about which column is last and drops its right padding.
  const sortColumns: readonly SortColumn[] = Object.values(columns);

  useEffect(() => {
    const loadBudgets = async () => {
      try {
        const budgetList = await budgetsApi.getAll();
        setBudgets(budgetList);
        const active = budgetList.find((b) => b.isActive);
        if (active) {
          setSelectedBudgetId(active.id);
        } else if (budgetList.length > 0) {
          setSelectedBudgetId(budgetList[0].id);
        }
      } catch (error) {
        logger.error('Failed to load budgets:', error);
      }
    };
    loadBudgets();
  }, []);

  const handleExportPdf = async () => {
    const { exportToPdf } = await import('@/lib/pdf-export');
    await exportToPdf({
      title: t('savingsRate.pdfTitle'),
      summaryCards: [
        { label: t('savingsRate.pdfCurrentRate'), value: formatPercent(currentRate, 1), color: meetsTarget ? '#16a34a' : '#dc2626' },
        { label: t('savingsRate.pdfAverageRate'), value: formatPercent(avgRate, 1), color: '#111827' },
        { label: t('savingsRate.pdfTargetRate'), value: `${formatPercentTrimmed(targetRate)}`, color: '#2563eb' },
        { label: t('savingsRate.pdfTotalSaved'), value: formatCurrency(totalSaved), color: totalSaved >= 0 ? '#16a34a' : '#dc2626' },
      ],
      chartContainer: chartRef.current,
      additionalTables: data.length > 0 ? [{
        title: t('savingsRate.pdfBreakdownTitle'),
        headers: [
          t('savingsRate.pdfColMonth'),
          t('savingsRate.pdfColIncome'),
          t('savingsRate.pdfColExpenses'),
          t('savingsRate.pdfColSavings'),
          t('savingsRate.pdfColRate'),
        ],
        rows: data.map((point) => [
          point.month,
          formatCurrency(point.income),
          formatCurrency(point.expenses),
          formatCurrency(point.savings),
          formatPercent(point.savingsRate, 1),
        ]),
      }] : undefined,
      filename: 'savings-rate',
    });
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
          {t('savingsRate.noBudgets')}
        </p>
      </div>
    );
  }

  const avgRate = data.length > 0
    ? data.reduce((s, p) => s + p.savingsRate, 0) / data.length
    : 0;
  const currentRate = data.length > 0 ? data[data.length - 1].savingsRate : 0;
  const totalSaved = data.reduce((s, p) => s + p.savings, 0);
  const meetsTarget = currentRate >= targetRate;

  return (
    <div ref={chartRef} className="space-y-6">
      {/* Controls */}
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-4">
        <div className="flex flex-wrap gap-3 items-center">
          <select
            value={selectedBudgetId}
            onChange={(e) => setSelectedBudgetId(e.target.value)}
            className="px-3 py-2 text-sm border border-gray-300 dark:border-gray-600 rounded-md bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100"
          >
            {budgets.map((b) => (
              <option key={b.id} value={b.id}>{b.name}</option>
            ))}
          </select>
          <select
            value={months}
            onChange={(e) => setMonths(Number(e.target.value))}
            className="px-3 py-2 text-sm border border-gray-300 dark:border-gray-600 rounded-md bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100"
          >
            <option value={6}>{t('savingsRate.months6')}</option>
            <option value={12}>{t('savingsRate.months12')}</option>
            <option value={24}>{t('savingsRate.months24')}</option>
          </select>
          <div className="flex items-center gap-2">
            <label className="text-sm text-gray-600 dark:text-gray-400 whitespace-nowrap">{t('savingsRate.targetLabel')}</label>
            <select
              value={targetRate}
              onChange={(e) => setTargetRate(Number(e.target.value))}
              className="px-2 py-2 text-sm border border-gray-300 dark:border-gray-600 rounded-md bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100"
            >
              <option value={10}>10%</option>
              <option value={15}>15%</option>
              <option value={20}>20%</option>
              <option value={25}>25%</option>
              <option value={30}>30%</option>
              <option value={50}>50%</option>
            </select>
          </div>
          <div className="ml-auto">
            <ExportDropdown onExportPdf={handleExportPdf} />
          </div>
        </div>
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-4 text-center">
          <p className="text-xs text-gray-500 dark:text-gray-400">{t('savingsRate.currentRate')}</p>
          <p className={`text-2xl font-bold ${meetsTarget ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'}`}>
            {formatPercent(currentRate, 1)}
          </p>
        </div>
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-4 text-center">
          <p className="text-xs text-gray-500 dark:text-gray-400">{t('savingsRate.averageRate')}</p>
          <p className="text-2xl font-bold text-gray-900 dark:text-gray-100">
            {formatPercent(avgRate, 1)}
          </p>
        </div>
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-4 text-center">
          <p className="text-xs text-gray-500 dark:text-gray-400">{t('savingsRate.targetRate')}</p>
          <p className="text-2xl font-bold text-blue-600 dark:text-blue-400">
            {formatPercentTrimmed(targetRate)}
          </p>
        </div>
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-4 text-center">
          <p className="text-xs text-gray-500 dark:text-gray-400">{t('savingsRate.totalSaved')}</p>
          <p className={`text-2xl font-bold ${gainLossColor(totalSaved)}`}>
            {formatCurrency(totalSaved)}
          </p>
        </div>
      </div>

      {/* Chart */}
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 px-2 py-4 sm:p-6">
        {data.length === 0 ? (
          <p className="text-gray-500 dark:text-gray-400 text-center py-8">
            {t('savingsRate.noData')}
          </p>
        ) : (
          <div className="h-80">
            <ResponsiveContainer width="100%" height="100%" minWidth={0}>
              <LineChart data={data}>
                <CartesianGrid strokeDasharray="3 3" className="opacity-30" />
                <XAxis dataKey="month" tick={{ fontSize: 12 }} />
                <YAxis
                  tickFormatter={(v) => `${formatPercentTrimmed(v)}`}
                  tick={{ fontSize: 12 }}
                  domain={['auto', 'auto']}
                />
                <Tooltip
                  content={({ active, payload, label }) => {
                    if (!active || !payload || payload.length === 0) return null;
                    const point = payload[0]?.payload as SavingsRatePoint | undefined;
                    if (!point) return null;
                    return (
                      <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg shadow-lg p-3">
                        <p className="text-sm font-medium text-gray-900 dark:text-gray-100 mb-1">{label}</p>
                        <p className="text-sm text-gray-600 dark:text-gray-400">{t('savingsRate.tooltipIncome', { amount: formatCurrency(point.income) })}</p>
                        <p className="text-sm text-gray-600 dark:text-gray-400">{t('savingsRate.tooltipExpenses', { amount: formatCurrency(point.expenses) })}</p>
                        <p className="text-sm text-gray-600 dark:text-gray-400">{t('savingsRate.tooltipSavings', { amount: formatCurrency(point.savings) })}</p>
                        <p className={`text-sm font-medium ${point.savingsRate >= targetRate ? 'text-green-600' : 'text-red-600'}`}>
                          {t('savingsRate.tooltipRate', { rate: point.savingsRate.toFixed(1) })}
                        </p>
                      </div>
                    );
                  }}
                />
                <Legend />
                <ReferenceLine
                  y={targetRate}
                  stroke={chartColors.primary}
                  strokeDasharray="3 3"
                  label={{ value: t('savingsRate.targetPrefix', { rate: targetRate }), position: 'right', fill: chartColors.primary, fontSize: 11 }}
                />
                <ReferenceLine y={0} stroke={chartColors.axis} />
                <Line
                  type="monotone"
                  dataKey="savingsRate"
                  stroke={chartColors.income}
                  strokeWidth={2}
                  dot={{ r: 4 }}
                  name={t('savingsRate.seriesSavingsRate')}
                />
              </LineChart>
            </ResponsiveContainer>
          </div>
        )}
      </div>

      {/* Monthly breakdown table */}
      {data.length > 0 && (
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-4 sm:p-6">
          <h3 className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-3">{t('savingsRate.monthlyBreakdown')}</h3>
          {/* Below `sm` the table becomes a block and each row wraps into a
              three-column grid so all five columns fit a phone without a
              horizontal scroll, on two lines: the month, its savings and its
              income share line 1; the savings rate (spanning the first two
              tracks) and the expenses share line 2. Each derived figure sits
              under the figure it derives from -- rate under savings, expenses
              under income -- and the month is the one cell allowed to wrap,
              since a compact amount never may. No column is dropped, and no
              figure is truncated -- an amount wider than its track overflows
              the end edge and reopens the wrapper's scroll, which `MONEY_CELL`
              measures and argues for. From `sm` up it is the
              ordinary table: each cell restores this table's own `py-2 pr-4`
              (and the Rate column's bare `py-2`) through `cellPadding`, and a
              Chromium replica renders it pixel-identically to today at 800px.
              The one deliberate difference above `sm` is `whitespace-nowrap`
              on the figures, for the reason `MONEY_CELL` gives. The sort
              controls survive as their own phone-only header row, because the
              column header row that carries them on desktop is hidden there.

              Two costs of restyling one tree, both deliberate. Changing the
              display roles drops the table semantics below `sm`, which is why
              the roles are restated explicitly and every figure carries a
              `CellLabel` naming its column -- the month needs none, being the
              row's identity rather than one of its figures. And the phone
              reading order differs from the DOM order, which is the desktop
              column order the grid placement overrides visually. Both are
              properties of the mechanism, not of this table. */}
          <div className="overflow-x-auto">
            <table role="table" className="block min-w-full text-sm sm:table">
              <thead role="rowgroup" className="block sm:table-header-group">
                {/* Phone sort strip: the same five controls, wrapped. */}
                <tr role="row" className="flex flex-wrap gap-x-2 gap-y-1 pb-2 border-b border-gray-200 dark:border-gray-700 sm:hidden">
                  {sortColumns.map((col) => (
                    <SortableHeader<SavingsRateSortField>
                      key={col.field}
                      field={col.field}
                      sortField={sortField}
                      sortDirection={sortDirection}
                      onSort={handleSort}
                      className={PHONE_HEADER_CLASS}
                    >
                      {col.label}
                    </SortableHeader>
                  ))}
                </tr>
                <tr role="row" className="hidden border-b border-gray-200 dark:border-gray-700 sm:table-row">
                  {sortColumns.map((col) => (
                    <SortableHeader<SavingsRateSortField>
                      key={col.field}
                      field={col.field}
                      sortField={sortField}
                      sortDirection={sortDirection}
                      onSort={handleSort}
                      align={col.align}
                      className={headerClass(col)}
                    >
                      {col.label}
                    </SortableHeader>
                  ))}
                </tr>
              </thead>
              <tbody role="rowgroup" className="block sm:table-row-group">
                {sortedData.map((point) => (
                  <tr
                    key={point.month}
                    role="row"
                    className="grid grid-cols-3 items-start gap-x-3 gap-y-1.5 py-2 border-b border-gray-100 dark:border-gray-700/50 sm:table-row sm:py-0"
                  >
                    <td role="cell" className={`col-start-1 row-start-1 p-0 text-gray-900 dark:text-gray-100 sm:table-cell ${cellPadding(columns.month)}`}>{point.month}</td>
                    <td role="cell" className={`col-start-3 row-start-1 text-gray-600 dark:text-gray-400 ${cellPadding(columns.income)} ${MONEY_CELL}`}>
                      <CellLabel className={CAPTION_CLASS}>{t('savingsRate.colIncome')}</CellLabel>
                      {formatCurrency(point.income)}
                    </td>
                    <td role="cell" className={`col-start-3 row-start-2 text-gray-600 dark:text-gray-400 ${cellPadding(columns.expenses)} ${MONEY_CELL}`}>
                      <CellLabel className={CAPTION_CLASS}>{t('savingsRate.colExpenses')}</CellLabel>
                      {formatCurrency(point.expenses)}
                    </td>
                    {/* Savings takes the middle of line 1 beside the month:
                        it is the figure the row is read for. */}
                    <td role="cell" className={`col-start-2 row-start-1 font-medium ${gainLossColor(point.savings)} ${cellPadding(columns.savings)} ${MONEY_CELL}`}>
                      <CellLabel className={CAPTION_CLASS}>{t('savingsRate.colSavings')}</CellLabel>
                      {formatCurrency(point.savings)}
                    </td>
                    {/* The rate spans the first two tracks so it has room
                        beneath the savings it is derived from; right-aligned,
                        it ends under that figure. */}
                    <td role="cell" className={`col-start-1 col-span-2 row-start-2 font-medium ${point.savingsRate >= targetRate ? 'text-green-600 dark:text-green-400' : point.savingsRate >= 0 ? 'text-yellow-600 dark:text-yellow-400' : 'text-red-600 dark:text-red-400'} ${cellPadding(columns.rate)} ${MONEY_CELL}`}>
                      <CellLabel className={CAPTION_CLASS}>{t('savingsRate.colRate')}</CellLabel>
                      {formatPercent(point.savingsRate, 1)}
                    </td>
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
