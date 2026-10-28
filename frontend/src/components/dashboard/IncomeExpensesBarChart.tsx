'use client';

import { useReportingBasis, useReportingRouter } from '@/components/reports/ReportingBasis';
import { useMemo, useRef } from 'react';
import { gainLossColor } from '@/lib/format';

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
import { parseISO } from 'date-fns';
import { chartColors } from '@/lib/chart-colors';
import { Account } from '@/types/account';
import { builtInReportsApi } from '@/lib/built-in-reports';
import { IncomeExpensePeriodItem } from '@/types/built-in-reports';
import { useDateFormat } from '@/hooks/useDateFormat';
import { useChartDateFormat } from '@/hooks/useChartDateFormat';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import { PartialTotal } from '@/components/ui/PartialTotal';
import type { ConvertedTotal } from '@/lib/currency-total';
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
  const basis = useReportingBasis();
  const t = useTranslations('dashboard');
  const router = useReportingRouter();
  const { formatDate } = useDateFormat();
  const formatChartDate = useChartDateFormat();
  const { formatCurrencyCompact: formatCurrency, formatCurrencyAxis } = useNumberFormat();
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

  /**
   * The bars come from the Income vs Expenses report, which is the one place
   * that decides which rows count and which side of the line they fall on: VOID
   * rows out, asset-category accounts out, a split's transfer line out,
   * investment rows out by linkage rather than by account type
   * (INV-REPORT-001), and an uncategorized amount classified by its sign only
   * after its category has been asked. This widget applied a simpler set of
   * those rules over paged transactions and disagreed with the report about the
   * same period.
   *
   * Bucketing goes with the question rather than being done to the answer:
   * which transaction belongs to which bar is half of deciding what the bar
   * says, so the granularity and the user's first day of the week are asked of
   * the server, which returns every bucket in the window with the dates it
   * covers.
   */
  const { data: response, isLoading: dataLoading } = useReportData(
    () =>
      builtInReportsApi.getIncomeVsExpenses({
        ...(basis ? {basis} : {}),
        startDate: start || undefined,
        endDate: end,
        accountIds: config.accountIds.length > 0 ? config.accountIds : undefined,
        bucket: isWeekly ? 'week' : 'month',
        weekStartsOn,
      }),
    [start, end, accountIdsKey, isWeekly, weekStartsOn, basis],
    { requestKey: JSON.stringify([start, end, accountIdsKey, isWeekly, weekStartsOn, basis]), maskStaleData: true },
  );

  const chartData = useMemo(
    () =>
      (response?.data ?? []).map((item: IncomeExpensePeriodItem) => ({
        // A week is named by the date it opens, the way the register writes a
        // date; a month by its name and year.
        name: isWeekly
          ? formatDate(item.periodStart)
          : formatChartDate(parseISO(item.periodStart), 'MMM yyyy'),
        Income: Math.round(item.income),
        Expenses: Math.round(item.expenses),
        startDate: item.periodStart,
        endDate: item.periodEnd,
      })),
    [response, isWeekly, formatDate, formatChartDate],
  );

  /**
   * The window's income and expenses, and whether they are the whole story. The
   * server leaves a row it could not convert out of every figure and says so,
   * so these are subtotals exactly when it reports an exclusion.
   */
  const completeness = useMemo(
    () => ({
      missingCurrencies: response?.missingCurrencies ?? [],
      excludedCount: response?.excludedCount ?? 0,
    }),
    [response],
  );
  const totals = {
    income: response?.totals.knownIncome ?? 0,
    expenses: response?.totals.knownExpenses ?? 0,
    net: response?.totals.knownNet ?? 0,
  };
  const marked = (value: number): ConvertedTotal => ({ value, ...completeness });
  const displayCurrency = response?.currency ?? '';

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
      titleHref="/reports/income-vs-expenses"
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
          {/* A month with a transaction in a currency that has no rate is a
              subtotal: the bar and these figures exclude it, so each is marked
              rather than passing as the complete month. */}
          <div className="pt-4 border-t border-gray-200 dark:border-gray-700 grid grid-cols-3 gap-4 text-center flex-shrink-0">
            <div>
              <div className="text-sm text-gray-500 dark:text-gray-400">{t('incomeExpenses.income')}</div>
              <div className="font-semibold text-green-600 dark:text-green-400">
                <PartialTotal total={marked(totals.income)} displayCurrency={displayCurrency}>
                  {formatCurrency(totals.income)}
                </PartialTotal>
              </div>
            </div>
            <div>
              <div className="text-sm text-gray-500 dark:text-gray-400">{t('incomeExpenses.expenses')}</div>
              <div className="font-semibold text-red-600 dark:text-red-400">
                <PartialTotal total={marked(totals.expenses)} displayCurrency={displayCurrency}>
                  {formatCurrency(totals.expenses)}
                </PartialTotal>
              </div>
            </div>
            <div>
              <div className="text-sm text-gray-500 dark:text-gray-400">{t('incomeExpenses.net')}</div>
              <div className={`font-semibold ${gainLossColor(totals.net)}`}>
                {/* Net is the server's own subtraction, not income minus
                    expenses re-derived here from two rounded figures. */}
                <PartialTotal total={marked(totals.net)} displayCurrency={displayCurrency}>
                  {formatCurrency(totals.net)}
                </PartialTotal>
              </div>
            </div>
          </div>
        </>
      )}
    </WidgetCard>
  );
}
