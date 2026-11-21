'use client';

import { useMemo } from 'react';
import { useTranslations } from 'next-intl';
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from 'recharts';
import { chartColors } from '@/lib/chart-colors';
import { CHART_GRID_PROPS, CHART_TOOLTIP_CLASS } from '@/lib/chart-style';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import { ChartActiveDot } from '@/components/ui/ChartActiveDot';
import {
  computeMinMaxFlagIndices,
  computeTightYAxisDomain,
} from '@/components/investments/portfolio-chart-utils';
import type { HeroChartPoint } from '../hero-parts';

interface StepDotProps {
  cx?: number;
  cy?: number;
  index?: number;
}

/**
 * The Classic hero's history: net worth as a stepped ink line, a month held
 * flat until the next, its highest and lowest months named in words beside
 * their step and the latest month marked in the accent.
 */
export function NetWorthStepChart({
  points,
  currency,
  formatTick,
  formatTooltipKey,
}: {
  points: HeroChartPoint[];
  currency: string;
  formatTick: (key: string) => string;
  formatTooltipKey: (key: string) => string;
}) {
  const t = useTranslations('dashboard');
  const { formatCurrency, formatCurrencyFlag } = useNumberFormat();
  const values = useMemo(() => points.map((p) => p.value ?? Number.NaN), [points]);
  const flags = useMemo(() => computeMinMaxFlagIndices(values), [values]);
  const yDomain = useMemo(
    () => computeTightYAxisDomain(points.flatMap((p) => (p.value === null ? [] : [p.value]))),
    [points],
  );
  const last = points.length - 1;
  const latest = last >= 0 ? points[last].value : null;
  const high = flags.show ? points[flags.maxIndex].value : null;
  const low = flags.show ? points[flags.minIndex].value : null;
  const summary =
    high !== null && low !== null && latest !== null
      ? t('hero.historyLabel', {
          high: formatCurrencyFlag(high, currency),
          low: formatCurrencyFlag(low, currency),
          latest: formatCurrencyFlag(latest, currency),
        })
      : undefined;

  const renderDot = ({ cx, cy, index }: StepDotProps) => {
    if (cx === undefined || cy === undefined || index === undefined) return <g key={`d-${index}`} />;
    const value = points[index]?.value;
    if (value === null || value === undefined) return <g key={`d-${index}`} />;
    if (index === last) {
      return (
        <g key={`d-${index}`}>
          <text x={cx} y={cy - 14} textAnchor="end" fontSize={12} className="fill-gray-900 dark:fill-gray-100">
            {formatCurrencyFlag(value, currency)}
          </text>
          <circle
            cx={cx}
            cy={cy}
            r={4.5}
            strokeWidth={2}
            stroke={chartColors.surface}
            className="fill-blue-600 dark:fill-blue-400"
          />
        </g>
      );
    }
    // A flag sits after its step (the line holds the month flat to the right)
    // and on the side away from the line: above the high, below the low.
    if (flags.show && (index === flags.maxIndex || index === flags.minIndex)) {
      const isHigh = index === flags.maxIndex;
      const nearEnd = index > points.length * 0.7;
      return (
        <text
          key={`d-${index}`}
          x={nearEnd ? cx - 6 : cx + 8}
          y={isHigh ? cy - 8 : cy + 18}
          textAnchor={nearEnd ? 'end' : 'start'}
          fontSize={12}
          className="fill-gray-500 dark:fill-gray-400"
        >
          {isHigh
            ? t('hero.high', { value: formatCurrencyFlag(value, currency) })
            : t('hero.low', { value: formatCurrencyFlag(value, currency) })}
        </text>
      );
    }
    return <g key={`d-${index}`} />;
  };

  return (
    <div role="img" aria-label={summary} className="h-full w-full text-gray-900 dark:text-gray-100">
      <ResponsiveContainer width="100%" height="100%" minWidth={0}>
        <LineChart data={points} margin={{ top: 28, right: 12, left: 12, bottom: 0 }}>
          <CartesianGrid {...CHART_GRID_PROPS} />
          <XAxis
            dataKey="key"
            tick={{ fill: chartColors.axis, fontSize: 12 }}
            tickLine={false}
            axisLine={{ stroke: chartColors.grid }}
            interval="preserveStartEnd"
            minTickGap={36}
            tickFormatter={formatTick}
          />
          <YAxis hide domain={yDomain} />
          <Tooltip
            content={({ active, payload }) => {
              const point = (payload?.[0] as { payload?: HeroChartPoint } | undefined)?.payload;
              if (!active || !point || point.value === null) return null;
              return (
                <div className={CHART_TOOLTIP_CLASS}>
                  <p className="text-xs text-gray-500 dark:text-gray-400">{formatTooltipKey(point.key)}</p>
                  <p className="text-sm font-semibold text-gray-900 dark:text-gray-100">
                    {formatCurrency(point.value, currency)}
                  </p>
                </div>
              );
            }}
            cursor={{ stroke: chartColors.grid, strokeDasharray: '3 4' }}
          />
          <Line
            type="stepAfter"
            dataKey="value"
            stroke="currentColor"
            strokeWidth={1.75}
            strokeLinejoin="miter"
            dot={renderDot}
            activeDot={ChartActiveDot}
            isAnimationActive={false}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
