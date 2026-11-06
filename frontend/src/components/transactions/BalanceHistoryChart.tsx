'use client';

import { useCallback, useMemo, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { gainLossColor, getDecimalPlacesForCurrency, roundToDecimals } from '@/lib/format';
import { Skeleton } from '@/components/ui/LoadingSkeleton';
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  ReferenceLine,
  ReferenceDot,
} from 'recharts';
import { chartColors } from '@/lib/chart-colors';
import { parseLocalDate, type ChartDatePattern } from '@/lib/utils';
import { computeBalanceGradient, computeBalanceSummary } from '@/lib/balance-history';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import { useChartDateFormat } from '@/hooks/useChartDateFormat';
import { ChartDownloadButton } from '@/components/ui/ChartDownloadButton';
import { ChartCollapseButton } from '@/components/transactions/ChartCollapseControls';
import {
  ChartFlagShadowFilter,
  computeMinMaxFlagIndices,
  renderMinMaxFlagDots,
} from '@/components/investments/portfolio-chart-utils';


/**
 * An event to pin on the series: the security price chart marks the days a
 * holding was bought or sold, so a step in the line has a visible cause.
 */
export interface ChartMarker {
  /** ISO `yyyy-MM-dd`; snapped to the nearest earlier point if the series has
   *  no value for that exact day (a trade on a non-trading day). */
  date: string;
  /** Which way the event moved the position: 'in' reads green, 'out' red. */
  direction: 'in' | 'out';
  /** One tooltip line, already formatted, e.g. "Bought 12.5". */
  label: string;
}

interface BalanceHistoryChartProps {
  /**
   * The series. `balance` is `null` for a day whose figure is not known -- a
   * multi-currency series missing a rate. The line breaks at those points
   * (`connectNulls={false}`) rather than drawing a straight segment through the
   * gap, which would be indistinguishable from measured data.
   */
  data: Array<{ date: string; balance: number | null }>;
  isLoading: boolean;
  currencyCode?: string;
  /** Subject to append to the download filename, e.g. "Checking" or "AAPL". */
  accountName?: string;
  /**
   * Overrides the in-card title (and the download filename), for series that
   * are not an account balance -- a security's price history reuses this chart
   * so the two read identically.
   */
  title?: string;
  /**
   * Keep sub-cent precision. A balance is money and rounds to its currency's
   * places (`getDecimalPlacesForCurrency`: cents for most fiat, a coin's
   * four), but a price series can be quoted at 4-6dp (a fund NAV, a penny
   * stock, a crypto pair): rounding those to cents flattens the line to zero
   * and makes every tooltip read "$0.00" while the table beside it shows
   * 0.000342. The footer figures keep the quoted values too.
   */
  precise?: boolean;
  /**
   * Events to pin on the line, each snapped to a point in the series. Empty or
   * omitted for a plain balance history.
   */
  markers?: readonly ChartMarker[];
  /**
   * Drop the green/red colouring of the footer figures. For a series where the
   * sign carries no meaning: a security price is always positive, so tinting
   * every figure green says nothing.
   */
  neutralValues?: boolean;
  /**
   * True when the balance belongs to a liability account (credit card, loan,
   * mortgage, line of credit). A negative balance is the normal, expected
   * state for these, so the footer drops the "Lowest" alarm styling -- no red
   * value, no warning marker.
   */
  isLiability?: boolean;
  /**
   * Hide the in-card title. Set where the chart sits under a section heading
   * that already names it (the account-detail pages), so the name is not shown
   * twice. The download filename still uses the title.
   */
  hideTitle?: boolean;
  /**
   * What the series values are, which decides how every figure on the chart is
   * written. Defaults to money. Set to 'percent' for a series that is already a
   * percentage -- the security detail page's "Return" view plots percent change,
   * and formatting that as currency would label "+12.50%" as "$12.50".
   */
  valueFormat?: 'currency' | 'percent';
  /**
   * Names for the four footer figures. Defaults to the balance wording.
   *
   * Set it for a series that is not a balance: "Min Balance" is simply false
   * about a price or a percentage return, and the label is the one part of this
   * chart that cannot be made neutral. Supplying names also drops the
   * negative-balance alarm (the red "!" and the "Lowest" phrasing), which is
   * about an asset account going overdrawn and means nothing for a price.
   */
  summaryLabels?: {
    starting: string;
    current: string;
    ending: string;
    lowest: string;
  };
  /**
   * How tall the plot area is. `tall` is for a chart sharing a row with a column
   * of cards, where the extra height is what lets those cards breathe without
   * running past the chart's bottom edge.
   */
  plotHeight?: 'default' | 'tall';
  /**
   * Which series point a marker lands on when the event's own date has no point
   * (a trade on a non-trading day, or a series sampled sparsely).
   *
   * `earlier` (the default) suits a price: the quote is continuous, so the last
   * point before the trade is near enough. `later` is required for a series the
   * event *changes*: a purchase pinned to the point before it lands on the old
   * position -- zero, for a first purchase -- which draws the marker flat on the
   * axis instead of on the line, where it reads as missing.
   */
  markerSnap?: 'earlier' | 'later';
  /**
   * Drop the high/low value bubbles. They read as "this is what you paid" once
   * buy/sell markers share the plot -- same green and red, same size of dot --
   * and the footer already states the first, latest and lowest figures.
   */
  hideExtremeFlags?: boolean;
  /** Offer the header button that folds the chart away (the Transactions page). */
  onCollapse?: () => void;
}

