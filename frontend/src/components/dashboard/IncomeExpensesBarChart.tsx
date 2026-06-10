'use client';

import { useMemo, useRef } from 'react';
import { gainLossColor } from '@/lib/format';
import { Skeleton } from '@/components/ui/LoadingSkeleton';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
} from 'recharts';
import { format, startOfWeek, endOfWeek, eachWeekOfInterval, subWeeks } from 'date-fns';
import { chartColors } from '@/lib/chart-colors';
import { Transaction } from '@/types/transaction';
import { parseLocalDate } from '@/lib/utils';
import { useDateFormat } from '@/hooks/useDateFormat';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import { useExchangeRates } from '@/hooks/useExchangeRates';
import { usePreferencesStore } from '@/store/preferencesStore';

function IncomeExpensesTooltip({
  active,
  payload,
  label,
  formatCurrency,
  weekOfLabel,
}: {
  active?: boolean;
  payload?: Array<{ name: string; value: number; color: string }>;
  label?: string;
  formatCurrency: (v: number) => string;
  weekOfLabel: (date: string) => string;
}) {
  if (active && payload && payload.length) {
    return (
      <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg shadow-lg p-3">
        <p className="font-medium text-gray-900 dark:text-gray-100 mb-1">
          {weekOfLabel(label ?? '')}
        </p>
        {payload.map((entry, index) => (
          <p
            key={index}
            className="text-sm"
            style={{ color: entry.color }}
          >
            {entry.name}: {formatCurrency(entry.value)}
          </p>
        ))}
      </div>
    );
  }
  return null;
}

interface IncomeExpensesBarChartProps {
  transactions: Transaction[];
  isLoading: boolean;
}

