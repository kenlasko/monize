'use client';

import { useMemo, useRef } from 'react';
import { useTranslations } from 'next-intl';
import {
  CartesianGrid,
  Line,
  LineChart,
  ReferenceDot,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { Card } from '@/components/ui/Card';
import { Skeleton } from '@/components/ui/LoadingSkeleton';
import { ChartActiveDot } from '@/components/ui/ChartActiveDot';
import { ChartDownloadButton } from '@/components/ui/ChartDownloadButton';
import { DateRangeSelector } from '@/components/ui/DateRangeSelector';
import { calendarTicks } from '@/components/transactions/BalanceHistoryChart';
import { useChartDateFormat } from '@/hooks/useChartDateFormat';
import { useDateRange } from '@/hooks/useDateRange';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import { chartColors } from '@/lib/chart-colors';
import { CHART_GRID_PROPS, CHART_TOOLTIP_CLASS } from '@/lib/chart-style';
import { CHART_RANGES } from '@/lib/security-detail';
import { parseLocalDate, type ChartDatePattern } from '@/lib/utils';
import {
  buildRateChartSeries,
  rateAxisDecimals,
  rateDisplayDecimals,
  type RateHistoryRow,
  type TransactionRateChartPoint,
} from '@/lib/currency-detail';

interface CurrencyRateChartProps {
  code: string;
  defaultCurrency: string;
  /** Every rate row, provider and transaction alike, in any order. */
  rows: readonly RateHistoryRow[];
}

/** One plotted day: the provider's rate, and the reader's own rates near it. */
interface ChartDay {
  t: number;
  date: string;
  /** `null` on a day only a transaction rate falls on. */
  rate: number | null;
  transactions: TransactionRateChartPoint[];
}

/**
 * The days the line is drawn over, each carrying the transaction rates whose
 * date falls on it or after it and before the next one, so the tooltip of the
 * day a dot sits beside names it. With no provider rate in the window the
 * transaction dates themselves are the days, with no line between them.
 */
function chartDays(
  provider: ReturnType<typeof buildRateChartSeries>['provider'],
  transactions: readonly TransactionRateChartPoint[],
): ChartDay[] {
  if (provider.length === 0) {
    const byDate = new Map<string, ChartDay>();
    for (const point of transactions) {
      const day = byDate.get(point.date) ?? {
        t: point.t,
        date: point.date,
        rate: null,
        transactions: [],
      };
      byDate.set(point.date, { ...day, transactions: [...day.transactions, point] });
    }
    return [...byDate.values()];
  }
  const days: ChartDay[] = provider.map((point) => ({ ...point, transactions: [] }));
  let index = 0;
  for (const point of transactions) {
    while (index + 1 < days.length && days[index + 1].date <= point.date) index += 1;
    days[index] = { ...days[index], transactions: [...days[index].transactions, point] };
  }
  return days;
}

function RateTooltip({
  active,
  payload,
  formatRate,
  formatLabel,
  describe,
}: {
  active?: boolean;
  payload?: Array<{ payload: ChartDay }>;
  formatRate: (rate: number) => string;
  formatLabel: (date: string) => string;
  describe: (point: TransactionRateChartPoint) => string;
}) {
  const day = active ? payload?.[0]?.payload : undefined;
  if (!day) return null;
  return (
    <div className={CHART_TOOLTIP_CLASS}>
      <p className="mb-1 font-medium text-gray-900 dark:text-gray-100">{formatLabel(day.date)}</p>
      {day.rate !== null && (
        <p className="text-lg font-semibold text-gray-900 dark:text-gray-100">
          {formatRate(day.rate)}
        </p>
      )}
      {day.transactions.map((point) => (
        <p
          key={point.transactionId}
          className="mt-1 text-sm font-medium text-amber-600 dark:text-amber-400"
        >
          {describe(point)}
        </p>
      ))}
    </div>
  );
}

/**
 * The exchange rate over time: the provider's stored history as a line, and
 * each rate one of the reader's own transactions settled at as a highlighted
 * dot at its own value, so a payment made at a rate far from the market's
 * stands out. The window is the security chart's presets, remembered per
 * currency.
 */
export function CurrencyRateChart({ code, defaultCurrency, rows }: CurrencyRateChartProps) {
  const t = useTranslations('currencyDetail');
  const { formatNumber } = useNumberFormat();
  const formatChartDate = useChartDateFormat();
  const chartRef = useRef<HTMLDivElement>(null);

  const { dateRange, setDateRange, resolvedRange } = useDateRange({
    defaultRange: '1y',
    storageKey: `currencyDetail:range:${code}`,
  });

  const { days, transactions, axisTicks, axisPattern, axisDecimals } = useMemo(() => {
    const series = buildRateChartSeries(rows, resolvedRange.start, resolvedRange.end);
    const built = chartDays(series.provider, series.transactions);
    if (built.length === 0) {
      return {
        days: built,
        transactions: series.transactions,
        axisTicks: [] as number[],
        axisPattern: 'MMM' as ChartDatePattern,
        axisDecimals: 4,
      };
    }
    const maxRate = Math.max(
      ...built.map((d) => d.rate ?? 0),
      ...series.transactions.map((p) => p.rate),
    );
    const times = [...built.map((d) => d.t), ...series.transactions.map((p) => p.t)];
    const first = Math.min(...times);
    const last = Math.max(...times);
    // The balance chart's rule: month ticks up to two years, year ticks beyond.
    const useYearTicks = (last - first) / 86_400_000 > 730;
    return {
      days: built,
      transactions: series.transactions,
      axisTicks: calendarTicks(first, last, useYearTicks ? 'year' : 'month'),
      axisPattern: (useYearTicks ? 'yyyy' : 'MMM') as ChartDatePattern,
      axisDecimals: rateAxisDecimals(maxRate),
    };
  }, [rows, resolvedRange.start, resolvedRange.end]);

  const rangeLabels = Object.fromEntries(
    CHART_RANGES.map((range) => [range, t(`chart.ranges.${range}`)]),
  );

  const formatRate = (rate: number) => formatNumber(rate, rateDisplayDecimals(rate));
  const formatLabel = (date: string) => formatChartDate(parseLocalDate(date), 'MMM d, yyyy');
  const describe = (point: TransactionRateChartPoint) =>
    t('chart.transactionPoint', {
      rate: formatRate(point.rate),
      // A transfer leg's payee only names the transfer; its account says more.
      description:
        point.kind === 'transfer' ? point.accountName : (point.payeeName ?? point.accountName),
    });

  return (
    <Card padding="md">
      <div className="mb-4 flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
        <div>
          <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
            {t('chart.title')}
          </h2>
          <p className="mt-0.5 text-sm text-gray-500 dark:text-gray-400">
            {t('chart.direction', { code, currency: defaultCurrency })}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <DateRangeSelector
            ranges={CHART_RANGES}
            labels={rangeLabels}
            value={dateRange}
            onChange={setDateRange}
            size="sm"
          />
          <ChartDownloadButton
            chartRef={chartRef}
            filename={t('chart.filename', { code, currency: defaultCurrency })}
          />
        </div>
      </div>

      <div ref={chartRef} className="h-72 sm:h-96 overflow-hidden" style={{ minHeight: 288 }}>
        {days.length === 0 ? (
          <div className="flex h-full items-center justify-center text-gray-500 dark:text-gray-400">
            <p>{t('chart.noData')}</p>
          </div>
        ) : (
          <ResponsiveContainer width="100%" height="100%" minWidth={0}>
            <LineChart data={days} margin={{ left: 0, right: 8, top: 12, bottom: 0 }}>
              <CartesianGrid {...CHART_GRID_PROPS} />
              <XAxis
                dataKey="t"
                type="number"
                scale="time"
                domain={['dataMin', 'dataMax']}
                ticks={axisTicks}
                tick={{ fill: chartColors.axis, fontSize: 12 }}
                tickLine={false}
                axisLine={{ stroke: chartColors.grid }}
                tickFormatter={(value: number) => formatChartDate(new Date(value), axisPattern)}
              />
              <YAxis
                tick={{ fill: chartColors.axis, fontSize: 11 }}
                tickLine={false}
                axisLine={false}
                tickFormatter={(value: number) => formatNumber(value, axisDecimals)}
                width="auto"
                domain={['auto', 'auto']}
              />
              <Tooltip
                content={
                  <RateTooltip
                    formatRate={formatRate}
                    formatLabel={formatLabel}
                    describe={describe}
                  />
                }
              />
              <Line
                type="monotone"
                dataKey="rate"
                name={t('chart.legend.provider')}
                // A day with no provider rate is not a rate of its own; the
                // line breaks there rather than drawing one nobody measured.
                connectNulls={false}
                stroke={chartColors.primary}
                strokeWidth={2}
                dot={false}
                activeDot={ChartActiveDot}
                isAnimationActive={false}
              />
              {/* The reader's own settled rates, at their own value rather
                  than snapped to the line: the distance between the two is
                  what the highlight is for. */}
              {transactions.map((point) => (
                <ReferenceDot
                  key={point.transactionId}
                  x={point.t}
                  y={point.rate}
                  r={5}
                  fill={chartColors.warning}
                  stroke={chartColors.surface}
                  strokeWidth={1.5}
                  ifOverflow="extendDomain"
                />
              ))}
            </LineChart>
          </ResponsiveContainer>
        )}
      </div>

      <ul className="mt-3 flex flex-wrap justify-center gap-x-6 gap-y-1 text-xs text-gray-600 dark:text-gray-300">
        <li className="inline-flex items-center gap-2">
          <span aria-hidden="true" className="h-0.5 w-4 rounded" style={{ backgroundColor: chartColors.primary }} />
          {t('chart.legend.provider')}
        </li>
        <li className="inline-flex items-center gap-2">
          <span aria-hidden="true" className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: chartColors.warning }} />
          {t('chart.legend.transaction', { count: formatNumber(transactions.length, 0) })}
        </li>
      </ul>
    </Card>
  );
}

/** The chart's place while the rate history loads. */
export function CurrencyRateChartSkeleton() {
  return (
    <Card padding="md">
      <Skeleton className="mb-4 h-6 w-48" />
      <Skeleton className="h-72 sm:h-96 w-full" />
    </Card>
  );
}
