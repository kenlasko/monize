import type { PerformanceComparison } from '@/types/investment';
import { buildPerformanceView } from './SecurityComparisonChart';
import type { ReturnRow } from './portfolio-return-rows';

/** One overlaid benchmark, drawn from its own points. */
export interface IndexOverlayLine {
  /** `idx:<code>`, the series key the comparison answered with. */
  key: string;
  /** The index code, for its localized name. */
  code: string;
  /** What the server called it, when no translation exists. */
  name: string;
  color: string;
  /**
   * The dates the comparison sampled, in order, each holding this index's
   * value under `key` (null where the server sent null).
   */
  points: ReturnRow[];
  /** The same points by timestamp, for the tooltip. */
  valueAt: ReadonlyMap<number, number | null>;
}

/**
 * The comparison's index series, shaped to be drawn over the return chart.
 *
 * The return series has a point on every day of the window; an index has one
 * only on the dates the comparison sampled (trading days, or weeks and months
 * over a long window). Merged into the return chart's rows, the index would
 * break on every day it was not sampled, and every index-only date would break
 * the portfolio line instead. So each index keeps its own points and is drawn
 * from them (`Line` `data`), with the server's nulls left in place so a stretch
 * nobody observed stays a gap.
 *
 * `valueAt` is what the tooltip reads: Recharts looks a line's own data up by
 * the hovered date and, when that date is missing, falls back to the same
 * position in the line's array, which is a different date's value. The tooltip
 * names an index only on a date the server sent a value for.
 */
export function overlayIndexLines(comparison: PerformanceComparison | null): IndexOverlayLine[] {
  if (!comparison) return [];
  const view = buildPerformanceView(comparison);
  return view.series
    .filter((series) => series.kind === 'INDEX')
    .map((series) => {
      const points: ReturnRow[] = view.rows.map((row) => ({
        ts: row.ts,
        [series.key]: row[series.key] ?? null,
      }));
      return {
        key: series.key,
        code: series.key.slice(4),
        name: series.name,
        color: series.color,
        points,
        valueAt: new Map(points.map((point) => [point.ts, point[series.key]])),
      };
    })
    .filter((line) => line.points.some((point) => point[line.key] !== null));
}
