import { BadRequestException } from "@nestjs/common";

import { tr } from "../i18n/translate";
import {
  parseSearchTerm,
  SearchTermPreferences,
} from "./transaction-search-parse.util";

/**
 * Reads the Transactions search string as a list of AND-ed terms.
 *
 * The grammar, the field list and the value rules are
 * `docs/specs/advanced-search.md` sections 4.1, 4.2 and 7; this file
 * is their one implementation. It is pure apart from the term-cap refusal:
 * no I/O, and no regular expression is built from the input.
 *
 * A term the parser cannot read is never a refusal. A qualifier whose value
 * does not parse becomes a bare term of its raw text marked `malformed`,
 * and an empty qualifier is kept for the echo but marked `empty` so the
 * builder skips it. The only refusals are the character cut (silent, as the
 * controller already does) and more than `MAX_SEARCH_TERMS` terms.
 */

export const MAX_SEARCH_LENGTH = 200;

/**
 * The syntax for a model: the `searchText` description of `list_transactions`
 * in both the assistant and the MCP server, written once so the two cannot
 * drift. Terse on purpose: it rides in the MCP `tools/list` byte budget and
 * the 300-character field cap (`tools-list-budget.spec.ts`), and the field
 * list is ordered so it never reads as the `sortBy` enum copied out.
 */
export const SEARCH_SYNTAX_SUMMARY =
  'Words ANDed; "phrase"; -x excludes; f:x contains, f:=x exact, * wildcard. ' +
  "f: payee memo account tag amount cat date status ref is has. " +
  "#10=ref:=10; amount:>5; date:2026-03";
export const MAX_SEARCH_TERMS = 12;

export type SearchField =
  | "payee"
  | "memo"
  | "cat"
  | "tag"
  | "account"
  | "ref"
  | "amount"
  | "date"
  | "status"
  | "is"
  | "has";

export type SearchOp =
  | "contains"
  | "exact"
  | "glob"
  | "eq"
  | "gt"
  | "gte"
  | "lt"
  | "lte"
  | "between";

export type SearchIgnoredReason = "malformed" | "empty";

export interface SearchTerm {
  /** `"any"` is a bare word or phrase, matched across every field. */
  field: SearchField | "any";
  op: SearchOp;
  /**
   * Unescaped. An amount is its magnitude as a plain decimal string, a date
   * is ISO `yyyy-MM-dd`, an enum value is lower-case.
   */
  value: string;
  /** `between` only: the inclusive upper bound. */
  valueTo?: string;
  negated: boolean;
  /** The term as typed, negation included, for the echo. */
  raw: string;
  ignored?: SearchIgnoredReason;
  /**
   * `any` terms only: the term read as an amount and as a date in the
   * user's formats, the interpretation a bare term has always carried.
   * Internal to the builder; never echoed.
   */
  interpreted?: { amount: number | null; date: string | null };
}

export interface ParsedSearch {
  terms: SearchTerm[];
}

export type SearchFormats = SearchTermPreferences;

/** Reserved field names, aliases included, keyed lower-case. */
const FIELD_NAMES: Readonly<Record<string, SearchField>> = {
  payee: "payee",
  memo: "memo",
  desc: "memo",
  cat: "cat",
  category: "cat",
  tag: "tag",
  account: "account",
  ref: "ref",
  amount: "amount",
  date: "date",
  status: "status",
  is: "is",
  has: "has",
};

const TEXT_FIELDS: ReadonlySet<SearchField> = new Set([
  "payee",
  "memo",
  "cat",
  "tag",
  "account",
  "ref",
]);

/** The accepted values of each enum field, lower-case. */
export const SEARCH_ENUM_VALUES: Readonly<
  Record<"status" | "is" | "has", readonly string[]>
> = {
  status: ["cleared", "reconciled", "unreconciled", "void"],
  is: ["transfer", "split", "uncategorized", "provisional"],
  has: ["attachment", "warranty", "ref", "memo", "tag"],
};

type Comparator = "gt" | "gte" | "lt" | "lte";

