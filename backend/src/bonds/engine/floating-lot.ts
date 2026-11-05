import { BenchmarkData } from "../domain/benchmark";
import {
  BusinessDayCalendar,
  nthBusinessDayBefore,
} from "../domain/business-day-calendar";
import { BondTerms, DailyIndexRule } from "../domain/bond-terms";
import { addDays, compareYMD } from "../domain/calendar-date";
import { ExactDecimal, RoundingMode } from "../domain/exact-decimal";
import { SchedulePeriod } from "../domain/period-schedule";
import { DailyRateRun, RateScheduleEntry } from "./bond-engine-types";
import { roundLot, unitText } from "./rounding";

/**
 * The figures of a lot whose rate is `DAILY_INDEX_PLUS_SPREAD` and whose accrual
 * is `ACTUAL_360_DAILY_SUM` (`docs/specs/bond-marketable-primitives.md` 7.2; 31
 * CFR 356 Appendix B I.C and IV): every day of a period accrues
 * `max(index + spread, floor) / 360` of the par, rounded per 100 of par, and a
 * period's interest is the sum of its days. Kept apart from the plain arithmetic
 * of `accrual.ts`, which has no meaning for a rate that changes inside a period.
 */

/** An index observation reaches this many calendar days past its date before it is stale (an auction is weekly). */
export const INDEX_FRESH_DAYS = 7;

const PAR = ExactDecimal.fromInt(100);
const DAY_COUNT = ExactDecimal.fromInt(360);

/** One day of a period: the index in force and the daily accrual per 100 of par, null while unknown. */
interface DayRow {
  readonly day: string;
  readonly index: ExactDecimal | null;
  readonly accrual: ExactDecimal | null;
}

/** What a floating rate reads, resolved once for a lot. */
export interface FloatingSeries {
  readonly rule: DailyIndexRule;
  readonly face: ExactDecimal;
  readonly mode: RoundingMode;
  readonly spread: ExactDecimal;
  readonly floor: ExactDecimal;
  /** The stored observations, oldest first: the day an auction was held and the index from the day after. */
  readonly observations: readonly {
    readonly date: string;
    readonly value: ExactDecimal;
  }[];
  readonly publisher: string | null;
  /** Null when the terms' calendar is unknown (the terms are incomplete) and a lockout needs it. */
  readonly calendar: BusinessDayCalendar | undefined;
  /** The assumed index (a fraction), supplied by the caller, for the days after the valuation day; null when none. */
  readonly assumed: ExactDecimal | null;
  /** The day rows of each period, by period number: they do not depend on the valuation day. */
  readonly tables: Map<number, readonly DayRow[]>;
}

export function floatingSeriesOf(
  terms: BondTerms,
  rule: DailyIndexRule,
  data: BenchmarkData | undefined,
  calendar: BusinessDayCalendar | undefined,
  assumed: ExactDecimal | null,
): FloatingSeries {
  const changes =
    data !== undefined && data.kind === "STEP" ? data.changes : [];
  return {
    rule,
    face: ExactDecimal.parse(terms.instrument.faceValue),
    mode: terms.rounding.mode,
    spread: ExactDecimal.parse(rule.spread),
    floor: ExactDecimal.parse(rule.floor),
    observations: changes
      .map((c) => ({
        date: c.effectiveFrom,
        value: ExactDecimal.parse(c.value),
      }))
      .sort((a, b) => compareYMD(a.date, b.date)),
    publisher: data === undefined ? null : data.publisher,
    calendar,
    assumed,
    tables: new Map(),
  };
}

/** The accrual of one day per 100 of par: `max(index + spread, floor) / 360` in percent of par, rounded to `dailyDecimals`. */
function dailyAccrual(series: FloatingSeries, index: ExactDecimal) {
  return ExactDecimal.max(index.add(series.spread), series.floor)
    .mul(PAR)
    .div(DAY_COUNT)
    .round(series.rule.dailyDecimals, series.mode);
}

/**
 * The day rows of a period. The index of a day is the latest observation strictly
 * before it, except an observation dated within `lockoutBusinessDays` business
 * days before the period's end, which the period does not use. A day more than
 * `INDEX_FRESH_DAYS` after the observation in force for it is unknown, whether
 * that is the newest stored observation or one before a gap: no value is carried
 * across an auction that is not stored (INV-BOND-002).
 */
