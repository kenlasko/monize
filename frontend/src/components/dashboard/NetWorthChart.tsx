'use client';

import { useMemo } from 'react';
import { useTranslations } from 'next-intl';
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
} from 'recharts';
import { chartColors } from '@/lib/chart-colors';
import { netWorthApi } from '@/lib/net-worth';
import { resolveRangePreset } from '@/lib/date-range';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import { useChartDateFormat } from '@/hooks/useChartDateFormat';
import { useLocalStorage } from '@/hooks/useLocalStorage';
import { useReportData } from '@/hooks/useReportData';
import { useWidgetConfig } from '@/hooks/useWidgetConfig';
import { ChartViewIcon } from '@/components/ui/ChartViewToggle';
import { PartialTotal } from '@/components/ui/PartialTotal';
import { UnknownAmount } from '@/components/ui/UnknownAmount';
import { partialTotalFor } from '@/lib/net-worth-completeness';
import { DateRangeSelector } from '@/components/ui/DateRangeSelector';
import { NetWorthByAccountTypeChart } from '@/components/reports/NetWorthByAccountTypeChart';
import { WidgetCard, WidgetConfigRow, WidgetMessage } from './WidgetCard';
import { WidgetSegmentedControl } from './WidgetSegmentedControl';
import { NET_WORTH_DEFAULT, NET_WORTH_RANGES, NetWorthConfig } from './widget-config';
import { CHART_TOOLTIP_CLASS } from '@/lib/chart-style';

const WIDGET_ID = 'net-worth';
/** Past this many months the axis names each January by its year alone. */
const YEAR_TICKS_AFTER = 36;

function NetWorthCompositionTooltip({
  active,
  payload,
  formatCurrency,
  labels,
}: {
  active?: boolean;
  payload?: Array<{ payload: { name: string; assets: number | null; liabilities: number | null } }>;
  formatCurrency: (v: number) => string;
  labels: { assets: string; liabilities: string; netWorth: string; partialMonth: string };
}) {
  const { formatPercent } = useNumberFormat();
  if (active && payload && payload.length) {
    const d = payload[0].payload;
    // A month the server could not fully convert has no split to print.
    if (d.assets === null || d.liabilities === null) {
      return (
        <div className={CHART_TOOLTIP_CLASS}>
          <p className="font-medium text-gray-900 dark:text-gray-100">{d.name}</p>
          <p className="text-sm text-gray-600 dark:text-gray-400 max-w-56">{labels.partialMonth}</p>
        </div>
      );
    }
    const total = d.assets + d.liabilities;
    const pct = (v: number) => (total > 0 ? formatPercent((v / total) * 100, 1) : '0%');
    return (
      <div className={CHART_TOOLTIP_CLASS}>
        <p className="font-medium text-gray-900 dark:text-gray-100">{d.name}</p>
        <p className="text-sm" style={{ color: chartColors.income }}>
          {labels.assets}: {formatCurrency(d.assets)} ({pct(d.assets)})
        </p>
        <p className="text-sm" style={{ color: chartColors.expense }}>
          {labels.liabilities}: {formatCurrency(d.liabilities)} ({pct(d.liabilities)})
        </p>
        <p className="text-sm text-gray-600 dark:text-gray-400 mt-1 pt-1 border-t border-gray-100 dark:border-gray-700">
          {labels.netWorth}: {formatCurrency(d.assets - d.liabilities)}
        </p>
      </div>
    );
  }
  return null;
}

interface NetWorthChartProps {
  isLoading: boolean;
}

