import { BenchmarkData } from "../domain/benchmark";
import { IndexRatioRule } from "../domain/principal-rule";
import { daysInMonth, monthKeyBefore, parseYMD } from "../domain/calendar-date";
import { ExactDecimal } from "../domain/exact-decimal";

/**
 * The index ratio of an `INDEX_RATIO` principal
 * (`docs/specs/bond-marketable-primitives.md` 7.1; 31 CFR 356 Appendix B I.B):
 * the reference index of a day by daily linear interpolation between the index
 * of the month `lagMonths` back and the next, and the ratio of that to the
 * reference index of the dated date, each truncated and then rounded.
 */

/** What an indexed principal reads, resolved once for a lot. */
export interface IndexSeries {
  readonly rule: IndexRatioRule;
  /** The stored monthly index levels by `YYYY-MM`; null when the benchmark is not stored (or not monthly). */
  readonly values: ReadonlyMap<string, string> | null;
  readonly publisher: string | null;
  /** The newest stored month, the base of a projection; null when none is stored. */
  readonly latest: {
    readonly key: string;
    readonly value: ExactDecimal;
  } | null;
  /** The assumed annual inflation as a fraction, supplied by the caller; null when none. */
  readonly annualInflation: ExactDecimal | null;
}

/** A series and the day the figures are valued on: a month not stored is projected only after that day. */
export interface IndexLookup {
  readonly series: IndexSeries;
  readonly asOf: string;
}

export interface IndexFigure {
  /** The reference index of the day, rounded; null when unknown. */
  readonly refIndex: ExactDecimal | null;
  /** The index ratio of the day; null when unknown. */
  readonly ratio: ExactDecimal | null;
  /** True when a month the figure reads is projected, not stored. */
  readonly projected: boolean;
  /** The `YYYY-MM` months the figure reads that are not stored (empty when every one is stored). */
  readonly absent: readonly string[];
}

const MONTHS_PER_YEAR = ExactDecimal.fromInt(12);

function monthsOf(key: string): number {
  const { year, month } = parseYMD(`${key}-01`);
  return year * 12 + month;
}

/** Reads the stored months of a benchmark as an index series for `rule`; the projection is `annualInflation`, when supplied. */
export function indexSeriesOf(
  rule: IndexRatioRule,
  data: BenchmarkData | undefined,
  annualInflation: ExactDecimal | null,
): IndexSeries {
  const values =
    data !== undefined && data.kind === "MONTHLY" ? data.values : null;
  let latest: IndexSeries["latest"] = null;
  if (values !== null) {
    for (const [key, value] of values) {
      if (latest === null || key > latest.key) {
        latest = { key, value: ExactDecimal.parse(value) };
      }
    }
  }
  return {
    rule,
    values,
    publisher: data === undefined ? null : data.publisher,
    latest,
    annualInflation,
  };
}

/**
 * The index level of one month: the stored one, or, when the figure is after the
 * valuation day and an annual inflation is assumed, the newest stored level grown
 * by `annualInflation x months / 12` (a stated assumption, not the issuer's rule;
 * a month before the newest stored one is never projected).
 */
function monthLevel(
  series: IndexSeries,
  key: string,
  projectable: boolean,
): { value: ExactDecimal; projected: boolean } | null {
  const stored = series.values?.get(key);
  if (stored !== undefined) {
    return { value: ExactDecimal.parse(stored), projected: false };
  }
  const { latest, annualInflation } = series;
  if (
    !projectable ||
    latest === null ||
    annualInflation === null ||
    key <= latest.key
  ) {
    return null;
  }
  const months = ExactDecimal.fromInt(monthsOf(key) - monthsOf(latest.key));
  const growth = ExactDecimal.ONE.add(
    annualInflation.mul(months).div(MONTHS_PER_YEAR),
  );
  return { value: latest.value.mul(growth), projected: true };
}

/** Truncated to `truncateDecimals`, then rounded half up to `roundDecimals` (Appendix B I.B.3). */
function cut(rule: IndexRatioRule, value: ExactDecimal): ExactDecimal {
  return value
    .round(rule.truncateDecimals, "DOWN")
    .round(rule.roundDecimals, "HALF_UP");
}

/**
 * The reference index and the index ratio of `date`, valued on `asOf`. Day `t` of
 * a month of `D` days reads the level `I0` of the month `lagMonths` back and the
 * next month's `I1`: `I0 + (t - 1) / D x (I1 - I0)`; the first of a month is `I0`
 * alone. A level that is not stored makes the figure unknown (never an older
 * level carried on) unless it is projected; `absent` names each such month.
 */
export function indexFigureOn(lookup: IndexLookup, date: string): IndexFigure {
  const { series, asOf } = lookup;
  const { rule } = series;
  const projectable = date > asOf;
  const { year, month, day } = parseYMD(date);
  const keys = [monthKeyBefore(date, rule.lagMonths)];
  if (day !== 1) keys.push(monthKeyBefore(date, rule.lagMonths - 1));
  const levels = keys.map((key) => monthLevel(series, key, projectable));
  const absent = keys.filter((_, i) => levels[i] === null);
  const [first, second] = levels;
  if (first === null || second === null) {
    return { refIndex: null, ratio: null, projected: false, absent };
  }
  const interpolated =
    second === undefined
      ? first.value
      : first.value.add(
          ExactDecimal.ratio(day - 1, daysInMonth(year, month)).mul(
            second.value.sub(first.value),
          ),
        );
  const refIndex = cut(rule, interpolated);
  return {
    refIndex,
    ratio: cut(rule, refIndex.div(ExactDecimal.parse(rule.baseReference))),
    projected: levels.some((level) => level !== null && level.projected),
    absent,
  };
}