function tableOf(
  series: FloatingSeries,
  period: SchedulePeriod,
): readonly DayRow[] {
  const cached = series.tables.get(period.index);
  if (cached !== undefined) return cached;
  const { observations, rule } = series;
  const lockoutNeedsCalendar =
    rule.lockoutBusinessDays > 0 && series.calendar === undefined;
  const lockFrom =
    rule.lockoutBusinessDays > 0 && series.calendar !== undefined
      ? nthBusinessDayBefore(
          series.calendar,
          period.end,
          rule.lockoutBusinessDays,
        )
      : null;
  const usable = observations.filter(
    (o) => lockFrom === null || compareYMD(o.date, lockFrom) < 0,
  );
  const rows: DayRow[] = [];
  let at = -1;
  let stored = -1;
  for (
    let day = period.start;
    compareYMD(day, period.end) < 0;
    day = addDays(day, 1)
  ) {
    while (at + 1 < usable.length && compareYMD(usable[at + 1].date, day) < 0) {
      at += 1;
    }
    while (
      stored + 1 < observations.length &&
      compareYMD(observations[stored + 1].date, day) < 0
    ) {
      stored += 1;
    }
    // Freshness is the stored series' (the lockout view only decides which
    // value is used): a day is stale when the latest stored observation before
    // it is more than INDEX_FRESH_DAYS older, a gap in the middle of the series
    // as much as the end of it (INV-BOND-002).
    const stale =
      stored >= 0 &&
      compareYMD(day, addDays(observations[stored].date, INDEX_FRESH_DAYS)) > 0;
    const index =
      lockoutNeedsCalendar || stale || at < 0 ? null : usable[at].value;
    rows.push({
      day,
      index,
      accrual: index === null ? null : dailyAccrual(series, index),
    });
  }
  series.tables.set(period.index, rows);
  return rows;
}

/** What a sum of days comes to and what could not be read. */
export interface DaySum {
  /** Per 100 of par; null when any day is unknown. */
  readonly total: ExactDecimal | null;
  /** True when a day not stored was filled with the assumed index. */
  readonly projected: boolean;
  /** The first day before the valuation day with no index: that observation is due and missing. */
  readonly dueUnknown: string | null;
  /** True when a day on or after the valuation day has no index and none is assumed. */
  readonly laterUnknown: boolean;
}

/**
 * The accruals of the days `from` (inclusive) to `to` (exclusive) of a period,
 * per 100 of par. A day on or after `asOf` that has no stored index takes the
 * assumed one, when there is one; a day before `asOf` never does.
 */
export function sumDays(
  series: FloatingSeries,
  period: SchedulePeriod,
  from: string,
  to: string,
  asOf: string,
): DaySum {
  const assumed =
    series.assumed === null ? null : dailyAccrual(series, series.assumed);
  let total = ExactDecimal.ZERO;
  let projected = false;
  let dueUnknown: string | null = null;
  let laterUnknown = false;
  let known = true;
  for (const row of tableOf(series, period)) {
    if (compareYMD(row.day, from) < 0) continue;
    if (compareYMD(row.day, to) >= 0) break;
    if (row.accrual !== null) {
      total = total.add(row.accrual);
    } else if (compareYMD(row.day, asOf) >= 0 && assumed !== null) {
      total = total.add(assumed);
      projected = true;
    } else {
      known = false;
      if (compareYMD(row.day, asOf) < 0) {
        if (dueUnknown === null) dueUnknown = row.day;
      } else {
        laterUnknown = true;
      }
    }
  }
  return {
    total: known ? total : null,
    projected: known && projected,
    dueUnknown,
    laterUnknown,
  };
}

/** A lot figure that may be unknown, with what the unknown part needed. */
export interface FloatAmount {
  readonly value: ExactDecimal | null;
  readonly projected: boolean;
  readonly dueUnknown: string | null;
  readonly laterUnknown: boolean;
}

/** What the floating figures of a lot read: its terms, its rate and its quantity. */
export interface FloatingLot {
  readonly terms: BondTerms;
  readonly series: FloatingSeries;
  readonly quantity: ExactDecimal;
}

function amountOf(
  lot: FloatingLot,
  sum: DaySum,
  scale: ExactDecimal = lot.series.face.div(PAR),
): FloatAmount {
  return {
    value:
      sum.total === null
        ? null
        : roundLot(lot.terms, sum.total.mul(scale), lot.quantity),
    projected: sum.projected,
    dueUnknown: sum.dueUnknown,
    laterUnknown: sum.laterUnknown,
  };
}

/** The lot's coupon of a period: the sum of all its days' accruals on the face value, rounded on the holding. */
export function couponLotOf(
  lot: FloatingLot,
  period: SchedulePeriod,
  asOf: string,
): FloatAmount {
  return amountOf(
    lot,
    sumDays(lot.series, period, period.start, period.end, asOf),
  );
}

/** The lot's accrued interest on `asOf` inside `period`: the days from its start to the day before `asOf`. */
export function accruedLotOn(
  lot: FloatingLot,
  period: SchedulePeriod,
  asOf: string,
): FloatAmount {
  return amountOf(lot, sumDays(lot.series, period, period.start, asOf, asOf));
}