export function IncomeExpensesBarChart({
  transactions,
  isLoading,
}: IncomeExpensesBarChartProps) {
  const t = useTranslations('dashboard');
  const router = useRouter();
  const { formatDate } = useDateFormat();
  const { formatCurrencyCompact: formatCurrency, formatCurrencyAxis } = useNumberFormat();
  const { convertToDefault } = useExchangeRates();
  const weekStartsOn = (usePreferencesStore((s) => s.preferences?.weekStartsOn) ?? 1) as 0 | 1 | 2 | 3 | 4 | 5 | 6;

  // Group transactions by week and calculate income/expenses
  const chartData = useMemo(() => {
    const today = new Date();
    const currentWeekStart = startOfWeek(today, { weekStartsOn });
    const fiveWeeksAgoStart = subWeeks(currentWeekStart, 4);

    // Get 5 weeks: 4 complete past weeks + current partial week
    const weeks = eachWeekOfInterval(
      { start: fiveWeeksAgoStart, end: today },
      { weekStartsOn }
    );

    const weekData = weeks.map((weekStart) => {
      const weekEnd = endOfWeek(weekStart, { weekStartsOn });
      return {
        weekStart,
        weekEnd,
        label: formatDate(weekStart),
        income: 0,
        expenses: 0,
      };
    });

    // Aggregate transactions by week
    transactions.forEach((tx) => {
      // Skip transfers and investment account transactions
      if (tx.isTransfer) return;
      if (tx.account?.accountType === 'INVESTMENT') return;

      const txDate = parseLocalDate(tx.transactionDate);
      const txWeekStart = startOfWeek(txDate, { weekStartsOn });

      const weekBucket = weekData.find(
        (w) => w.weekStart.getTime() === txWeekStart.getTime()
      );

      if (weekBucket) {
        const classifyAmount = (rawAmount: number, category: { isIncome: boolean } | null | undefined) => {
          const amount = convertToDefault(rawAmount, tx.currencyCode);
          if (category?.isIncome === true) {
            weekBucket.income += amount;
          } else if (category?.isIncome === false) {
            weekBucket.expenses += -1 * amount;
          } else {
            // Uncategorized: fall back to sign-based
            if (amount >= 0) {
              weekBucket.income += amount;
            } else {
              weekBucket.expenses += Math.abs(amount);
            }
          }
        };

        if (tx.splits && tx.splits.length > 0) {
          tx.splits.forEach((split) => {
            if (split.transferAccountId) return;
            classifyAmount(Number(split.amount) || 0, split.category);
          });
        } else {
          classifyAmount(Number(tx.amount) || 0, tx.category);
        }
      }
    });

    return weekData.map((w) => ({
      name: w.label,
      Income: Math.round(w.income),
      Expenses: Math.round(w.expenses),
      startDate: format(w.weekStart, 'yyyy-MM-dd'),
      endDate: format(w.weekEnd, 'yyyy-MM-dd'),
    }));
  }, [transactions, formatDate, convertToDefault, weekStartsOn]);

  const barClickedRef = useRef(false);

  const handleBarClick = (categoryType: 'income' | 'expense') => (data: { payload?: { startDate?: string; endDate?: string } }) => {
    barClickedRef.current = true;
    const startDate = data.payload?.startDate;
    const endDate = data.payload?.endDate;
    if (startDate && endDate) {
      router.push(`/transactions?startDate=${startDate}&endDate=${endDate}&categoryType=${categoryType}`);
    }
  };

  const handleChartClick = (state: { activeLabel?: string | number } | null) => {
    if (barClickedRef.current) {
      barClickedRef.current = false;
      return;
    }
    const label = state?.activeLabel;
    if (!label) return;
    const item = chartData.find((d) => d.name === label);
    if (item?.startDate && item?.endDate) {
      router.push(`/transactions?startDate=${item.startDate}&endDate=${item.endDate}`);
    }
  };

  const totals = useMemo(() => {
    return chartData.reduce(
      (acc, week) => ({
        income: acc.income + week.Income,
        expenses: acc.expenses + week.Expenses,
      }),
      { income: 0, expenses: 0 }
    );
  }, [chartData]);

  if (isLoading) {
    return (
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-3 sm:p-6 lg:min-h-[540px]">
        <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-4">
          {t('incomeExpenses.title')}
        </h3>
        <div className="h-64 flex items-center justify-center">
          <Skeleton className="w-full h-full" />
        </div>
      </div>
    );
  }

  return (
    <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-3 sm:p-6 lg:min-h-[540px] flex flex-col h-full">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
          {t('incomeExpenses.title')}
        </h3>
        <span className="text-sm text-gray-500 dark:text-gray-400">{t('incomeExpenses.last5Weeks')}</span>
      </div>
      <div className="flex-1 min-h-[16rem]">
        <ResponsiveContainer width="100%" height="100%" minWidth={0}>
          <BarChart
            data={chartData}
            barGap={4}
            margin={{ top: 5, right: 5, left: -10, bottom: 0 }}
            onClick={handleChartClick}
            style={{ cursor: 'pointer' }}
          >
            <CartesianGrid strokeDasharray="3 3" stroke={chartColors.grid} />
            <XAxis
              dataKey="name"
              tick={{ fill: chartColors.axis, fontSize: 12 }}
              tickLine={false}
              axisLine={{ stroke: chartColors.grid }}
            />
            <YAxis
              tick={{ fill: chartColors.axis, fontSize: 12 }}
              tickLine={false}
              axisLine={{ stroke: chartColors.grid }}
              tickFormatter={formatCurrencyAxis}
            />
            <Tooltip content={<IncomeExpensesTooltip formatCurrency={formatCurrency} weekOfLabel={(date) => t('incomeExpenses.weekOf', { date })} />} />
            <Legend
              wrapperStyle={{ paddingTop: '1rem' }}
              formatter={(value) => (
                <span className="text-gray-600 dark:text-gray-400">{value}</span>
              )}
            />
            <Bar
              dataKey="Income"
              fill={chartColors.income}
              radius={[4, 4, 0, 0]}
              maxBarSize={40}
              cursor="pointer"
              onClick={handleBarClick('income')}
            />
            <Bar
              dataKey="Expenses"
              fill={chartColors.expense}
              radius={[4, 4, 0, 0]}
              maxBarSize={40}
              cursor="pointer"
              onClick={handleBarClick('expense')}
            />
          </BarChart>
        </ResponsiveContainer>
      </div>
      <div className="pt-4 border-t border-gray-200 dark:border-gray-700 grid grid-cols-3 gap-4 text-center">
        <div>
          <div className="text-sm text-gray-500 dark:text-gray-400">{t('incomeExpenses.income')}</div>
          <div className="font-semibold text-green-600 dark:text-green-400">
            {formatCurrency(totals.income)}
          </div>
        </div>
        <div>
          <div className="text-sm text-gray-500 dark:text-gray-400">{t('incomeExpenses.expenses')}</div>
          <div className="font-semibold text-red-600 dark:text-red-400">
            {formatCurrency(totals.expenses)}
          </div>
        </div>
        <div>
          <div className="text-sm text-gray-500 dark:text-gray-400">{t('incomeExpenses.net')}</div>
          <div
            className={`font-semibold ${gainLossColor(totals.income - totals.expenses)}`}
          >
            {formatCurrency(totals.income - totals.expenses)}
          </div>
        </div>
      </div>
    </div>
  );
}
