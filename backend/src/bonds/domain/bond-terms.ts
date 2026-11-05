import { assertNever } from "./assert-never";
import { BondRounding, parseRounding } from "./bond-rounding";
import { ExactDecimal } from "./exact-decimal";
import { parsePrincipalRule, PrincipalRule } from "./principal-rule";
import {
  assertScheduleConsistent,
  BondSchedule,
  parseSchedule,
} from "./bond-schedule";
import {
  BondTermsError,
  code,
  date,
  decimal,
  exact,
  integer,
  list,
  nullable,
  object,
  oneOf,
  primitive,
  signedDecimal,
  text,
} from "./terms-readers";

export { BondTermsError } from "./terms-readers";
export type { BondTermsErrorCode } from "./terms-readers";
export type { BondRounding, RoundingBasis } from "./bond-rounding";
export { roundingBasisOf } from "./bond-rounding";
export { scheduleDaysOf, scheduleMonthsOf } from "./bond-schedule";
export type { IndexRatioRule, PrincipalRule } from "./principal-rule";
export type {
  BondSchedule,
  CouponDatesSchedule,
  IssueDateSchedule,
  LotAnchoredSchedule,
} from "./bond-schedule";

export type StepObservation = {
  readonly type: "STEP_VALUE_ON_NTH_BUSINESS_DAY_BEFORE_START_MONTH";
  readonly businessDays: number;
  readonly calendarId: string;
};

export type MonthlyObservation = {
  readonly type: "MONTHLY_VALUE_MONTHS_BEFORE_START";
  readonly months: number;
};

export type ObservationRule = StepObservation | MonthlyObservation;

export interface BenchmarkRuleFields {
  readonly benchmarkId: string;
  /** Null: period 1 is derived like every other period. */
  readonly firstPeriodRate: string | null;
  readonly benchmarkFloor: string | null;
  readonly observation: ObservationRule;
}

/**
 * A floating rate that accrues daily (`docs/specs/bond-marketable-primitives.md`
 * 7.2): on each day `max(index + spread, floor) / 360` of the par, where the
 * index is the latest observation of a `STEP` benchmark strictly before the day.
 * An observation dated within `lockoutBusinessDays` business days (of
 * `calendarId`) before the end of the period is not used for that period. The
 * daily accrual per 100 of par is rounded to `dailyDecimals` (percent units).
 * The spread is the only signed decimal of the terms.
 */
export interface DailyIndexRule {
  readonly type: "DAILY_INDEX_PLUS_SPREAD";
  readonly benchmarkId: string;
  readonly spread: string;
  readonly floor: string;
  readonly lockoutBusinessDays: number;
  readonly calendarId: string;
  readonly dailyDecimals: number;
}

export type RateRule =
  | { readonly type: "FIXED"; readonly annualRate: string }
  /**
   * A discount instrument: bought below its face value, it pays the face value
   * at maturity and states no rate. Needs `instrument.issuePrice`.
   */
  | { readonly type: "ZERO_COUPON_DISCOUNT" }
  | ({
      readonly type: "BENCHMARK_PLUS_SPREAD";
      readonly spread: string;
    } & BenchmarkRuleFields)
  | ({
      readonly type: "INFLATION_PLUS_MARGIN_AS_RATE";
      readonly margin: string;
    } & BenchmarkRuleFields)
  | DailyIndexRule;

/** A rule that reads one observation per period (`observation`), as opposed to a daily one. */
export type BenchmarkRule = Extract<
  RateRule,
  {
    readonly type: "BENCHMARK_PLUS_SPREAD" | "INFLATION_PLUS_MARGIN_AS_RATE";
  }
>;

/** The rule when it reads one observation per period, null for a rule that reads none or reads daily; exhaustive over the rule types. */
export function benchmarkRuleOf(rule: RateRule): BenchmarkRule | null {
  switch (rule.type) {
    case "FIXED":
    case "ZERO_COUPON_DISCOUNT":
    case "DAILY_INDEX_PLUS_SPREAD":
      return null;
    case "BENCHMARK_PLUS_SPREAD":
    case "INFLATION_PLUS_MARGIN_AS_RATE":
      return rule;
    default:
      return assertNever(rule);
  }
}

