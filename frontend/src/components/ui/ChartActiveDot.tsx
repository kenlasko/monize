import type { ActiveDotProps } from 'recharts';
import { chartColors } from '@/lib/chart-colors';

/**
 * The marker on the hovered point of a line or area series:
 * `activeDot={ChartActiveDot}`. A soft halo in the series colour around a
 * solid dot, ringed in the card colour so it reads as a gap above the line
 * beneath it. Recharts' own default rings the dot in white, which on a dark
 * card is an outline rather than a gap (`docs/frontend/theming.md`).
 *
 * Recharts passes the series colour as `fill`, so one component serves every
 * series and no caller names a colour.
 */
export function ChartActiveDot({ cx, cy, fill }: ActiveDotProps) {
  if (cx === undefined || cy === undefined) return null;
  return (
    <g className="pointer-events-none">
      <circle cx={cx} cy={cy} r={9} fill={fill} fillOpacity={0.2} />
      <circle cx={cx} cy={cy} r={4.5} fill={fill} stroke={chartColors.surface} strokeWidth={2} />
    </g>
  );
}
