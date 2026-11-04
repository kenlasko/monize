import { daysBetween, parseYMD } from "./calendar-date";
import { assertNever } from "./assert-never";
import { BondRounding, parseRounding } from "./bond-rounding";
import { ExactDecimal } from "./exact-decimal";
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
  text,
} from "./terms-readers";

export { BondTermsError } from "./terms-readers";
export type { BondTermsErrorCode } from "./terms-readers";
export type { BondRounding } from "./bond-rounding";

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
    } & BenchmarkRuleFields);

export type BenchmarkRule = Exclude<
  RateRule,
  { readonly type: "FIXED" } | { readonly type: "ZERO_COUPON_DISCOUNT" }
>;

/** The rule when it reads a benchmark, null for a rule that reads none; exhaustive over the rule types. */
export function benchmarkRuleOf(rule: RateRule): BenchmarkRule | null {
  switch (rule.type) {
    case "FIXED":
    case "ZERO_COUPON_DISCOUNT":
      return null;
    case "BENCHMARK_PLUS_SPREAD":
    case "INFLATION_PLUS_MARGIN_AS_RATE":
      return rule;
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

/** Periods counted from each lot's purchase date. */
export interface LotAnchoredSchedule {
  readonly anchor: "LOT_PURCHASE_DATE";
  readonly periodMonths: number;
  readonly periodCount: number;
  readonly rollDay: "ANCHOR_DAY_CLAMPED";
  readonly calendarId: string;
}

/** One period from the series' issue date to its maturity date, whatever the lot's purchase date. */
export interface IssueDateSchedule {
  readonly anchor: "ISSUE_DATE";
  readonly issueDate: string;
  readonly maturityDate: string;
  readonly periodCount: 1;
  readonly calendarId: string;
}

export type BondSchedule = LotAnchoredSchedule | IssueDateSchedule;

/**
 * The length of the schedule in whole months of `periodMonths` and a period
 * count; a single issue-to-maturity period is its whole months, at least one.
 */
export function scheduleMonthsOf(schedule: BondSchedule): {
  readonly periodMonths: number;
  readonly periodCount: number;
} {
  switch (schedule.anchor) {
    case "LOT_PURCHASE_DATE":
      return {
        periodMonths: schedule.periodMonths,
        periodCount: schedule.periodCount,
      };
    case "ISSUE_DATE": {
      const from = parseYMD(schedule.issueDate);
      const to = parseYMD(schedule.maturityDate);
      const whole =
        (to.year - from.year) * 12 +
        (to.month - from.month) -
        (to.day < from.day ? 1 : 0);
      return { periodMonths: whole < 1 ? 1 : whole, periodCount: 1 };
    }
    default:
      return assertNever(schedule);
  }
}

/**
 * The exact length in days of a single issue-to-maturity period (`ISSUE_DATE`),
 * or null for a schedule counted in months (`LOT_PURCHASE_DATE`): a discount
 * bill of 4 weeks is 28 days, not "1 month".
 */
export function scheduleDaysOf(schedule: BondSchedule): number | null {
  switch (schedule.anchor) {
    case "LOT_PURCHASE_DATE":
      return null;
    case "ISSUE_DATE":
      return daysBetween(schedule.issueDate, schedule.maturityDate);
    default:
      return assertNever(schedule);
  }
}

export interface BondTerms {
  readonly schemaVersion: 1;
  readonly instrument: {
    readonly issuerCountryCode: string;
    readonly issuerCode: string;
    readonly programCode: string;
    readonly seriesCode: string;
    readonly currency: string;
    readonly marketability: "RETAIL_REDEEMABLE";
    readonly faceValue: string;
    /**
     * The price of one face value at issue, exact decimal, above zero and below
     * `faceValue`. Present exactly when the rate rule is ZERO_COUPON_DISCOUNT.
     */
    readonly issuePrice?: string;
  };
  readonly saleWindow: { readonly from: string; readonly to: string } | null;
  readonly schedule: BondSchedule;
  readonly accrual: { readonly type: "ACTUAL_DAYS_IN_PERIOD" };
  readonly principalRule: { readonly type: "FIXED_NOMINAL" };
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
  ] as const);
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

function parseSchedule(value: unknown, path: string): BondSchedule {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new BondTermsError(path, "must be an object");
  }
  const anchor = oneOf((value as Json).anchor, `${path}.anchor`, [
    "LOT_PURCHASE_DATE",
    "ISSUE_DATE",
  ] as const);
  if (anchor === "ISSUE_DATE") {
    const s = object(value, path, [
      "anchor",
      "issueDate",
      "maturityDate",
      "periodCount",
      "calendarId",
    ]);
    const issueDate = date(s.issueDate, `${path}.issueDate`);
    const maturityDate = date(s.maturityDate, `${path}.maturityDate`);
    if (issueDate >= maturityDate) {
      throw new BondTermsError(
        `${path}.maturityDate`,
        "must be after the issue date",
      );
    }
    return {
      anchor,
      issueDate,
      maturityDate,
      periodCount: exact(s.periodCount, `${path}.periodCount`, 1),
      calendarId: text(s.calendarId, `${path}.calendarId`),
    };
  }
  const s = object(value, path, [
    "anchor",
    "periodMonths",
    "periodCount",
    "rollDay",
    "calendarId",
  ]);
  const periodMonths = integer(s.periodMonths, `${path}.periodMonths`, 1);
  if (periodMonths > 12 || 12 % periodMonths !== 0) {
    throw new BondTermsError(`${path}.periodMonths`, "must divide 12");
  }
  return {
    anchor,
    periodMonths,
    periodCount: integer(s.periodCount, `${path}.periodCount`, 1),
    rollDay: oneOf(s.rollDay, `${path}.rollDay`, [
      "ANCHOR_DAY_CLAMPED",
    ] as const),
    calendarId: text(s.calendarId, `${path}.calendarId`),
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
      ] as const),
    },
    principalRule: {
      type: primitive(t.principalRule, "terms.principalRule", [
        "FIXED_NOMINAL",
      ] as const),
    },
    rateRule: parseRateRule(t.rateRule, "terms.rateRule"),
    capitalization: parseCapitalization(
      t.capitalization,
      "terms.capitalization",
    ),
    redemption: parseRedemption(t.redemption, "terms.redemption"),
    rounding: parseRounding(t.rounding, "terms.rounding"),
    source: {
      provider: text(source.provider, "terms.source.provider"),
      url: text(source.url, "terms.source.url"),
      document: text(source.document, "terms.source.document"),
    },
  };
  object(t.accrual, "terms.accrual", ["type"]);
  object(t.principalRule, "terms.principalRule", ["type"]);
  assertConsistent(terms);
  return terms;
}

/** Generic consistency between primitives, never a per-product rule. */
function assertConsistent(terms: BondTerms): void {
  const { redemption, capitalization } = terms;
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
  if (
    price.isZero() ||
    price.cmp(ExactDecimal.parse(instrument.faceValue)) >= 0
  ) {
    throw new BondTermsError(
      "terms.instrument.issuePrice",
      "must be above zero and below the face value",
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