/** The id of the benchmark a rate rule reads, whichever way it reads it; null for a rule that reads none. */
export function rateBenchmarkIdOf(rule: RateRule): string | null {
  switch (rule.type) {
    case "FIXED":
    case "ZERO_COUPON_DISCOUNT":
      return null;
    case "BENCHMARK_PLUS_SPREAD":
    case "INFLATION_PLUS_MARGIN_AS_RATE":
    case "DAILY_INDEX_PLUS_SPREAD":
      return rule.benchmarkId;
    default:
      return assertNever(rule);
  }
}

/** The benchmark fields of a rule that reads a benchmark, null for a rule that reads none. */
export function benchmarkFieldsOf(rule: RateRule): BenchmarkRuleFields | null {
  return benchmarkRuleOf(rule);
}

export type Capitalization =
  | { readonly type: "NONE" }
  | {
      readonly type: "COMPOUND_AT_PERIOD_END";
      readonly baseRounding: "PER_PERIOD" | "NONE";
    };

export type Blackout = {
  readonly type: "RECORD_DAY_BEFORE_COUPON";
  readonly businessDays: number;
  readonly calendarId: string;
};

export type Penalty =
  | {
      readonly type: "FIXED_FEE_PER_UNIT";
      readonly amount: string;
    }
  | {
      /** The interest accrued since the period start is not paid. */
      readonly type: "FORFEIT_ACCRUED_SINCE_LAST_PAYMENT";
    };

export type ProceedsFloor = {
  readonly type: "FACE_VALUE";
  readonly appliesTo: "ALL_PERIODS" | "FIRST_PERIOD";
};

export type Redemption =
  | { readonly type: "MATURITY_ONLY" }
  | {
      readonly type: "ON_DEMAND";
      /**
       * The issuer's number of calendar days that must fully elapse after the
       * sale before a request. The sale day is not counted, so the period ends
       * with purchaseDate + N and the first request is on purchaseDate + N + 1.
       */
      readonly earliestDaysAfterPurchase: number;
      readonly latestDaysBeforeMaturity: number;
      readonly blackouts: readonly Blackout[];
      readonly penalties: readonly Penalty[];
      readonly proceedsFloor: ProceedsFloor | null;
    };

/** `ACTUAL_360_DAILY_SUM`: a period's interest is the sum of its days' accruals (`DAILY_INDEX_PLUS_SPREAD` only). */
export type AccrualType =
  "ACTUAL_DAYS_IN_PERIOD" | "ACTUAL_ACTUAL_ICMA" | "ACTUAL_360_DAILY_SUM";

export type Marketability = "RETAIL_REDEEMABLE" | "MARKETABLE";

export interface BondTerms {
  readonly schemaVersion: 1;
  readonly instrument: {
    readonly issuerCountryCode: string;
    readonly issuerCode: string;
    readonly programCode: string;
    readonly seriesCode: string;
    readonly currency: string;
    /**
     * `RETAIL_REDEEMABLE`: the issuer redeems it. `MARKETABLE`: it trades, so its
     * market price is not a function of its terms; it has no sale window and is
     * paid at maturity only.
     */
    readonly marketability: Marketability;
    readonly faceValue: string;
    /**
     * The price of one face value at issue, exact decimal, above zero and below
     * `faceValue` (at most `faceValue` for a MARKETABLE bill issued at par). Present exactly when the rate rule is ZERO_COUPON_DISCOUNT.
     */
    readonly issuePrice?: string;
  };
  readonly saleWindow: { readonly from: string; readonly to: string } | null;
  readonly schedule: BondSchedule;
  readonly accrual: { readonly type: AccrualType };
  /** The nominal, or a nominal that tracks an index (`INDEX_RATIO`). */
  readonly principalRule: PrincipalRule;
  readonly rateRule: RateRule;
  readonly capitalization: Capitalization;
  readonly redemption: Redemption;
  readonly rounding: BondRounding;
  readonly source: {
    readonly provider: string;
    readonly url: string;
    readonly document: string;
  };
}

