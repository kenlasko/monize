'use client';

import { useTranslations } from 'next-intl';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import { computeMinMaxFlagIndices } from '@/components/investments/portfolio-chart-utils';
import type { HeroChartPoint } from '../hero-parts';

const WIDTH = 416;
const PLOT_TOP = 20;
const PLOT_BOTTOM = 200;
const HEIGHT = 232;

/**
 * The Modern hero's history: a rounded bar per month from zero, the current
 * month in the accent, the highest, lowest and latest named above their bars.
 * Drawn for a dark block (the hero inverts), so its fills are the ramp steps
 * a light card would use, which the inversion turns around.
 */
export function MonthBars({
  points,
  currency,
  formatNarrowMonth,
}: {
  points: HeroChartPoint[];
  currency: string;
  formatNarrowMonth: (key: string) => string;
}) {
  const t = useTranslations('dashboard');
  const { formatCurrencyAxis, formatCurrencyFlag } = useNumberFormat();
  const known = points.flatMap((p) => (p.value === null ? [] : [p.value]));
  if (points.length === 0 || known.length === 0) return null;

  const top = Math.max(0, ...known);
  const bottom = Math.min(0, ...known);
  const span = top - bottom || 1;
  const y = (v: number) => PLOT_TOP + ((top - v) / span) * (PLOT_BOTTOM - PLOT_TOP);
  const slot = WIDTH / points.length;
  const barWidth = Math.min(20, slot * 0.62);
  const radius = Math.min(10, barWidth / 2);
  const flags = computeMinMaxFlagIndices(points.map((p) => p.value ?? Number.NaN));
  const last = points.length - 1;
  const labelEvery = Math.ceil(points.length / 13);
  const latest = points[last].value;
  const summary =
    flags.show && latest !== null
      ? t('hero.historyLabel', {
          high: formatCurrencyFlag(points[flags.maxIndex].value ?? 0, currency),
          low: formatCurrencyFlag(points[flags.minIndex].value ?? 0, currency),
          latest: formatCurrencyFlag(latest, currency),
        })
      : undefined;

  return (
    <svg role="img" aria-label={summary} viewBox={`0 0 ${WIDTH} ${HEIGHT}`} className="block h-auto w-full">
      {points.map((point, i) => {
        if (point.value === null) return null;
        const cx = slot * i + slot / 2;
        const y0 = y(0);
        const yv = y(point.value);
        // A month near zero still shows as a round dot on the baseline.
        const height = Math.max(Math.abs(y0 - yv), barWidth);
        const barTop = point.value >= 0 ? y0 - height : y0;
        const isLast = i === last;
        const named = isLast || (flags.show && (i === flags.maxIndex || i === flags.minIndex));
        return (
          <g key={point.key}>
            <rect
              x={cx - barWidth / 2}
              y={barTop}
              width={barWidth}
              height={height}
              rx={radius}
              className={isLast ? 'fill-blue-300 dark:fill-blue-400' : 'fill-gray-200 dark:fill-gray-700'}
            />
            {named && (
              <text
                x={isLast ? cx + barWidth / 2 : i === 0 ? cx - barWidth / 2 : cx}
                y={barTop - 8}
                textAnchor={isLast ? 'end' : i === 0 ? 'start' : 'middle'}
                fontSize={12}
                className={
                  isLast
                    ? 'fill-gray-900 font-semibold dark:fill-gray-50'
                    : 'fill-gray-500 dark:fill-gray-400'
                }
              >
                {formatCurrencyAxis(point.value, currency)}
              </text>
            )}
          </g>
        );
      })}
      {points.map((point, i) =>
        i % labelEvery === 0 || i === last ? (
          <text
            key={`m-${point.key}`}
            x={slot * i + slot / 2}
            y={HEIGHT - 10}
            textAnchor="middle"
            fontSize={12}
            className={
              i === last ? 'fill-gray-900 font-semibold dark:fill-gray-50' : 'fill-gray-500 dark:fill-gray-400'
            }
          >
            {formatNarrowMonth(point.key)}
          </text>
        ) : null,
      )}
    </svg>
  );
}
