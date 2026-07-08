'use client';

import { useMemo } from 'react';
import { useTranslations } from 'next-intl';
import {
  PieChart,
  Pie,
  Cell,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from 'recharts';
import { builtInReportsApi } from '@/lib/built-in-reports';
import { IncomeSourceItem } from '@/types/built-in-reports';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import { useReportData } from '@/hooks/useReportData';
import { useWidgetConfig } from '@/hooks/useWidgetConfig';
import { resolveRangePreset } from '@/lib/date-range';
import { chartColors } from '@/lib/chart-colors';
import { CHART_COLOURS_INCOME } from '@/lib/chart-colours';
import { ChartTooltipPanel } from '@/components/reports/ChartTooltip';
import { DateRangeSelector } from '@/components/ui/DateRangeSelector';
import { ChartViewToggle } from '@/components/ui/ChartViewToggle';
import { WidgetCard, WidgetConfigRow, WidgetMessage } from './WidgetCard';
import {
  INCOME_BY_SOURCE_DEFAULT,
  SPENDING_RANGES,
  IncomeBySourceConfig,
} from './widget-config';

const WIDGET_ID = 'income-by-source';

interface IncomeBySourceWidgetProps {
  isLoading: boolean;
}

interface IncomeSlice {
  id: string;
  name: string;
  value: number;
  colour: string;
}

export function IncomeBySourceWidget({ isLoading }: IncomeBySourceWidgetProps) {
  const t = useTranslations('dashboard');
  const { formatCurrencyCompact: formatCurrency, formatCurrencyAxis } = useNumberFormat();
  const { config, updateConfig } = useWidgetConfig<IncomeBySourceConfig>(
    WIDGET_ID,
    INCOME_BY_SOURCE_DEFAULT,
  );

  const { start, end } = useMemo(
    () => resolveRangePreset(config.range),
    [config.range],
  );

  const { data: response, isLoading: dataLoading } = useReportData(
    () =>
      builtInReportsApi.getIncomeBySource({
        startDate: start || undefined,
        endDate: end,
      }),
    [start, end],
  );

  const chartData = useMemo<IncomeSlice[]>(() => {
    if (!response) return [];
    let colourIndex = 0;
    return response.data.map((item: IncomeSourceItem) => {
      let colour = item.color || '';
      if (!colour) {
        colour = CHART_COLOURS_INCOME[colourIndex % CHART_COLOURS_INCOME.length];
        colourIndex++;
      }
      return {
        id: item.categoryId || '',
        name: item.categoryName,
        value: item.total,
        colour,
      };
    });
  }, [response]);

  const totalIncome = response?.totalIncome ?? 0;

  const renderTooltip = (active: boolean | undefined, rawPayload: unknown) => {
    const payload = rawPayload as Array<{ payload: IncomeSlice }> | undefined;
    if (!active || !payload?.length) return null;
    const d = payload[0].payload;
    const pct = totalIncome > 0 ? ((d.value / totalIncome) * 100).toFixed(1) : '0';
    return (
      <ChartTooltipPanel>
        <p className="font-medium text-gray-900 dark:text-gray-100">{d.name}</p>
        <p className="text-gray-600 dark:text-gray-400">
          {formatCurrency(d.value)} ({pct}%)
        </p>
      </ChartTooltipPanel>
    );
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
      <WidgetConfigRow label={t('widgets.chartType')}>
        <ChartViewToggle
          value={config.chartType}
          onChange={(v) => updateConfig({ chartType: v as 'pie' | 'bar' })}
          options={['pie', 'bar']}
        />
      </WidgetConfigRow>
    </>
  );

  const loading = isLoading || dataLoading;

  return (
    <WidgetCard
      title={t('incomeBySource.title')}
      widgetId={WIDGET_ID}
      configControls={configControls}
      configTitle={t('incomeBySource.title')}
    >
      {loading ? (
        <div className="flex-1 min-h-[260px] animate-pulse rounded-md bg-gray-100 dark:bg-gray-700/50" />
      ) : chartData.length === 0 ? (
        <WidgetMessage>{t('incomeBySource.empty')}</WidgetMessage>
      ) : (
        <>
          <div className="flex-1 min-h-[260px]">
            <ResponsiveContainer width="100%" height="100%" minWidth={0}>
              {config.chartType === 'bar' ? (
                <BarChart data={chartData} layout="vertical" margin={{ left: 10, right: 10 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke={chartColors.grid} horizontal={false} />
                  <XAxis type="number" tickFormatter={formatCurrencyAxis} tick={{ fontSize: 11 }} />
                  <YAxis type="category" dataKey="name" tick={{ fontSize: 11 }} width={90} />
                  <Tooltip content={({ active, payload }) => renderTooltip(active, payload)} />
                  <Bar dataKey="value" radius={[0, 4, 4, 0]}>
                    {chartData.map((entry) => (
                      <Cell key={entry.id || entry.name} fill={entry.colour} />
                    ))}
                  </Bar>
                </BarChart>
              ) : (
                <PieChart>
                  <Pie
                    data={chartData}
                    cx="50%"
                    cy="50%"
                    innerRadius="55%"
                    outerRadius="85%"
                    paddingAngle={2}
                    dataKey="value"
                  >
                    {chartData.map((entry) => (
                      <Cell key={entry.id || entry.name} fill={entry.colour} />
                    ))}
                  </Pie>
                  <Tooltip content={({ active, payload }) => renderTooltip(active, payload)} />
                </PieChart>
              )}
            </ResponsiveContainer>
          </div>
          <div className="mt-3 pt-3 border-t border-gray-200 dark:border-gray-700 flex items-center justify-between text-sm flex-shrink-0">
            <span className="text-gray-500 dark:text-gray-400">{t('incomeBySource.totalLabel')}</span>
            <span className="font-semibold text-gray-900 dark:text-gray-100">
              {formatCurrency(totalIncome)}
            </span>
          </div>
        </>
      )}
    </WidgetCard>
  );
}