/** The most decimals a daily accrual is rounded to (a bound against a hostile document). */
const MAX_DAILY_DECIMALS = 12;

function parseObservation(value: unknown, path: string): ObservationRule {
  const type = primitive(value, path, [
    "STEP_VALUE_ON_NTH_BUSINESS_DAY_BEFORE_START_MONTH",
    "MONTHLY_VALUE_MONTHS_BEFORE_START",
  ] as const);
  if (type === "MONTHLY_VALUE_MONTHS_BEFORE_START") {
    const o = object(value, path, ["type", "months"]);
    return { type, months: integer(o.months, `${path}.months`, 1) };
  }
  const o = object(value, path, ["type", "businessDays", "calendarId"]);
  return {
    type,
    businessDays: integer(o.businessDays, `${path}.businessDays`, 1),
    calendarId: text(o.calendarId, `${path}.calendarId`),
  };
}

function parseRateRule(value: unknown, path: string): RateRule {
  const type = primitive(value, path, [
    "FIXED",
    "BENCHMARK_PLUS_SPREAD",
    "INFLATION_PLUS_MARGIN_AS_RATE",
    "ZERO_COUPON_DISCOUNT",
    "DAILY_INDEX_PLUS_SPREAD",
  ] as const);
  if (type === "DAILY_INDEX_PLUS_SPREAD") {
    const r = object(value, path, [
      "type",
      "benchmarkId",
      "spread",
      "floor",
      "lockoutBusinessDays",
      "calendarId",
      "dailyDecimals",
    ]);
    const dailyDecimals = integer(r.dailyDecimals, `${path}.dailyDecimals`, 0);
    if (dailyDecimals > MAX_DAILY_DECIMALS) {
      throw new BondTermsError(
        `${path}.dailyDecimals`,
        `must be at most ${MAX_DAILY_DECIMALS}`,
      );
    }
    return {
      type,
      benchmarkId: text(r.benchmarkId, `${path}.benchmarkId`),
      spread: signedDecimal(r.spread, `${path}.spread`),
      floor: decimal(r.floor, `${path}.floor`),
      lockoutBusinessDays: integer(
        r.lockoutBusinessDays,
        `${path}.lockoutBusinessDays`,
        0,
      ),
      calendarId: text(r.calendarId, `${path}.calendarId`),
      dailyDecimals,
    };
  }
  if (type === "ZERO_COUPON_DISCOUNT") {
    object(value, path, ["type"]);
    return { type };
  }
  if (type === "FIXED") {
    const r = object(value, path, ["type", "annualRate"]);
    return { type, annualRate: decimal(r.annualRate, `${path}.annualRate`) };
  }
  const addend = type === "BENCHMARK_PLUS_SPREAD" ? "spread" : "margin";
  const r = object(value, path, [
    "type",
    "benchmarkId",
    addend,
    "firstPeriodRate",
    "benchmarkFloor",
    "observation",
  ]);
  const common: BenchmarkRuleFields = {
    benchmarkId: text(r.benchmarkId, `${path}.benchmarkId`),
    firstPeriodRate: nullable(r.firstPeriodRate, (v) =>
      decimal(v, `${path}.firstPeriodRate`),
    ),
    benchmarkFloor: nullable(r.benchmarkFloor, (v) =>
      decimal(v, `${path}.benchmarkFloor`),
    ),
    observation: parseObservation(r.observation, `${path}.observation`),
  };
  return type === "BENCHMARK_PLUS_SPREAD"
    ? { type, spread: decimal(r.spread, `${path}.spread`), ...common }
    : { type, margin: decimal(r.margin, `${path}.margin`), ...common };
}

function parseCapitalization(value: unknown, path: string): Capitalization {
  const type = primitive(value, path, [
    "NONE",
    "COMPOUND_AT_PERIOD_END",
  ] as const);
  if (type === "NONE") {
    object(value, path, ["type"]);
    return { type };
  }
  const c = object(value, path, ["type", "baseRounding"]);
  return {
    type,
    baseRounding: oneOf(c.baseRounding, `${path}.baseRounding`, [
      "PER_PERIOD",
      "NONE",
    ] as const),
  };
}

