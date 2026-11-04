import { assertNever } from "../domain/assert-never";
import { BenchmarkRule, benchmarkFieldsOf } from "../domain/bond-terms";
import { compareYMD, isValidYMD } from "../domain/calendar-date";
import { ExactDecimal } from "../domain/exact-decimal";
import {
  buildSchedule,
  SchedulePeriod,
  singlePeriodSchedule,
} from "../domain/period-schedule";
import {
  baseAt,
  compounds,
  couponLot,
  grossLotOf,
  isDiscount,
  maturityLot,
  principalAt,
  principalLot,
  PricedPeriod,
  valueAt,
} from "./accrual";
import { roundLot, unitText } from "./rounding";
import {
  BondEngineError,
  BondEngineInput,
  BondLotStatus,
  BondValuation,
  BondValuationRefusal,
  CashFlow,
  EarlyRedemptionRefusal,
  MissingObservation,
  RateRuleDescription,
  RateScheduleEntry,
} from "./bond-engine-types";
import { attributeInterest } from "./attribution";
import {
  RedemptionSplit,
  RedemptionSplitRefusal,
  refusedSplit,
  SplitBasis,
  splitOf,
} from "./redemption-split";
import {
  PeriodRate,
  RatePlan,
  RateResolution,
  planPeriodRates,
  ratesWithStarted,
  startedPeriods,
} from "./rate-resolution";
import {
  proceedsLot,
  referencedCalendarIds,
  windowRefusal,
} from "./redemption";

export * from "./bond-engine-types";
export * from "./redemption-split";

interface RateInputs {
  readonly prior: readonly PricedPeriod[];
  readonly current: PricedPeriod;
}

/**
 * The rates the formulas of period `k` need, or null when one is unknown. A
 * compounding bond needs periods 1..k; a coupon bond only period k.
 */
function inputsFor(
  compounding: boolean,
  rates: readonly PeriodRate[],
  k: number,
): RateInputs | null {
  const entry = rates[k - 1];
  if (entry.rate === null) return null;
  const current = { period: entry.period, rate: entry.rate };
  if (!compounding) return { prior: [], current };
  const prior: PricedPeriod[] = [];
  for (const earlier of rates.slice(0, k - 1)) {
    if (earlier.rate === null) return null;
    prior.push({ period: earlier.period, rate: earlier.rate });
  }
  return { prior, current };
}

type LotInput = Omit<BondEngineInput, "asOf">;

/** The lot itself: a positive integer quantity and a real purchase date. */
function validateLot(input: LotInput, asOf = ""): void {
  const { quantity, purchaseDate } = input.lot;
  if (!Number.isSafeInteger(quantity) || quantity < 1) {
    throw new BondEngineError(
      "QUANTITY_INVALID",
      { quantity: String(quantity) },
      `Quantity must be a positive integer: ${quantity}`,
    );
  }
  if (!isValidYMD(purchaseDate)) {
    throw new BondEngineError(
      "DATE_INVALID",
      { purchaseDate: String(purchaseDate), asOf },
      "purchaseDate must be a YYYY-MM-DD date",
    );
  }
}

/**
 * The boundary of every date: once a day passes this it is compared as text
 * (`compareYMD` does not validate).
 */
function validateDay(purchaseDate: string, asOf: string): void {
  if (!isValidYMD(asOf)) {
    throw new BondEngineError(
      "DATE_INVALID",
      { purchaseDate, asOf: String(asOf) },
      "purchaseDate and asOf must be YYYY-MM-DD dates",
    );
  }
  if (compareYMD(asOf, purchaseDate) < 0) {
    throw new BondEngineError(
      "AS_OF_BEFORE_PURCHASE",
      { asOf, purchaseDate },
      `asOf ${asOf} is before the purchase date ${purchaseDate}`,
    );
  }
}

/** Observations a value needs: every started period, completed or current. */
function neededMissing(
  rates: readonly PeriodRate[],
  startedCount: number,
): readonly MissingObservation[] {
  const seen = new Set<string>();
  const missing: MissingObservation[] = [];
  for (const entry of rates.slice(0, startedCount)) {
    const m = entry.missing;
    if (m && !seen.has(`${m.benchmarkId}|${m.observation}`)) {
      seen.add(`${m.benchmarkId}|${m.observation}`);
      missing.push(m);
    }
  }
  return missing;
}

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
    default:
      return assertNever(rule);
  }
}

