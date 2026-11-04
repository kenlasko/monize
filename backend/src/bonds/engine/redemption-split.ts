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
  /**
   * One unit's figures by the same rule. Under `PER_UNIT` the lot's are these,
   * each times `quantity`; under another basis the lot is rounded on the
   * holding, so these are informational and the lot's figures are not their
   * multiples.
   */
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

/** What a lot (or one unit) is worth in the three figures the split is built from, exact and rounded as the terms say. */
export interface SplitBasis {
  /** The principal base on the date. */
  readonly principal: ExactDecimal;
  /** The value before any deduction. */
  readonly gross: ExactDecimal;
  /** The cash paid. */
  readonly payout: ExactDecimal;
}

/**
 * No split: the refusal, and the principal when it is still known (the lot's and
 * one unit's).
 */
export function refusedSplit(
  date: string,
  quantity: number,
  places: number,
  refusal: RedemptionSplitRefusal,
  principal: { readonly lot: ExactDecimal; readonly unit: ExactDecimal } | null,
): RedemptionSplit {
  const known = (value: ExactDecimal | undefined): RedemptionSplitFigures => ({
    ...NONE,
    principal: value === undefined ? null : value.toFixed(places),
  });
  return {
    date,
    quantity,
    ...known(principal?.lot),
    perBond: known(principal?.unit),
    refusal,
  };
}

/**
 * The figures of a split from the three of its basis. The deduction is what the
 * issuer keeps; it comes out of the interest first.
 * `payout = principalReturned + interest` exactly, whatever the basis: all three
 * inputs are on the money grid, so every difference is, and the text is exact.
 */
function figuresOf(places: number, basis: SplitBasis): RedemptionSplitFigures {
  const { principal, gross, payout } = basis;
  const grossInterest = gross.sub(principal);
  const deduction = gross.sub(payout);
  const interest = ExactDecimal.max(
    ExactDecimal.ZERO,
    grossInterest.sub(deduction),
  );
  const text = (v: ExactDecimal) => v.toFixed(places);
  return {
    principal: text(principal),
    grossInterest: text(grossInterest),
    deduction: text(deduction),
    interest: text(interest),
    principalReturned: text(payout.sub(interest)),
    payout: text(payout),
  };
}

/** The split of the lot (`lot`) and of one unit (`unit`) from their three figures. */
export function splitOf(
  date: string,
  quantity: number,
  places: number,
  lot: SplitBasis,
  unit: SplitBasis,
): RedemptionSplit {
  return {
    date,
    quantity,
    ...figuresOf(places, lot),
    perBond: figuresOf(places, unit),
    refusal: null,
  };
}
