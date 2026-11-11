/**
 * The invested part's time-weighted return as a series: its running value on
 * every day of a window, rather than only on the last one.
 *
 * Nothing is measured here that `investedPeriodResult` does not measure. The
 * window's return is decided by that function (through
 * `investedTimeWeightedDecision`, which also hands back the factors it chained);
 * this one draws only where it reports a figure, so the line is withheld exactly where the
 * card beside it is and ends on the card's number (INV-PORTTWR-001,
 * `docs/specs/portfolio-twr-series.md`). The factors are `investedDayFactors`,
 * the one place the day's base and ending are written.
 *
 * Pure, so the policy is table-tested without a database.
 */
import { roundToDecimals } from "../common/round.util";
import { PORTFOLIO_MOVE_PERCENT_DECIMALS } from "../notification-center/portfolio-movement.util";
import {
  InvestedPeriodInput,
  investedTimeWeightedDecision,
} from "./invested-period-result.util";
import { PeriodResultReason } from "./portfolio-period-result.util";

/** One day of the series. */
export interface InvestedTwrPoint {
  date: string;
  /** Cumulative time-weighted return from the window's opening close, in percent. */
  returnPercent: number;
}

export interface InvestedTwrSeries {
  /**
   * The opening close, then every day of the window, in order. Empty when the
   * return is withheld: a subtotal day, a flow that did not convert, or no
   * capital ever at risk with something earned. Never partial.
   */
  points: InvestedTwrPoint[];
  /** True when `points` is drawn; the reasons below are then empty. */
  complete: boolean;
  /** Why the series is withheld, from the closed set the period result uses. */
  reasons: PeriodResultReason[];
}

/** A withheld series carrying the decision's own reasons. */
const withheld = (reasons: PeriodResultReason[]): InvestedTwrSeries => ({
  points: [],
  complete: false,
  reasons,
});

/**
 * The running time-weighted return over `(startIndex, endIndex]`, opening at
 * `0` on `startIndex`.
 *
 * A day with no capital at risk contributes factor 1, so the line is flat until
 * the first day that has a base. Where nothing was ever at risk and nothing was
 * earned the period result reports a known zero, and so does this: a flat line
 * at zero, not a refusal.
 */
export function investedTwrSeries(
  input: InvestedPeriodInput,
): InvestedTwrSeries {
  // The card's own decision and the factors it chained, read once: no second
  // derivation of the factors, and no money-weighted solve the line discards.
  const { decision, dayFactors } = investedTimeWeightedDecision(input);
  if (decision.investmentReturnPercent === null || dayFactors === null) {
    return withheld(decision.investedReasons);
  }

  const { points, startIndex, endIndex } = input;
  const start = points[startIndex];
  const days = points.slice(startIndex + 1, endIndex + 1);
  const factors = dayFactors;

  const series: InvestedTwrPoint[] = [{ date: start.date, returnPercent: 0 }];
  let product = 1;
  for (let i = 0; i < days.length; i++) {
    // The same product, in the same order, `chainTwrPercent` multiplies: a day
    // with no base is factor 1, which multiplies exactly.
    product *= factors[i] ?? 1;
    series.push({
      date: days[i].date,
      // `+ 0` turns a rounded negative zero into zero.
      returnPercent:
        roundToDecimals((product - 1) * 100, PORTFOLIO_MOVE_PERCENT_DECIMALS) +
        0,
    });
  }

  return { points: series, complete: true, reasons: [] };
}
