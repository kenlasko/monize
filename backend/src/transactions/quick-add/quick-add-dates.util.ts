/**
 * Dates the Quick Add reader understands beyond a complete date
 * (`docs/future-plans/quick-add.md`, "Reading the text", step 3): month and
 * weekday names and the yesterday / today / tomorrow words, all taken from
 * `Intl` in the reader's locale and in English, so every locale has them
 * without a catalog; and the rules that turn a day and month, or a weekday,
 * into a calendar date.
 */
import { addDaysYMD } from "../../common/date-utils";
import {
  buildIsoDate,
  resolveDatePattern,
} from "../transaction-search-parse.util";
import { foldForComparison, isCjkChar } from "./quick-add-text.util";

export type DateWordKind = "month" | "weekday" | "relative";

export interface DateWord {
  /** Folded in the reader's locale. */
  readonly folded: string;
  readonly kind: DateWordKind;
  /** Month 1-12, weekday 0 (Sunday) - 6, or a day offset from today. */
  readonly value: number;
}

/** A date written without a year is never taken to be more than this far ahead. */
export const DAY_MONTH_MAX_DAYS_AHEAD = 7;

const HAS_DIGIT = /\d/u;
/** A short name this brief (`Mo`, `月`) is too easily an ordinary word. */
const MIN_SHORT_LATIN = 3;
const MIN_SHORT_CJK = 2;

/** Weekday indexes of 17-23 November 2024, a Sunday-first week. */
const SUNDAY_2024 = Date.UTC(2024, 10, 17);
const DAY_MS = 86_400_000;

function intlParts(
  locale: string,
  options: Intl.DateTimeFormatOptions,
  date: number,
  type: Intl.DateTimeFormatPartTypes,
): string | null {
  try {
    const formatter = new Intl.DateTimeFormat(locale, {
      ...options,
      timeZone: "UTC",
    });
    return (
      formatter.formatToParts(new Date(date)).find((p) => p.type === type)
        ?.value ?? null
    );
  } catch {
    return null;
  }
}

function longEnough(folded: string, short: boolean): boolean {
  if (!short) return folded.length > 0;
  const cjk = [...folded].some((ch) => isCjkChar(ch));
  return [...folded].length >= (cjk ? MIN_SHORT_CJK : MIN_SHORT_LATIN);
}

function nameWords(
  names: Array<{ raw: string | null; short: boolean }>,
  kind: DateWordKind,
  value: number,
  foldLocale: string,
  allowDigits: boolean,
): DateWord[] {
  return names.flatMap(({ raw, short }) => {
    if (!raw) return [];
    const folded = foldForComparison(raw, foldLocale).replace(/\.+$/u, "");
    if (!allowDigits && HAS_DIGIT.test(folded)) return [];
    if (!longEnough(folded, short)) return [];
    return [{ folded, kind, value }];
  });
}

function monthWords(locale: string, foldLocale: string): DateWord[] {
  return Array.from({ length: 12 }, (_unused, index) => {
    const date = Date.UTC(2024, index, 15);
    const names = [
      {
        raw: intlParts(locale, { month: "long" }, date, "month"),
        short: false,
      },
      {
        raw: intlParts(locale, { month: "short" }, date, "month"),
        short: true,
      },
      // The form a day number takes beside it: Russian `ноября`, Polish
      // `listopada`, where the standalone name is `ноябрь`, `listopad`.
      {
        raw: intlParts(
          locale,
          { day: "numeric", month: "long" },
          date,
          "month",
        ),
        short: false,
      },
      {
        raw: intlParts(
          locale,
          { day: "numeric", month: "short" },
          date,
          "month",
        ),
        short: true,
      },
    ];
    // A name holding a digit (`11月`, `Tháng 11`) is read by the numeric
    // patterns instead, never as a word.
    return nameWords(names, "month", index + 1, foldLocale, false);
  }).flat();
}

