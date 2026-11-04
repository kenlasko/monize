import { ExactDecimal } from "../domain/exact-decimal";
import {
  BondValuationRefusal,
  EarlyRedemptionRefusal,
} from "./bond-engine-types";

/** Why no split is given: a window rule (never "MATURED", which pays the maturity split), an unknown rate, or the purchase date (the sale window, or a marketable lot bought at or after maturity). */
export type RedemptionSplitRefusal =
  Exclude<EarlyRedemptionRefusal, "MATURED"> | BondValuationRefusal["code"];

/**
 * The cash of a redemption as returned principal and interest, exact decimal
 * strings in the terms' money decimals; null where unknown.
 * `payout = principalReturned + interest` and `interest >= 0` (INV-BOND-009).
 */
export interface RedemptionSplitFigures {
  /** The principal base on the date (the face value, or a discount instrument's issue price). */
  readonly principal: string | null;
  /** The value before any deduction, less `principal`. */
  readonly grossInterest: string | null;
  /** The value before deduction less what is paid; 0 at maturity. */
  readonly deduction: string | null;
  /** `max(0, grossInterest - deduction)`: what the holder reports as interest. */
  readonly interest: string | null;
  /** `payout - interest`; below `principal` only when a deduction exceeds the interest and no floor stops it. */
  readonly principalReturned: string | null;
  /** The cash paid out. */
  readonly payout: string | null;
}

export interface RedemptionSplit extends RedemptionSplitFigures {
  /** The date asked about; after maturity the split is the maturity split. */
  readonly date: string;
  readonly quantity: number;
  /** One bond's figures; the lot's are these, each times `quantity`. */
  readonly perBond: RedemptionSplitFigures;
  /** Set when no split can be given; the figures are then null (`principal` stays known for RATE_UNKNOWN). */
  readonly refusal: RedemptionSplitRefusal | null;
}

const NONE: RedemptionSplitFigures = {
  principal: null,
  grossInterest: null,
  deduction: null,
  interest: null,
  principalReturned: null,
  payout: null,
};

/** The lot's figures from one bond's, each rounded per bond first and then multiplied by the quantity. */
function lotOf(
  perBond: RedemptionSplitFigures,
  quantity: number,
  places: number,
): RedemptionSplitFigures {
  const q = ExactDecimal.fromInt(quantity);
  const times = (v: string | null) =>
    v === null ? null : ExactDecimal.parse(v).mul(q).toFixed(places);
  return {
    principal: times(perBond.principal),
    grossInterest: times(perBond.grossInterest),
    deduction: times(perBond.deduction),
    interest: times(perBond.interest),
    principalReturned: times(perBond.principalReturned),
    payout: times(perBond.payout),
  };
}

/** No split: the refusal, and the principal when it is still known. */
export function refusedSplit(
  date: string,
  quantity: number,
  places: number,
  refusal: RedemptionSplitRefusal,
  principalBond: ExactDecimal | null,
): RedemptionSplit {
  const perBond: RedemptionSplitFigures = {
    ...NONE,
    principal: principalBond === null ? null : principalBond.toFixed(places),
  };
  return {
    date,
    quantity,
    ...lotOf(perBond, quantity, places),
    perBond,
    refusal,
  };
}

/**
 * The split of one bond's rounded `principal`, `gross` (value before any
 * deduction) and `payout`, then of the lot. The deduction is what the issuer
 * keeps; it comes out of the interest first.
 */
export function splitOf(
  date: string,
  quantity: number,
  places: number,
  bond: {
    readonly principal: ExactDecimal;
    readonly gross: ExactDecimal;
    readonly payout: ExactDecimal;
  },
): RedemptionSplit {
  const { principal, gross, payout } = bond;
  const grossInterest = gross.sub(principal);
  const deduction = gross.sub(payout);
  const interest = ExactDecimal.max(
    ExactDecimal.ZERO,
    grossInterest.sub(deduction),
  );
  const text = (v: ExactDecimal) => v.toFixed(places);
  const perBond: RedemptionSplitFigures = {
    principal: text(principal),
    grossInterest: text(grossInterest),
    deduction: text(deduction),
    interest: text(interest),
    principalReturned: text(payout.sub(interest)),
    payout: text(payout),
  };
  return {
    date,
    quantity,
    ...lotOf(perBond, quantity, places),
    perBond,
    refusal: null,
  };
}
