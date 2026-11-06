import { assertNever } from "../domain/assert-never";
import {
  BenchmarkRule,
  BondTerms,
  benchmarkFieldsOf,
} from "../domain/bond-terms";
import { compareYMD } from "../domain/calendar-date";
import { ExactDecimal } from "../domain/exact-decimal";
import { SchedulePeriod } from "../domain/period-schedule";
import {
  couponLot,
  isDiscount,
  maturityLot,
  principalAt,
  principalLot,
} from "./accrual";
import { paymentDateOf } from "./coupon-accrual";
import { toMoney, roundLot } from "./rounding";
import {
  BondEngineInput,
  BondLotStatus,
  BondValuation,
  BondValuationRefusal,
  CashFlow,
  RateRuleDescription,
} from "./bond-engine-types";
import {
  RedemptionSplit,
  RedemptionSplitRefusal,
  refusedSplit,
  SplitBasis,
  splitOf,
} from "./redemption-split";
import { startedPeriods } from "./rate-resolution";
import { derivedFlowsOf } from "./derived-flows";
import { maturityCashOf as floatingMaturityCash } from "./floating-lot";
import { IndexedLot, maturityCashOf, unitPrincipalOn } from "./indexed-lot";
import { referencedCalendarIds } from "./redemption";

import {
  costOf,
  figuresOn,
  inputsFor,
  PreparedLot,
  RateInputs,
  prepare,
  resolvedFor,
  validateDay,
  validateLot,
} from "./prepared-lot";

export * from "./bond-engine-types";
export * from "./redemption-split";

function benchmarkDescription(
  rule: BenchmarkRule,
  addend: string,
): RateRuleDescription {
  return {
    type: rule.type,
    benchmarkId: rule.benchmarkId,
    annualRate: null,
    firstPeriodRate: rule.firstPeriodRate,
    addend,
    benchmarkFloor: rule.benchmarkFloor,
  };
}

function describeRule(
  rule: BondEngineInput["terms"]["rateRule"],
): RateRuleDescription {
  switch (rule.type) {
    case "FIXED":
      return {
        type: rule.type,
        benchmarkId: null,
        annualRate: rule.annualRate,
        firstPeriodRate: null,
        addend: null,
        benchmarkFloor: null,
      };
    case "ZERO_COUPON_DISCOUNT":
      return {
        type: rule.type,
        benchmarkId: null,
        annualRate: null,
        firstPeriodRate: null,
        addend: null,
        benchmarkFloor: null,
      };
    case "BENCHMARK_PLUS_SPREAD":
      return benchmarkDescription(rule, rule.spread);
    case "INFLATION_PLUS_MARGIN_AS_RATE":
      return benchmarkDescription(rule, rule.margin);
    case "DAILY_INDEX_PLUS_SPREAD":
      return {
        type: rule.type,
        benchmarkId: rule.benchmarkId,
        annualRate: null,
        firstPeriodRate: null,
        addend: rule.spread,
        benchmarkFloor: rule.floor,
        lockoutBusinessDays: rule.lockoutBusinessDays,
      };
    default:
      return assertNever(rule);
  }
}

function principalBasisOf(p: PreparedLot): BondValuation["principalBasis"] {
  if (!isDiscount(p.input.terms)) return null;
  return p.cost === null ? "ISSUE_PRICE" : "LOT_COST";
}

function refusedValuation(
  p: PreparedLot,
  asOf: string,
  refusal: BondValuationRefusal,
): BondValuation {
  const { terms, calendars } = p.input;
  return {
    asOf,
    seriesCode: terms.instrument.seriesCode,
    termsVersion: p.input.termsVersion,
    quantity: p.input.lot.quantity,
    maturityDate: p.maturity,
    status: "REFUSED",
    refusal,
    currentPeriod: null,
    rateRule: describeRule(terms.rateRule),
    rateSchedule: [],
    principal: null,
    principalBasis: principalBasisOf(p),
    accruedInterest: null,
    grossValue: null,
    earlyRedemptionValue: null,
    earlyRedemptionRefusal: null,
    nextPayment: [],
    nextRateReset: null,
    nextCapitalization: null,
    knownCashflows: [],
    projectedCashflows: [],
    maturityValueKnown: null,
    maturityValueProjected: null,
    projectionAssumptions: [],
    projectionMissing: [],
    dataCompleteness: {
      termsComplete: [...referencedCalendarIds(terms)].every((id) =>
        calendars.has(id),
      ),
      referenceDataComplete: true,
      earlyRedemptionTermsComplete: true,
    },
    missing: [],
    valuationComplete: false,
  };
}

