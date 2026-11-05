import { assertNever } from "../domain/assert-never";
import { BenchmarkData } from "../domain/benchmark";
import { nthBusinessDayBefore } from "../domain/business-day-calendar";
import {
  BenchmarkRule,
  ObservationRule,
  RateRule,
  benchmarkRuleOf,
} from "../domain/bond-terms";
import {
  compareYMD,
  firstOfMonth,
  monthKeyBefore,
  parseYMD,
} from "../domain/calendar-date";
import { ExactDecimal } from "../domain/exact-decimal";
import { SchedulePeriod } from "../domain/period-schedule";
import {
  BondEngineError,
  BondEngineInput,
  MissingObservation,
  ProjectionAssumption,
  RateSource,
} from "./bond-engine-types";

/** What a benchmark period read: the observation key, the value and the floored value. */
export interface PeriodBenchmark {
  readonly benchmarkId: string;
  /** The YYYY-MM-DD or YYYY-MM key the observation rule computed. */
  readonly observation: string;
  /** The observed value, or the assumed one when PROJECTED; null when missing. */
  readonly value: string | null;
  /** The value after the benchmark floor; null when `value` is null. */
  readonly flooredValue: string | null;
}

export interface PeriodRate {
  readonly period: SchedulePeriod;
  /** Null for a TERMS or ANNOUNCED period: the stated rate does not read a benchmark. */
  readonly benchmark: PeriodBenchmark | null;
  /** The margin or spread as a fraction; null when `benchmark` is null. */
  readonly addend: string | null;
  readonly rate: ExactDecimal | null;
  readonly source: RateSource | null;
  /** Set when the rate is null and the cause is a missing observation. */
  readonly missing: MissingObservation | null;
}

/** `field` names the stored or supplied value by a technical key, e.g. `announcedRate:2`. */
export function parseDecimal(value: string, field: string): ExactDecimal {
  try {
    return ExactDecimal.parse(value);
  } catch {
    throw new BondEngineError(
      "DECIMAL_INVALID",
      { field, value: String(value) },
      `${field} is not a decimal string: ${String(value)}`,
    );
  }
}

/** The value as the fraction it is stored as, e.g. 0.0290. */
function fraction(value: ExactDecimal): string {
  return value.toTrimmedString(10, 4);
}

function addendOf(rule: BenchmarkRule): ExactDecimal {
  switch (rule.type) {
    case "BENCHMARK_PLUS_SPREAD":
      return parseDecimal(rule.spread, "spread");
    case "INFLATION_PLUS_MARGIN_AS_RATE":
      return parseDecimal(rule.margin, "margin");
    default:
      return assertNever(rule);
  }
}

/** max(floor, benchmark): the floor keeps a negative benchmark out of the rate. */
function floored(rule: BenchmarkRule, benchmark: ExactDecimal): ExactDecimal {
  const floor =
    rule.benchmarkFloor === null
      ? benchmark
      : parseDecimal(rule.benchmarkFloor, "floor");
  return ExactDecimal.max(floor, benchmark);
}

function newestStep(
  data: Extract<BenchmarkData, { kind: "STEP" }>,
  onOrBefore?: string,
) {
  let newest: (typeof data.changes)[number] | null = null;
  for (const change of data.changes) {
    if (
      onOrBefore !== undefined &&
      compareYMD(change.effectiveFrom, onOrBefore) > 0
    )
      continue;
    if (
      newest === null ||
      compareYMD(change.effectiveFrom, newest.effectiveFrom) > 0
    ) {
      newest = change;
    }
  }
  return newest;
}

interface Observation {
  readonly value: ExactDecimal | null;
  /** The stored value string as read; null when `value` is null. */
  readonly raw: string | null;
  readonly missing: MissingObservation;
}

/** What the rule observes for `period`; null when a calendar it needs is unknown. */
function observe(
  rule: BenchmarkRule,
  period: SchedulePeriod,
  input: Omit<BondEngineInput, "asOf">,
): Observation | null {
  const data = input.benchmarks.get(rule.benchmarkId);
  const publisher = data ? data.publisher : null;
  const observation: ObservationRule = rule.observation;
  switch (observation.type) {
    case "STEP_VALUE_ON_NTH_BUSINESS_DAY_BEFORE_START_MONTH": {
      const calendar = input.calendars.get(observation.calendarId);
      if (!calendar) return null;
      const day = nthBusinessDayBefore(
        calendar,
        firstOfMonth(period.start),
        observation.businessDays,
      );
      const missing = {
        benchmarkId: rule.benchmarkId,
        observation: day,
        publisher,
      };
      if (
        !data ||
        data.kind !== "STEP" ||
        data.coveredThrough === null ||
        compareYMD(day, data.coveredThrough) > 0
      ) {
        return { value: null, raw: null, missing };
      }
      const change = newestStep(data, day);
      return {
        raw: change ? change.value : null,
        value: change
          ? parseDecimal(
              change.value,
              `${rule.benchmarkId}:${change.effectiveFrom}`,
            )
          : null,
        missing,
      };
    }
    case "MONTHLY_VALUE_MONTHS_BEFORE_START": {
      const key = monthKeyBefore(period.start, observation.months);
      const stored =
        data && data.kind === "MONTHLY" ? data.values.get(key) : undefined;
      return {
        raw: stored === undefined ? null : stored,
        value:
          stored === undefined
            ? null
            : parseDecimal(stored, `${rule.benchmarkId}:${key}`),
        missing: { benchmarkId: rule.benchmarkId, observation: key, publisher },
      };
    }
    default:
      return assertNever(observation);
  }
}

