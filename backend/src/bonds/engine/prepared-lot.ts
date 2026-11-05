import { assertNever } from "../domain/assert-never";
import { compareYMD, isValidYMD } from "../domain/calendar-date";
import { ExactDecimal } from "../domain/exact-decimal";
import {
  buildSchedule,
  couponLotPeriods,
  SchedulePeriod,
  singlePeriodSchedule,
} from "../domain/period-schedule";
import {
  baseAt,
  compounds,
  grossLotOf,
  isDiscount,
  maturityLot,
  discountLotValueAt,
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
  floatingDayFigures,
  floatingEntries,
  floatingSeriesOf,
  FloatingSeries,
} from "./floating-lot";
import { indexedDayFigures, indexOn } from "./indexed-lot";
import { IndexSeries, indexSeriesOf } from "./index-ratio";
import {
  PeriodRate,
  RatePlan,
  RateResolution,
  parseDecimal,
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
  parseCost(input.lot.cost);
}

/** The lot's cost as a decimal, null when unknown; a text that is not a non-negative decimal is refused. */
function parseCost(cost: string | null | undefined): ExactDecimal | null {
  if (cost === null || cost === undefined) return null;
  let parsed: ExactDecimal;
  try {
    parsed = ExactDecimal.parse(cost);
  } catch {
    parsed = ExactDecimal.of(-1n);
  }
  if (parsed.isNegative()) {
    throw new BondEngineError(
      "DECIMAL_INVALID",
      { field: "lot.cost", value: String(cost) },
      `lot.cost is not a non-negative decimal string: ${String(cost)}`,
    );
  }
  return parsed;
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
  p: PreparedLot,
  rates: readonly PeriodRate[],
  asOf: string,
): RateScheduleEntry[] {
  const { terms } = p.input;
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
    ...attributeInterest(
      terms,
      rates,
      r.period.index,
      // An indexed coupon is on the ratio of the period's end.
      p.index === null
        ? undefined
        : indexOn(
            { terms, series: p.index, quantity: p.quantity },
            r.period.end,
            asOf,
          ).ratio,
    ),
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
  /** What a discount lot cost, replacing the issue price; null otherwise. */
  readonly cost: ExactDecimal | null;
  /** One unit's cost; null with `cost`. */
  readonly unitBase: ExactDecimal | null;
  readonly plan: RatePlan;
  /** What an `INDEX_RATIO` principal reads; null for every other principal. */
  readonly index: IndexSeries | null;
  /** What a `DAILY_INDEX_PLUS_SPREAD` rate reads; null for every other rate. */
  readonly floating: FloatingSeries | null;
  readonly saleRefusal: BondValuationRefusal | null;
  /** By the count of started periods and, for an indexed or floating lot, the day (its projection depends on it). */
  readonly byStarted: Map<string, Resolved>;
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

/** The lot's cost when it replaces the issue price: a discount instrument with a known cost. */
export function lotCostOf(input: LotInput): ExactDecimal | null {
  return isDiscount(input.terms) ? parseCost(input.lot.cost) : null;
}

/** The cost of `units` of the lot's units, pro rata; null when the cost is unknown. */
export function costOf(
  p: PreparedLot,
  units: ExactDecimal,
): ExactDecimal | null {
  return p.cost === null ? null : p.cost.mul(units).div(p.quantity);
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
    case "ISSUE_DATE": {
      // A discount lot of known cost accrues from the later of its purchase and
      // issue dates; a purchase on or after maturity leaves the schedule as it is.
      const start =
        lotCostOf(input) !== null &&
        compareYMD(input.lot.purchaseDate, schedule.issueDate) > 0 &&
        compareYMD(input.lot.purchaseDate, schedule.maturityDate) < 0
          ? input.lot.purchaseDate
          : schedule.issueDate;
      return singlePeriodSchedule(start, schedule.maturityDate);
    }
    case "COUPON_DATES":
      // The series' own periods that end after the purchase: the coupon of the
      // period the lot was bought in is paid in full (spec 5.1).
      return couponLotPeriods(schedule, input.lot.purchaseDate);
    default:
      return assertNever(schedule);
  }
}

/** The indexed principal's benchmark, with the assumed annual inflation the caller supplied (a fraction), if any. */
function indexSeriesFor(input: LotInput): IndexSeries | null {
  const rule = input.terms.principalRule;
  if (rule.type !== "INDEX_RATIO") return null;
  const assumed = input.projection?.get(rule.benchmarkId);
  return indexSeriesOf(
    rule,
    input.benchmarks.get(rule.benchmarkId),
    assumed === undefined
      ? null
      : parseDecimal(assumed, `projectionAssumption:${rule.benchmarkId}`),
  );
}

/** The floating rate's benchmark and calendar, with the assumed index (a fraction) the caller supplied, if any. */
function floatingSeriesFor(input: LotInput): FloatingSeries | null {
  const { terms } = input;
  const rule = terms.rateRule;
  if (rule.type !== "DAILY_INDEX_PLUS_SPREAD") return null;
  const assumed = input.projection?.get(rule.benchmarkId);
  return floatingSeriesOf(
    terms,
    rule,
    input.benchmarks.get(rule.benchmarkId),
    input.calendars.get(rule.calendarId),
    assumed === undefined
      ? null
      : parseDecimal(assumed, `projectionAssumption:${rule.benchmarkId}`),
  );
}