/** The cash at maturity: the face value of the lot and the last coupon; null while the last coupon is unknown. */
export function maturityCashOf(
  lot: FloatingLot,
  last: SchedulePeriod,
  asOf: string,
): FloatAmount {
  const coupon = couponLotOf(lot, last, asOf);
  return {
    ...coupon,
    value:
      coupon.value === null
        ? null
        : coupon.value.add(roundLot(lot.terms, lot.series.face, lot.quantity)),
  };
}

/** The figures an open day shows for a floating lot, as the engine prints them. */
export interface FloatingDayFigures {
  readonly principal: string | null;
  readonly accrued: string | null;
  readonly gross: string | null;
  readonly grossLot: ExactDecimal | null;
  /** The first day of the period with no stored index, when the accrued interest could not be worked out. */
  readonly dueUnknown: string | null;
}

/**
 * An open day: the face value plus the interest accrued since the period
 * start, each rounded once on the holding. The principal is known whatever the
 * index; the accrued interest and the value are null while a day of the period
 * before `asOf` has no stored index.
 */
export function floatingDayFigures(
  lot: FloatingLot,
  current: SchedulePeriod,
  asOf: string,
  places: number,
): FloatingDayFigures {
  const { terms, series, quantity } = lot;
  const principal = unitText(terms, series.face);
  const accrued = accruedLotOn(lot, current, asOf);
  if (accrued.value === null) {
    return {
      principal,
      accrued: null,
      gross: null,
      grossLot: null,
      dueUnknown: accrued.dueUnknown,
    };
  }
  const grossLot = roundLot(terms, series.face, quantity).add(accrued.value);
  return {
    principal,
    accrued: accrued.value.toFixed(places),
    gross: grossLot.toFixed(places),
    grossLot,
    dueUnknown: null,
  };
}

const TEXT_PLACES = 12;
const fraction = (value: ExactDecimal) => value.toTrimmedString(TEXT_PLACES, 4);

/**
 * The rate schedule of the lot's periods: no annual rate, the days' rates in runs
 * of equal index (`dailyRates`), and the period's interest per bond split into
 * the index part and the spread part (the rounding residual and a negative
 * spread go to the spread part, so the two add up to the interest). The
 * interest is null while a day has no index and none is assumed.
 */
export function floatingEntries(
  lot: FloatingLot,
  schedule: readonly SchedulePeriod[],
  asOf: string,
): RateScheduleEntry[] {
  const { series } = lot;
  const unit = series.face.div(PAR);
  const zero = ExactDecimal.ZERO.toFixed(10);
  return schedule.map((period): RateScheduleEntry => {
    const sum = sumDays(series, period, period.start, period.end, asOf);
    const assumed =
      series.assumed === null ? null : dailyAccrual(series, series.assumed);
    const runs: DailyRateRun[] = [];
    let benchmark = ExactDecimal.ZERO;
    for (const row of tableOf(series, period)) {
      const projected = row.index === null;
      const index =
        row.index ??
        (compareYMD(row.day, asOf) >= 0 && series.assumed !== null
          ? series.assumed
          : null);
      if (index === null) continue;
      const accrual = row.accrual ?? assumed;
      if (accrual === null) continue;
      benchmark = benchmark.add(
        ExactDecimal.max(index, series.floor)
          .mul(PAR)
          .div(DAY_COUNT)
          .round(series.rule.dailyDecimals, series.mode),
      );
      const previous = runs[runs.length - 1];
      const next = addDays(row.day, 1);
      if (
        previous !== undefined &&
        previous.to === row.day &&
        previous.index === fraction(index) &&
        previous.projected === projected
      ) {
        runs[runs.length - 1] = { ...previous, to: next };
      } else {
        runs.push({
          from: row.day,
          to: next,
          index: fraction(index),
          rate: fraction(
            ExactDecimal.max(index.add(series.spread), series.floor),
          ),
          dailyAccrual: accrual.toFixed(series.rule.dailyDecimals),
          projected,
        });
      }
    }
    const interest = sum.total === null ? null : sum.total.mul(unit);
    const benchmarkPart = benchmark.mul(unit);
    return {
      index: period.index,
      start: period.start,
      end: period.end,
      annualRate: null,
      rateSource:
        sum.total === null ? null : sum.projected ? "PROJECTED" : "DERIVED",
      benchmark: null,
      addend: series.spread.toTrimmedString(10, 4),
      interest: interest === null ? null : interest.toFixed(10),
      fixedPart: interest === null ? null : zero,
      benchmarkPart: interest === null ? null : benchmarkPart.toFixed(10),
      addendPart:
        interest === null ? null : interest.sub(benchmarkPart).toFixed(10),
      announcedPart: interest === null ? null : zero,
      dailyRates: runs,
    };
  });
}