/** Every cash flow dated on the earliest date among `cashflows`, which are all after asOf. */
function nextPaymentOf(cashflows: readonly CashFlow[]): CashFlow[] {
  if (cashflows.length === 0) return [];
  const next = cashflows.reduce(
    (earliest, c) => (compareYMD(c.date, earliest) < 0 ? c.date : earliest),
    cashflows[0].date,
  );
  return cashflows.filter((c) => c.date === next);
}

/** The next period's start when the rate reads a benchmark and a next period exists. */
function nextRateResetOf(
  p: PreparedLot,
  current: SchedulePeriod | null,
): string | null {
  if (current === null || benchmarkFieldsOf(p.input.terms.rateRule) === null)
    return null;
  const next = p.schedule[current.index];
  return next === undefined ? null : next.start;
}

/** The whole valuation of an already validated day of a prepared lot. */
function valueOn(p: PreparedLot, asOf: string): BondValuation {
  if (p.saleRefusal) return refusedValuation(p, asOf, p.saleRefusal);
  const { terms, calendars } = p.input;
  const figures = figuresOn(p, asOf);
  const { matured, current, started } = figures;
  const resolved = resolvedFor(p, started, asOf);
  const { rates } = resolved;
  const { compounding, lastPeriod } = p;
  // A lot whose principal tracks an index or whose rate is floating has flows of
  // its own (`derived-flows.ts`); every other lot runs the plain arithmetic.
  const derived = derivedFlowsOf(p, asOf, matured, current);
  let { maturityCash, maturityProjected } = resolved;
  const lot = (figure: ExactDecimal) => figure.toFixed(p.places);
  const currentRate =
    current && !isDiscount(terms) ? rates[current.index - 1] : null;

  const cashflows: CashFlow[] = [];
  const flow = (
    period: SchedulePeriod,
    type: CashFlow["type"],
    amount: ExactDecimal | null,
    projected: boolean,
  ): CashFlow => {
    const date = paymentDateOf(terms, calendars, period);
    return {
      date,
      ...(date === period.end ? {} : { accrualEndDate: period.end }),
      type,
      amount: amount === null ? null : lot(amount),
      status: amount === null ? "UNKNOWN" : projected ? "PROJECTED" : "KNOWN",
      period: period.index,
    };
  };
  if (!compounding) {
    for (const period of p.schedule) {
      // Paid on its payment date, which an adjustment moves after the period end.
      if (compareYMD(paymentDateOf(terms, calendars, period), asOf) <= 0)
        continue;
      const rate = rates[period.index - 1];
      if (derived !== null) {
        const coupon = derived.coupon(period, rate.rate);
        cashflows.push(
          flow(period, "INTEREST", coupon.value, coupon.projected),
        );
        continue;
      }
      const coupon =
        rate.rate === null
          ? null
          : couponLot(terms, { period, rate: rate.rate }, p.quantity, p.cost);
      cashflows.push(
        flow(period, "INTEREST", coupon, rate.source === "PROJECTED"),
      );
    }
    if (compareYMD(paymentDateOf(terms, calendars, lastPeriod), asOf) > 0) {
      if (derived !== null) {
        const paid = derived.principal(lastPeriod);
        cashflows.push(
          flow(lastPeriod, "PRINCIPAL", paid.value, paid.projected),
        );
      } else {
        cashflows.push(
          flow(
            lastPeriod,
            "PRINCIPAL",
            principalLot(
              terms,
              { date: lastPeriod.end, unitBase: p.unitBase },
              p.quantity,
              p.cost,
            ),
            false,
          ),
        );
      }
    }
  } else if (!matured) {
    cashflows.push(
      flow(lastPeriod, "PRINCIPAL", maturityCash, maturityProjected),
    );
  }

  if (derived !== null) {
    const cash = derived.maturity(lastPeriod, rates[lastPeriod.index - 1].rate);
    maturityCash = cash.value;
    maturityProjected = cash.projected;
  }
  const trail = derived === null ? null : derived.trail();
  const missing =
    trail === null
      ? resolved.missingFor
      : [...resolved.missingFor, ...trail.missing];
  const assumptions =
    trail === null
      ? resolved.assumptions
      : [...resolved.assumptions, ...trail.assumptions];
  const projectionMissing =
    trail === null
      ? resolved.projectionMissing
      : [...resolved.projectionMissing, ...trail.projectionMissing];
  const calendarsKnown = [...referencedCalendarIds(terms)].every((id) =>
    calendars.has(id),
  );
  const earlyTermsComplete =
    terms.redemption.type !== "ON_DEMAND" ||
    terms.redemption.blackouts.every((b) => calendars.has(b.calendarId));
  const dataCompleteness = {
    termsComplete: calendarsKnown,
    referenceDataComplete: missing.length === 0,
    earlyRedemptionTermsComplete: earlyTermsComplete,
  };

  return {
    asOf,
    seriesCode: terms.instrument.seriesCode,
    termsVersion: p.input.termsVersion,
    quantity: p.input.lot.quantity,
    maturityDate: p.maturity,
    status: figures.status,
    refusal: null,
    currentPeriod: current
      ? {
          index: current.index,
          start: current.start,
          end: current.end,
          annualRate: currentRate?.rate
            ? currentRate.rate.toTrimmedString(10, 4)
            : null,
          rateSource: currentRate?.rate ? currentRate.source : null,
        }
      : null,
    rateRule: describeRule(terms.rateRule),
    rateSchedule: resolved.rateSchedule,
    principal: figures.principal,
    principalBasis: principalBasisOf(p),
    accruedInterest: figures.accrued,
    grossValue: figures.gross,
    earlyRedemptionValue: figures.early,
    earlyRedemptionRefusal: figures.refusal,
    nextPayment: nextPaymentOf(cashflows),
    nextRateReset: nextRateResetOf(p, current),
    nextCapitalization:
      compounding && current && current.index < lastPeriod.index
        ? current.end
        : null,
    knownCashflows: cashflows.filter((c) => c.status === "KNOWN"),
    projectedCashflows: cashflows.filter((c) => c.status !== "KNOWN"),
    maturityValueKnown:
      maturityCash && !maturityProjected ? lot(maturityCash) : null,
    maturityValueProjected:
      maturityCash && maturityProjected ? lot(maturityCash) : null,
    projectionAssumptions: assumptions,
    projectionMissing,
    dataCompleteness,
    missing,
    valuationComplete: Object.values(dataCompleteness).every(Boolean),
  };
}

