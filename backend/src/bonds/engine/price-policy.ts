import { BondTerms } from "../domain/bond-terms";
import { isDiscount } from "./accrual";

/**
 * Whether the engine may write the price of a security that holds a series of
 * these terms (INV-BOND-005, `docs/specs/bond-marketable-primitives.md` 3).
 *
 * A retail-redeemable series is worth what its terms say, and so is a discount
 * instrument (its value rises ratably to the face value). A marketable coupon
 * series trades: its market price is not a function of its terms, so the engine
 * has no price to write for it.
 */
export function engineWritesPrice(terms: BondTerms): boolean {
  return (
    terms.instrument.marketability === "RETAIL_REDEEMABLE" || isDiscount(terms)
  );
}

/**
 * True when a security holding series of these terms is priced by the person,
 * not by the engine: at least one series is one the engine does not price. No
 * series is not a reason to ask for a price.
 */
export function marketPriceRequired(series: readonly BondTerms[]): boolean {
  return series.some((terms) => !engineWritesPrice(terms));
}
