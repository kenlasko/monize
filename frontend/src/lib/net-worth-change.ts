import type { MonthlyNetWorth } from '@/types/net-worth';
import { roundMoney } from '@/lib/format';

/**
 * Net worth's change over the window a monthly series covers, from its first
 * month to its last, read by the Net Worth report and the dashboard's Net
 * Worth widget.
 */
export interface NetWorthWindowChange {
  /** False when either end month is a subtotal: a change measured from or to one is not a change. */
  known: boolean;
  /** The last month's net worth less the first's. */
  amount: number;
  /** `amount` over the first month's magnitude; `0` when that month was exactly zero. */
  percent: number;
}

/**
 * The amount is the server's (`netWorthChangeFromStart`, one rounding of the
 * two months' unrounded difference), where the difference of the two readings
 * can sit a unit off it (`docs/specs/report-rounding-and-aggregation.md`
 * rule 4). A response without it (an older backend) takes the difference of
 * the two readings here, rounded at the reporting currency's money precision
 * only to shed float error, as `heroMonthChange` does. `null` for an empty
 * series, which has no change to state.
 */
export function netWorthWindowChange(
  series: readonly MonthlyNetWorth[],
  moneyDecimals: number,
): NetWorthWindowChange | null {
  if (series.length === 0) return null;
  const first = series[0];
  const last = series[series.length - 1];
  const amount =
    last.netWorthChangeFromStart ?? roundMoney(last.netWorth - first.netWorth, moneyDecimals);
  return {
    known: last.fxComplete !== false && first.fxComplete !== false,
    amount,
    percent: first.netWorth !== 0 ? (amount / Math.abs(first.netWorth)) * 100 : 0,
  };
}