interface ChartPoint {
  date: string;
  /**
   * The same day as a millisecond timestamp. The x axis is a time scale, so it
   * needs a number: on a category axis recharts spaces points evenly by index,
   * which puts a year of daily closes and a year of monthly ones side by side at
   * the same width and bunches the older year labels together.
   */
  t: number;
  label: string;
  balance: number | null;
}

/**
 * Evenly spaced tick positions across `[from, to]`, at the start of each year or
 * each month.
 *
 * Computed from the calendar rather than from the data, which is the whole point:
 * a tick per "first point of a new year" lands wherever that year's history
 * happens to begin, so the gaps between labels vary with how densely each period
 * was recorded. Boundaries are regular by construction.
 */
function calendarTicks(from: number, to: number, unit: 'year' | 'month'): number[] {
  const start = new Date(from);
  const ticks: number[] = [];
  const cursor =
    unit === 'year'
      ? new Date(start.getFullYear(), 0, 1)
      : new Date(start.getFullYear(), start.getMonth(), 1);
  // The first boundary may precede the data; step forward until inside.
  while (cursor.getTime() < from) {
    if (unit === 'year') cursor.setFullYear(cursor.getFullYear() + 1);
    else cursor.setMonth(cursor.getMonth() + 1);
  }
  while (cursor.getTime() <= to) {
    ticks.push(cursor.getTime());
    if (unit === 'year') cursor.setFullYear(cursor.getFullYear() + 1);
    else cursor.setMonth(cursor.getMonth() + 1);
  }
  if (ticks.length > 0) return ticks;
  // A span too short to cross a boundary leaves the axis bare, so fall back to
  // its own ends. De-duplicated because a single-point series has `from === to`,
  // and two identical ticks draw two labels on top of each other over a
  // zero-width domain.
  return from === to ? [from] : [from, to];
}

