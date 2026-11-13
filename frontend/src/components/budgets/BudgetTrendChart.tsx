'use client';

import { useTranslations } from 'next-intl';
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
} from 'recharts';
import { chartColors } from '@/lib/chart-colors';
import { useChartMonthFormat } from '@/hooks/useChartMonthFormat';
import type { BudgetTrendPoint } from '@/types/budget';
import { CHART_GRID_PROPS, CHART_TOOLTIP_CLASS } from '@/lib/chart-style';
import { ChartActiveDot } from '@/components/ui/ChartActiveDot';
import { BudgetTrendPartialNote } from './PartialTrendFigure';

interface BudgetTrendChartProps {
  data: BudgetTrendPoint[];
  formatCurrency: (amount: number) => string;
}

function CustomTooltip({
  active,
  payload,
  label,
  formatCurrency,
  budgetedLabel,
  actualLabel,
  formatChartMonth,
}: {
  active?: boolean;
  payload?: Array<{
    value: number;
    dataKey: string;
    color: string;
    payload?: BudgetTrendPoint;
  }>;
  label?: string;
  formatCurrency: (amount: number) => string;
  budgetedLabel: string;
  actualLabel: string;
  formatChartMonth: (monthKey: string) => string;
}) {
  const tReports = useTranslations('reports');
  if (!active || !payload || payload.length === 0) return null;
  const partialLabel = tReports('partialData.pdfSuffix');

  return (
    <div className={CHART_TOOLTIP_CLASS}>
      <p className="text-sm font-medium text-gray-900 dark:text-gray-100 mb-1">
        {formatChartMonth(String(label))}
      </p>
      {payload.map((entry) => (
        <p
          key={entry.dataKey}
          className="text-sm"
          style={{ color: entry.color }}
        >
          {entry.dataKey === 'budgeted' ? budgetedLabel : actualLabel}:{' '}
          {formatCurrency(entry.value)}
          {/* A partial month's actual is its converted part; the note under
              the chart says what is missing. */}
          {entry.dataKey === 'actual' &&
            entry.payload?.valuationComplete === false && (
              <span className="text-amber-600 dark:text-amber-400">
                {' '}
                {partialLabel}
              </span>
            )}
        </p>
      ))}
    </div>
  );
}

export function BudgetTrendChart({
  data,
  formatCurrency,
}: BudgetTrendChartProps) {
  const t = useTranslations('budgets');
  // A month marker on a CHART localizes the month name (`Jan 2026`), the way
  // every other chart in the app does. `useDateFormat().formatMonth` follows
  // the date-format preference instead, which renders most preferences as a
  // numeric `01/2026` -- right for a table's month column, wrong for an axis.
  const formatChartMonth = useChartMonthFormat();
  const budgetedLabel = t('trendChart.budgeted');
  const actualLabel = t('trendChart.actual');

  if (data.length === 0) {
    return (
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-4 sm:p-6">
        <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-4">
          {t('trendChart.title')}
        </h2>
        <p className="text-sm text-gray-500 dark:text-gray-400">
          {t('trendChart.empty')}
        </p>
      </div>
    );
  }

  return (
    <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-4 sm:p-6">
      <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-4">
        {t('trendChart.title')}
      </h2>
      <div className="h-64">
        <ResponsiveContainer width="100%" height="100%" minWidth={0}>
          <LineChart data={data}>
            <CartesianGrid {...CHART_GRID_PROPS} />
            <XAxis
              dataKey="monthKey"
              tick={{ fontSize: 12 }}
              className="text-gray-500"
              tickFormatter={(value: string) => formatChartMonth(value)}
            />
            <YAxis
              tick={{ fontSize: 12 }}
              className="text-gray-500"
              tickFormatter={(value) => formatCurrency(value)}
            />
            <Tooltip
              content={
                <CustomTooltip
                  formatCurrency={formatCurrency}
                  formatChartMonth={formatChartMonth}
                  budgetedLabel={budgetedLabel}
                  actualLabel={actualLabel}
                />
              }
            />
            <Legend />
            <Line
              activeDot={ChartActiveDot}
              type="monotone"
              dataKey="budgeted"
              stroke={chartColors.primary}
              strokeWidth={2}
              strokeDasharray="5 5"
              dot={{ r: 4 }}
              name={budgetedLabel}
            />
            <Line
              activeDot={ChartActiveDot}
              type="monotone"
              dataKey="actual"
              stroke={chartColors.income}
              strokeWidth={2}
              dot={{ r: 4 }}
              name={actualLabel}
            />
          </LineChart>
        </ResponsiveContainer>
      </div>
      <BudgetTrendPartialNote points={data} />
    </div>
  );
}