export function prepare(input: LotInput): PreparedLot {
  const { terms } = input;
  const schedule = scheduleOf(input);
  const lastPeriod = schedule[schedule.length - 1];
  const quantity = ExactDecimal.fromInt(input.lot.quantity);
  const cost = lotCostOf(input);
  return {
    input,
    cost,
    unitBase: cost === null ? null : cost.div(quantity),
    compounding: compounds(terms),
    schedule,
    lastPeriod,
    maturity: lastPeriod.end,
    places: terms.rounding.moneyDecimals,
    quantity,
    plan: planPeriodRates(input, schedule),
    index: indexSeriesFor(input),
    floating: floatingSeriesFor(input),
    saleRefusal: purchaseRefusal(input, lastPeriod.end),
    byStarted: new Map(),
  };
}

export function resolvedFor(
  p: PreparedLot,
  started: number,
  asOf: string,
): Resolved {
  const key =
    p.index === null && p.floating === null
      ? String(started)
      : `${started}|${asOf}`;
  const cached = p.byStarted.get(key);
  if (cached) return cached;
  const resolution = ratesWithStarted(p.plan, started);
  const { rates } = resolution;
  const terms = p.input.terms;
  const maturityInputs = inputsFor(p.compounding, rates, p.lastPeriod.index);
  const resolved: Resolved = {
    ...resolution,
    rateSchedule:
      p.floating === null
        ? describeSchedule(p, rates, asOf)
        : floatingEntries(
            { terms, series: p.floating, quantity: p.quantity },
            p.schedule,
            asOf,
          ),
    // The cash at maturity of an indexed or floating lot is worked out for the
    // day (`derived-flows.ts`).
    maturityCash:
      maturityInputs && p.index === null && p.floating === null
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
  p.byStarted.set(key, resolved);
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
  const { rates } = resolvedFor(p, started, asOf);
  const { compounding, places, lastPeriod } = p;
  const text = (figure: ExactDecimal) => figure.toFixed(places);

  const matured = compareYMD(asOf, p.maturity) >= 0;
  // A series is bought before its dated or issue date (a broker books the
  // auction date): the lot is worth its principal, or its cost, then and no
  // interest has accrued. A schedule anchored on the purchase has no such day.
  const beforeDated =
    started === 0 &&
    (terms.schedule.anchor === "COUPON_DATES" ||
      terms.schedule.anchor === "ISSUE_DATE");
  const candidate = matured ? null : p.schedule[beforeDated ? 0 : started - 1];
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

  if (p.index !== null) {
    // An indexed principal: its own figures (`indexed-lot.ts`), null while the
    // ratio is unknown; MATURITY_ONLY, so no early redemption value.
    const open =
      matured || current === null
        ? null
        : inputsFor(compounding, rates, current.index);
    if (matured || open !== null) {
      const figures = indexedDayFigures(
        { terms, series: p.index, quantity },
        {
          asOf,
          maturity: p.maturity,
          current: open === null ? null : open.current,
          places,
        },
      );
      principal = figures.principal;
      accrued = figures.accrued;
      gross = figures.gross;
      grossLot = figures.grossLot;
    }
  } else if (matured) {
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
          baseAt(terms, inputs.prior, {
            date: lastPeriod.start,
            unitBase: p.unitBase,
          }),
        );
        gross = text(grossLot);
        accrued = text(
          grossLot.sub(
            principalLot(
              terms,
              { date: p.maturity, unitBase: p.unitBase },
              quantity,
              costOf(p, quantity),
            ),
          ),
        );
      }
    }
  } else if (current && p.floating !== null) {
    // A floating rate: the face value plus the days accrued so far (`floating-lot.ts`).
    const open = floatingDayFigures(
      { terms, series: p.floating, quantity },
      current,
      asOf,
      places,
    );
    principal = open.principal;
    accrued = open.accrued;
    gross = open.gross;
    grossLot = open.grossLot;
  } else if (current) {
    const inputs = inputsFor(compounding, rates, current.index);
    if (inputs) {
      const lotCost = costOf(p, quantity);
      const value = valueAt(
        terms,
        inputs.prior,
        inputs.current,
        asOf,
        p.unitBase,
      );
      const base = baseAt(terms, inputs.prior, {
        date: current.start,
        unitBase: p.unitBase,
      });
      grossLot =
        lotCost === null
          ? grossLotOf(terms, value, asOf, quantity)
          : discountLotValueAt(terms, current, asOf, quantity, lotCost);
      principal = unitText(terms, base);
      gross = text(grossLot);
      accrued = text(
        grossLot.sub(
          principalLot(
            terms,
            { date: asOf, unitBase: p.unitBase },
            quantity,
            lotCost,
          ),
        ),
      );
      if (refusal === null) {
        // A lot of known cost is worth its own figure: no per-unit value is
        // behind it to round again.
        earlyLot =
          lotCost !== null && terms.redemption.type !== "ON_DEMAND"
            ? grossLot
            : proceedsLot(terms, value, base, current.index, asOf, quantity);
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