function describeSchedule(
  terms: BondEngineInput["terms"],
  rates: readonly PeriodRate[],
): RateScheduleEntry[] {
  // A discount instrument states no rate: its placeholder is never shown.
  const stated = !isDiscount(terms);
  return rates.map((r) => ({
    index: r.period.index,
    start: r.period.start,
    end: r.period.end,
    annualRate: r.rate && stated ? r.rate.toTrimmedString(10, 4) : null,
    rateSource: stated ? r.source : null,
    benchmark: r.benchmark,
    addend: r.addend,
    ...attributeInterest(terms, rates, r.period.index),
  }));
}

/** What a lot's rates give once `started` periods have begun; shared by every such day. */
interface Resolved extends RateResolution {
  readonly rateSchedule: readonly RateScheduleEntry[];
  /** The lot's cash at maturity, rounded as the terms' basis says. */
  readonly maturityCash: ExactDecimal | null;
  readonly maturityProjected: boolean;
  readonly missingFor: readonly MissingObservation[];
}

/**
 * A lot with its schedule and rate plan resolved once. A valuation on a day is
 * then a lookup of the rates for that day's count of started periods (at most
 * periodCount + 1 distinct sets) and the arithmetic of the day.
 */
interface PreparedLot {
  readonly input: LotInput;
  readonly compounding: boolean;
  readonly schedule: readonly SchedulePeriod[];
  readonly lastPeriod: SchedulePeriod;
  readonly maturity: string;
  readonly places: number;
  readonly quantity: ExactDecimal;
  readonly plan: RatePlan;
  readonly saleRefusal: BondValuationRefusal | null;
  readonly byStarted: Map<number, Resolved>;
}

/**
 * Why the lot's purchase date makes it unvaluable, or null: a stated purchase
 * outside the sale window, or a lot of a marketable series bought on or after
 * its maturity (`maturity` is the end of the lot's last period). An assumed
 * purchase date (an unpaired transfer in) is never refused: the real purchase
 * is unknown and the lot restarts at the transfer by design.
 */
function purchaseRefusal(
  input: LotInput,
  maturity: string,
): BondValuationRefusal | null {
  const window = input.terms.saleWindow;
  const { purchaseDate } = input.lot;
  if (
    input.terms.instrument.marketability === "MARKETABLE" &&
    input.lot.purchaseDateAssumed !== true &&
    compareYMD(purchaseDate, maturity) >= 0
  ) {
    return {
      code: "PURCHASE_AFTER_MATURITY",
      params: { maturityDate: maturity, purchaseDate },
    };
  }
  if (
    window === null ||
    // An assumed purchase date (an unpaired transfer in) restarts the lot at
    // the transfer by design (docs/specs/polish-retail-bonds.md 12.2); the
    // window refuses only a stated purchase (2.6).
    input.lot.purchaseDateAssumed === true ||
    (compareYMD(purchaseDate, window.from) >= 0 &&
      compareYMD(purchaseDate, window.to) <= 0)
  ) {
    return null;
  }
  return {
    code: "PURCHASE_OUTSIDE_SALE_WINDOW",
    params: { from: window.from, to: window.to, purchaseDate },
  };
}

/** The periods of the lot from the terms' schedule anchor. */
function scheduleOf(input: LotInput): readonly SchedulePeriod[] {
  const { schedule } = input.terms;
  switch (schedule.anchor) {
    case "LOT_PURCHASE_DATE":
      return buildSchedule(
        input.lot.purchaseDate,
        schedule.periodCount,
        schedule.periodMonths,
      );
    case "ISSUE_DATE":
      return singlePeriodSchedule(schedule.issueDate, schedule.maturityDate);
    default:
      return assertNever(schedule);
  }
}

function prepare(input: LotInput): PreparedLot {
  const { terms } = input;
  const schedule = scheduleOf(input);
  const lastPeriod = schedule[schedule.length - 1];
  return {
    input,
    compounding: compounds(terms),
    schedule,
    lastPeriod,
    maturity: lastPeriod.end,
    places: terms.rounding.moneyDecimals,
    quantity: ExactDecimal.fromInt(input.lot.quantity),
    plan: planPeriodRates(input, schedule),
    saleRefusal: purchaseRefusal(input, lastPeriod.end),
    byStarted: new Map(),
  };
}