export interface Assumption {
  readonly value: ExactDecimal;
  readonly entry: ProjectionAssumption;
}

/** The supplied assumption, else the newest stored observation, else none. */
function projectionAssumption(
  rule: BenchmarkRule,
  input: Omit<BondEngineInput, "asOf">,
): Assumption | null {
  const id = rule.benchmarkId;
  const supplied = input.projection?.get(id);
  if (supplied !== undefined) {
    const value = parseDecimal(supplied, `projectionAssumption:${id}`);
    return {
      value,
      entry: {
        benchmarkId: id,
        value: fraction(value),
        basis: "SUPPLIED",
        observation: null,
      },
    };
  }
  const data = input.benchmarks.get(id);
  if (!data) return null;
  let at: string;
  let raw: string;
  if (data.kind === "STEP") {
    const newest = newestStep(data);
    if (!newest) return null;
    [at, raw] = [newest.effectiveFrom, newest.value];
  } else {
    const keys = [...data.values.keys()].sort();
    if (keys.length === 0) return null;
    [at, raw] = [
      keys[keys.length - 1],
      data.values.get(keys[keys.length - 1])!,
    ];
  }
  const value = parseDecimal(raw, `${id}:${at}`);
  return {
    value,
    entry: {
      benchmarkId: id,
      value: fraction(value),
      basis: "LATEST_OBSERVATION",
      observation: at,
    },
  };
}

/**
 * A period whose rate depends on the day asked about: the observation is not
 * stored, so the period is unknown once it has started and projected before.
 */
interface PendingRate {
  readonly period: SchedulePeriod;
  readonly missing: MissingObservation;
  readonly absent: PeriodBenchmark;
  readonly key: string;
}

type PlannedRate =
  | { readonly kind: "final"; readonly rate: PeriodRate }
  | { readonly kind: "pending"; readonly pending: PendingRate };

/**
 * The rates of a lot resolved once, for every day. A period's rate does not
 * depend on the day except when its observation is missing; that case is left
 * `pending` and settled by `ratesWithStarted` for the number of started periods.
 */
export interface RatePlan {
  readonly rule: RateRule;
  readonly planned: readonly PlannedRate[];
  readonly assumption: Assumption | null;
  readonly publisher: string | null;
}

/** Number of periods with `start <= asOf`; both are valid dates. */
export function startedPeriods(
  schedule: readonly SchedulePeriod[],
  asOf: string,
): number {
  let count = 0;
  for (const period of schedule) {
    if (compareYMD(period.start, asOf) > 0) break;
    count += 1;
  }
  return count;
}

/** Stored benchmark dates are compared as text from here on: validate them once. */
function assertStoredDates(input: Omit<BondEngineInput, "asOf">): void {
  for (const data of input.benchmarks.values()) {
    if (data.kind !== "STEP") continue;
    for (const change of data.changes) parseYMD(change.effectiveFrom);
    if (data.coveredThrough !== null) parseYMD(data.coveredThrough);
  }
}

/**
 * Plan the rate of every period by the spec section 4 truth table: a fixed rate
 * and a stated first-period rate come from the terms, an announced rate wins,
 * otherwise the rate is derived from the stored observation. With none, a
 * period that has started has no rate (INV-BOND-002) and one that has not is
 * projected from an assumption.
 */