/**
 * Value one holding lot (spec 2.4 to 2.6). All arithmetic is exact; rounding is
 * applied only where the terms round, as the terms' rounding basis says
 * (`roundLot`: per bond and multiplied by the quantity by default). A lot bought outside the terms' sale window is REFUSED: no
 * figure, `valuationComplete` false.
 */
export function valueBondLot(input: BondEngineInput): BondValuation {
  validateLot(input, String(input.asOf));
  validateDay(input.lot.purchaseDate, input.asOf);
  return valueOn(prepare(input), input.asOf);
}

/**
 * The interest accrued on `date` that a buyer of `quantity` units on that day
 * pays the seller (`docs/specs/bond-marketable-primitives.md` 6.2): the
 * valuation's own `accruedInterest` of a lot bought on `date` and valued on it,
 * so a purchase form's suggestion and the valuation are one figure. It is the
 * lot's figure, rounded as the terms' basis says, in the terms' money decimals;
 * null when the terms alone do not give it (a rate that reads a benchmark, a
 * lot refused by the terms, such as a marketable one bought on or after its
 * maturity). Before the dated date nothing has accrued: "0.00".
 */
export function accruedInterestOn(
  terms: BondTerms,
  date: string,
  quantity: number,
): string | null {
  return valueBondLot({
    terms,
    termsVersion: 1,
    announcedRates: new Map(),
    benchmarks: new Map(),
    calendars: new Map(),
    lot: { purchaseDate: date, quantity },
    asOf: date,
  }).accruedInterest;
}

