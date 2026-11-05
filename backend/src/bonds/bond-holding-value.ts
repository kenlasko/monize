import { ExactDecimal } from "./domain/exact-decimal";
import { SecurityValueByAccount } from "./bond-valuation.service";

/** How far a lot count may sit from a holding's quantity and still be the same position. */
const LOT_QUANTITY_TOLERANCE = 0.0001;

/** Money is `decimal(20,4)`: a market value is rounded to it once, at the end. */
const MONEY_PLACES = 4;

/** Why a bond-linked holding has no value. */
export type BondHoldingUnpriced =
  /** The valuation failed, the lots are unknowable or one lot has no gross value. */
  | "UNKNOWN"
  /** The lots count a different number of bonds than the holding: never price another quantity. */
  | "QUANTITY_MISMATCH"
  /** The holding's series trade and nobody has entered a price. */
  | "MARKET_PRICE_MISSING";

/** What a surface shows for one bond-linked holding, in the security's currency. */
export interface BondHoldingValue {
  /** Exact decimal text, rounded to the money places. */
  readonly marketValue: string;
  /** The value of one bond (one unit of the holding's quantity). */
  readonly unitPrice: string;
  /** Where the value came from: the engine's lots, or the person's price. */
  readonly basis: "LOTS" | "MARKET_PRICE";
}

/**
 * The value of one account's holding of a bond-linked security, or why it has
 * none. Written once for every surface that values such a holding
 * (INV-BOND-010, `docs/specs/bond-program-securities.md` 2.4; the fix for one
 * surface is not the fix).
 *
 * - A holding of series the engine prices (a retail bond, a discount
 *   instrument) is worth the exact gross value of its own account's lots.
 * - A holding with a series the engine does not price (a marketable coupon
 *   security, `marketPriceRequired`; INV-BOND-005,
 *   `docs/specs/bond-marketable-primitives.md` 3) is worth the person's price
 *   times the quantity, never the engine's par. A unit is one bond of face
 *   value 100 and a price is quoted per 100 of face value, so `value = price x
 *   quantity`, the arithmetic the holdings of every other security use. A
 *   missing price leaves the holding unpriced (`MARKET_PRICE_MISSING`), never
 *   par and never zero. Accrued interest is not added: a quoted price of a
 *   coupon security is a clean price and the model holds no field for the
 *   accrued part of a holding's value, so the value is the clean value and the
 *   lot view still shows the accrued interest on its own line.
 *
 * `price` is the surface's own price for the security (the one the non-bond
 * path reads); only a holding that needs it uses it.
 */
export function bondHoldingValue(
  valued: SecurityValueByAccount | null | undefined,
  accountId: string,
  quantity: number,
  price: number | null | undefined,
): BondHoldingValue | { readonly unpriced: BondHoldingUnpriced } {
  const lots = valued?.accounts?.get(accountId);
  if (!lots) return { unpriced: "UNKNOWN" };
  if (Math.abs(lots.quantity - quantity) >= LOT_QUANTITY_TOLERANCE) {
    return { unpriced: "QUANTITY_MISMATCH" };
  }
  if (lots.marketPriceRequired) {
    if (price === null || price === undefined || !Number.isFinite(price)) {
      return { unpriced: "MARKET_PRICE_MISSING" };
    }
    const unit = ExactDecimal.parse(price.toFixed(10));
    const value = unit.mul(ExactDecimal.parse(quantity.toFixed(8)));
    return {
      marketValue: value.toFixed(MONEY_PLACES),
      unitPrice: unit.toFixed(10),
      basis: "MARKET_PRICE",
    };
  }
  if (lots.grossValue === null) return { unpriced: "UNKNOWN" };
  return {
    marketValue: lots.grossValue,
    unitPrice: ExactDecimal.parse(lots.grossValue)
      .div(ExactDecimal.parse(lots.quantity.toFixed(8)))
      .toFixed(10),
    basis: "LOTS",
  };
}
