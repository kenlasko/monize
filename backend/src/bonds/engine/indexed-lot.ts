import { BondTerms } from "../domain/bond-terms";
import { ExactDecimal } from "../domain/exact-decimal";
import { PricedPeriod, AccrualPeriod, yearFraction } from "./accrual";
import { IndexFigure, IndexSeries, indexFigureOn } from "./index-ratio";
import { roundLot, unitText } from "./rounding";

/**
 * The figures of a lot whose principal is `INDEX_RATIO`
 * (`docs/specs/bond-marketable-primitives.md` 7.1), kept apart from the plain
 * arithmetic of `accrual.ts` so that a terms document without an indexed
 * principal runs exactly the code it always did. Every figure is the lot's,
 * rounded once on the holding (`roundLot`): the index ratio is already rounded,
 * so nothing is rounded per unit first (section 5.3).
 */

/** A lot figure that may be unknown: null, with the months it needed and could not read. */
export interface LotAmount {
  readonly value: ExactDecimal | null;
  /** True when a projected month went into the figure. */
  readonly projected: boolean;
  /** The `YYYY-MM` months the figure needs that are not stored (empty when it is known or projected). */
  readonly absent: readonly string[];
}

/** What the indexed figures of a lot read: its terms, its index and its quantity. */
export interface IndexedLot {
  readonly terms: BondTerms;
  readonly series: IndexSeries;
  readonly quantity: ExactDecimal;
}

const face = (terms: BondTerms) =>
  ExactDecimal.parse(terms.instrument.faceValue);

function amountOf(figure: IndexFigure, value: ExactDecimal | null): LotAmount {
  return {
    value: figure.ratio === null ? null : value,
    projected: figure.ratio !== null && figure.projected,
    absent: figure.ratio === null ? figure.absent : [],
  };
}

/** The index figure of `date`, valued on `asOf`. */
export function indexOn(lot: IndexedLot, date: string, asOf: string) {
  return indexFigureOn({ series: lot.series, asOf }, date);
}

/**
 * One unit's principal on `date` valued on `asOf`: the face value times the index
 * ratio. `floored` is the payment at maturity, which is at least the face value
 * when the rule says `maturityFloor: PAR` (31 CFR 356.30(b)).
 */
export function unitPrincipalOn(
  lot: IndexedLot,
  date: string,
  asOf: string,
  floored: boolean,
): { readonly value: ExactDecimal | null; readonly figure: IndexFigure } {
  const figure = indexOn(lot, date, asOf);
  if (figure.ratio === null) return { value: null, figure };
  const adjusted = face(lot.terms).mul(figure.ratio);
  const paid =
    floored && lot.series.rule.maturityFloor === "PAR"
      ? ExactDecimal.max(adjusted, face(lot.terms))
      : adjusted;
  return { value: paid, figure };
}

/** The lot's principal on `date` (`floored`: as paid at maturity), rounded on the holding. */
export function principalLotOn(
  lot: IndexedLot,
  date: string,
  asOf: string,
  floored: boolean,
): LotAmount {
  const { value, figure } = unitPrincipalOn(lot, date, asOf, floored);
  return amountOf(
    figure,
    value === null ? null : roundLot(lot.terms, value, lot.quantity),
  );
}

/** One unit's coupon of a period before indexing: `face x rate x` the period's year fraction. */
function unindexedCoupon(lot: IndexedLot, priced: PricedPeriod): ExactDecimal {
  const { terms } = lot;
  return face(terms)
    .mul(priced.rate)
    .mul(
      yearFraction(
        terms,
        priced.period,
        priced.period.start,
        priced.period.end,
      ),
    );
}

/**
 * One unit's interest of a period, exact: the coupon on the face value times the
 * index ratio of the period's unadjusted end (Appendix B I.B.5); null when that
 * ratio is unknown.
 */
export function unitInterestOf(
  lot: IndexedLot,
  priced: PricedPeriod,
  asOf: string,
): { readonly value: ExactDecimal | null; readonly figure: IndexFigure } {
  const figure = indexOn(lot, priced.period.end, asOf);
  return {
    value:
      figure.ratio === null
        ? null
        : unindexedCoupon(lot, priced).mul(figure.ratio),
    figure,
  };
}

