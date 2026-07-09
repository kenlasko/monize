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
import { useNumberFormat } from '@/hooks/useNumberFormat';
import { useReportData } from '@/hooks/useReportData';
import { useWidgetConfig } from '@/hooks/useWidgetConfig';
import { resolveRangePreset } from '@/lib/date-range';
import { chartColors, CHART_SERIES } from '@/lib/chart-colors';
import { ChartTooltipPanel } from '@/components/reports/ChartTooltip';
import { DateRangeSelector } from '@/components/ui/DateRangeSelector';
import { WidgetCard, WidgetConfigRow, WidgetMessage } from './WidgetCard';
import { WidgetSegmentedControl } from './WidgetSegmentedControl';
import {
  WEEKEND_WEEKDAY_DEFAULT,
  WEEKEND_RANGES,
  WeekendConfig,
} from './widget-config';

const WIDGET_ID = 'weekend-weekday';
const WEEKEND_COLOR = CHART_SERIES[4];
const WEEKDAY_COLOR = CHART_SERIES[0];

interface WeekendVsWeekdayWidgetProps {
  isLoading: boolean;
}

export function WeekendVsWeekdayWidget({ isLoading }: WeekendVsWeekdayWidgetProps) {
  const t = useTranslations('dashboard');
  const tc = useTranslations('common');
  const dayNames = tc.raw('weekdaysShort') as string[];
  const { formatCurrencyCompact: formatCurrency, formatCurrencyAxis } = useNumberFormat();
  const { config, updateConfig } = useWidgetConfig<WeekendConfig>(
    WIDGET_ID,
    WEEKEND_WEEKDAY_DEFAULT,
  );

  const { start, end } = useMemo(
    () => resolveRangePreset(config.range),
    [config.range],
  );

  const { data: reportData, isLoading: dataLoading } = useReportData(
    () => builtInReportsApi.getWeekendVsWeekday({ startDate: start, endDate: end }),
    [start, end],
  );

  const dayData = useMemo(() => {
    const byDay = reportData?.byDay ?? [];
    return dayNames.map((day, index) => {
      const info = byDay.find((d) => d.dayOfWeek === index);
      return {
        day,
        total: info?.total ?? 0,
        isWeekend: index === 0 || index === 6,
      };
    });
  }, [reportData, dayNames]);

  const summary = reportData?.summary;
  const weekendTotal = summary?.weekendTotal ?? 0;
  const weekdayTotal = summary?.weekdayTotal ?? 0;
  const totalSpending = weekendTotal + weekdayTotal;
  const weekendPercent = totalSpending > 0 ? (weekendTotal / totalSpending) * 100 : 0;

  const pieData = [
    { name: t('weekendVsWeekday.weekendLabel'), value: weekendTotal, color: WEEKEND_COLOR },
    { name: t('weekendVsWeekday.weekdayLabel'), value: weekdayTotal, color: WEEKDAY_COLOR },
  ];

  const configControls = (
    <>
      <WidgetConfigRow label={t('widgets.timeframe')}>
        <DateRangeSelector
          ranges={WEEKEND_RANGES}
          value={config.range}
          onChange={(range) => updateConfig({ range })}
          size="sm"
        />
      </WidgetConfigRow>
      <WidgetConfigRow label={t('widgets.view')}>
        <WidgetSegmentedControl
          value={config.view}
          onChange={(view) => updateConfig({ view })}
          options={[
            { value: 'overview', label: t('weekendVsWeekday.viewOverview') },
            { value: 'byDay', label: t('weekendVsWeekday.viewByDay') },
          ]}
        />
      </WidgetConfigRow>
    </>
  );

  const loading = isLoading || dataLoading;

  return (
    <WidgetCard
      title={t('weekendVsWeekday.title')}
      widgetId={WIDGET_ID}
      headerRight={
        <span className="text-sm text-gray-500 dark:text-gray-400">
          {t(`widgets.rangeLabels.${config.range}` as Parameters<typeof t>[0])}
        </span>
      }
      configControls={configControls}
      configTitle={t('weekendVsWeekday.title')}
    >
      {loading ? (
        <div className="flex-1 min-h-[260px] animate-pulse rounded-md bg-gray-100 dark:bg-gray-700/50" />
      ) : totalSpending === 0 ? (
        <WidgetMessage>{t('weekendVsWeekday.empty')}</WidgetMessage>
      ) : config.view === 'byDay' ? (
        <div className="flex-1 min-h-[260px]">
          <ResponsiveContainer width="100%" height="100%" minWidth={0}>
            <BarChart data={dayData} margin={{ left: 4, right: 8, top: 4 }}>
              <CartesianGrid strokeDasharray="3 3" stroke={chartColors.grid} />
              <XAxis dataKey="day" tick={{ fontSize: 11 }} />
              <YAxis tickFormatter={formatCurrencyAxis} tick={{ fontSize: 11 }} width={56} />
              <Tooltip
                content={({ active, payload }) => {
                  if (!active || !payload?.length) return null;
                  const d = payload[0].payload as { day: string; total: number };
                  return (
                    <ChartTooltipPanel>
                      <p className="font-medium text-gray-900 dark:text-gray-100">{d.day}</p>
                      <p className="text-gray-600 dark:text-gray-400">{formatCurrency(d.total)}</p>
                    </ChartTooltipPanel>
                  );
                }}
              />
              <Bar dataKey="total" radius={[4, 4, 0, 0]}>
                {dayData.map((entry) => (
                  <Cell key={entry.day} fill={entry.isWeekend ? WEEKEND_COLOR : WEEKDAY_COLOR} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
      ) : (
        <>
          <div className="flex-1 min-h-[220px] relative">
            <ResponsiveContainer width="100%" height="100%" minWidth={0}>
              <PieChart>
                <Pie
                  data={pieData}
                  cx="50%"
                  cy="50%"
                  innerRadius="60%"
                  outerRadius="88%"
                  paddingAngle={2}
                  dataKey="value"
                >
                  {pieData.map((entry) => (
                    <Cell key={entry.name} fill={entry.color} />
                  ))}
                </Pie>
                <Tooltip
                  content={({ active, payload }) => {
                    if (!active || !payload?.length) return null;
                    const d = payload[0].payload as { name: string; value: number };
                    const pct = totalSpending > 0 ? ((d.value / totalSpending) * 100).toFixed(1) : '0';
                    return (
                      <ChartTooltipPanel>
                        <p className="font-medium text-gray-900 dark:text-gray-100">{d.name}</p>
                        <p className="text-gray-600 dark:text-gray-400">
                          {formatCurrency(d.value)} ({pct}%)
                        </p>
                      </ChartTooltipPanel>
                    );
                  }}
                />
              </PieChart>
            </ResponsiveContainer>
            <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none">
              <span className="text-2xl font-bold text-gray-900 dark:text-gray-100">
                {weekendPercent.toFixed(0)}%
              </span>
              <span className="text-xs text-gray-500 dark:text-gray-400">
                {t('weekendVsWeekday.weekendLabel')}
              </span>
            </div>
          </div>
          <div className="mt-3 grid grid-cols-2 gap-2 text-sm flex-shrink-0">
            {pieData.map((slice) => (
              <div key={slice.name} className="flex items-center gap-2">
                <span className="w-3 h-3 rounded-sm shrink-0" style={{ backgroundColor: slice.color }} />
                <span className="text-gray-500 dark:text-gray-400 truncate">{slice.name}</span>
                <span className="ml-auto font-medium text-gray-900 dark:text-gray-100">
                  {formatCurrency(slice.value)}
                </span>
              </div>
            ))}
          </div>
        </>
      )}
    </WidgetCard>
  );
}
