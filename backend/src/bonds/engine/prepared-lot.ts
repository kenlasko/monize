import { assertNever } from "../domain/assert-never";
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
  grossLotOf,
  isDiscount,
  maturityLot,
  principalAt,
  principalLot,
  PricedPeriod,
  valueAt,
} from "./accrual";
import { unitText } from "./rounding";
import {
  BondEngineError,
  BondEngineInput,
  BondLotStatus,
  BondValuationRefusal,
  EarlyRedemptionRefusal,
  MissingObservation,
  RateScheduleEntry,
} from "./bond-engine-types";
import { attributeInterest } from "./attribution";
import {
  PeriodRate,
  RatePlan,
  RateResolution,
  planPeriodRates,
  ratesWithStarted,
  startedPeriods,
} from "./rate-resolution";
import { proceedsLot, windowRefusal } from "./redemption";

export interface RateInputs {
  readonly prior: readonly PricedPeriod[];
  readonly current: PricedPeriod;
}

/**
 * The rates the formulas of period `k` need, or null when one is unknown. A
 * compounding bond needs periods 1..k; a coupon bond only period k.
 */
export function inputsFor(
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

export type LotInput = Omit<BondEngineInput, "asOf">;

/** The lot itself: a positive integer quantity and a real purchase date. */
export function validateLot(input: LotInput, asOf = ""): void {
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
export function validateDay(purchaseDate: string, asOf: string): void {
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
export interface Resolved extends RateResolution {
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
export interface PreparedLot {
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

export function prepare(input: LotInput): PreparedLot {
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

export function resolvedFor(p: PreparedLot, started: number): Resolved {
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

export interface DayFigures {
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
export function figuresOn(
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
