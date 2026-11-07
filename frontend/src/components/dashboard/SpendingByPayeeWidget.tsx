'use client';

import { useMemo } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Cell,
} from 'recharts';
import { builtInReportsApi } from '@/lib/built-in-reports';
import { PayeeSpendingItem } from '@/types/built-in-reports';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import { useReportData } from '@/hooks/useReportData';
import { PartialTotal } from '@/components/ui/PartialTotal';
import { reportTotal } from '@/lib/currency-total';
import { useWidgetConfig } from '@/hooks/useWidgetConfig';
import { resolveRangePreset } from '@/lib/date-range';
import { chartSeriesColor } from '@/lib/chart-colors';
import { ChartTooltipPanel } from '@/components/reports/ChartTooltip';
import { DateRangeSelector } from '@/components/ui/DateRangeSelector';
import { WidgetCard, WidgetConfigRow, WidgetMessage } from './WidgetCard';
import {
  SPENDING_BY_PAYEE_DEFAULT,
  SPENDING_RANGES,
  RangeConfig,
} from './widget-config';
import { CHART_GRID_PROPS_HORIZONTAL_BARS } from '@/lib/chart-style';

const WIDGET_ID = 'spending-by-payee';
const MAX_BARS = 8;

interface SpendingByPayeeWidgetProps {
  isLoading: boolean;
}

export function SpendingByPayeeWidget({ isLoading }: SpendingByPayeeWidgetProps) {
  const t = useTranslations('dashboard');
  const router = useRouter();
  const { formatCurrencyCompact: formatCurrency, formatCurrencyAxis, formatPercent, defaultCurrency } = useNumberFormat();
  const { config, updateConfig } = useWidgetConfig<RangeConfig>(
    WIDGET_ID,
    SPENDING_BY_PAYEE_DEFAULT,
  );

  const { start, end } = useMemo(
    () => resolveRangePreset(config.range),
    [config.range],
  );

  const { data: response, isLoading: dataLoading } = useReportData(
    () =>
      builtInReportsApi.getSpendingByPayee({
        startDate: start || undefined,
        endDate: end,
      }),
    [start, end],
  );

  const chartData = useMemo(
    () =>
      (response?.data ?? []).slice(0, MAX_BARS).map((item: PayeeSpendingItem) => ({
        id: item.payeeId || '',
        name: item.payeeName,
        value: item.total,
      })),
    [response],
  );

  // `totalSpending` is withheld when a row could not be converted; what is shown
  // is the part that did, marked as a subtotal, and shares are of what is shown.
  const spendingTotal = reportTotal(response?.totalSpending ?? response?.knownSpending ?? 0, response);
  const totalExpenses = spendingTotal.value;
  const reportingCurrency = response?.currency ?? defaultCurrency;

  // A payee in the widget opens its detail page; the date-ranged transaction
  // drill-down lives on the detail page's own chart and links.
  const handlePayeeClick = (payeeId: string) => {
    if (payeeId) {
      router.push(`/payees/${payeeId}`);
    }
  };

  const configControls = (
    <WidgetConfigRow label={t('widgets.timeframe')}>
      <DateRangeSelector
        ranges={SPENDING_RANGES}
        value={config.range}
        onChange={(range) => updateConfig({ range })}
        size="sm"
      />
    </WidgetConfigRow>
  );

  const loading = isLoading || dataLoading;

  return (
    <WidgetCard
      title={t('spendingByPayee.title')}
      titleHref="/reports/spending-by-payee"
      widgetId={WIDGET_ID}
      headerRight={
        <span className="text-sm text-gray-500 dark:text-gray-400">
          {t(`widgets.rangeLabels.${config.range}` as Parameters<typeof t>[0])}
        </span>
      }
      configControls={configControls}
      configTitle={t('spendingByPayee.title')}
    >
      {loading ? (
        <div className="flex-1 min-h-[260px] animate-pulse skeleton-shimmer rounded-md bg-gray-100 dark:bg-gray-700/50" />
      ) : chartData.length === 0 ? (
        <WidgetMessage>{t('spendingByPayee.empty')}</WidgetMessage>
      ) : (
        <>
          <div className="flex-1 min-h-[260px]">
            <ResponsiveContainer width="100%" height="100%" minWidth={0}>
              <BarChart data={chartData} layout="vertical" margin={{ left: 10, right: 10 }}>
                <CartesianGrid {...CHART_GRID_PROPS_HORIZONTAL_BARS} />
                <XAxis type="number" tickFormatter={formatCurrencyAxis} tick={{ fontSize: 11 }} />
                <YAxis type="category" dataKey="name" tick={{ fontSize: 11 }} width={90} />
                <Tooltip
                  content={({ active, payload }) => {
                    if (!active || !payload?.length) return null;
                    const d = payload[0].payload as { name: string; value: number };
                    const pct = totalExpenses > 0 ? (d.value / totalExpenses) * 100 : 0;
                    return (
                      <ChartTooltipPanel>
                        <p className="font-medium text-gray-900 dark:text-gray-100">{d.name}</p>
                        <p className="text-gray-600 dark:text-gray-400">
                          {formatCurrency(d.value)} ({formatPercent(pct, 1)})
                        </p>
                      </ChartTooltipPanel>
                    );
                  }}
                />
                <Bar
                  dataKey="value"
                  cursor="pointer"
                  onClick={(d) => (d as { id?: string }).id && handlePayeeClick((d as { id: string }).id)}
                  radius={[0, 4, 4, 0]}
                >
                  {chartData.map((entry, index) => (
                    <Cell key={entry.id || index} fill={chartSeriesColor(index)} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
          <div className="mt-3 pt-3 border-t border-gray-200 dark:border-gray-700 flex items-center justify-between text-sm flex-shrink-0">
            <span className="text-gray-500 dark:text-gray-400">{t('spendingByPayee.totalLabel')}</span>
            <span className="font-semibold text-gray-900 dark:text-gray-100">
              <PartialTotal total={spendingTotal} displayCurrency={reportingCurrency}>
                {formatCurrency(totalExpenses)}
              </PartialTotal>
            </span>
          </div>
        </>
      )}
    </WidgetCard>
  );
}
