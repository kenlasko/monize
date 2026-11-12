import { roundMoney } from "../common/round.util";
import { ReplayStep } from "./position-basis-replay";

/** What one SELL or RETURN_OF_CAPITAL realized, as the replay states it. */
export type ReplayedDisposal = NonNullable<ReplayStep["disposal"]>;

/**
 * One disposal's figures in the reporting currency, from the account-currency
 * replay's `disposal` and the reporting-currency replay's `reported` for the
 * same row: the proceeds at the sale's own rate or date, the basis at each
 * acquisition's (issue #2106). The gain is the difference of the two rounded
 * figures, so `proceeds - costBasis` is the gain to the last place.
 *
 * A figure is null when the account-currency gain is unknown, or when a rate
 * the reporting replay needs is missing. The one rule Realized Gains lists and
 * the capital-gains fold sums by period, so the two state a sale's gain in the
 * reporting currency alike (issue #2130).
 */
export function disposalInReporting(
  disposal: ReplayedDisposal,
  reported: ReplayedDisposal | undefined,
): {
  proceeds: number | null;
  costBasis: number | null;
  realizedGain: number | null;
} {
  const known =
    disposal.gap === null &&
    disposal.proceeds !== null &&
    reported !== undefined &&
    reported.gap === null &&
    reported.proceeds !== null;
  const proceeds =
    reported?.proceeds != null ? roundMoney(reported.proceeds) : null;
  const costBasis =
    known && reported ? roundMoney(reported.basisRelieved) : null;
  const realizedGain =
    known && proceeds !== null && costBasis !== null
      ? roundMoney(proceeds - costBasis)
      : null;
  return { proceeds, costBasis, realizedGain };
}
