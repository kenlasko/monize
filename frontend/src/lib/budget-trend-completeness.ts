import type { TrendPointCompleteness } from '@/types/budget';

/**
 * The rate pairs behind the partial points among `points`, sorted and unique,
 * or `null` when none is partial. A point is partial only when the server said
 * so (`valuationComplete === false`): an absent flag is no information.
 */
export function trendPartialPairs(
  points: readonly TrendPointCompleteness[],
): string[] | null {
  const partial = points.filter((point) => point.valuationComplete === false);
  if (partial.length === 0) return null;
  return [...new Set(partial.flatMap((point) => point.missingRatePairs ?? []))].sort();
}
