'use client';

import { amountWithShare, reportBreakdownShare } from '@/lib/report-breakdown-share';
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
import { PartialTotal } from '@/components/ui/PartialTotal';
import { reportTotal } from '@/lib/currency-total';
import { useWidgetConfig } from '@/hooks/useWidgetConfig';
import { resolveRangePreset } from '@/lib/date-range';
import { useFinancialToday } from '@/hooks/useFinancialToday';
import { CHART_COLOURS_INCOME } from '@/lib/chart-colours';
import { chartColors } from '@/lib/chart-colors';
import { sumMoney } from '@/lib/format';
import { ChartTooltipPanel } from '@/components/reports/ChartTooltip';
import { DateRangeSelector } from '@/components/ui/DateRangeSelector';
import { ChartViewToggle } from '@/components/ui/ChartViewToggle';
import { WidgetCard, WidgetConfigRow, WidgetMessage } from './WidgetCard';
import {
  INCOME_BY_SOURCE_DEFAULT,
  SPENDING_RANGES,
  IncomeBySourceConfig,
} from './widget-config';
import { CHART_GRID_PROPS_HORIZONTAL_BARS } from '@/lib/chart-style';

const WIDGET_ID = 'income-by-source';

interface IncomeBySourceWidgetProps {
  isLoading: boolean;
}

/** Sources that keep a slice of their own before the rest become Other. */
const MAX_SLICES = 15;

interface IncomeSlice {
  id: string;
  name: string;
  value: number;
  colour: string;
  /**
   * The server's share of the income, divided from the unrounded figures
   * (rule 8); the merged slice's is the sum of its sources'. Absent from an
   * older backend, which still gets the readings' ratio.
   */
  percentage?: number | null;
}

export function IncomeBySourceWidget({ isLoading }: IncomeBySourceWidgetProps) {
  const t = useTranslations('dashboard');
  const { formatCurrencyCompact: formatCurrency, formatCurrencyAxis, formatPercent, defaultCurrency } = useNumberFormat();
  const { config, updateConfig } = useWidgetConfig<IncomeBySourceConfig>(
    WIDGET_ID,
    INCOME_BY_SOURCE_DEFAULT,
  );

  const today = useFinancialToday();

  const { start, end } = useMemo(
    () => resolveRangePreset(config.range, { today }),
    [config.range, today],
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
    const slices = response.data.map((item: IncomeSourceItem) => {
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
        percentage: item.percentage,
      };
    });
    // The server returns every source; the chart keeps the largest and merges
    // the rest, so the slices still add up to the total.
    if (slices.length <= MAX_SLICES || slices.some((item) => item.percentage === null)) return slices;
    const rest = slices.slice(MAX_SLICES);
    return [
      ...slices.slice(0, MAX_SLICES),
      {
        id: '',
        name: t('expensesPieChart.other'),
        value: sumMoney(rest.map((item) => item.value)),
        colour: chartColors.neutral,
        percentage: rest.every((item) => item.percentage !== undefined)
          ? rest.reduce((sum, item) => sum + (item.percentage as number), 0)
          : undefined,
      },
    ];
  }, [response, t]);

  // `totalIncome` is withheld when a row could not be converted; what is shown
  // is the part that did, marked as a subtotal, and shares are of what is shown.
  const incomeTotal = reportTotal(response?.totalIncome ?? response?.knownIncome ?? 0, response);
  const totalIncome = incomeTotal.value;
  const reportingCurrency = response?.currency ?? defaultCurrency;

  const canDrawPie = chartData.every((item) => item.percentage !== null);
  const chartType = canDrawPie ? config.chartType : 'bar';

  const renderTooltip = (active: boolean | undefined, rawPayload: unknown) => {
    const payload = rawPayload as Array<{ payload: IncomeSlice }> | undefined;
    if (!active || !payload?.length) return null;
    const d = payload[0].payload;
    // The server's share, never the slice's reading over the income's: two
    // equal sources of 1.2474 read 1.25 over 2.49, 50.2%, and are each half.
    const pct = reportBreakdownShare(d, totalIncome);
    return (
      <ChartTooltipPanel>
        <p className="font-medium text-gray-900 dark:text-gray-100">{d.name}</p>
        <p className="text-gray-600 dark:text-gray-400">
          {amountWithShare(formatCurrency(d.value), pct, formatPercent)}
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
          value={chartType}
          onChange={(v) => updateConfig({ chartType: v as 'pie' | 'bar' })}
          options={canDrawPie ? ['pie', 'bar'] : ['bar']}
        />
      </WidgetConfigRow>
    </>
  );

  const loading = isLoading || dataLoading;

  return (
    <WidgetCard
      title={t('incomeBySource.title')}
      titleHref="/reports/income-by-source"
      widgetId={WIDGET_ID}
      headerRight={
        <span className="text-sm text-gray-500 dark:text-gray-400">
          {t(`widgets.rangeLabels.${config.range}` as Parameters<typeof t>[0])}
        </span>
      }
      configControls={configControls}
      configTitle={t('incomeBySource.title')}
    >
      {loading ? (
        <div className="flex-1 min-h-[260px] animate-pulse skeleton-shimmer rounded-md bg-gray-100 dark:bg-gray-700/50" />
      ) : chartData.length === 0 ? (
        <WidgetMessage>{t('incomeBySource.empty')}</WidgetMessage>
      ) : (
        <>
          <div className={canDrawPie ? 'flex-1 min-h-[260px]' : 'flex-1 min-h-[260px] max-h-[260px] overflow-y-auto'}>
            <ResponsiveContainer width="100%" height={canDrawPie ? '100%' : Math.max(260, chartData.length * 26)} minWidth={0}>
              {chartType === 'bar' ? (
                <BarChart data={chartData} layout="vertical" margin={{ left: 10, right: 10 }}>
                  <CartesianGrid {...CHART_GRID_PROPS_HORIZONTAL_BARS} />
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
              <PartialTotal total={incomeTotal} displayCurrency={reportingCurrency}>
                {formatCurrency(totalIncome)}
              </PartialTotal>
            </span>
          </div>
        </>
      )}
    </WidgetCard>
  );
}
