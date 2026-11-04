import { assertNever } from "../domain/assert-never";
import { BondTerms, roundingBasisOf } from "../domain/bond-terms";
import { ExactDecimal } from "../domain/exact-decimal";

/**
 * The one place the terms' rounding basis is applied
 * (`docs/specs/bond-marketable-primitives.md` 4). No caller multiplies a rounded
 * per-unit figure by the quantity itself: it asks for the lot's figure here.
 */

/**
 * A figure rounded to the terms' money decimals by the terms' mode. Also what a
 * figure that is already the lot's (a known cost and what is worked out from
 * it) takes whatever the basis: no per-unit figure is behind it to round.
 */
export function toMoney(terms: BondTerms, value: ExactDecimal): ExactDecimal {
  return value.round(terms.rounding.moneyDecimals, terms.rounding.mode);
}

/**
 * What a per-unit figure is, for the per-unit rounding of the other bases
 * (`docs/specs/bond-marketable-primitives.md` 5.3): `ACCRUED` is an accrued
 * interest, which the issuer rounds per unit to `unitDecimals`; `AMOUNT` is any
 * other figure (a principal, a regular coupon, a value, a maturity value), which
 * is exact until the holding is rounded. `PER_UNIT` rounds both to the money
 * decimals.
 */
export type UnitFigure = "ACCRUED" | "AMOUNT";

/**
 * A per-unit intermediate under the basis: rounded to the money decimals for
 * `PER_UNIT` (the figure is final); for the other bases to `unitDecimals` when
 * the figure is an accrued interest and `unitDecimals` is set, else exact (the
 * lot is rounded afterwards).
 */
export function unitRound(
  terms: BondTerms,
  perUnit: ExactDecimal,
  figure: UnitFigure = "AMOUNT",
): ExactDecimal {
  const basis = roundingBasisOf(terms);
  switch (basis) {
    case "PER_UNIT":
      return toMoney(terms, perUnit);
    case "PER_HOLDING":
    case "REFERENCE_AMOUNT": {
      const { unitDecimals, mode } = terms.rounding;
      return figure === "ACCRUED" &&
        unitDecimals !== undefined &&
        unitDecimals !== null
        ? perUnit.round(unitDecimals, mode)
        : perUnit;
    }
    default:
      return assertNever(basis);
  }
}

/** How many units of face make up one reference amount; whole by the parser. */
function unitsPerReference(terms: BondTerms): ExactDecimal {
  const { referenceAmount } = terms.rounding;
  if (referenceAmount === undefined) {
    throw new RangeError("A REFERENCE_AMOUNT basis has no reference amount");
  }
  return ExactDecimal.parse(referenceAmount).div(
    ExactDecimal.parse(terms.instrument.faceValue),
  );
}

/**
 * The lot's figure from the exact figure of one unit of face and the number of
 * units, rounded once as the terms say:
 *
 * - `PER_UNIT`: each unit's figure to the money decimals, times the quantity;
 * - `PER_HOLDING`: the unit's figure (to `unitDecimals` first, for an accrued
 *   interest when it is set) times the quantity, the lot rounded once to the
 *   money decimals;
 * - `REFERENCE_AMOUNT`: the same unit figure, the value of one reference amount
 *   of face rounded to the money decimals, scaled to the quantity and rounded
 *   again.
 */
export function roundLot(
  terms: BondTerms,
  perUnit: ExactDecimal,
  quantity: ExactDecimal,
  figure: UnitFigure = "AMOUNT",
): ExactDecimal {
  const basis = roundingBasisOf(terms);
  const unit = unitRound(terms, perUnit, figure);
  switch (basis) {
    case "PER_UNIT":
      return unit.mul(quantity);
    case "PER_HOLDING":
      return toMoney(terms, unit.mul(quantity));
    case "REFERENCE_AMOUNT": {
      const units = unitsPerReference(terms);
      const reference = toMoney(terms, unit.mul(units));
      return toMoney(terms, reference.mul(quantity).div(units));
    }
    default:
      return assertNever(basis);
  }
}

/**
 * One unit's figure as text, for a surface that shows a per-bond amount: the
 * money decimals under `PER_UNIT`; under another basis the finer of the money
 * decimals and `unitDecimals`, so a unit price quoted to six decimals is not
 * shown to two.
 */
export function unitText(terms: BondTerms, perUnit: ExactDecimal): string {
  const money = terms.rounding.moneyDecimals;
  if (roundingBasisOf(terms) === "PER_UNIT") {
    return unitRound(terms, perUnit).toFixed(money);
  }
  const unit = terms.rounding.unitDecimals ?? money;
  return unitRound(terms, perUnit).toFixed(unit > money ? unit : money);
}