/** A term as the tokenizer saw it, before any field rule is applied. */
interface RawToken {
  raw: string;
  negated: boolean;
  /** Set when the term is `field:...` with a reserved field name. */
  field?: SearchField;
  /** `=` or a comparator written right after `field:`. */
  operator?: "=" | Comparator;
  /** Set when the term is `#value`. */
  hash?: boolean;
  value: string;
  /** The value was written in quotes. */
  quoted: boolean;
}

/**
 * Terms are separated by ASCII whitespace only. A no-break or narrow no-break
 * space is part of a term: it is the thousands separator several locales
 * format amounts with (fr-FR writes 1 234,56 with U+202F), so a pasted figure
 * stays one term and reads as one amount, as it did before the syntax.
 */
const TERM_SEPARATORS = new Set([" ", "\t", "\n", "\r", "\f", "\v"]);

function isWhitespace(ch: string): boolean {
  return TERM_SEPARATORS.has(ch);
}

function isLetter(ch: string): boolean {
  return /\p{L}/u.test(ch);
}

/**
 * Reads a quoted value starting just after its opening quote. `\"` and `\\`
 * are escapes; any other backslash is literal. An unterminated quote runs to
 * the end of the input.
 */
function readQuoted(
  input: string,
  start: number,
): { value: string; end: number } {
  let value = "";
  let i = start;
  while (i < input.length) {
    const ch = input[i];
    if (ch === "\\" && (input[i + 1] === '"' || input[i + 1] === "\\")) {
      value += input[i + 1];
      i += 2;
      continue;
    }
    if (ch === '"') return { value, end: i + 1 };
    value += ch;
    i += 1;
  }
  return { value, end: i };
}

/** Reads a run of non-whitespace characters. */
function readWord(
  input: string,
  start: number,
): { value: string; end: number } {
  let i = start;
  while (i < input.length && !isWhitespace(input[i])) i += 1;
  return { value: input.slice(start, i), end: i };
}

/** Reads a value (quoted or a word) at `start`. */
function readValue(
  input: string,
  start: number,
): { value: string; end: number; quoted: boolean } {
  if (input[start] === '"') {
    return { ...readQuoted(input, start + 1), quoted: true };
  }
  return { ...readWord(input, start), quoted: false };
}

/**
 * Matches `field:` with a reserved field name at `start`, returning the field
 * and the index just after the colon.
 */
function readFieldPrefix(
  input: string,
  start: number,
): { field: SearchField; end: number } | null {
  let i = start;
  while (i < input.length && /[A-Za-z]/.test(input[i])) i += 1;
  if (i === start || input[i] !== ":") return null;
  // An own-property lookup: `constructor:` must not resolve through the
  // prototype of a plain object and be read as a field.
  const name = input.slice(start, i).toLowerCase();
  const field = Object.prototype.hasOwnProperty.call(FIELD_NAMES, name)
    ? FIELD_NAMES[name]
    : undefined;
  return field ? { field, end: i + 1 } : null;
}

function readOperator(
  input: string,
  start: number,
): { operator?: "=" | Comparator; end: number } {
  const two = input.slice(start, start + 2);
  if (two === ">=") return { operator: "gte", end: start + 2 };
  if (two === "<=") return { operator: "lte", end: start + 2 };
  const one = input[start];
  if (one === ">") return { operator: "gt", end: start + 1 };
  if (one === "<") return { operator: "lt", end: start + 1 };
  if (one === "=") return { operator: "=", end: start + 1 };
  return { end: start };
}

