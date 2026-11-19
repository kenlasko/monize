import { createHash } from "crypto";
import {
  addDaysYMD,
  formatMonthKey,
  getMonthEndYMD,
} from "../../common/date-utils";
import { TRIVIA_WINDOWS, type TriviaWindow } from "./trivia.types";
import type { TriviaFamily } from "./trivia-families";

const DAY_MS = 86_400_000;
/** A year-to-date window opens this day of January or later. */
const YTD_FIRST_DAY = 8;

/**
 * A deterministic unsigned 32-bit hash: the first 4 bytes of a SHA-256 of the
 * parts. Nothing in the trivia selection is random.
 */
export function seedHash(...parts: string[]): number {
  return createHash("sha256")
    .update(parts.join("\u001f"))
    .digest()
    .readUInt32BE(0);
}

/** Whole days since 1970-01-01 of a calendar date. */
export function dayIndex(today: string): number {
  const [y, m, d] = today.split("-").map(Number);
  return Math.floor(Date.UTC(y, m - 1, d) / DAY_MS);
}

export function weekIndex(today: string): number {
  return Math.floor(dayIndex(today) / 7);
}

/** The last complete day: daily-moving facts end here, never at `today`. */
export function asOfDay(today: string): string {
  return addDaysYMD(today, -1);
}

/** The window the spending and income facts describe, in whole months. */
export const TRIVIA_WINDOW_MONTHS = 12;

/**
 * The last `TRIVIA_WINDOW_MONTHS` whole months before `today`'s, so the
 * figures never move with the day of the month a reader happens to look.
 */
export function triviaWindow(today: string): {
  startDate: string;
  endDate: string;
} {
  const [year, month] = today.split("-").map(Number);
  // `month - 1` is the last whole month; Date arithmetic would bring a zone.
  const endIndex = year * 12 + (month - 1) - 1;
  const startIndex = endIndex - (TRIVIA_WINDOW_MONTHS - 1);
  const yearOf = (index: number) => Math.floor(index / 12);
  const monthOf = (index: number) => (index % 12) + 1;
  return {
    startDate: `${formatMonthKey(yearOf(startIndex), monthOf(startIndex))}-01`,
    endDate: getMonthEndYMD(yearOf(endIndex), monthOf(endIndex)),
  };
}

/** A window's dates; `startDate` is `undefined` for all time. */
export function windowRange(
  window: TriviaWindow,
  today: string,
): { startDate: string | undefined; endDate: string } {
  const asOf = asOfDay(today);
  switch (window) {
    case "d30":
      return { startDate: addDaysYMD(asOf, -29), endDate: asOf };
    case "d90":
      return { startDate: addDaysYMD(asOf, -89), endDate: asOf };
    case "ytd":
      return { startDate: `${today.slice(0, 4)}-01-01`, endDate: asOf };
    case "m12":
      return triviaWindow(today);
    case "all":
      return { startDate: undefined, endDate: asOf };
  }
}

/**
 * The window a family describes this week. A year-to-date window a week old
 * says nothing, so early January falls back to the twelve whole months.
 */
export function pickWindow(
  userId: string,
  family: TriviaFamily,
  today: string,
): TriviaWindow {
  const picked =
    TRIVIA_WINDOWS[
      seedHash(userId, family, "window", String(weekIndex(today))) %
        TRIVIA_WINDOWS.length
    ];
  const earlyJanuary =
    today.slice(5, 7) === "01" && Number(today.slice(8, 10)) < YTD_FIRST_DAY;
  return picked === "ytd" && earlyJanuary ? "m12" : picked;
}

/** The rank, 2 or 3, a ranked family describes this week. */
export function pickRank(
  userId: string,
  family: TriviaFamily,
  today: string,
): 2 | 3 {
  return (2 +
    (seedHash(userId, family, "rank", String(weekIndex(today))) % 2)) as 2 | 3;
}