function resolvedFor(p: PreparedLot, started: number): Resolved {
  const cached = p.byStarted.get(started);
  if (cached) return cached;
  const resolution = ratesWithStarted(p.plan, started);
  const { rates } = resolution;
  const terms = p.input.terms;
  const maturityInputs = inputsFor(p.compounding, rates, p.lastPeriod.index);
  const resolved: Resolved = {
    ...resolution,
    rateSchedule: describeSchedule(terms, rates),
    maturityCash: maturityInputs
      ? maturityLot(
          terms,
          maturityInputs.prior,
          maturityInputs.current,
          p.quantity,
        )
      : null,
    maturityProjected: p.compounding
      ? rates.some((r) => r.source === "PROJECTED")
      : rates[p.lastPeriod.index - 1].source === "PROJECTED",
    missingFor: neededMissing(rates, started),
  };
  p.byStarted.set(started, resolved);
  return resolved;
}

interface DayFigures {
  readonly status: BondLotStatus;
  readonly started: number;
  readonly matured: boolean;
  readonly current: SchedulePeriod | null;
  readonly principal: string | null;
  readonly accrued: string | null;
  readonly gross: string | null;
  readonly early: string | null;
  /** The lot's gross value and early-redemption proceeds, exact, rounded as the basis says: what `gross` and `early` print. */
  readonly grossLot: ExactDecimal | null;
  readonly earlyLot: ExactDecimal | null;
  readonly refusal: EarlyRedemptionRefusal | null;
}

/**
 * The value figures of one day (spec 2.4 to 2.6) from the rates of its started
 * count, for `quantity` units (the lot's by default; `redemptionSplit` also asks
 * for one unit).
 */