export function planPeriodRates(
  input: Omit<BondEngineInput, "asOf">,
  schedule: readonly SchedulePeriod[],
): RatePlan {
  assertStoredDates(input);
  const rule = input.terms.rateRule;
  const benchmarkRule = benchmarkRuleOf(rule);
  const assumption = benchmarkRule
    ? projectionAssumption(benchmarkRule, input)
    : null;
  const publisher = benchmarkRule
    ? (input.benchmarks.get(benchmarkRule.benchmarkId)?.publisher ?? null)
    : null;

  const planned = schedule.map((period): PlannedRate => {
    const final = (rate: PeriodRate): PlannedRate => ({ kind: "final", rate });
    const known = (
      rate: ExactDecimal,
      source: RateSource,
      benchmark: PeriodBenchmark | null = null,
    ) =>
      final({
        period,
        rate,
        source,
        missing: null,
        benchmark,
        addend:
          benchmark && benchmarkRule ? fraction(addendOf(benchmarkRule)) : null,
      });
    const benchmarkPeriod = (rule: BenchmarkRule): PlannedRate => {
      if (period.index === 1 && rule.firstPeriodRate !== null) {
        return known(
          parseDecimal(rule.firstPeriodRate, "firstPeriodRate"),
          "TERMS",
        );
      }
      const announced = input.announcedRates.get(period.index);
      if (announced !== undefined) {
        return known(
          parseDecimal(announced, `announcedRate:${period.index}`),
          "ANNOUNCED",
        );
      }
      const observation = observe(rule, period, input);
      const absent = (key: string): PeriodBenchmark => ({
        benchmarkId: rule.benchmarkId,
        observation: key,
        value: null,
        flooredValue: null,
      });
      if (observation === null) {
        // A calendar the observation needs is unknown: the terms are incomplete.
        return final({
          period,
          rate: null,
          source: null,
          missing: null,
          benchmark: null,
          addend: null,
        });
      }
      const key = observation.missing.observation;
      if (observation.value !== null) {
        const base = floored(rule, observation.value);
        return known(base.add(addendOf(rule)), "DERIVED", {
          benchmarkId: rule.benchmarkId,
          observation: key,
          value: observation.raw,
          flooredValue: fraction(base),
        });
      }
      return {
        kind: "pending",
        pending: {
          period,
          missing: observation.missing,
          absent: absent(key),
          key,
        },
      };
    };
    switch (rule.type) {
      case "FIXED":
        return known(parseDecimal(rule.annualRate, "annualRate"), "TERMS");
      case "ZERO_COUPON_DISCOUNT":
        // States no rate; zero is the placeholder that keeps the period known,
        // and the discount arithmetic never reads it.
        return known(ExactDecimal.ZERO, "TERMS");
      case "BENCHMARK_PLUS_SPREAD":
      case "INFLATION_PLUS_MARGIN_AS_RATE":
        return benchmarkPeriod(rule);
      case "DAILY_INDEX_PLUS_SPREAD":
        // The days' rates are the lot's own (`floating-lot.ts`); a period has no
        // single rate, and no observation of its own to be missing.
        return final({
          period,
          rate: null,
          source: null,
          missing: null,
          benchmark: null,
          addend: fraction(parseDecimal(rule.spread, "spread")),
        });
      default:
        return assertNever(rule);
    }
  });
  return { rule, planned, assumption, publisher };
}

export interface RateResolution {
  readonly rates: readonly PeriodRate[];
  readonly assumptions: readonly ProjectionAssumption[];
  /** Benchmarks a not-yet-started period needs for which no projection is possible. */
  readonly projectionMissing: readonly {
    readonly benchmarkId: string;
    readonly publisher: string | null;
  }[];
}

/**
 * The rates as known on a day on which `started` periods have begun. Exact for
 * every day with that count: a period that has started has the rate (or the
 * missing observation) it has today, and a period that has not started does not
 * enter a value on that day.
 */
export function ratesWithStarted(
  plan: RatePlan,
  started: number,
): RateResolution {
  const { rule, assumption } = plan;
  const benchmarkRule = benchmarkRuleOf(rule);
  let usedAssumption = false;
  let projectionNeeded = false;
  const rates = plan.planned.map((entry): PeriodRate => {
    if (entry.kind === "final") return entry.rate;
    const { period, missing, absent, key } = entry.pending;
    const addend = benchmarkRule ? fraction(addendOf(benchmarkRule)) : null;
    if (period.index <= started) {
      return {
        period,
        rate: null,
        source: null,
        missing,
        benchmark: absent,
        addend,
      };
    }
    if (assumption === null || benchmarkRule === null) {
      projectionNeeded = true;
      return {
        period,
        rate: null,
        source: null,
        missing: null,
        benchmark: absent,
        addend,
      };
    }
    usedAssumption = true;
    const base = floored(benchmarkRule, assumption.value);
    return {
      period,
      rate: base.add(addendOf(benchmarkRule)),
      source: "PROJECTED",
      missing: null,
      addend,
      benchmark: {
        benchmarkId: benchmarkRule.benchmarkId,
        observation: key,
        value: fraction(assumption.value),
        flooredValue: fraction(base),
      },
    };
  });
  return {
    rates,
    assumptions: usedAssumption && assumption ? [assumption.entry] : [],
    projectionMissing:
      projectionNeeded && benchmarkRule
        ? [
            {
              benchmarkId: benchmarkRule.benchmarkId,
              publisher: plan.publisher,
            },
          ]
        : [],
  };
}