function weekdayWords(locale: string, foldLocale: string): DateWord[] {
  return Array.from({ length: 7 }, (_unused, index) => {
    const date = SUNDAY_2024 + index * DAY_MS;
    const names = [
      {
        raw: intlParts(locale, { weekday: "long" }, date, "weekday"),
        short: false,
      },
      {
        raw: intlParts(locale, { weekday: "short" }, date, "weekday"),
        short: true,
      },
    ];
    return nameWords(names, "weekday", index, foldLocale, true);
  }).flat();
}

function relativeWords(locale: string, foldLocale: string): DateWord[] {
  let format: Intl.RelativeTimeFormat;
  try {
    format = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
  } catch {
    return [];
  }
  // Yesterday first: Hindi `कल` is both yesterday and tomorrow, and an entry
  // being recorded is far more often one already made.
  return [-1, 0, 1].flatMap((offset) => {
    const folded = foldForComparison(format.format(offset, "day"), foldLocale);
    return folded === "" || HAS_DIGIT.test(folded)
      ? []
      : [{ folded, kind: "relative" as const, value: offset }];
  });
}

const DATE_WORDS_BY_LOCALE = new Map<string, readonly DateWord[]>();

/**
 * The month, weekday and relative words for a reader in `locale`: theirs
 * first, then English's, folded in `locale`. A word two entries share keeps
 * the first (so `कल` reads yesterday). Memoized per locale: it is a pure
 * function of `Intl` data.
 */
export function dateWordsFor(locale: string): readonly DateWord[] {
  const cached = DATE_WORDS_BY_LOCALE.get(locale);
  if (cached) return cached;
  const locales = locale === "en" ? ["en"] : [locale, "en"];
  const all = locales.flatMap((l) => [
    ...relativeWords(l, locale),
    ...monthWords(l, locale),
    ...weekdayWords(l, locale),
  ]);
  const seen = new Set<string>();
  const words = all.filter((word) => {
    const key = `${word.kind}:${word.folded}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  DATE_WORDS_BY_LOCALE.set(locale, words);
  return words;
}

/**
 * The date a day and month written without a year mean: this year's, unless
 * that is more than {@link DAY_MONTH_MAX_DAYS_AHEAD} days after `today`, when
 * it is last year's (`3 dec` typed on 20 November is last December). A day
 * the year does not have (29 February) reads last year's when that has it.
 */
export function resolveDayMonth(
  today: string,
  month: number,
  day: number,
  year?: number,
): string | null {
  if (year !== undefined) {
    return buildIsoDate(String(year), String(month), String(day));
  }
  const thisYear = Number(today.slice(0, 4));
  const current = buildIsoDate(String(thisYear), String(month), String(day));
  if (current && current <= addDaysYMD(today, DAY_MONTH_MAX_DAYS_AHEAD)) {
    return current;
  }
  return buildIsoDate(String(thisYear - 1), String(month), String(day));
}

/** The most recent `weekday` (0 = Sunday) on or before `today`, today included. */
export function mostRecentWeekday(today: string, weekday: number): string {
  const [y, m, d] = today.split("-").map(Number);
  const todayWeekday = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return addDaysYMD(today, -((todayWeekday - weekday + 7) % 7));
}

export interface DayMonthOrder {
  /** The one character the reader's format puts between day and month. */
  readonly separator: string;
  readonly dayFirst: boolean;
}

/**
 * The order and separator of the day and month in the reader's `dateFormat`
 * (the locale's own for "browser"), for reading `3/11`. Null when the format
 * does not put a numeric day and month next to each other with one
 * separator between them.
 */
export function dayMonthOrder(
  dateFormat: string,
  numberFormat: string,
): DayMonthOrder | null {
  const pattern = resolveDatePattern(dateFormat, numberFormat);
  if (pattern.includes("MMM")) return null;
  const day = pattern.indexOf("DD");
  const month = pattern.indexOf("MM");
  if (day === -1 || month === -1) return null;
  const dayFirst = day < month;
  const between = dayFirst
    ? pattern.slice(day + 2, month)
    : pattern.slice(month + 2, day);
  return between.length === 1 ? { separator: between, dayFirst } : null;
}
