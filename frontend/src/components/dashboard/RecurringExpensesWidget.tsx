'use client';

import { useMemo } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { PieChart, Pie, Cell, Tooltip, ResponsiveContainer } from 'recharts';
import { builtInReportsApi } from '@/lib/built-in-reports';
import { RecurringExpenseItem } from '@/types/built-in-reports';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import { useReportData } from '@/hooks/useReportData';
import { useWidgetConfig } from '@/hooks/useWidgetConfig';
import { chartSeriesColor } from '@/lib/chart-colors';
import { ChartTooltipPanel } from '@/components/reports/ChartTooltip';
import { WidgetCard, WidgetConfigRow, WidgetMessage } from './WidgetCard';
import { RECURRING_EXPENSES_DEFAULT, RecurringConfig } from './widget-config';

const WIDGET_ID = 'recurring-expenses';
const MIN_OCCURRENCE_OPTIONS = [2, 3, 4, 5, 6];

interface RecurringExpensesWidgetProps {
  isLoading: boolean;
}

type RecurringSlice = RecurringExpenseItem & { color: string };

export function RecurringExpensesWidget({ isLoading }: RecurringExpensesWidgetProps) {
  const t = useTranslations('dashboard');
  const router = useRouter();
  const { formatCurrency, formatCurrencyCompact } = useNumberFormat();
  const { config, updateConfig } = useWidgetConfig<RecurringConfig>(
    WIDGET_ID,
    RECURRING_EXPENSES_DEFAULT,
  );

  const { data: response, isLoading: dataLoading } = useReportData(
    () => builtInReportsApi.getRecurringExpenses(config.minOccurrences),
    [config.minOccurrences],
  );

  const chartData = useMemo<RecurringSlice[]>(
    () =>
      (response?.data ?? []).slice(0, 10).map((item, index) => ({
        ...item,
        color: chartSeriesColor(index),
      })),
    [response],
  );

  const monthlyEstimate = response?.summary.monthlyEstimate ?? 0;

  const handleSliceClick = (payeeId: string | null) => {
    if (payeeId) router.push(`/transactions?payeeId=${payeeId}`);
  };

  const configControls = (
    <WidgetConfigRow label={t('recurringExpenses.minOccurrences')}>
      <select
        value={config.minOccurrences}
        onChange={(e) => updateConfig({ minOccurrences: Number(e.target.value) })}
        className="w-full rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 px-3 py-2 text-sm text-gray-900 dark:text-gray-100"
      >
        {MIN_OCCURRENCE_OPTIONS.map((n) => (
          <option key={n} value={n}>
            {t('recurringExpenses.minOccurrencesOption', { count: n })}
          </option>
        ))}
      </select>
    </WidgetConfigRow>
  );

  const loading = isLoading || dataLoading;

  return (
    <WidgetCard
      title={t('recurringExpenses.title')}
      configControls={configControls}
      configTitle={t('recurringExpenses.title')}
    >
      {loading ? (
        <div className="flex-1 min-h-[260px] animate-pulse rounded-md bg-gray-100 dark:bg-gray-700/50" />
      ) : chartData.length === 0 ? (
        <WidgetMessage>{t('recurringExpenses.empty')}</WidgetMessage>
      ) : (
        <>
          <div className="flex-1 min-h-[240px]">
            <ResponsiveContainer width="100%" height="100%" minWidth={0}>
              <PieChart>
                <Pie
                  data={chartData}
                  cx="50%"
                  cy="50%"
                  innerRadius="55%"
                  outerRadius="85%"
                  paddingAngle={2}
                  dataKey="totalAmount"
                  nameKey="payeeName"
                  cursor="pointer"
                  onClick={(d) => handleSliceClick((d as unknown as RecurringSlice).payeeId)}
                >
                  {chartData.map((entry) => (
                    <Cell key={entry.payeeId || entry.payeeName} fill={entry.color} />
                  ))}
                </Pie>
                <Tooltip
                  content={({ active, payload }) => {
                    if (!active || !payload?.length) return null;
                    const d = payload[0].payload as RecurringSlice;
                    return (
                      <ChartTooltipPanel>
                        <p className="font-medium text-gray-900 dark:text-gray-100">{d.payeeName}</p>
                        <p className="text-gray-600 dark:text-gray-400">
                          {formatCurrency(d.totalAmount)}
                        </p>
                        <p className="text-xs text-gray-500 dark:text-gray-400">
                          {t('recurringExpenses.occurrences', { count: d.occurrences })}
                        </p>
                      </ChartTooltipPanel>
                    );
                  }}
                />
              </PieChart>
            </ResponsiveContainer>
          </div>
          <div className="mt-3 pt-3 border-t border-gray-200 dark:border-gray-700 flex items-center justify-between text-sm flex-shrink-0">
            <span className="text-gray-500 dark:text-gray-400">{t('recurringExpenses.monthlyEstimate')}</span>
            <span className="font-semibold text-gray-900 dark:text-gray-100">
              {formatCurrencyCompact(monthlyEstimate)}
            </span>
          </div>
        </>
      )}
    </WidgetCard>
  );
}