function BalanceTooltip({
  active,
  payload,
  formatValue,
  neutral = false,
  markersByDate,
}: {
  active?: boolean;
  payload?: Array<{ payload: ChartPoint }>;
  formatValue: (v: number) => string;
  /** Skip the by-sign colouring, for a series whose sign means nothing. */
  neutral?: boolean;
  /** Events pinned on each day, listed under the value. */
  markersByDate?: Map<string, ChartMarker[]>;
}) {
  if (active && payload?.[0]) {
    const data = payload[0].payload;
    return (
      <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg shadow-lg p-3">
        <p className="font-medium text-gray-900 dark:text-gray-100 mb-1">
          {data.label}
        </p>
        <p
          className={`text-lg font-semibold ${
            neutral
              ? 'text-gray-900 dark:text-gray-100'
              : gainLossColor(data.balance ?? 0)
          }`}
        >
          {data.balance === null ? '\u2014' : formatValue(data.balance)}
        </p>
        {markersByDate?.get(data.date)?.map((marker, i) => (
          <p
            key={i}
            className={`mt-1 text-sm font-medium ${
              marker.direction === 'in'
                ? 'text-green-600 dark:text-green-400'
                : 'text-red-600 dark:text-red-400'
            }`}
          >
            {marker.label}
          </p>
        ))}
      </div>
    );
  }
  return null;
}

