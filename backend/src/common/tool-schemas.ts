import { z } from "zod";
import { addDaysYMD } from "./date-utils";

/**
 * Shared Zod primitives for tool inputs exposed to LLMs, used by both
 * the internal AI query engine (src/ai) and the MCP server (src/mcp).
 *
 * Keeping date and direction validation in one place prevents drift
 * between the two surfaces — the same normalization rules apply
 * regardless of which surface the model is talking to.
 */

/**
 * A number a model may have written as a string.
 *
 * `limit: "10"` is what an LLM emits often enough that rejecting it is a defect,
 * not strictness: the MCP SDK validated `list_payees` against a bare
 * `z.number()` and answered -32602 "expected number, received string" for a
 * perfectly clear request.
 *
 * It is deliberately NOT `z.coerce.number()`, which is `Number(value)` and so
 * reads `""`, `"   "`, `null` and `[]` as **0** -- an unknown arriving as a
 * measured zero, which on `minAmount` silently filters at zero and on an
 * `amount` would post a transaction for nothing. Only a non-empty numeric
 * string is converted; everything else is left for `z.number()` to refuse.
 *
 * Pass the bounds as the inner schema (`numberArg(z.number().int().min(1))`):
 * the constraints belong to the number, and the result serializes to exactly
 * the JSON Schema the bare form would, so tolerance costs no `tools/list` bytes.
 */
export const numberArg = (inner: z.ZodNumber = z.number()) =>
  z.preprocess(
    (value) =>
      typeof value === "string" && value.trim() !== "" ? Number(value) : value,
    inner,
  );

/**
 * A boolean a model may have written as a string.
 *
 * Same defect, same fix, and `z.coerce.boolean()` is likewise the wrong tool: it
 * is `Boolean(value)`, so it reads "false" as TRUE -- the one input a caller
 * most needs it to get right (`hasEmail: "false"` is how you ask which payees
 * are missing one). This maps the two literal strings and leaves everything else
 * to `z.boolean()`, so "yes" and 1 are still refused, and it serializes to a
 * plain `{"type": "boolean"}` where a union would emit an `anyOf`.
 */
export const booleanArg = () =>
  z.preprocess(
    (value) => (value === "true" ? true : value === "false" ? false : value),
    z.boolean(),
  );

/**
 * A bond series code (`EDO1036`) a model names on an investment row: trimmed,
 * never empty (an empty string would read as "no series named" and silently
 * fall back to inference), at most 40 characters. One schema for the assistant
 * and the MCP server.
 */
export const bondSeriesCodeSchema = z.string().trim().min(1).max(40);

const isoDateRegex = /^\d{4}-\d{2}-\d{2}$/;

export const isoDateSchema = z
  .string()
  .regex(isoDateRegex, "Expected YYYY-MM-DD");

/**
 * Direction normalization. The model often sends variants of the same
 * concept (e.g. "expense" vs "expenses", "all" vs "both"). Normalize
 * at the schema boundary so the tool executor always gets a canonical
 * value and the user doesn't see a failed tool call for a cosmetic
 * difference.
 */
function normalizeDirection(val: unknown, debit: "outgoing" | "expenses") {
  if (typeof val !== "string") return val;
  const normalized = val.toLowerCase().trim();
  const aliases: Record<string, string> = {
    expense: "expenses",
    expenditure: "expenses",
    expenditures: "expenses",
    spending: "expenses",
    out: debit,
    outgoing: debit,
    debit,
    debits: debit,
    earnings: "income",
    revenue: "income",
    in: "income",
    incoming: "income",
    credit: "income",
    credits: "income",
    all: "both",
    any: "both",
  };
  return aliases[normalized] ?? normalized;
}

export const listDirectionSchema = z.preprocess(
  (val) => normalizeDirection(val, "outgoing"),
  z.enum(["expenses", "outgoing", "income", "both"]),
);

export const directionSchema = z.preprocess(
  (val) => normalizeDirection(val, "expenses"),
  z.enum(["expenses", "income", "both"]),
);

/**
 * Coerce clean numeric strings ("5") to integers while letting other
 * strings fail validation with a clear error. The model sometimes
 * sends topN / limit as a string.
 */
export const positiveIntSchema = (min: number, max: number) =>
  z.preprocess(
    (val) =>
      typeof val === "string" && /^-?\d+$/.test(val) ? Number(val) : val,
    z.number().int().min(min).max(max),
  );

/**
 * Defaults applied when an LLM omits parameters that would otherwise be
 * required. Centralized here so the AI Assistant and the MCP server
 * fall back to the same values.
 */
export const DEFAULT_LOOKBACK_DAYS = 30;
export const DEFAULT_TOP_N = 10;

/**
 * Return a {startDate, endDate} pair covering the last `lookbackDays`
 * days (inclusive of today). Used when the model omits a date range.
 */
export function getDefaultDateRange(
  today: string,
  lookbackDays: number = DEFAULT_LOOKBACK_DAYS,
): { startDate: string; endDate: string } {
  return { startDate: addDaysYMD(today, -lookbackDays), endDate: today };
}

/** First day of the month `monthsBack` before the month of `today` (YYYY-MM-DD). */
function firstOfMonthBefore(today: string, monthsBack: number): string {
  const index = Number(today.slice(0, 4)) * 12 + Number(today.slice(5, 7)) - 1;
  const target = index - monthsBack;
  const y = Math.floor(target / 12);
  const m = (target % 12) + 1;
  return `${y}-${String(m).padStart(2, "0")}-01`;
}

export interface ComparePeriods {
  period1Start: string;
  period1End: string;
  period2Start: string;
  period2End: string;
}

/**
 * Return the four dates needed to compare the previous full month
 * against the current month-to-date. Used when the model omits any
 * period in compare_periods -- treated as all-or-nothing because
 * mixing user-supplied dates with computed ones would be surprising.
 */
export function getDefaultComparePeriods(today: string): ComparePeriods {
  const currentStart = firstOfMonthBefore(today, 0);
  return {
    period1Start: firstOfMonthBefore(today, 1),
    // The day before the current month starts = last day of the previous month
    period1End: addDaysYMD(currentStart, -1),
    period2Start: currentStart,
    period2End: today,
  };
}

/**
 * Resolve the four `compare_periods` dates from caller input. If any of the
 * four dates is missing, falls back to the all-or-nothing default
 * ({@link getDefaultComparePeriods}) -- mixing user-supplied dates with
 * computed ones would compare unrelated windows.
 *
 * Used by both the AI tool executor and the MCP tool adapter so the
 * surfaces stay in lockstep.
 */
export function resolveComparePeriods(
  input: {
    period1Start?: string | null;
    period1End?: string | null;
    period2Start?: string | null;
    period2End?: string | null;
  },
  today: string,
): ComparePeriods {
  const hasAllPeriods = Boolean(
    input.period1Start &&
    input.period1End &&
    input.period2Start &&
    input.period2End,
  );
  if (hasAllPeriods) {
    return {
      period1Start: input.period1Start as string,
      period1End: input.period1End as string,
      period2Start: input.period2Start as string,
      period2End: input.period2End as string,
    };
  }
  return getDefaultComparePeriods(today);
}

/**
 * Return the previous complete calendar month in YYYY-MM format.
 * Used as the default for the generate_report month_comparison type so
 * reports run against a month that has already closed.
 */
export function getDefaultPreviousMonth(today: string): string {
  return firstOfMonthBefore(today, 1).slice(0, 7);
}