/**
 * The cash of `units` at maturity (principal and last coupon), the lot's figure
 * rounded as the terms' basis says; null while an index ratio or a floating
 * index it needs is not known. `inputs` is the last period's rate, null for a
 * floating rate.
 */
function maturityCashFor(
  p: PreparedLot,
  inputs: RateInputs | null,
  units: ExactDecimal,
  asOf: string,
): ExactDecimal | null {
  const { terms } = p.input;
  if (p.floating !== null) {
    return floatingMaturityCash(
      { terms, series: p.floating, quantity: units },
      p.lastPeriod,
      asOf,
    ).value;
  }
  if (inputs === null) return null;
  if (p.index !== null) {
    return maturityCashOf(
      { terms, series: p.index, quantity: units },
      inputs.current,
      p.maturity,
      asOf,
    ).value;
  }
  return maturityLot(terms, inputs.prior, inputs.current, units);
}

/**
 * What a redemption on `date` pays, as returned principal and interest (spec
 * `bond-redemption-interest.md` section 2), through the same schedule, rates,
 * penalties, floor and rounding as `valueBondLot`: the lot's figures are rounded
 * as the terms' basis says (`roundLot`), and one unit's are given beside them.
 *
 * Before maturity the day must be allowed (`windowRefusal`): the value before
 * deduction is the gross value, the payout the early-redemption proceeds. On or
 * after maturity the payout is the principal plus the last period's interest
 * (`maturityLot`) and the deduction is 0. A refused day, a purchase outside
 * the sale window and an unknown rate give the refusal and null figures (the
 * principal stays known for an unknown rate).
 */
