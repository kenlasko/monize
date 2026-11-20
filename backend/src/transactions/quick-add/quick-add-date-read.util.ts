/**
 * Step 3 of the Quick Add reader (`docs/future-plans/quick-add.md`): the date,
 * in this order of preference.
 *
 * 1. A complete date: ISO `YYYY-MM-DD`, or one in the reader's `dateFormat`,
 *    through the parser the transaction search uses.
 * 2. A Han or Hangul date (`11月3日`, `11월 3일`), with or without its year.
 * 3. A day and a month name (`3 nov`, `nov 3`, `3. November`, `3 de nov`).
 * 4. A day and month in the `dateFormat`'s order and separator (`3/11`).
 * 5. A weekday name (the most recent one on or before today) or the
 *    yesterday / today / tomorrow word.
 *
 * A date without a year follows `resolveDayMonth`'s rule.
 */
import { parseDate } from "../transaction-search-parse.util";
import { addDaysYMD } from "../../common/date-utils";
import {
  DateWord,
  dateWordsFor,
  dayMonthOrder,
  mostRecentWeekday,
  resolveDayMonth,
} from "./quick-add-dates.util";
import {
  FreeToken,
  QuickAddText,
  UnitSpan,
  findPhrase,
  freeTokens,
  selectLongest,
  separatedBySpace,
} from "./quick-add-text.util";

export interface DateContext {
  readonly today: string;
  readonly locale: string;
  readonly numberFormat: string;
  readonly dateFormat: string;
}

export interface DateRead {
  readonly date: string;
  readonly spans: readonly UnitSpan[];
}

const TRAILING_SEPARATORS = /[,;]+$/u;
const DAY_BEFORE_MONTH = /^(\d{1,2})(?:\.|st|nd|rd|th|er|e|º|ª)?$/u;
const DAY_AFTER_MONTH = /^(\d{1,2})(?:st|nd|rd|th)?[.,]?$/u;
const YEAR = /^(\d{4})[.,]?$/u;
const CJK_DATE =
  /(?<!\d)(?:(\d{4})\s?[年년]\s?)?(\d{1,2})\s?[月월]\s?(\d{1,2})\s?[日号號일]?/u;
/** The word Spanish and Portuguese put between a day and its month. */
const DAY_MONTH_JOINER = "de";

function absoluteDate(
  tokens: readonly FreeToken[],
  ctx: DateContext,
): DateRead | null {
  for (const token of tokens) {
    const core = token.text.replace(TRAILING_SEPARATORS, "");
    const date = parseDate(core, ctx.dateFormat, ctx.numberFormat);
    if (date) return { date, spans: [token] };
  }
  return null;
}

/** Maximal runs of free units, spaces included, as text with unit offsets. */
function freeRuns(
  text: QuickAddText,
  used: readonly boolean[],
): Array<{ start: number; end: number }> {
  const runs: Array<{ start: number; end: number }> = [];
  let start = -1;
  for (let i = 0; i <= text.units.length; i++) {
    const free = i < text.units.length && !used[i];
    if (free && start === -1) start = i;
    if (!free && start !== -1) {
      runs.push({ start, end: i });
      start = -1;
    }
  }
  return runs;
}

function cjkDate(
  text: QuickAddText,
  used: readonly boolean[],
  ctx: DateContext,
): DateRead | null {
  for (const run of freeRuns(text, used)) {
    const units = text.units.slice(run.start, run.end);
    const value = units.map((u) => u.text).join("");
    const match = CJK_DATE.exec(value);
    if (!match) continue;
    const [, year, month, day] = match;
    const date = resolveDayMonth(
      ctx.today,
      Number(month),
      Number(day),
      year ? Number(year) : undefined,
    );
    if (!date) continue;
    // Code-unit offsets back to units.
    let offset = 0;
    let start = run.end;
    let end = run.start;
    for (const [i, unit] of units.entries()) {
      if (offset >= match.index && offset < match.index + match[0].length) {
        start = Math.min(start, run.start + i);
        end = Math.max(end, run.start + i + 1);
      }
      offset += unit.text.length;
    }
    return { date, spans: [{ start, end }] };
  }
  return null;
}

function tokenBefore(
  text: QuickAddText,
  tokens: readonly FreeToken[],
  span: UnitSpan,
): FreeToken | null {
  return (
    tokens.find(
      (t) => t.end <= span.start && separatedBySpace(text, t, span),
    ) ?? null
  );
}