function figuresOn(
  p: PreparedLot,
  asOf: string,
  quantity: ExactDecimal = p.quantity,
): DayFigures {
  const { terms, calendars } = p.input;
  const started = startedPeriods(p.schedule, asOf);
  const { rates } = resolvedFor(p, started);
  const { compounding, places, lastPeriod } = p;
  const text = (figure: ExactDecimal) => figure.toFixed(places);

  const matured = compareYMD(asOf, p.maturity) >= 0;
  const candidate = matured ? null : p.schedule[started - 1];
  const current =
    candidate && compareYMD(asOf, candidate.end) < 0 ? candidate : null;

  let principal: string | null = null;
  let accrued: string | null = null;
  let gross: string | null = null;
  let early: string | null = null;
  let grossLot: ExactDecimal | null = null;
  let earlyLot: ExactDecimal | null = null;
  let refusal: EarlyRedemptionRefusal | null = windowRefusal(
    terms,
    calendars,
    p.input.lot.purchaseDate,
    asOf,
    current,
    p.maturity,
  );

  if (matured) {
    if (!compounding && !isDiscount(terms)) {
      // A coupon bond redeems at its nominal whatever the rates were; its last
      // coupon is a past cash flow, so no rate is needed for the value.
      const nominal = principalAt(terms, { date: p.maturity });
      principal = text(nominal);
      grossLot = nominal.mul(quantity);
      gross = text(grossLot);
      accrued = text(ExactDecimal.ZERO);
    } else {
      const inputs = inputsFor(compounding, rates, lastPeriod.index);
      if (inputs) {
        grossLot = maturityLot(terms, inputs.prior, inputs.current, quantity);
        // The same principal as an open day: the base the last period accrued
        // on, interest capitalised earlier included. `accrued` stays all the
        // interest since the nominal, as on an open day (golden-pinned), so
        // the two overlap by design and `gross` is the figure to total.
        principal = unitText(
          terms,
          baseAt(terms, inputs.prior, { date: lastPeriod.start }),
        );
        gross = text(grossLot);
        accrued = text(
          grossLot.sub(principalLot(terms, { date: p.maturity }, quantity)),
        );
      }
    }
  } else if (current) {
    const inputs = inputsFor(compounding, rates, current.index);
    if (inputs) {
      const value = valueAt(terms, inputs.prior, inputs.current, asOf);
      const base = baseAt(terms, inputs.prior, { date: current.start });
      grossLot = grossLotOf(terms, value, asOf, quantity);
      principal = unitText(terms, base);
      gross = text(grossLot);
      accrued = text(
        grossLot.sub(principalLot(terms, { date: asOf }, quantity)),
      );
      if (refusal === null) {
        earlyLot = proceedsLot(
          terms,
          value,
          base,
          current.index,
          asOf,
          quantity,
        );
        early = text(earlyLot);
      }
    } else if (refusal === null) {
      refusal = "RATE_UNKNOWN";
    }
  }

  return {
    status: matured ? "MATURED" : "OPEN",
    started,
    matured,
    current,
    principal,
    accrued,
    gross,
    early,
    grossLot,
    earlyLot,
    refusal,
  };
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
  const resolved = resolvedFor(p, started);
  const { rates, maturityCash, maturityProjected } = resolved;
  const { compounding, lastPeriod } = p;
  const lot = (figure: ExactDecimal) => figure.toFixed(p.places);
  const currentRate =
    current && !isDiscount(terms) ? rates[current.index - 1] : null;

  const cashflows: CashFlow[] = [];
  const flow = (
    period: SchedulePeriod,
    type: CashFlow["type"],
    amount: ExactDecimal | null,
    projected: boolean,
  ): CashFlow => ({
    date: period.end,
    type,
    amount: amount === null ? null : lot(amount),
    status: amount === null ? "UNKNOWN" : projected ? "PROJECTED" : "KNOWN",
    period: period.index,
  });
  if (!compounding) {
    for (const period of p.schedule) {
      if (compareYMD(period.end, asOf) <= 0) continue;
      const rate = rates[period.index - 1];
      const coupon =
        rate.rate === null
          ? null
          : couponLot(terms, { period, rate: rate.rate }, p.quantity);
      cashflows.push(
        flow(period, "INTEREST", coupon, rate.source === "PROJECTED"),
      );
    }
    if (!matured)
      cashflows.push(
        flow(
          lastPeriod,
          "PRINCIPAL",
          principalLot(terms, { date: lastPeriod.end }, p.quantity),
          false,
        ),
      );
  } else if (!matured) {
    cashflows.push(
      flow(lastPeriod, "PRINCIPAL", maturityCash, maturityProjected),
    );
  }

  const missing = resolved.missingFor;
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
    projectionAssumptions: resolved.assumptions,
    projectionMissing: resolved.projectionMissing,
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
  const principal = principalAt(terms, { date: day });
  // The principal of the lot and of one unit, rounded as the basis says.
  const principalOf = (units: ExactDecimal) =>
    roundLot(terms, principal, units);
  const refused = (refusal: RedemptionSplitRefusal, principalKnown = false) =>
    refusedSplit(
      date,
      quantity,
      p.places,
      refusal,
      principalKnown
        ? {
            lot: principalOf(p.quantity),
            unit: principalOf(ExactDecimal.ONE),
          }
        : null,
    );
  if (p.saleRefusal) return refused(p.saleRefusal.code);

  if (matured) {
    const { rates } = resolvedFor(p, startedPeriods(p.schedule, day));
    const inputs = inputsFor(p.compounding, rates, p.lastPeriod.index);
    if (!inputs) return refused("RATE_UNKNOWN", true);
    const basisOf = (units: ExactDecimal): SplitBasis => {
      const paid = maturityLot(terms, inputs.prior, inputs.current, units);
      return { principal: principalOf(units), gross: paid, payout: paid };
    };
    return splitOf(
      date,
      quantity,
      p.places,
      basisOf(p.quantity),
      basisOf(ExactDecimal.ONE),
    );
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
  if (
    figures.grossLot === null ||
    figures.earlyLot === null ||
    unit.grossLot === null ||
    unit.earlyLot === null
  ) {
    return refused("RATE_UNKNOWN", true);
  }
  return splitOf(
    date,
    quantity,
    p.places,
    {
      principal: principalOf(p.quantity),
      gross: figures.grossLot,
      payout: figures.earlyLot,
    },
    {
      principal: principalOf(ExactDecimal.ONE),
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