export function redemptionSplit(
  input: Omit<BondEngineInput, "asOf">,
  date: string,
): RedemptionSplit {
  validateLot(input, String(date));
  validateDay(input.lot.purchaseDate, date);
  const p = prepare(input);
  const { terms } = input;
  const { quantity } = input.lot;
  const matured = compareYMD(date, p.maturity) >= 0;
  const day = matured ? p.maturity : date;
  const indexed: IndexedLot | null =
    p.index === null ? null : { terms, series: p.index, quantity: p.quantity };
  // One unit's principal on the day; null when an indexed principal's ratio is
  // not stored. The payment at maturity takes the floor.
  const unitPrincipal = (): ExactDecimal | null =>
    indexed === null
      ? principalAt(terms, { date: day, unitBase: p.unitBase })
      : unitPrincipalOn(indexed, day, date, matured).value;
  // The principal of the lot and of one unit, rounded as the basis says; a lot
  // of known cost has the cost (pro rata for one unit) as its principal.
  const principalOf = (units: ExactDecimal): ExactDecimal | null => {
    const cost = costOf(p, units);
    if (cost !== null) return toMoney(terms, cost);
    const unit = unitPrincipal();
    return unit === null ? null : roundLot(terms, unit, units);
  };
  const refused = (refusal: RedemptionSplitRefusal, principalKnown = false) => {
    const lot = principalKnown ? principalOf(p.quantity) : null;
    const unit = principalKnown ? principalOf(ExactDecimal.ONE) : null;
    return refusedSplit(
      date,
      quantity,
      p.places,
      refusal,
      lot === null || unit === null ? null : { lot, unit },
    );
  };
  if (p.saleRefusal) return refused(p.saleRefusal.code);

  if (matured) {
    const { rates } = resolvedFor(p, startedPeriods(p.schedule, day), date);
    const inputs = inputsFor(p.compounding, rates, p.lastPeriod.index);
    // A floating rate has no single rate: its last coupon is the sum of its days.
    if (!inputs && p.floating === null) return refused("RATE_UNKNOWN", true);
    const basisOf = (units: ExactDecimal): SplitBasis | null => {
      const principal = principalOf(units);
      const paid = maturityCashFor(p, inputs, units, date);
      return principal === null || paid === null
        ? null
        : { principal, gross: paid, payout: paid };
    };
    const lotBasis = basisOf(p.quantity);
    const unitBasis = basisOf(ExactDecimal.ONE);
    // An unknown index ratio leaves no principal either: nothing is known.
    return lotBasis === null || unitBasis === null
      ? refused("RATE_UNKNOWN", true)
      : splitOf(date, quantity, p.places, lotBasis, unitBasis);
  }

  const figures = figuresOn(p, day);
  if (figures.refusal === "RATE_UNKNOWN") return refused("RATE_UNKNOWN", true);
  if (figures.refusal !== null) {
    // No open period (before the first one starts) is not a day to redeem on.
    return refused(
      figures.refusal === "MATURED" ? "NOT_REDEEMABLE" : figures.refusal,
    );
  }
  const unit = figuresOn(p, day, ExactDecimal.ONE);
  const lotPrincipal = principalOf(p.quantity);
  const unitBasePrincipal = principalOf(ExactDecimal.ONE);
  if (
    figures.grossLot === null ||
    figures.earlyLot === null ||
    unit.grossLot === null ||
    unit.earlyLot === null ||
    lotPrincipal === null ||
    unitBasePrincipal === null
  ) {
    return refused("RATE_UNKNOWN", true);
  }
  return splitOf(
    date,
    quantity,
    p.places,
    {
      principal: lotPrincipal,
      gross: figures.grossLot,
      payout: figures.earlyLot,
    },
    {
      principal: unitBasePrincipal,
      gross: unit.grossLot,
      payout: unit.earlyLot,
    },
  );
}

export type BondLotSeriesInput = Omit<BondEngineInput, "asOf"> & {
  /** `YYYY-MM-DD` days on or after the purchase date, in any order, repeats allowed. */
  readonly days: readonly string[];
};

function preparedSeries(input: BondLotSeriesInput): PreparedLot {
  const { days, ...lotInput } = input;
  validateLot(lotInput);
  for (const day of days) validateDay(lotInput.lot.purchaseDate, day);
  return prepare(lotInput);
}

/**
 * `valueBondLot` for many days of one lot, in the order of `days`, resolving the
 * schedule and the rates once. Exactly equal to calling `valueBondLot` for each
 * day with the same input (a period that has started has the same rate, or the
 * same missing observation, whichever day it is read from; one that has not
 * started does not enter the value). Throws on the first invalid day, as
 * `valueBondLot` would.
 */
export function valueBondLotSeries(
  input: BondLotSeriesInput,
): readonly BondValuation[] {
  const prepared = preparedSeries(input);
  return input.days.map((day) => valueOn(prepared, day));
}

/** One day of a gross value series. */
export interface GrossValuePoint {
  readonly asOf: string;
  readonly status: BondLotStatus;
  /** The lot's gross value, in the terms' money decimals; null when it cannot be worked out or the lot is REFUSED. */
  readonly grossValue: string | null;
}

/**
 * The lightest series: per day only the lot's gross value (the figure a price
 * series needs) and the status, equal to `valueBondLot(...).grossValue` and
 * `.status` of that day. A null `grossValue` on an OPEN or MATURED lot means a
 * rate it needs is unknown.
 */
export function grossValueSeries(
  input: BondLotSeriesInput,
): readonly GrossValuePoint[] {
  const prepared = preparedSeries(input);
  return input.days.map((asOf): GrossValuePoint => {
    if (prepared.saleRefusal)
      return { asOf, status: "REFUSED", grossValue: null };
    const figures = figuresOn(prepared, asOf);
    return { asOf, status: figures.status, grossValue: figures.gross };
  });
}
