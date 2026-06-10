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

interface TrendDataPoint {
  month: string;
  budgeted: number;
  actual: number;
}

interface BudgetTrendChartProps {
  data: TrendDataPoint[];
  formatCurrency: (amount: number) => string;
}

function CustomTooltip({
  active,
  payload,
  label,
  formatCurrency,
  budgetedLabel,
  actualLabel,
}: {
  active?: boolean;
  payload?: Array<{ value: number; dataKey: string; color: string }>;
  label?: string;
  formatCurrency: (amount: number) => string;
  budgetedLabel: string;
  actualLabel: string;
}) {
  if (!active || !payload || payload.length === 0) return null;

  return (
    <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg shadow-lg p-3">
      <p className="text-sm font-medium text-gray-900 dark:text-gray-100 mb-1">
        {label}
      </p>
      {payload.map((entry) => (
        <p
          key={entry.dataKey}
          className="text-sm"
          style={{ color: entry.color }}
        >
          {entry.dataKey === 'budgeted' ? budgetedLabel : actualLabel}:{' '}
          {formatCurrency(entry.value)}
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
            <CartesianGrid strokeDasharray="3 3" className="opacity-30" />
            <XAxis
              dataKey="month"
              tick={{ fontSize: 12 }}
              className="text-gray-500"
            />
            <YAxis
              tick={{ fontSize: 12 }}
              className="text-gray-500"
              tickFormatter={(value) => formatCurrency(value)}
            />
            <Tooltip
              content={
                <CustomTooltip formatCurrency={formatCurrency} budgetedLabel={budgetedLabel} actualLabel={actualLabel} />
              }
            />
            <Legend />
            <Line
              type="monotone"
              dataKey="budgeted"
              stroke={chartColors.primary}
              strokeWidth={2}
              strokeDasharray="5 5"
              dot={{ r: 4 }}
              name={budgetedLabel}
            />
            <Line
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
    </div>
  );
}
