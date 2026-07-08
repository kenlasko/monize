'use client';

import { useMemo, useRef } from 'react';
import { gainLossColor } from '@/lib/format';
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
import {
  format,
  startOfWeek,
  endOfWeek,
  eachWeekOfInterval,
  startOfMonth,
  endOfMonth,
  eachMonthOfInterval,
} from 'date-fns';
import { chartColors } from '@/lib/chart-colors';
import { Account } from '@/types/account';
import { parseLocalDate } from '@/lib/utils';
import { transactionsApi } from '@/lib/transactions';
import { useDateFormat } from '@/hooks/useDateFormat';
import { useChartDateFormat } from '@/hooks/useChartDateFormat';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import { useExchangeRates } from '@/hooks/useExchangeRates';
import { useReportData } from '@/hooks/useReportData';
import { useWidgetConfig } from '@/hooks/useWidgetConfig';
import { usePreferencesStore } from '@/store/preferencesStore';
import { resolveRangePreset } from '@/lib/date-range';
import { DateRangeSelector } from '@/components/ui/DateRangeSelector';
import { ReportAccountMultiSelect } from '@/components/reports/ReportAccountMultiSelect';
import { WidgetCard, WidgetConfigRow } from './WidgetCard';
import {
  INCOME_EXPENSES_DEFAULT,
  SPENDING_RANGES,
  RangeAccountsConfig,
} from './widget-config';

const WIDGET_ID = 'income-expenses';

// The recent-weeks view stays weekly; longer windows switch to monthly buckets
// so a year does not render 52 bars in a compact card.
const WEEKLY_RANGE = '1m';

const nonInvestmentAccounts = (a: Account) => a.accountType !== 'INVESTMENT';

