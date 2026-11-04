import { assertNever } from "../domain/assert-never";
import { BondTerms } from "../domain/bond-terms";
import { daysBetween } from "../domain/calendar-date";
import { ExactDecimal } from "../domain/exact-decimal";
import { roundingBasisOf } from "../domain/bond-rounding";
import { roundLot, unitRound } from "./rounding";

/**
 * Per-bond amounts from the primitives of the terms. Every amount is for ONE
 * bond; `prior` are the periods 1..k-1 with their rates (empty unless the bond
 * compounds) and `current` is period k with its annual rate.
 */

/**
 * What the principal may depend on. Today only the day; this is where an index
 * ratio or an amortisation schedule will be passed when a principal rule needs
 * one.
 */
export interface PrincipalContext {
  readonly date: string;
}

/** The days a rate accrues over: a period's start and end. */
export interface AccrualPeriod {
  readonly start: string;
  readonly end: string;
}

/** A period with the annual rate that applies to it. */
export interface PricedPeriod {
  readonly period: AccrualPeriod;
  readonly rate: ExactDecimal;
}

/** True for a discount instrument: the value rises from its issue price to the face value, no rate is stated. */
export function isDiscount(terms: BondTerms): boolean {
  return terms.rateRule.type === "ZERO_COUPON_DISCOUNT";
}

/** The issue price of a discount instrument; the terms parser guarantees it is there. */
function issuePriceOf(terms: BondTerms): ExactDecimal {
  if (terms.instrument.issuePrice === undefined) {
    throw new RangeError("A discount instrument has no issue price");
  }
  return ExactDecimal.parse(terms.instrument.issuePrice);
}

/**
 * One bond's principal on `ctx.date`: the nominal, or for a discount instrument
 * the issue price it was bought at.
 */
export function principalAt(
  terms: BondTerms,
  ctx: PrincipalContext,
): ExactDecimal {
  switch (terms.principalRule.type) {
    case "FIXED_NOMINAL":
      void ctx;
      return isDiscount(terms)
        ? issuePriceOf(terms)
        : ExactDecimal.parse(terms.instrument.faceValue);
    default:
      return assertNever(terms.principalRule.type);
  }
}

export function roundMoney(
  terms: BondTerms,
  value: ExactDecimal,
): ExactDecimal {
  return value.round(terms.rounding.moneyDecimals, terms.rounding.mode);
}

/** True when the value of period k depends on the rates of the periods before it. */
export function compounds(terms: BondTerms): boolean {
  switch (terms.capitalization.type) {
    case "NONE":
      return false;
    case "COMPOUND_AT_PERIOD_END":
      return true;
    default:
      return assertNever(terms.capitalization);
  }
}

/** Periods per year, F = 12 / periodMonths; only a schedule counted in months has one. */
function periodsPerYear(terms: BondTerms): ExactDecimal {
  const { schedule } = terms;
  switch (schedule.anchor) {
    case "LOT_PURCHASE_DATE":
      return ExactDecimal.fromInt(12 / schedule.periodMonths);
    case "ISSUE_DATE":
      throw new RangeError("A single-period schedule has no periods per year");
    default:
      return assertNever(schedule);
  }
}

/**
 * The share of a year the rate earns from `from` to `to` inside `period`:
 * (1 / F) of the period for the days elapsed of its days, F = 12 / periodMonths.
 * A whole period is `yearFraction(terms, period, period.start, period.end)`.
 */
export function yearFraction(
  terms: BondTerms,
  period: AccrualPeriod,
  from: string,
  to: string,
): ExactDecimal {
  switch (terms.accrual.type) {
    case "ACTUAL_DAYS_IN_PERIOD": {
      const perPeriod = ExactDecimal.ONE.div(periodsPerYear(terms));
      // The whole period is exactly 1 / F; skip the day count on the hot path.
      if (from === period.start && to === period.end) return perPeriod;
      return perPeriod.mul(
        ExactDecimal.ratio(
          daysBetween(from, to),
          daysBetween(period.start, period.end),
        ),
      );
    }
    default:
      return assertNever(terms.accrual.type);
  }
}

function wholePeriod(terms: BondTerms, period: AccrualPeriod): ExactDecimal {
  return yearFraction(terms, period, period.start, period.end);
}

/** The interest one whole period earns on `base` at `rate`, unrounded. */
export function periodInterest(
  terms: BondTerms,
  base: ExactDecimal,
  period: AccrualPeriod,
  rate: ExactDecimal,
): ExactDecimal {
  return base.mul(rate).mul(wholePeriod(terms, period));
}

function compoundedNominal(
  terms: BondTerms,
  periods: readonly PricedPeriod[],
  ctx: PrincipalContext,
): ExactDecimal {
  return periods.reduce(
    (base, { period, rate }) =>
      base.mul(ExactDecimal.ONE.add(rate.mul(wholePeriod(terms, period)))),
    principalAt(terms, ctx),
  );
}

/** The base interest accrues on at `ctx.date`, the start of the period after `prior`. */
export function baseAt(
  terms: BondTerms,
  prior: readonly PricedPeriod[],
  ctx: PrincipalContext,
): ExactDecimal {
  const capitalization = terms.capitalization;
  switch (capitalization.type) {
    case "NONE":
      return principalAt(terms, ctx);
    case "COMPOUND_AT_PERIOD_END": {
      const base = compoundedNominal(terms, prior, ctx);
      return capitalization.baseRounding === "PER_PERIOD"
        ? roundMoney(terms, base)
        : base;
    }
    default:
      return assertNever(capitalization);
  }
}