/** The lot's coupon of a period, on the index ratio of the period's end, rounded on the holding. */
export function couponLotOf(
  lot: IndexedLot,
  priced: PricedPeriod,
  asOf: string,
): LotAmount {
  const { value, figure } = unitInterestOf(lot, priced, asOf);
  return amountOf(
    figure,
    value === null ? null : roundLot(lot.terms, value, lot.quantity),
  );
}

/**
 * The lot's accrued interest on `asOf` inside `current`: the unindexed accrued
 * interest times the index ratio of `asOf` (Appendix B III.A), rounded on the
 * holding.
 */
export function accruedLotOn(
  lot: IndexedLot,
  current: PricedPeriod,
  asOf: string,
): LotAmount {
  const figure = indexOn(lot, asOf, asOf);
  if (figure.ratio === null) return amountOf(figure, null);
  const period: AccrualPeriod = current.period;
  const unindexed = face(lot.terms)
    .mul(current.rate)
    .mul(yearFraction(lot.terms, period, period.start, asOf));
  return amountOf(
    figure,
    roundLot(lot.terms, unindexed.mul(figure.ratio), lot.quantity),
  );
}

/**
 * The cash of the lot at maturity: the floored principal and the last coupon,
 * each on the index ratio of the maturity date (the final coupon is on the
 * inflation-adjusted principal, not on the floor). `last` is the last period
 * with its rate, null when that rate is unknown.
 */
export function maturityCashOf(
  lot: IndexedLot,
  last: PricedPeriod | null,
  maturity: string,
  asOf: string,
): LotAmount {
  const paid = principalLotOn(lot, maturity, asOf, true);
  const coupon: LotAmount =
    last === null
      ? { value: null, projected: false, absent: [] }
      : couponLotOf(lot, last, asOf);
  return {
    value:
      paid.value === null || coupon.value === null
        ? null
        : paid.value.add(coupon.value),
    projected: paid.projected || coupon.projected,
    absent: paid.absent,
  };
}

/** The figures an open or matured day shows for an indexed lot, as the engine prints them. */
export interface IndexedDayFigures {
  readonly principal: string | null;
  readonly accrued: string | null;
  readonly gross: string | null;
  readonly grossLot: ExactDecimal | null;
  /** The ratio's months that are not stored, when the day's figures could not be worked out. */
  readonly absent: readonly string[];
}

/**
 * The value figures of one day. Matured: the principal paid (floored), no accrued
 * interest, the final coupon being a past cash flow as for any coupon bond. Open:
 * the principal on the day plus the accrued interest, both on the day's ratio.
 * `current` is the period the day is in (null when matured).
 */
export function indexedDayFigures(
  lot: IndexedLot,
  day: {
    readonly asOf: string;
    readonly maturity: string;
    readonly current: PricedPeriod | null;
    readonly places: number;
  },
): IndexedDayFigures {
  const { terms } = lot;
  const text = (figure: ExactDecimal) => figure.toFixed(day.places);
  const unknown = (absent: readonly string[]): IndexedDayFigures => ({
    principal: null,
    accrued: null,
    gross: null,
    grossLot: null,
    absent,
  });
  if (day.current === null) {
    const unit = unitPrincipalOn(lot, day.maturity, day.asOf, true);
    if (unit.value === null) return unknown(unit.figure.absent);
    const paid = principalLotOn(lot, day.maturity, day.asOf, true);
    if (paid.value === null) return unknown(paid.absent);
    return {
      principal: unitText(terms, unit.value),
      accrued: text(ExactDecimal.ZERO),
      gross: text(paid.value),
      grossLot: paid.value,
      absent: [],
    };
  }
  const unit = unitPrincipalOn(lot, day.asOf, day.asOf, false);
  const principal = principalLotOn(lot, day.asOf, day.asOf, false);
  const accrued = accruedLotOn(lot, day.current, day.asOf);
  if (
    unit.value === null ||
    principal.value === null ||
    accrued.value === null
  ) {
    return unknown(unit.figure.absent);
  }
  const grossLot = principal.value.add(accrued.value);
  return {
    principal: unitText(terms, unit.value),
    accrued: text(accrued.value),
    gross: text(grossLot),
    grossLot,
    absent: [],
  };
}