function IncomeExpensesTooltip({
  active,
  payload,
  label,
  formatCurrency,
  periodLabel,
}: {
  active?: boolean;
  payload?: Array<{ name: string; value: number; color: string }>;
  label?: string;
  formatCurrency: (v: number) => string;
  periodLabel: (label: string) => string;
}) {
  if (active && payload && payload.length) {
    return (
      <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg shadow-lg p-3">
        <p className="font-medium text-gray-900 dark:text-gray-100 mb-1">
          {periodLabel(label ?? '')}
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
  accounts: Account[];
  isLoading: boolean;
}

export function IncomeExpensesBarChart({
  accounts,
  isLoading,
}: IncomeExpensesBarChartProps) {
  const t = useTranslations('dashboard');
  const router = useRouter();
  const { formatDate } = useDateFormat();
  const formatChartDate = useChartDateFormat();
  const { formatCurrencyCompact: formatCurrency, formatCurrencyAxis } = useNumberFormat();
  const { convertToDefault } = useExchangeRates();
  const weekStartsOn = (usePreferencesStore((s) => s.preferences?.weekStartsOn) ?? 1) as 0 | 1 | 2 | 3 | 4 | 5 | 6;
  const { config, updateConfig } = useWidgetConfig<RangeAccountsConfig>(
    WIDGET_ID,
    INCOME_EXPENSES_DEFAULT,
  );

  const isWeekly = config.range === WEEKLY_RANGE;
  const { start, end } = useMemo(
    () => resolveRangePreset(config.range, { alignment: isWeekly ? 'day' : 'month' }),
    [config.range, isWeekly],
  );
  const accountIdsKey = config.accountIds.join(',');

  const { data: transactions, isLoading: dataLoading } = useReportData(
    () =>
      transactionsApi.getAllPages({
        startDate: start || undefined,
        endDate: end,
        accountIds: config.accountIds.length > 0 ? config.accountIds : undefined,
      }),
    [start, end, accountIdsKey],
  );

  // Group transactions into weekly (recent) or monthly (longer) buckets and
  // split each bucket's activity into income and expenses.
  const chartData = useMemo(() => {
    const txns = transactions ?? [];
    const startDate = start ? parseLocalDate(start) : parseLocalDate(end);
    const endDate = parseLocalDate(end);

    const buckets = isWeekly
      ? eachWeekOfInterval(
          { start: startOfWeek(startDate, { weekStartsOn }), end: endDate },
          { weekStartsOn },
        ).map((bucketStart) => ({
          bucketStart,
          bucketEnd: endOfWeek(bucketStart, { weekStartsOn }),
          label: formatDate(bucketStart),
          income: 0,
          expenses: 0,
        }))
      : eachMonthOfInterval({ start: startOfMonth(startDate), end: endDate }).map(
          (bucketStart) => ({
            bucketStart,
            bucketEnd: endOfMonth(bucketStart),
            label: formatChartDate(bucketStart, 'MMM yyyy'),
            income: 0,
            expenses: 0,
          }),
        );

    txns.forEach((tx) => {
      // Skip transfers and investment account transactions
      if (tx.isTransfer) return;
      if (tx.account?.accountType === 'INVESTMENT') return;

      const txDate = parseLocalDate(tx.transactionDate);
      const bucket = buckets.find(
        (b) => txDate >= b.bucketStart && txDate <= b.bucketEnd,
      );
      if (!bucket) return;

      const classifyAmount = (rawAmount: number, category: { isIncome: boolean } | null | undefined) => {
        const amount = convertToDefault(rawAmount, tx.currencyCode);
        if (category?.isIncome === true) {
          bucket.income += amount;
        } else if (category?.isIncome === false) {
          bucket.expenses += -1 * amount;
        } else {
          // Uncategorized: fall back to sign-based
          if (amount >= 0) {
            bucket.income += amount;
          } else {
            bucket.expenses += Math.abs(amount);
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
    });

    return buckets.map((b) => ({
      name: b.label,
      Income: Math.round(b.income),
      Expenses: Math.round(b.expenses),
      startDate: format(b.bucketStart, 'yyyy-MM-dd'),
      endDate: format(b.bucketEnd, 'yyyy-MM-dd'),
    }));
  }, [transactions, start, end, isWeekly, formatDate, formatChartDate, convertToDefault, weekStartsOn]);

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
      (acc, bucket) => ({
        income: acc.income + bucket.Income,
        expenses: acc.expenses + bucket.Expenses,
      }),
      { income: 0, expenses: 0 }
    );
  }, [chartData]);

  const configControls = (
    <>
      <WidgetConfigRow label={t('widgets.timeframe')}>
        <DateRangeSelector
          ranges={SPENDING_RANGES}
          value={config.range}
          onChange={(range) => updateConfig({ range })}
          size="sm"
        />
      </WidgetConfigRow>
      <WidgetConfigRow label={t('widgets.accounts')}>
        <ReportAccountMultiSelect
          accounts={accounts}
          value={config.accountIds}
          onChange={(accountIds) => updateConfig({ accountIds })}
          filter={nonInvestmentAccounts}
          className="w-full"
        />
      </WidgetConfigRow>
    </>
  );

  const loading = isLoading || dataLoading;

  return (
    <WidgetCard
      title={t('incomeExpenses.title')}
      widgetId={WIDGET_ID}
      configTitle={t('incomeExpenses.title')}
      configControls={configControls}
      headerRight={
        <span className="text-sm text-gray-500 dark:text-gray-400">
          {t(`widgets.rangeLabels.${config.range}` as Parameters<typeof t>[0])}
        </span>
      }
    >
      {loading ? (
        <div className="flex-1 min-h-[16rem] animate-pulse rounded-md bg-gray-100 dark:bg-gray-700/50" />
      ) : (
        <>
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
                <Tooltip content={<IncomeExpensesTooltip formatCurrency={formatCurrency} periodLabel={(label) => label} />} />
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
          <div className="pt-4 border-t border-gray-200 dark:border-gray-700 grid grid-cols-3 gap-4 text-center flex-shrink-0">
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
        </>
      )}
    </WidgetCard>
  );
}
