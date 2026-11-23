/**
 * Collapsing a look-through weighting result (countries, asset classes) into
 * the buckets a chart draws.
 *
 * The backend answers these queries in the same shape whatever the dimension
 * is: ranked buckets plus a `unclassifiedValue` remainder for fund value beyond
 * the manual weightings and securities whose type says nothing definite. Every
 * surface that draws one -- the Investments allocation chart and the Security
 * Type Allocation widget -- collapses it the same way here, so a portfolio
 * cannot be split into eleven slices on one screen and ten plus Other on
 * another.
 */

import { FIAT_MONEY_DECIMALS, sumMoney } from '@/lib/format';

/** The fields this module reads from any look-through result. */
export interface LookThroughResult {
  items: { name: string; totalValue: number; percentage: number }[];
  /** null while the result is partial; `knownSubtotal` is then the base of its percentages. */
  totalPortfolioValue: number | null;
  knownSubtotal?: number;
  unclassifiedValue: number;
}

/** One bucket ready to draw. */
export interface LookThroughSlice {
  name: string;
  value: number;
  percentage: number;
  /** True for the merged remainder, which no drill-down can open. */
  isOther: boolean;
}

/** How many buckets stay individual before the rest merge into Other. */
export const LOOK_THROUGH_TOP_N = 10;

/**
 * The largest `topN` buckets, with everything else -- the buckets ranked below
 * them plus the backend's unclassified remainder -- merged into one Other
 * slice named `otherLabel`.
 *
 * Other is omitted entirely when it would round to nothing, so a fully
 * classified portfolio does not carry an empty slice. Percentages are the
 * backend's own, which are shares of the whole portfolio, so the slices sum to
 * the portfolio and not to the classified part of it.
 */
export function collapseLookThrough(
  result: LookThroughResult,
  otherLabel: string,
  topN: number = LOOK_THROUGH_TOP_N,
): LookThroughSlice[] {
  const total = result.totalPortfolioValue ?? result.knownSubtotal ?? 0;
  // The backend already sorts by value descending; sort defensively.
  const sorted = [...result.items].sort((a, b) => b.totalValue - a.totalValue);
  const slices: LookThroughSlice[] = sorted.slice(0, topN).map((item) => ({
    name: item.name,
    value: item.totalValue,
    percentage: item.percentage,
    isOther: false,
  }));

  // Summed exactly at the storage precision, so many buckets cannot leave
  // float dust behind.
  const otherValue = sumMoney(
    [result.unclassifiedValue, ...sorted.slice(topN).map((item) => item.totalValue)],
    FIAT_MONEY_DECIMALS,
  );
  if (otherValue > 0.0001) {
    slices.push({
      name: otherLabel,
      value: otherValue,
      percentage: total > 0 ? (otherValue / total) * 100 : 0,
      isOther: true,
    });
  }

  return slices;
}