function tokenAfter(
  text: QuickAddText,
  tokens: readonly FreeToken[],
  span: UnitSpan,
): FreeToken | null {
  return (
    tokens.find(
      (t) => t.start >= span.end && separatedBySpace(text, span, t),
    ) ?? null
  );
}

/** The typed text of `token` after `inner`. */
function spanRest(
  text: QuickAddText,
  token: UnitSpan,
  inner: UnitSpan,
): string {
  return text.units
    .slice(inner.end, token.end)
    .map((unit) => unit.text)
    .join("");
}

/** `3 nov`, `nov 3`, `3 de nov`, each with an optional year after it. */
function monthNameDate(
  text: QuickAddText,
  used: readonly boolean[],
  tokens: readonly FreeToken[],
  months: readonly DateWord[],
  ctx: DateContext,
): DateRead | null {
  const found = months.flatMap((word) =>
    findPhrase(text, word.folded, used).map((span) => ({ span, word })),
  );
  const groups = selectLongest(found, used).sort(
    (a, b) => a.span.start - b.span.start,
  );
  for (const { span: nameSpan, items } of groups) {
    const month = items[0].word.value;
    // The name's own token, which may carry an abbreviation's period (`nov.`).
    const span = tokens.find(
      (t) => t.start === nameSpan.start && t.end >= nameSpan.end,
    );
    if (!span || !/^[.,]*$/u.test(spanRest(text, span, nameSpan))) continue;
    let before = tokenBefore(text, tokens, span);
    const joiner =
      before && before.text.toLowerCase() === DAY_MONTH_JOINER ? before : null;
    if (joiner) before = tokenBefore(text, tokens, joiner);
    const after = tokenAfter(text, tokens, span);
    const dayBefore = before ? DAY_BEFORE_MONTH.exec(before.text) : null;
    const dayAfter =
      !dayBefore && after ? DAY_AFTER_MONTH.exec(after.text) : null;
    const dayToken = dayBefore ? before : dayAfter ? after : null;
    const day = dayBefore?.[1] ?? dayAfter?.[1];
    if (!dayToken || !day) continue;
    const last = dayToken.start > span.start ? dayToken : span;
    const yearToken = tokenAfter(text, tokens, last);
    const year = yearToken ? YEAR.exec(yearToken.text) : null;
    const date = resolveDayMonth(
      ctx.today,
      month,
      Number(day),
      year ? Number(year[1]) : undefined,
    );
    if (!date) continue;
    const spans: UnitSpan[] = [span, dayToken];
    if (joiner) spans.push(joiner);
    if (year && yearToken) spans.push(yearToken);
    return { date, spans };
  }
  return null;
}

/** `3/11` in the order and with the separator of the reader's date format. */
function numericDayMonth(
  tokens: readonly FreeToken[],
  ctx: DateContext,
): DateRead | null {
  const order = dayMonthOrder(ctx.dateFormat, ctx.numberFormat);
  if (!order) return null;
  for (const token of tokens) {
    const parts = token.text.replace(/\.$/u, "").split(order.separator);
    if (parts.length !== 2 || !parts.every((p) => /^\d{1,2}$/u.test(p))) {
      continue;
    }
    const [first, second] = parts.map(Number);
    const date = order.dayFirst
      ? resolveDayMonth(ctx.today, second, first)
      : resolveDayMonth(ctx.today, first, second);
    if (date) return { date, spans: [token] };
  }
  return null;
}

function wordDate(
  text: QuickAddText,
  used: readonly boolean[],
  words: readonly DateWord[],
  ctx: DateContext,
): DateRead | null {
  const found = words.flatMap((word) =>
    findPhrase(text, word.folded, used).map((span) => ({ span, word })),
  );
  const first = selectLongest(found, used).sort(
    (a, b) => a.span.start - b.span.start,
  )[0];
  if (!first) return null;
  const { word } = first.items[0];
  const date =
    word.kind === "weekday"
      ? mostRecentWeekday(ctx.today, word.value)
      : addDaysYMD(ctx.today, word.value);
  return { date, spans: [first.span] };
}

export function readDate(
  text: QuickAddText,
  used: readonly boolean[],
  ctx: DateContext,
): DateRead | null {
  const tokens = freeTokens(text, used);
  const words = dateWordsFor(ctx.locale);
  return (
    absoluteDate(tokens, ctx) ??
    cjkDate(text, used, ctx) ??
    monthNameDate(
      text,
      used,
      tokens,
      words.filter((w) => w.kind === "month"),
      ctx,
    ) ??
    numericDayMonth(tokens, ctx) ??
    wordDate(
      text,
      used,
      words.filter((w) => w.kind !== "month"),
      ctx,
    )
  );
}