export function BalanceHistoryChart({
  data,
  isLoading,
  currencyCode,
  accountName,
  isLiability = false,
  hideTitle = false,
  title,
  neutralValues = false,
  precise = false,
  markers,
  valueFormat = 'currency',
  summaryLabels,
  plotHeight = 'default',
  markerSnap = 'earlier',
  hideExtremeFlags = false,
  onCollapse,
}: BalanceHistoryChartProps) {
  const t = useTranslations('transactions');
  const tc = useTranslations('common');
  const chartTitle = title ?? t('charts.balanceHistory.title');
  const {
    formatCurrency,
    formatCurrencyPrecise,
    formatCurrencyAxis,
    formatCurrencyFlag,
    formatSignedPercent,
    defaultCurrency,
  } = useNumberFormat();
  const isPercent = valueFormat === 'percent';
  // A balance rounds to its currency's own places (a coin's four, not cents);
  // a price keeps what it was quoted at.
  const balanceDecimals = precise
    ? null
    : getDecimalPlacesForCurrency(currencyCode || defaultCurrency);
  // A caller that names its own figures is not plotting a balance, so the
  // overdrawn-account alarm below does not apply to it.
  const isBalanceSeries = summaryLabels === undefined;
  const isTall = plotHeight === 'tall';
  // Both literals stay in this file so Tailwind sees them.
  const plotClass = isTall ? 'h-96' : 'h-72';
  const cardMinHeight = isTall ? 'min-h-[520px]' : 'min-h-[420px]';
  const formatChartDate = useChartDateFormat();
  const chartRef = useRef<HTMLDivElement>(null);
  // High/low value bubbles a user has temporarily dismissed, keyed by the value
  // they marked so a later data change with a new extreme shows its bubble
  // again. Intentionally component-local (not persisted), so it resets on
  // navigation.
  const [dismissedHigh, setDismissedHigh] = useState<number | null>(null);
  const [dismissedLow, setDismissedLow] = useState<number | null>(null);
  const downloadFilename = accountName ? `${chartTitle} - ${accountName}` : chartTitle;

  const formatValue = useCallback(
    (value: number) =>
      isPercent
        ? formatSignedPercent(value)
        : precise
          ? formatCurrencyPrecise(value, currencyCode)
          : formatCurrency(value, currencyCode),
    [
      isPercent,
      formatSignedPercent,
      precise,
      formatCurrencyPrecise,
      formatCurrency,
      currencyCode,
    ],
  );

  const formatAxis = useCallback(
    (value: number) =>
      isPercent
        ? formatSignedPercent(value, 0)
        : precise
          ? formatCurrencyPrecise(value, currencyCode)
          : formatCurrencyAxis(value, currencyCode),
    [
      isPercent,
      formatSignedPercent,
      precise,
      formatCurrencyPrecise,
      formatCurrencyAxis,
      currencyCode,
    ],
  );

  const formatFlag = useCallback(
    (value: number) =>
      isPercent
        ? formatSignedPercent(value)
        : precise
          ? formatCurrencyPrecise(value, currencyCode)
          : formatCurrencyFlag(value, currencyCode),
    [
      isPercent,
      formatSignedPercent,
      precise,
      formatCurrencyPrecise,
      formatCurrencyFlag,
      currencyCode,
    ],
  );

  const { chartData, axisTicks, axisPattern } = useMemo(() => {
    if (data.length === 0) {
      return {
        chartData: [] as ChartPoint[],
        axisTicks: [] as number[],
        axisPattern: 'MMM' as ChartDatePattern,
      };
    }

    const points = data.map((d) => ({
      date: d.date,
      t: parseLocalDate(d.date).getTime(),
      label: formatChartDate(parseLocalDate(d.date), 'MMM d, yyyy'),
      // Money rounds to its currency's places; a price keeps what it was quoted at.
      balance:
        d.balance === null || balanceDecimals === null
          ? d.balance
          : roundToDecimals(d.balance, balanceDecimals),
    }));

    // A month tick per month reads well over ~2 years or less; beyond that the
    // axis is crowded and yearless, so switch to one tick per year.
    const first = points[0].t;
    const last = points[points.length - 1].t;
    const useYearTicks = (last - first) / 86_400_000 > 730;

    return {
      chartData: points,
      axisTicks: calendarTicks(first, last, useYearTicks ? 'year' : 'month'),
      axisPattern: (useYearTicks ? 'yyyy' : 'MMM') as ChartDatePattern,
    };
  }, [data, formatChartDate, balanceDecimals]);

  // The exact span the chart covers, shown under the title so the timeframe is
  // always explicit (e.g. the all-history default is no longer a silent range).
  const rangeLabel = useMemo(() => {
    if (chartData.length === 0) return '';
    const start = formatChartDate(parseLocalDate(chartData[0].date), 'MMM d, yyyy');
    const end = formatChartDate(
      parseLocalDate(chartData[chartData.length - 1].date),
      'MMM d, yyyy',
    );
    return t('charts.balanceHistory.range', { start, end });
  }, [chartData, formatChartDate, t]);

  // Markers snapped onto the series: a trade can fall on a day with no price
  // row (a weekend, or a gap in history), so it lands on the nearest earlier
  // point. Events outside the series are dropped rather than clamped to its
  // ends: a Microsoft Money migration carries decades of trades against a
  // couple of years of backfilled prices, and pinning them all to the earliest
  // point would claim they happened that day.
  const pinnedMarkers = useMemo(() => {
    if (!markers?.length || chartData.length === 0) return [];
    const first = chartData[0].date;
    const last = chartData[chartData.length - 1].date;
    return markers.flatMap((marker) => {
      if (marker.date < first || marker.date > last) return [];
      let point = chartData[0];
      if (markerSnap === 'later') {
        // The first point at or after the event, i.e. the first one that
        // reflects it.
        point =
          chartData.find((candidate) => candidate.date >= marker.date) ??
          chartData[chartData.length - 1];
      } else {
        for (const candidate of chartData) {
          if (candidate.date <= marker.date) point = candidate;
          else break;
        }
      }
      return [{ marker, point }];
    });
  }, [markers, chartData, markerSnap]);

  const markersByDate = useMemo(() => {
    const byDate = new Map<string, ChartMarker[]>();
    for (const { marker, point } of pinnedMarkers) {
      const existing = byDate.get(point.date);
      if (existing) existing.push(marker);
      else byDate.set(point.date, [marker]);
    }
    return byDate;
  }, [pinnedMarkers]);

  const summary = useMemo(
    () => computeBalanceSummary(chartData, balanceDecimals),
    [chartData, balanceDecimals],
  );
  /** Footer figure colour: by sign, unless the sign means nothing here. */
  const valueColor = (value: number) =>
    neutralValues ? 'text-gray-900 dark:text-gray-100' : gainLossColor(value);

  // Date of the last point on or before today, when future (projected) points
  // follow it -- used to draw the "history vs projection" divider line.
  const futureDivider = useMemo(() => {
    if (chartData.length === 0) return null;
    const now = new Date();
    const todayStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    let anchor: number | null = null;
    let hasFuture = false;
    for (const point of chartData) {
      // `x` is a position on the time axis now, so the divider carries the
      // anchor's timestamp rather than its ISO date.
      if (point.date <= todayStr) anchor = point.t;
      else hasFuture = true;
    }
    return hasFuture ? anchor : null;
  }, [chartData]);

  const areaGradient = useMemo(
    () =>
      computeBalanceGradient(
        chartData
          .map((point) => point.balance)
          .filter((balance): balance is number => balance !== null),
      ),
    [chartData],
  );

  // Highest/lowest points get green/red value bubbles, positioned to the
  // inside of whichever chart half they fall on so they never overlap the
  // plot edges.
  const flags = useMemo(
    () =>
      hideExtremeFlags
        ? { show: false as const, minIndex: 0, maxIndex: 0 }
        : // Extremes are only meaningful over the points that have a value; a
          // gap is neither a high nor a low.
          computeMinMaxFlagIndices(
            chartData.map((point) =>
              point.balance === null ? Number.NaN : point.balance,
            ),
          ),
    [chartData, hideExtremeFlags],
  );

  if (isLoading) {
    return (
      <div className={`bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-3 sm:p-6 mb-6 ${cardMinHeight}`}>
        {(!hideTitle || onCollapse) && (
          <div className="flex items-start justify-between mb-4 gap-2">
            {!hideTitle ? (
              <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
                {chartTitle}
              </h3>
            ) : (
              <span />
            )}
            {onCollapse && <ChartCollapseButton onCollapse={onCollapse} />}
          </div>
        )}
        <div className={`${plotClass} flex items-center justify-center`}>
          <Skeleton className="w-full h-full" />
        </div>
      </div>
    );
  }

  if (chartData.length === 0) {
    return (
      <div className={`bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-3 sm:p-6 mb-6 ${cardMinHeight}`}>
        {(!hideTitle || onCollapse) && (
          <div className="flex items-start justify-between mb-4 gap-2">
            {!hideTitle ? (
              <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
                {chartTitle}
              </h3>
            ) : (
              <span />
            )}
            {onCollapse && <ChartCollapseButton onCollapse={onCollapse} />}
          </div>
        )}
        <div className={`${plotClass} flex items-center justify-center text-gray-500 dark:text-gray-400`}>
          <p>{t('charts.balanceHistory.noData')}</p>
        </div>
      </div>
    );
  }

  const highValue = flags.show ? chartData[flags.maxIndex].balance : null;
  const lowValue = flags.show ? chartData[flags.minIndex].balance : null;
  const highLabel = highValue !== null ? formatFlag(highValue) : '';
  const lowLabel = lowValue !== null ? formatFlag(lowValue) : '';
  const highDismissed = highValue !== null && highValue === dismissedHigh;
  const lowDismissed = lowValue !== null && lowValue === dismissedLow;

  return (
    <div className={`bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-3 sm:p-6 mb-6 ${cardMinHeight}`}>
      <div className="flex items-start justify-between mb-4">
        <div>
          {!hideTitle && (
            <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
              {chartTitle}
            </h3>
          )}
          {rangeLabel && (
            <p className="text-sm text-gray-500 dark:text-gray-400 mt-0.5">
              {rangeLabel}
            </p>
          )}
        </div>
        <div className="flex items-center gap-2">
          <ChartDownloadButton chartRef={chartRef} filename={downloadFilename} />
          {onCollapse && <ChartCollapseButton onCollapse={onCollapse} />}
        </div>
      </div>

      {/* overflow-hidden: while the account-widget column animates the card's
          width, the recharts SVG keeps its last measured size until it
          re-measures, so clip it to the card instead of painting outside. */}
      <div
        ref={chartRef}
        className={`${plotClass} overflow-hidden`}
        style={{ minHeight: isTall ? 384 : 288 }}
      >
        <ResponsiveContainer width="100%" height="100%" minWidth={0}>
          {/* top margin leaves headroom for the high-value bubble callout */}
          <AreaChart data={chartData} margin={{ left: 0, right: 8, top: 20, bottom: 0 }}>
            <defs>
              <linearGradient id="colorBalance" x1="0" y1="0" x2="0" y2="1">
                <stop offset={0} stopColor={chartColors.primary} stopOpacity={areaGradient.topOpacity} />
                <stop offset={areaGradient.zeroOffset} stopColor={chartColors.primary} stopOpacity={0} />
                <stop offset={1} stopColor={chartColors.primary} stopOpacity={areaGradient.bottomOpacity} />
              </linearGradient>
            </defs>
            <ChartFlagShadowFilter />
            <CartesianGrid strokeDasharray="3 3" stroke={chartColors.grid} />
            {/* A time scale, not a category axis: distance along it is elapsed
                time, so ten years of monthly closes cannot occupy the same width
                as ten years of daily ones. */}
            <XAxis
              dataKey="t"
              type="number"
              scale="time"
              domain={['dataMin', 'dataMax']}
              ticks={axisTicks}
              tick={{ fill: chartColors.axis, fontSize: 12 }}
              tickLine={false}
              axisLine={{ stroke: chartColors.grid }}
              tickFormatter={(value: number) =>
                formatChartDate(new Date(value), axisPattern)
              }
            />
            {/* width="auto" lets recharts size the axis to its widest tick
                label so long localized currency values (e.g. "1.234.567 €")
                are never clipped. */}
            <YAxis
              tick={{ fill: chartColors.axis, fontSize: 11 }}
              tickLine={false}
              axisLine={false}
              tickFormatter={formatAxis}
              width="auto"
              domain={['auto', 'auto']}
            />
            <Tooltip
              content={
                <BalanceTooltip
                  formatValue={formatValue}
                  neutral={neutralValues}
                  markersByDate={markersByDate}
                />
              }
            />
            <ReferenceLine
              y={0}
              stroke={chartColors.expense}
              strokeDasharray="5 5"
              strokeOpacity={0.5}
            />
            {futureDivider && (
              <ReferenceLine
                x={futureDivider}
                stroke={chartColors.axis}
                strokeDasharray="4 4"
                strokeWidth={2}
                label={{
                  value: t('charts.balanceHistory.projected'),
                  // Bottom of the divider, clear of the high-value ("Max
                  // Balance") bubble that sits in the top headroom.
                  position: 'insideBottomRight',
                  fill: chartColors.axis,
                  fontSize: 11,
                }}
              />
            )}
            {/* The amber dashed line marks the series' lowest point. That is
                worth flagging on an account balance -- "this is how low you
                got" -- and meaningless on a price or a percentage, where a
                minimum always exists and amber reads as a warning about
                nothing. `summaryLabels` is the caller saying "this is not a
                balance", the same signal that drops the overdrawn styling. */}
            {!summaryLabels &&
              summary &&
              summary.minBalance !== summary.startBalance && (
                <ReferenceLine
                  y={summary.minBalance}
                  stroke={
                    summary.minBalance < 0 && !isLiability
                      ? chartColors.expense
                      : chartColors.warning
                  }
                  strokeDasharray="3 3"
                  strokeOpacity={0.4}
                />
              )}
            {/* Pinned events (buys and sells on a price series): a dot on the
                line at the day it happened, green in / red out, with the
                quantity in the tooltip for that day. */}
            {pinnedMarkers.map(({ marker, point }, i) => (
              <ReferenceDot
                key={`${point.date}-${i}`}
                x={point.t}
                y={point.balance ?? undefined}
                r={4}
                fill={
                  marker.direction === 'in'
                    ? chartColors.income
                    : chartColors.expense
                }
                // Same ring the min/max flag dots use (see
                // portfolio-chart-utils): it separates the dot from the line
                // under it. `--chart-surface` now exists, so the ring is the
                // card colour on every theme rather than a white outline.
                stroke={chartColors.surface}
                strokeWidth={1.5}
                ifOverflow="extendDomain"
              />
            ))}
            <Area
              type="monotone"
              dataKey="balance"
              // A day with no known balance leaves a gap; joining across it
              // would draw a figure nobody measured.
              connectNulls={false}
              stroke={chartColors.primary}
              strokeWidth={2}
              fillOpacity={1}
              fill="url(#colorBalance)"
              dot={(props: { cx?: number; cy?: number; index?: number }) =>
                renderMinMaxFlagDots({
                  cx: props.cx,
                  cy: props.cy,
                  index: props.index,
                  flags,
                  pointCount: chartData.length,
                  highColor: chartColors.income,
                  lowColor: chartColors.expense,
                  highLabel,
                  lowLabel,
                  highDismissed,
                  lowDismissed,
                  onDismissHigh: () => setDismissedHigh(highValue),
                  onDismissLow: () => setDismissedLow(lowValue),
                  dismissLabel: tc('chartFlag.dismiss'),
                })
              }
              activeDot={{ r: 6, fill: chartColors.primary }}
            />
          </AreaChart>
        </ResponsiveContainer>
      </div>

      {/* Summary footer. With a fourth (Ending) figure the row still fits on a
          single line on wider cards (grid-cols-4) and only falls back to two
          rows when the width can't hold all four (grid-cols-2). Every figure
          is coloured green/red by sign so the +/- state reads at a glance. */}
      {summary && (
        <div className={`mt-4 pt-4 border-t border-gray-200 dark:border-gray-700 grid ${summary.hasFutureData ? 'grid-cols-2 sm:grid-cols-4' : 'grid-cols-3'} gap-4 text-center`}>
          <div>
            <div className="text-sm text-gray-500 dark:text-gray-400">{summaryLabels?.starting ?? t('charts.balanceHistory.starting')}</div>
            <div className={`font-semibold ${valueColor(summary.startBalance)}`}>
              {formatValue(summary.startBalance)}
            </div>
          </div>
          <div>
            <div className="text-sm text-gray-500 dark:text-gray-400">{summaryLabels?.current ?? t('charts.balanceHistory.current')}</div>
            <div className={`font-semibold ${valueColor(summary.currentBalance)}`}>
              {formatValue(summary.currentBalance)}
            </div>
          </div>
          {summary.hasFutureData && (
            <div>
              <div className="text-sm text-gray-500 dark:text-gray-400">{summaryLabels?.ending ?? t('charts.balanceHistory.ending')}</div>
              <div className={`font-semibold ${valueColor(summary.endBalance)}`}>
                {formatValue(summary.endBalance)}
              </div>
            </div>
          )}
          <div>
            <div className="text-sm text-gray-500 dark:text-gray-400">
              {/* For liability accounts a negative balance is expected, so this
                  stays the neutral "Min Balance" label -- never the "Lowest"
                  alarm phrasing (or "!" marker) reserved for an unexpectedly
                  negative asset. The value itself is still coloured by sign. */}
              {summaryLabels
                ? summaryLabels.lowest
                : summary.goesNegative && !isLiability
                  ? t('charts.balanceHistory.lowest')
                  : t('charts.balanceHistory.minBalance')}
            </div>
            <div className={`font-semibold ${valueColor(summary.minBalance)}`}>
              {formatValue(summary.minBalance)}
              {isBalanceSeries && summary.goesNegative && !isLiability && (
                <span className="ml-1 text-xs text-red-500">!</span>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