export function NetWorthChart({ isLoading }: NetWorthChartProps) {
  const t = useTranslations('dashboard');
  const { formatCurrencyCompact: formatCurrency, formatCurrencyLabel, formatPercent, defaultCurrency } = useNumberFormat();
  const formatChartDate = useChartDateFormat();
  const [chartType, setChartType] = useLocalStorage<'bar' | 'stacked'>(
    'dashboard.net-worth.chartType',
    'bar',
  );
  const { config, updateConfig } = useWidgetConfig<NetWorthConfig>(WIDGET_ID, NET_WORTH_DEFAULT);
  const tCommon = useTranslations('common');
  const tReports = useTranslations('reports');
  const compositionLabels = {
    partialMonth: tReports('netWorth.partialMonth'),
    assets: t('assetsVsLiabilities.assets'),
    liabilities: t('assetsVsLiabilities.liabilities'),
    netWorth: t('assetsVsLiabilities.netWorthLabel'),
  };

  // The widget's own window, so a longer one than the dashboard loads for the
  // other widgets does not hold them up.
  const { data, isLoading: dataLoading, error } = useReportData(
    () => {
      const { start, end } = resolveRangePreset(config.range, { alignment: 'month' });
      return netWorthApi.getMonthly({ startDate: start || undefined, endDate: end });
    },
    [config.range],
  );

  // A month with `fxComplete === false` holds SUBTOTALS. It is drawn as `null`
  // (no bar, no point), never as a measured dip.
  const chartData = useMemo(() =>
    (data ?? []).map((d) => {
      const partial = d.fxComplete === false;
      return {
        // Raw YYYY-MM keeps the X-axis category stable and locale-independent;
        // the tick formatter localizes it to a short month for display.
        month: d.month,
        key: d.month,
        name: formatChartDate(`${d.month}-01`, 'MMM yyyy'),
        netWorth: partial ? null : Math.round(d.netWorth),
        assets: partial ? null : Math.round(d.assets),
        liabilities: partial ? null : Math.round(d.liabilities),
        byAccountType: partial ? undefined : d.byAccountType,
      };
    }),
  [data, formatChartDate]);

  const summary = useMemo(() => {
    if (!data || data.length === 0) return null;
    const last = data[data.length - 1];
    const first = data[0];
    const current = Math.round(last.netWorth);
    const initial = Math.round(first.netWorth);
    const change = current - initial;
    const changePercent = initial !== 0 ? (change / Math.abs(initial)) * 100 : 0;
    return {
      current,
      change,
      changePercent,
      // The headline is the latest month's: marked when it is a subtotal.
      currentTotal: partialTotalFor(current, last.fxComplete, last.missingRatePairs),
      // A change measured from or to a subtotal is not a change.
      changeKnown: last.fxComplete !== false && first.fxComplete !== false,
    };
  }, [data]);

  // A long window names each January by its year; a shorter one each month.
  const yearTicks = chartData.length > YEAR_TICKS_AFTER;
  const xTicks = yearTicks
    ? chartData.filter((d) => d.month.slice(5, 7) === '01').map((d) => d.key)
    : undefined;
  const formatXTick = (value: string) =>
    yearTicks ? value.slice(0, 4) : formatChartDate(`${value}-01`, chartData.length > 18 ? 'MMM yy' : 'MMM');
  // Each bar's figure is only legible while the bars are wide enough for it.
  const showValueLabels = config.range === '1y' || config.range === '2y';

  const rangeLabel = (range: string) =>
    t(`widgets.rangeLabels.${range}` as Parameters<typeof t>[0]);

  const configControls = (
    <>
      <WidgetConfigRow label={t('widgets.timeframe')}>
        <DateRangeSelector
          ranges={NET_WORTH_RANGES}
          labels={Object.fromEntries(NET_WORTH_RANGES.map((r) => [r, rangeLabel(r)]))}
          value={config.range}
          onChange={(range) => updateConfig({ range: range as NetWorthConfig['range'] })}
          size="sm"
        />
      </WidgetConfigRow>
      <WidgetConfigRow label={t('netWorth.barStyle')}>
        <WidgetSegmentedControl
          value={config.barStyle}
          onChange={(barStyle) => updateConfig({ barStyle })}
          options={[
            { value: 'netWorth', label: t('netWorth.barStyleNetWorth') },
            { value: 'accountType', label: t('netWorth.barStyleAccountType') },
          ]}
        />
      </WidgetConfigRow>
    </>
  );

  const loading = isLoading || dataLoading || (data === null && !error);
  const isPositive = summary ? summary.change >= 0 : true;

  return (
    <WidgetCard
      title={t('netWorth.title')}
      titleHref="/reports/net-worth"
      widgetId={WIDGET_ID}
      headerRight={
        <>
          <span className="hidden sm:inline text-sm text-gray-500 dark:text-gray-400">{rangeLabel(config.range)}</span>
          {/* Icons, so the switcher is the gear's height and shares its line. */}
          <WidgetSegmentedControl
            value={chartType}
            onChange={setChartType}
            ariaLabel={t('widgets.view')}
            options={[
              {
                value: 'bar',
                label: tCommon('chartViewToggle.barChart'),
                icon: <ChartViewIcon view="bar" className="h-4 w-4" />,
              },
              {
                value: 'stacked',
                label: tCommon('chartViewToggle.stackedChart'),
                icon: <ChartViewIcon view="stacked" className="h-4 w-4" />,
              },
            ]}
          />
        </>
      }
      configControls={configControls}
      configTitle={t('netWorth.title')}
    >
      {loading ? (
        <div className="animate-pulse skeleton-shimmer space-y-3">
          <div className="h-8 bg-gray-200 dark:bg-gray-700 rounded w-1/3" />
          <div className="h-40 bg-gray-200 dark:bg-gray-700 rounded" />
        </div>
      ) : error ? (
        <WidgetMessage>{t('netWorth.loadFailed')}</WidgetMessage>
      ) : !summary ? (
        <WidgetMessage>{t('netWorth.empty')}</WidgetMessage>
      ) : (
        <>
          <div className="mb-3">
            <div className={`text-2xl font-bold ${
              summary.current >= 0 ? 'text-gray-900 dark:text-gray-100' : 'text-red-600 dark:text-red-400'
            }`}>
              <PartialTotal total={summary.currentTotal} displayCurrency={defaultCurrency}>
                {formatCurrency(summary.current)}
              </PartialTotal>
            </div>
            {summary.changeKnown ? (
              <div className={`text-sm font-medium ${
                isPositive ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'
              }`}>
                {isPositive ? '+' : ''}{formatCurrency(summary.change)} ({isPositive ? '+' : ''}{formatPercent(summary.changePercent, 1)})
              </div>
            ) : (
              <div className="text-sm font-medium text-gray-500 dark:text-gray-400">
                <UnknownAmount reason="displayFx" />
              </div>
            )}
          </div>
          <div className="h-80">
            {chartType === 'stacked' ? (
              <ResponsiveContainer width="100%" height="100%" minWidth={0}>
                <BarChart data={chartData} stackOffset="expand" margin={{ top: 12, right: 12, left: 12, bottom: 0 }}>
                  <YAxis hide domain={[0, 1]} />
                  <XAxis
                    dataKey="month"
                    tick={{ fill: chartColors.axis, fontSize: 11 }}
                    tickLine={false}
                    axisLine={false}
                    {...(xTicks ? { ticks: xTicks } : { interval: 'preserveStartEnd' as const })}
                    tickFormatter={formatXTick}
                  />
                  <Tooltip
                    content={<NetWorthCompositionTooltip formatCurrency={formatCurrency} labels={compositionLabels} />}
                    cursor={{ fill: chartColors.grid, fillOpacity: 0.35 }}
                  />
                  <Bar dataKey="assets" stackId="nw" fill={chartColors.income} />
                  <Bar dataKey="liabilities" stackId="nw" fill={chartColors.expense} radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            ) : (
              // One solid bar of net worth a month, or stacked by account
              // type: what each type adds to (or, owed, takes from) net worth,
              // with net worth itself as the line across them.
              <NetWorthByAccountTypeChart
                data={chartData}
                barStyle={config.barStyle}
                formatCurrency={formatCurrency}
                formatXTick={formatXTick}
                xTicks={xTicks}
                fontSize={11}
                valueLabels={showValueLabels ? 'vertical' : undefined}
                formatValueLabel={formatCurrencyLabel}
                margin={{ top: showValueLabels ? 52 : 12, right: 12, left: 12, bottom: 0 }}
              />
            )}
          </div>
        </>
      )}
    </WidgetCard>
  );
}
