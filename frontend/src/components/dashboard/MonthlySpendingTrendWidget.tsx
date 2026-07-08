'use client';

import { useMemo } from 'react';
import { useTranslations } from 'next-intl';
import { parseISO } from 'date-fns';
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Legend,
} from 'recharts';
import { builtInReportsApi } from '@/lib/built-in-reports';
import { MonthlyIncomeExpenseItem } from '@/types/built-in-reports';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import { useReportData } from '@/hooks/useReportData';
import { useChartDateFormat } from '@/hooks/useChartDateFormat';
import { useWidgetConfig } from '@/hooks/useWidgetConfig';
import { resolveRangePreset } from '@/lib/date-range';
import { chartColors } from '@/lib/chart-colors';
import { ChartTooltip } from '@/components/reports/ChartTooltip';
import { DateRangeSelector } from '@/components/ui/DateRangeSelector';
import { WidgetCard, WidgetConfigRow, WidgetMessage } from './WidgetCard';
import {
  MONTHLY_SPENDING_TREND_DEFAULT,
  TREND_RANGES,
  RangeConfig,
} from './widget-config';

const WIDGET_ID = 'monthly-spending-trend';

interface MonthlySpendingTrendWidgetProps {
  isLoading: boolean;
}

export function MonthlySpendingTrendWidget({ isLoading }: MonthlySpendingTrendWidgetProps) {
  const t = useTranslations('dashboard');
  const { formatCurrency, formatCurrencyAxis } = useNumberFormat();
  const formatChartDate = useChartDateFormat();
  const { config, updateConfig } = useWidgetConfig<RangeConfig>(
    WIDGET_ID,
    MONTHLY_SPENDING_TREND_DEFAULT,
  );

  const { start, end } = useMemo(
    () => resolveRangePreset(config.range, { alignment: 'month' }),
    [config.range],
  );

  const { data: response, isLoading: dataLoading } = useReportData(
    () =>
      builtInReportsApi.getIncomeVsExpenses({
        startDate: start || undefined,
        endDate: end,
      }),
    [start, end],
  );

  const chartData = useMemo(
    () =>
      (response?.data ?? []).map((item: MonthlyIncomeExpenseItem) => ({
        name: item.month,
        fullName: formatChartDate(parseISO(item.month + '-01'), 'MMM yyyy'),
        Expenses: Math.round(item.expenses),
        Income: Math.round(item.income),
      })),
    [response, formatChartDate],
  );

  const configControls = (
    <WidgetConfigRow label={t('widgets.timeframe')}>
      <DateRangeSelector
        ranges={TREND_RANGES}
        value={config.range}
        onChange={(range) => updateConfig({ range })}
        size="sm"
      />
    </WidgetConfigRow>
  );

  const loading = isLoading || dataLoading;

  return (
    <WidgetCard
      title={t('monthlySpendingTrend.title')}
      configControls={configControls}
      configTitle={t('monthlySpendingTrend.title')}
    >
      {loading ? (
        <div className="flex-1 min-h-[260px] animate-pulse rounded-md bg-gray-100 dark:bg-gray-700/50" />
      ) : chartData.length === 0 ? (
        <WidgetMessage>{t('monthlySpendingTrend.empty')}</WidgetMessage>
      ) : (
        <div className="flex-1 min-h-[260px]">
          <ResponsiveContainer width="100%" height="100%" minWidth={0}>
            <LineChart data={chartData} margin={{ left: 4, right: 8, top: 4 }}>
              <CartesianGrid strokeDasharray="3 3" stroke={chartColors.grid} />
              <XAxis
                dataKey="name"
                tickFormatter={(value) => chartData.find((d) => d.name === value)?.fullName ?? String(value)}
                tick={{ fontSize: 11 }}
              />
              <YAxis tickFormatter={formatCurrencyAxis} tick={{ fontSize: 11 }} width={56} />
              <Tooltip
                content={({ active, payload }) => (
                  <ChartTooltip
                    active={active}
                    label={
                      (payload?.[0]?.payload as { fullName?: string } | undefined)?.fullName
                    }
                    payload={payload as { name?: string; value?: number; color?: string }[]}
                    formatValue={(v) => formatCurrency(Number(v))}
                  />
                )}
              />
              <Legend />
              <Line
                type="monotone"
                dataKey="Expenses"
                name={t('monthlySpendingTrend.expenses')}
                stroke={chartColors.expense}
                strokeWidth={2}
                dot={false}
              />
              <Line
                type="monotone"
                dataKey="Income"
                name={t('monthlySpendingTrend.income')}
                stroke={chartColors.income}
                strokeWidth={2}
                dot={false}
              />
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}
    </WidgetCard>
  );
}