function parseRedemption(value: unknown, path: string): Redemption {
  const type = primitive(value, path, ["MATURITY_ONLY", "ON_DEMAND"] as const);
  if (type === "MATURITY_ONLY") {
    object(value, path, ["type"]);
    return { type };
  }
  const r = object(value, path, [
    "type",
    "earliestDaysAfterPurchase",
    "latestDaysBeforeMaturity",
    "blackouts",
    "penalties",
    "proceedsFloor",
  ]);
  return {
    type,
    earliestDaysAfterPurchase: integer(
      r.earliestDaysAfterPurchase,
      `${path}.earliestDaysAfterPurchase`,
      0,
    ),
    latestDaysBeforeMaturity: integer(
      r.latestDaysBeforeMaturity,
      `${path}.latestDaysBeforeMaturity`,
      0,
    ),
    blackouts: list(r.blackouts, `${path}.blackouts`, (item, at): Blackout => {
      const t = primitive(item, at, ["RECORD_DAY_BEFORE_COUPON"] as const);
      const b = object(item, at, ["type", "businessDays", "calendarId"]);
      return {
        type: t,
        businessDays: integer(b.businessDays, `${at}.businessDays`, 1),
        calendarId: text(b.calendarId, `${at}.calendarId`),
      };
    }),
    penalties: list(r.penalties, `${path}.penalties`, (item, at): Penalty => {
      const t = primitive(item, at, [
        "FIXED_FEE_PER_UNIT",
        "FORFEIT_ACCRUED_SINCE_LAST_PAYMENT",
      ] as const);
      if (t === "FORFEIT_ACCRUED_SINCE_LAST_PAYMENT") {
        object(item, at, ["type"]);
        return { type: t };
      }
      const p = object(item, at, ["type", "amount"]);
      return { type: t, amount: decimal(p.amount, `${at}.amount`) };
    }),
    proceedsFloor: nullable(r.proceedsFloor, (v): ProceedsFloor => {
      const at = `${path}.proceedsFloor`;
      const t = primitive(v, at, ["FACE_VALUE"] as const);
      const f = object(v, at, ["type", "appliesTo"]);
      return {
        type: t,
        appliesTo: oneOf(f.appliesTo, `${at}.appliesTo`, [
          "ALL_PERIODS",
          "FIRST_PERIOD",
        ] as const),
      };
    }),
  };
}

const FIELDS = [
  "schemaVersion",
  "instrument",
  "saleWindow",
  "schedule",
  "accrual",
  "principalRule",
  "rateRule",
  "capitalization",
  "redemption",
  "rounding",
  "source",
] as const;

