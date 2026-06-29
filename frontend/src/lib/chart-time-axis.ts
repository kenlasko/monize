import { startOfYear, startOfMonth, addMonths } from 'date-fns';

// Candidate spacings (in months) for a price/performance chart's time axis,
// smallest first.
export const TICK_STEP_MONTHS = [1, 2, 3, 6, 12, 24, 60, 120];

/**
 * Build evenly-spaced, calendar-aligned tick timestamps for a time axis.
 *
 * Picks the smallest step that keeps the tick count at or below `target`, then
 * anchors ticks to year/month boundaries. This keeps spacing uniform across the
 * whole timeline regardless of how densely the underlying data is sampled
 * (e.g. sparse early history vs. daily recent prices), so old and new periods
 * get the same horizontal scale.
 *
 * Shared by the single-security price chart and the all-securities performance
 * comparison chart so both render the same consistent time axis.
 */
export function buildTimeAxisTicks(
  minTs: number,
  maxTs: number,
  target = 10,
): { ticks: number[]; stepMonths: number } {
  if (!(maxTs > minTs)) return { ticks: [minTs], stepMonths: 1 };
  const minDate = new Date(minTs);
  const maxDate = new Date(maxTs);
  const spanMonths =
    (maxDate.getFullYear() - minDate.getFullYear()) * 12 +
    (maxDate.getMonth() - minDate.getMonth());
  const stepMonths =
    TICK_STEP_MONTHS.find((s) => spanMonths / s <= target) ??
    TICK_STEP_MONTHS[TICK_STEP_MONTHS.length - 1];
  const anchor = stepMonths >= 12 ? startOfYear(minDate) : startOfMonth(minDate);
  const ticks: number[] = [];
  for (let cur = anchor; cur.getTime() <= maxTs; cur = addMonths(cur, stepMonths)) {
    if (cur.getTime() >= minTs) ticks.push(cur.getTime());
  }
  return { ticks: ticks.length > 0 ? ticks : [minTs, maxTs], stepMonths };
}