/**
 * A discount instrument's value on day k of the N days of its period: the issue
 * price plus k/N of the discount (the ratable accrual method), unrounded.
 */
function discountValueAt(
  terms: BondTerms,
  period: AccrualPeriod,
  asOf: string,
): ExactDecimal {
  const issuePrice = issuePriceOf(terms);
  const discount = ExactDecimal.parse(terms.instrument.faceValue).sub(
    issuePrice,
  );
  return issuePrice.add(
    discount.mul(
      ExactDecimal.ratio(
        daysBetween(period.start, asOf),
        daysBetween(period.start, period.end),
      ),
    ),
  );
}

/** Value on the day `asOf` inside `current` before any penalty, unrounded. */
export function valueAt(
  terms: BondTerms,
  prior: readonly PricedPeriod[],
  current: PricedPeriod,
  asOf: string,
): ExactDecimal {
  if (isDiscount(terms)) return discountValueAt(terms, current.period, asOf);
  const accrual = current.rate.mul(
    yearFraction(terms, current.period, current.period.start, asOf),
  );
  return baseAt(terms, prior, { date: asOf }).mul(
    ExactDecimal.ONE.add(accrual),
  );
}

/**
 * The coupon paid at a period end per unit, rounded as a unit's figure is (to
 * the money decimals under `PER_UNIT`, exact under another basis, where the lot
 * is rounded instead: `couponLot`); null when interest is capitalised instead. A
 * discount instrument's "coupon" is its whole discount, paid inside the face
 * value at maturity.
 */
export function couponOf(
  terms: BondTerms,
  period: PricedPeriod,
): ExactDecimal | null {
  switch (terms.capitalization.type) {
    case "NONE": {
      if (isDiscount(terms)) {
        return unitRound(
          terms,
          ExactDecimal.parse(terms.instrument.faceValue),
        ).sub(unitRound(terms, issuePriceOf(terms)));
      }
      const base = principalAt(terms, { date: period.period.end });
      return unitRound(
        terms,
        periodInterest(terms, base, period.period, period.rate),
      );
    }
    case "COMPOUND_AT_PERIOD_END":
      return null;
    default:
      return assertNever(terms.capitalization);
  }
}

/**
 * The coupon of `quantity` units paid at a period end, the lot's figure rounded
 * as the terms' basis says (`roundLot`); null when interest is capitalised. A
 * discount instrument's is its whole discount: the face value less the issue
 * price, each as a lot figure.
 */
export function couponLot(
  terms: BondTerms,
  period: PricedPeriod,
  quantity: ExactDecimal,
): ExactDecimal | null {
  switch (terms.capitalization.type) {
    case "NONE": {
      if (isDiscount(terms)) {
        return roundLot(
          terms,
          ExactDecimal.parse(terms.instrument.faceValue),
          quantity,
        ).sub(roundLot(terms, issuePriceOf(terms), quantity));
      }
      const base = principalAt(terms, { date: period.period.end });
      return roundLot(
        terms,
        periodInterest(terms, base, period.period, period.rate),
        quantity,
      );
    }
    case "COMPOUND_AT_PERIOD_END":
      return null;
    default:
      return assertNever(terms.capitalization);
  }
}

/** Cash received at maturity for `quantity` units, the lot's figure; `last` is the final period. */
export function maturityLot(
  terms: BondTerms,
  prior: readonly PricedPeriod[],
  last: PricedPeriod,
  quantity: ExactDecimal,
): ExactDecimal {
  const date = last.period.end;
  if (isDiscount(terms)) {
    return roundLot(
      terms,
      ExactDecimal.parse(terms.instrument.faceValue),
      quantity,
    );
  }
  const coupon = couponLot(terms, last, quantity);
  return coupon === null
    ? roundLot(
        terms,
        compoundedNominal(terms, [...prior, last], { date }),
        quantity,
      )
    : principalAt(terms, { date }).mul(quantity).add(coupon);
}

/**
 * The lot's principal on `ctx.date`: the nominal (the issue price of a discount
 * instrument) of `quantity` units. Unrounded under `PER_UNIT`, where the nominal
 * is the issuer's own figure; rounded on the holding under another basis.
 */
export function principalLot(
  terms: BondTerms,
  ctx: PrincipalContext,
  quantity: ExactDecimal,
): ExactDecimal {
  const nominal = principalAt(terms, ctx);
  return roundingBasisOf(terms) === "PER_UNIT"
    ? nominal.mul(quantity)
    : roundLot(terms, nominal, quantity);
}

/**
 * The lot's figure for a unit's `value` on the day `asOf` (`valueAt`, before any
 * penalty), rounded as the basis says. A coupon bond's is its principal plus its
 * accrued interest, the accrued interest being the figure the issuer rounds per
 * unit (`unitDecimals`); every other value is rounded once as a whole.
 */
export function grossLotOf(
  terms: BondTerms,
  value: ExactDecimal,
  asOf: string,
  quantity: ExactDecimal,
): ExactDecimal {
  if (
    roundingBasisOf(terms) === "PER_UNIT" ||
    isDiscount(terms) ||
    compounds(terms)
  ) {
    return roundLot(terms, value, quantity);
  }
  const nominal = principalAt(terms, { date: asOf });
  return roundLot(terms, nominal, quantity).add(
    roundLot(terms, value.sub(nominal), quantity, "ACCRUED"),
  );
}