/** Strict validator for a stored terms document (spec 2.1, schemaVersion 1). */
export function parseBondTerms(json: unknown): BondTerms {
  const t = object(json, "terms", FIELDS);
  exact(t.schemaVersion, "terms.schemaVersion", 1);

  const i = object(
    t.instrument,
    "terms.instrument",
    [
      "issuerCountryCode",
      "issuerCode",
      "programCode",
      "seriesCode",
      "currency",
      "marketability",
      "faceValue",
    ],
    ["issuePrice"],
  );
  const faceValue = decimal(i.faceValue, "terms.instrument.faceValue");
  if (ExactDecimal.parse(faceValue).isZero()) {
    throw new BondTermsError("terms.instrument.faceValue", "must be positive");
  }

  const source = object(t.source, "terms.source", [
    "provider",
    "url",
    "document",
  ]);

  const terms: BondTerms = {
    schemaVersion: 1,
    instrument: {
      issuerCountryCode: code(
        i.issuerCountryCode,
        "terms.instrument.issuerCountryCode",
        /^[A-Z]{2}$/,
      ),
      issuerCode: text(i.issuerCode, "terms.instrument.issuerCode"),
      programCode: text(i.programCode, "terms.instrument.programCode"),
      seriesCode: text(i.seriesCode, "terms.instrument.seriesCode"),
      currency: code(i.currency, "terms.instrument.currency", /^[A-Z]{3}$/),
      marketability: oneOf(i.marketability, "terms.instrument.marketability", [
        "RETAIL_REDEEMABLE",
        "MARKETABLE",
      ] as const),
      faceValue,
      ...(i.issuePrice === undefined
        ? {}
        : { issuePrice: decimal(i.issuePrice, "terms.instrument.issuePrice") }),
    },
    saleWindow: nullable(t.saleWindow, (v) => {
      const w = object(v, "terms.saleWindow", ["from", "to"]);
      const from = date(w.from, "terms.saleWindow.from");
      const to = date(w.to, "terms.saleWindow.to");
      if (from > to)
        throw new BondTermsError("terms.saleWindow", "from is after to");
      return { from, to };
    }),
    schedule: parseSchedule(t.schedule, "terms.schedule"),
    accrual: {
      type: primitive(t.accrual, "terms.accrual", [
        "ACTUAL_DAYS_IN_PERIOD",
        "ACTUAL_ACTUAL_ICMA",
        "ACTUAL_360_DAILY_SUM",
      ] as const),
    },
    principalRule: parsePrincipalRule(t.principalRule, "terms.principalRule"),
    rateRule: parseRateRule(t.rateRule, "terms.rateRule"),
    capitalization: parseCapitalization(
      t.capitalization,
      "terms.capitalization",
    ),
    redemption: parseRedemption(t.redemption, "terms.redemption"),
    rounding: parseRounding(t.rounding, "terms.rounding", faceValue),
    source: {
      provider: text(source.provider, "terms.source.provider"),
      url: text(source.url, "terms.source.url"),
      document: text(source.document, "terms.source.document"),
    },
  };
  object(t.accrual, "terms.accrual", ["type"]);
  assertConsistent(terms);
  return terms;
}

/** Generic consistency between primitives, never a per-product rule. */
function assertConsistent(terms: BondTerms): void {
  const { redemption, capitalization } = terms;
  assertMarketableConsistent(terms);
  assertScheduleConsistent(terms);
  assertPrincipalConsistent(terms);
  assertDailyConsistent(terms);
  assertDiscountConsistent(terms);
  if (
    redemption.type === "ON_DEMAND" &&
    capitalization.type !== "NONE" &&
    redemption.blackouts.length > 0
  ) {
    throw new BondTermsError(
      "terms.redemption.blackouts",
      "a record day exists only for a bond that pays a coupon (capitalization NONE)",
    );
  }
}

/**
 * An indexed principal is paid with coupons computed on it: a `COUPON_DATES`
 * schedule, capitalization `NONE`, redemption at maturity only. Its index is not
 * the benchmark the rate rule reads: one series cannot be a rate and an index
 * level (`benchmarkReadsOf`).
 */
function assertPrincipalConsistent(terms: BondTerms): void {
  const { principalRule, schedule, capitalization, redemption, rateRule } =
    terms;
  if (principalRule.type !== "INDEX_RATIO") return;
  if (schedule.anchor !== "COUPON_DATES") {
    throw new BondTermsError(
      "terms.schedule.anchor",
      "an INDEX_RATIO principal needs a COUPON_DATES schedule",
    );
  }
  if (capitalization.type !== "NONE") {
    throw new BondTermsError(
      "terms.capitalization",
      "an INDEX_RATIO principal pays each coupon at its date (capitalization NONE)",
    );
  }
  if (redemption.type !== "MATURITY_ONLY") {
    throw new BondTermsError(
      "terms.redemption",
      "an INDEX_RATIO principal is paid at maturity only (MATURITY_ONLY)",
    );
  }
  if (rateRule.type === "DAILY_INDEX_PLUS_SPREAD") {
    throw new BondTermsError(
      "terms.rateRule",
      "an INDEX_RATIO principal does not combine with a DAILY_INDEX_PLUS_SPREAD rate",
    );
  }
  if (rateBenchmarkIdOf(rateRule) === principalRule.benchmarkId) {
    throw new BondTermsError(
      "terms.principalRule.benchmarkId",
      "must not be the benchmark the rate rule reads: a rate and an index level are different units",
    );
  }
}

/**
 * `DAILY_INDEX_PLUS_SPREAD` and `ACTUAL_360_DAILY_SUM` need each other: the rate
 * is a daily one and the accrual sums days (`yearFraction` has no meaning for
 * it). Interest is paid at each period's end: a `COUPON_DATES` schedule,
 * capitalization `NONE`.
 */