/** Splits the input into raw terms (plan section 4.1). */
function tokenize(input: string): RawToken[] {
  const tokens: RawToken[] = [];
  let i = 0;
  while (i < input.length) {
    if (isWhitespace(input[i])) {
      i += 1;
      continue;
    }
    const start = i;

    // "-" negates only before a letter, a quote or "#"; before a digit, "."
    // or "," it is the sign of a number word, so "-10" still searches 10.
    let negated = false;
    const next = input[i + 1];
    if (
      input[i] === "-" &&
      next !== undefined &&
      (next === '"' || next === "#" || isLetter(next))
    ) {
      negated = true;
      i += 1;
    }

    let token: Omit<RawToken, "raw" | "negated">;
    let end: number;

    const fieldPrefix = readFieldPrefix(input, i);
    if (input[i] === '"') {
      const read = readQuoted(input, i + 1);
      token = { value: read.value, quoted: true };
      end = read.end;
    } else if (fieldPrefix) {
      const op = readOperator(input, fieldPrefix.end);
      const read = readValue(input, op.end);
      token = {
        field: fieldPrefix.field,
        operator: op.operator,
        value: read.value,
        quoted: read.quoted,
      };
      end = read.end;
    } else if (
      input[i] === "#" &&
      i + 1 < input.length &&
      !isWhitespace(input[i + 1])
    ) {
      const read = readValue(input, i + 1);
      token = { hash: true, value: read.value, quoted: read.quoted };
      end = read.end;
    } else {
      const read = readWord(input, i);
      token = { value: read.value, quoted: false };
      end = read.end;
    }

    tokens.push({ ...token, raw: input.slice(start, end), negated });
    i = end;
  }
  return tokens;
}

function anyTerm(
  value: string,
  raw: string,
  negated: boolean,
  formats: SearchFormats,
  ignored?: SearchIgnoredReason,
): SearchTerm {
  const term: SearchTerm = {
    field: "any",
    op: "contains",
    value,
    negated,
    raw,
    interpreted: parseSearchTerm(value, formats),
  };
  if (ignored) term.ignored = ignored;
  if (value.trim() === "") term.ignored = "empty";
  return term;
}

/** A qualifier that could not be read: its raw text, matched as a bare term. */
function malformed(token: RawToken, formats: SearchFormats): SearchTerm {
  const text = token.negated ? token.raw.slice(1) : token.raw;
  return anyTerm(text, token.raw, token.negated, formats, "malformed");
}

function emptyTerm(token: RawToken, field: SearchField): SearchTerm {
  return {
    field,
    op: "contains",
    value: "",
    negated: token.negated,
    raw: token.raw,
    ignored: "empty",
  };
}

function textTerm(token: RawToken, field: SearchField): SearchTerm | null {
  if (token.operator && token.operator !== "=") return null;
  const value = token.value;
  const op: SearchOp = value.includes("*")
    ? "glob"
    : token.operator === "="
      ? "exact"
      : "contains";
  return { field, op, value, negated: token.negated, raw: token.raw };
}

function enumTerm(
  token: RawToken,
  field: "status" | "is" | "has",
): SearchTerm | null {
  if (token.operator && token.operator !== "=") return null;
  const value = token.value.trim().toLowerCase();
  if (!SEARCH_ENUM_VALUES[field].includes(value)) return null;
  return { field, op: "eq", value, negated: token.negated, raw: token.raw };
}

/** The magnitude of an amount in the user's number format, or null. */
function readAmount(text: string, formats: SearchFormats): number | null {
  const amount = parseSearchTerm(text, formats).amount;
  return amount === null ? null : Math.abs(amount);
}

/** Plan section 7: an ISO day, month or year, or the user's full date. */
function readDatePeriod(
  text: string,
  formats: SearchFormats,
): { start: string; end: string } | null {
  const trimmed = text.trim();
  const year = /^(\d{4})$/.exec(trimmed);
  if (year) {
    const y = Number(year[1]);
    if (y < 1) return null;
    return { start: `${year[1]}-01-01`, end: `${year[1]}-12-31` };
  }
  const month = /^(\d{4})-(\d{1,2})$/.exec(trimmed);
  if (month) {
    const y = Number(month[1]);
    const m = Number(month[2]);
    if (y < 1 || m < 1 || m > 12) return null;
    const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
    const mm = String(m).padStart(2, "0");
    return {
      start: `${month[1]}-${mm}-01`,
      end: `${month[1]}-${mm}-${String(lastDay).padStart(2, "0")}`,
    };
  }
  const day = parseSearchTerm(trimmed, formats).date;
  return day ? { start: day, end: day } : null;
}

/**
 * Splits `a..b` on the first `..`. Returns null when the value holds no
 * range marker.
 */
function splitRange(value: string): { from: string; to: string } | null {
  const idx = value.indexOf("..");
  if (idx === -1) return null;
  return { from: value.slice(0, idx).trim(), to: value.slice(idx + 2).trim() };
}

