'use client';

import { type ReactNode, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts';
import { ArrowDownIcon, ArrowUpIcon } from '@heroicons/react/20/solid';
import { chartColors } from '@/lib/chart-colors';
import { CHART_TOOLTIP_CLASS } from '@/lib/chart-style';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import { useIsBelowDesktop } from '@/hooks/useIsMobile';
import { ChartActiveDot } from '@/components/ui/ChartActiveDot';
import { ChartAreaGradient } from '@/components/ui/ChartAreaGradient';
import {
  ChartFlagShadowFilter,
  computeMinMaxFlagIndices,
  computeTightYAxisDomain,
  renderMinMaxFlagDots,
} from '@/components/investments/portfolio-chart-utils';

/**
 * The pieces both dashboard hero sets are drawn from, so net worth and the
 * portfolio read as one surface: the layout that seats the page header above
 * the figures with the chart beside them, its loading state, the area chart
 * with its dismissable high/low bubbles, and the figure pill.
 */

// Below `lg` the figures stack above the chart, so `gap-y-1` and the chart's
// reduced top margin (`HeroAreaChart`) keep that seam tight.
const LAYOUT_CLASS = 'mb-6 flex flex-col lg:flex-row gap-x-10 gap-y-1 lg:gap-y-4 lg:items-start';

// The high/low bubbles sit beside their dot and are 22px tall, so they rise 11px
// above a point at the top of the plot; stacked, the margin only has to clear that.
const CHART_TOP_MARGIN_STACKED = 12;
const CHART_TOP_MARGIN_BESIDE = 36;

/** The page header, tucked close to the figures under it. */
function HeaderBlock({ header }: { header: ReactNode }) {
  return <div className="-mb-3">{header}</div>;
}

export function HeroLayout({
  header,
  label,
  figures,
  chart,
}: {
  header: ReactNode;
  /** The section's accessible name. */
  label: string;
  figures: ReactNode;
  chart: ReactNode;
}) {
  return (
    <section aria-label={label} data-testid="dashboard-hero" className={LAYOUT_CLASS}>
      <div className="flex flex-col gap-2 lg:flex-shrink-0">
        <HeaderBlock header={header} />
        {figures}
      </div>
      <div className="h-48 w-full lg:flex-1 lg:min-w-0" data-testid="dashboard-hero-chart">
        {chart}
      </div>
    </section>
  );
}

export function HeroSkeleton({ header, label }: { header: ReactNode; label: string }) {
  return (
    <section aria-busy="true" aria-label={label} className={LAYOUT_CLASS}>
      <div className="flex flex-col lg:flex-shrink-0">
        <HeaderBlock header={header} />
        <div className="animate-pulse skeleton-shimmer space-y-3 w-full max-w-md">
          <div className="h-3 w-24 rounded bg-gray-200 dark:bg-gray-700" />
          <div className="h-12 w-72 rounded bg-gray-200 dark:bg-gray-700" />
          <div className="h-4 w-80 rounded bg-gray-200 dark:bg-gray-700" />
        </div>
      </div>
      <div className="animate-pulse skeleton-shimmer h-48 w-full lg:flex-1 lg:min-w-0 rounded-lg bg-gray-200/60 dark:bg-gray-700/60" />
    </section>
  );
}

/**
 * The place of one figure still on its way, in a hero that is otherwise drawn:
 * it keeps the row from shifting when the figure lands.
 */
export function HeroFigureSkeleton({ width = 'w-28' }: { width?: string }) {
  return (
    <span
      aria-hidden="true"
      data-testid="dashboard-hero-figure-skeleton"
      className={`inline-block h-4 ${width} rounded align-middle animate-pulse skeleton-shimmer bg-gray-200 dark:bg-gray-700`}
    />
  );
}

/** The chart's place while its series is on the way; fills `HeroLayout`'s slot. */
export function HeroChartSkeleton() {
  return (
    <div
      aria-hidden="true"
      data-testid="dashboard-hero-chart-skeleton"
      className="animate-pulse skeleton-shimmer h-full w-full rounded-lg bg-gray-200/60 dark:bg-gray-700/60"
    />
  );
}

/** The header alone with one line under it: a failed load, an empty scope. */
export function HeroMessage({ header, children }: { header: ReactNode; children: ReactNode }) {
  return (
    <>
      {header}
      <p className="-mt-3 mb-6 text-sm text-gray-500 dark:text-gray-400">{children}</p>
    </>
  );
}

/** The small caps caption over the headline figure. */
export function HeroCaption({ children }: { children: ReactNode }) {
  return (
    <div className="text-[11px] font-semibold uppercase tracking-[0.1em] text-gray-500 dark:text-gray-400">
      {children}
    </div>
  );
}

export function HeroHeadline({ negative, children }: { negative: boolean; children: ReactNode }) {
  return (
    <div
      data-testid="dashboard-hero-headline"
      className={`text-4xl sm:text-5xl font-extrabold tracking-tight leading-none ${
        negative ? 'text-red-600 dark:text-red-400' : 'text-gray-900 dark:text-gray-50'
      }`}
    >
      {children}
    </div>
  );
}

export const heroStrong = (chunks: ReactNode) => (
  <span className="font-semibold text-gray-900 dark:text-gray-100">{chunks}</span>
);

/** The line of smaller figures under the headline. */
export function HeroSubFigures({ children }: { children: ReactNode }) {
  return (
    <div className="flex flex-wrap gap-x-5 gap-y-1 text-sm text-gray-500 dark:text-gray-400">
      {children}
    </div>
  );
}

/**
 * A signed figure beside the headline: green rising, red falling, the arrow
 * decoration only (the caller's text says the direction, or the sign does).
 */
export function HeroPill({ up, children }: { up: boolean; children: ReactNode }) {
  return (
    <span
      data-testid="dashboard-hero-pill"
      className={`inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-sm font-semibold ${
        up
          ? 'bg-green-500/10 text-green-700 dark:text-green-400'
          : 'bg-red-500/10 text-red-700 dark:text-red-400'
      }`}
    >
      {up ? (
        <ArrowUpIcon className="h-3.5 w-3.5" aria-hidden="true" />
      ) : (
        <ArrowDownIcon className="h-3.5 w-3.5" aria-hidden="true" />
      )}
      {children}
    </span>
  );
}

/** A figure the server withheld, in the pill's place: no colour, the cause. */
export function HeroPillUnknown({ children }: { children: ReactNode }) {
  return (
    <span data-testid="dashboard-hero-pill" className="text-sm text-gray-500 dark:text-gray-400">
      {children}
    </span>
  );
}

export interface HeroChartPoint {
  key: string;
  /** `null` where the value is not known: drawn as a gap, never a dip. */
  value: number | null;
}

function HeroTooltip({
  active,
  payload,
  formatValue,
  formatKey,
}: {
  active?: boolean;
  payload?: Array<{ payload: HeroChartPoint }>;
  formatValue: (v: number) => string;
  formatKey: (key: string) => string;
}) {
  if (!active || !payload?.length) return null;
  const point = payload[0].payload;
  if (point.value === null) return null;
  return (
    <div className={CHART_TOOLTIP_CLASS}>
      <p className="text-xs text-gray-500 dark:text-gray-400">{formatKey(point.key)}</p>
      <p className="text-sm font-semibold text-gray-900 dark:text-gray-100">{formatValue(point.value)}</p>
    </div>
  );
}

/**
 * The hero's area chart, its highest and lowest points carrying the forecast
 * chart's dismissable bubbles. A dismissal is keyed by the value it marked, so
 * a new extreme (another window, a new point) shows its bubble again; it is not
 * persisted. Values are plotted as given, never rounded to whole units.
 */
export function HeroAreaChart({
  points,
  currency,
  gradientId,
  formatTick,
  formatTooltipKey,
}: {
  points: HeroChartPoint[];
  currency: string;
  gradientId: string;
  formatTick: (key: string) => string;
  formatTooltipKey: (key: string) => string;
}) {
  const tc = useTranslations('common');
  const { formatCurrency, formatCurrencyAxis, formatCurrencyFlag } = useNumberFormat();
  const isStacked = useIsBelowDesktop();
  const [dismissedHigh, setDismissedHigh] = useState<number | null>(null);
  const [dismissedLow, setDismissedLow] = useState<number | null>(null);
  const flags = useMemo(
    () => computeMinMaxFlagIndices(points.map((p) => p.value ?? Number.NaN)),
    [points],
  );
  const highValue = flags.show ? points[flags.maxIndex].value : null;
  const lowValue = flags.show ? points[flags.minIndex].value : null;
  const yDomain = useMemo(
    () => computeTightYAxisDomain(points.flatMap((p) => (p.value === null ? [] : [p.value]))),
    [points],
  );

  const renderFlagDots = (props: { cx?: number; cy?: number; index?: number }) =>
    renderMinMaxFlagDots({
      cx: props.cx,
      cy: props.cy,
      index: props.index,
      flags,
      pointCount: points.length,
      highColor: chartColors.income,
      lowColor: chartColors.expense,
      highLabel: highValue !== null ? formatCurrencyFlag(highValue, currency) : '',
      lowLabel: lowValue !== null ? formatCurrencyFlag(lowValue, currency) : '',
      highDismissed: highValue !== null && highValue === dismissedHigh,
      lowDismissed: lowValue !== null && lowValue === dismissedLow,
      onDismissHigh: () => setDismissedHigh(highValue),
      onDismissLow: () => setDismissedLow(lowValue),
      dismissLabel: tc('chartFlag.dismiss'),
    });

  return (
    <ResponsiveContainer width="100%" height="100%" minWidth={0}>
      <AreaChart
        data={points}
        margin={{
          top: isStacked ? CHART_TOP_MARGIN_STACKED : CHART_TOP_MARGIN_BESIDE,
          right: 8,
          left: 8,
          bottom: 0,
        }}
      >
        <defs>
          <ChartAreaGradient id={gradientId} color={chartColors.primary} />
        </defs>
        <ChartFlagShadowFilter />
        <XAxis
          dataKey="key"
          tick={{ fill: chartColors.axis, fontSize: 11 }}
          tickLine={false}
          axisLine={false}
          interval="preserveStartEnd"
          minTickGap={32}
          tickFormatter={formatTick}
        />
        <YAxis hide domain={yDomain} tickFormatter={(v: number) => formatCurrencyAxis(v, currency)} />
        <Tooltip
          content={
            <HeroTooltip
              formatValue={(v) => formatCurrency(v, currency)}
              formatKey={formatTooltipKey}
            />
          }
          cursor={{ stroke: chartColors.grid, strokeDasharray: '3 4' }}
        />
        <Area
          type="monotone"
          dataKey="value"
          stroke={chartColors.primary}
          strokeWidth={2.25}
          fill={`url(#${gradientId})`}
          dot={renderFlagDots}
          activeDot={ChartActiveDot}
          isAnimationActive={false}
        />
      </AreaChart>
    </ResponsiveContainer>
  );
}