function assertDailyConsistent(terms: BondTerms): void {
  const { rateRule, accrual, schedule, capitalization } = terms;
  const daily = rateRule.type === "DAILY_INDEX_PLUS_SPREAD";
  if (daily !== (accrual.type === "ACTUAL_360_DAILY_SUM")) {
    throw new BondTermsError(
      "terms.accrual",
      "ACTUAL_360_DAILY_SUM and a DAILY_INDEX_PLUS_SPREAD rate are used together",
    );
  }
  if (!daily) return;
  if (schedule.anchor !== "COUPON_DATES") {
    throw new BondTermsError(
      "terms.schedule.anchor",
      "a DAILY_INDEX_PLUS_SPREAD rate needs a COUPON_DATES schedule",
    );
  }
  if (capitalization.type !== "NONE") {
    throw new BondTermsError(
      "terms.capitalization",
      "a DAILY_INDEX_PLUS_SPREAD rate pays each coupon at its date (capitalization NONE)",
    );
  }
}

/** A marketable series is bought on any day before maturity and sold, not redeemed early. */
function assertMarketableConsistent(terms: BondTerms): void {
  if (terms.instrument.marketability !== "MARKETABLE") return;
  if (terms.saleWindow !== null) {
    throw new BondTermsError(
      "terms.saleWindow",
      "a MARKETABLE instrument has no sale window (null)",
    );
  }
  if (terms.redemption.type !== "MATURITY_ONLY") {
    throw new BondTermsError(
      "terms.redemption",
      "a MARKETABLE instrument is paid at maturity only (MATURITY_ONLY)",
    );
  }
}

/** A discount instrument has an issue price, one issue-to-maturity period, no coupon and no early redemption. */
function assertDiscountConsistent(terms: BondTerms): void {
  const { instrument, schedule, rateRule, capitalization, redemption } = terms;
  const discount = rateRule.type === "ZERO_COUPON_DISCOUNT";
  if (!discount) {
    if (instrument.issuePrice !== undefined) {
      throw new BondTermsError(
        "terms.instrument.issuePrice",
        "only a ZERO_COUPON_DISCOUNT instrument has an issue price",
      );
    }
    if (schedule.anchor === "ISSUE_DATE") {
      throw new BondTermsError(
        "terms.schedule.anchor",
        "an ISSUE_DATE schedule is only for a ZERO_COUPON_DISCOUNT instrument",
      );
    }
    return;
  }
  if (instrument.issuePrice === undefined) {
    throw new BondTermsError(
      "terms.instrument.issuePrice",
      "required for a ZERO_COUPON_DISCOUNT instrument",
    );
  }
  const price = ExactDecimal.parse(instrument.issuePrice);
  const against = price.cmp(ExactDecimal.parse(instrument.faceValue));
  // A marketable bill may be issued at par (a discount rate of nothing): the
  // value stays at the face value and the interest is nothing. A retail
  // discount bond is always issued below its face value.
  const parAllowed = instrument.marketability === "MARKETABLE";
  if (price.isZero() || against > 0 || (against === 0 && !parAllowed)) {
    throw new BondTermsError(
      "terms.instrument.issuePrice",
      parAllowed
        ? "must be above zero and at most the face value"
        : "must be above zero and below the face value",
    );
  }
  if (schedule.anchor !== "ISSUE_DATE") {
    throw new BondTermsError(
      "terms.schedule.anchor",
      "a ZERO_COUPON_DISCOUNT instrument needs an ISSUE_DATE schedule",
    );
  }
  if (capitalization.type !== "NONE") {
    throw new BondTermsError(
      "terms.capitalization",
      "a ZERO_COUPON_DISCOUNT instrument does not capitalise (NONE)",
    );
  }
  if (redemption.type !== "MATURITY_ONLY") {
    throw new BondTermsError(
      "terms.redemption",
      "a ZERO_COUPON_DISCOUNT instrument is redeemed at maturity only (MATURITY_ONLY)",
    );
  }
}