/**
 * Builds an amount or date term. `read` turns one written value into the
 * `[start, end]` it covers (a point for an amount or a full date, a period
 * for a partial date); `compare` orders two normalised values.
 */
function valueTerm(
  token: RawToken,
  field: "amount" | "date",
  read: (text: string) => { start: string; end: string } | null,
  compare: (a: string, b: string) => number,
): SearchTerm | null {
  const base = { field, negated: token.negated, raw: token.raw };
  const range = splitRange(token.value);

  if (range) {
    if (token.operator) return null;
    if (range.from === "" && range.to === "") return null;
    // An amount is a magnitude, so a range of two negatives written in
    // natural order (`-100..-50`) names its larger magnitude first.
    const bothNegative =
      field === "amount" &&
      range.from.startsWith("-") &&
      range.to.startsWith("-");
    const fromText = bothNegative ? range.to : range.from;
    const toText = bothNegative ? range.from : range.to;
    const from = fromText === "" ? null : read(fromText);
    const to = toText === "" ? null : read(toText);
    if ((fromText !== "" && !from) || (toText !== "" && !to)) return null;
    if (from && to) {
      if (compare(from.start, to.end) > 0) return null;
      return { ...base, op: "between", value: from.start, valueTo: to.end };
    }
    if (from) return { ...base, op: "gte", value: from.start };
    return { ...base, op: "lte", value: (to as { end: string }).end };
  }

  const period = read(token.value);
  if (!period) return null;
  switch (token.operator) {
    case "gt":
      return { ...base, op: "gt", value: period.end };
    case "gte":
      return { ...base, op: "gte", value: period.start };
    case "lt":
      return { ...base, op: "lt", value: period.start };
    case "lte":
      return { ...base, op: "lte", value: period.end };
    default:
      return period.start === period.end
        ? { ...base, op: "eq", value: period.start }
        : { ...base, op: "between", value: period.start, valueTo: period.end };
  }
}

function toTerm(token: RawToken, formats: SearchFormats): SearchTerm {
  if (token.hash) {
    if (token.value.trim() === "") return emptyTerm(token, "ref");
    return {
      field: "ref",
      op: token.value.includes("*") ? "glob" : "exact",
      value: token.value,
      negated: token.negated,
      raw: token.raw,
    };
  }

  const field = token.field;
  if (!field) return anyTerm(token.value, token.raw, token.negated, formats);
  if (token.value.trim() === "") return emptyTerm(token, field);

  let term: SearchTerm | null;
  if (TEXT_FIELDS.has(field)) {
    term = textTerm(token, field);
  } else if (field === "status" || field === "is" || field === "has") {
    term = enumTerm(token, field);
  } else if (field === "amount") {
    term = valueTerm(
      token,
      "amount",
      (text) => {
        const amount = readAmount(text, formats);
        if (amount === null) return null;
        const value = String(amount);
        return { start: value, end: value };
      },
      (a, b) => Number(a) - Number(b),
    );
  } else {
    term = valueTerm(
      token,
      "date",
      (text) => readDatePeriod(text, formats),
      // ISO dates order as plain strings.
      (a, b) => (a < b ? -1 : a > b ? 1 : 0),
    );
  }
  return term ?? malformed(token, formats);
}

/**
 * Parses the search string into AND-ed terms. A blank string yields no terms.
 * Throws a 400 when the string holds more than `MAX_SEARCH_TERMS` terms.
 */
export function parseTransactionSearch(
  raw: string,
  formats: SearchFormats = {},
): ParsedSearch {
  const input = (raw ?? "").slice(0, MAX_SEARCH_LENGTH);
  const tokens = tokenize(input);
  if (tokens.length > MAX_SEARCH_TERMS) {
    throw new BadRequestException(
      tr(
        "errors.transactions.searchTooManyTerms",
        `A search can hold at most ${MAX_SEARCH_TERMS} terms`,
        { max: MAX_SEARCH_TERMS },
      ),
    );
  }
  return { terms: tokens.map((token) => toTerm(token, formats)) };
}
