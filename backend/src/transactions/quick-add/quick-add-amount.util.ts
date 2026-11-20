/**
 * Step 4 of the Quick Add reader (`docs/future-plans/quick-add.md`): the first
 * remaining number is the amount, read by the search's locale-aware parser
 * under the reader's `numberFormat` (`12,50` is 12.5 for a German reader). A
 * leading `+` or `-` marks a deposit or a payment, and a currency written
 * next to it is reported for the interpretation to compare with the account.
 */
import { parseAmount } from "../transaction-search-parse.util";
import { capitalIsoCode, CurrencySpellings } from "./quick-add-currency.util";
import {
  FreeToken,
  QuickAddText,
  UnitSpan,
  foldForComparison,
  freeTokens,
  isCjkChar,
  separatedBySpace,
} from "./quick-add-text.util";

export interface TypedCurrency {
  /** As typed. */
  readonly text: string;
  /** Every currency the spelling may name. */
  readonly codes: readonly string[];
}

export interface TypedAmount {
  /** The magnitude, at the column scale. */
  readonly value: number;
  readonly sign: "+" | "-" | null;
  readonly currency: TypedCurrency | null;
}

export interface AmountContext {
  readonly locale: string;
  readonly numberFormat: string;
  readonly spellings: CurrencySpellings;
  /** Codes of the reader's accounts, which name a currency in any case. */
  readonly heldCodes: ReadonlySet<string>;
}

/** The first number of a token: digits with inner separators, or `.50`. */
const NUMBER = /[.,]?\d(?:[\d.,']*\d)?/u;
const SIGNS: Readonly<Record<string, "+" | "-">> = {
  "+": "+",
  "-": "-",
  "−": "-",
};
const TRAILING_PUNCTUATION = /^[.,;:!?)]*$/u;

function attachedAtEnd(
  folded: string,
  spellings: CurrencySpellings,
): readonly [string, readonly string[]] | null {
  return spellings.attached.find(([s]) => folded.endsWith(s)) ?? null;
}

function attachedAtStart(
  folded: string,
  spellings: CurrencySpellings,
): readonly [string, readonly string[]] | null {
  return spellings.attached.find(([s]) => folded.startsWith(s)) ?? null;
}

/** The currency a whole token standing beside the number names, if any. */
function separateCurrency(
  typed: string,
  ctx: AmountContext,
): TypedCurrency | null {
  const capital = capitalIsoCode(typed);
  if (capital) return { text: typed, codes: [capital] };
  const folded = foldForComparison(typed, ctx.locale);
  const codes = ctx.spellings.separate.get(folded);
  if (codes) return { text: typed, codes };
  const upper = typed.toUpperCase();
  return ctx.heldCodes.has(upper) ? { text: typed, codes: [upper] } : null;
}

interface TokenReading {
  readonly core: string;
  readonly sign: "+" | "-" | null;
  readonly currency: TypedCurrency | null;
  /** Code-unit offsets of the consumed part of the token's text. */
  readonly from: number;
  readonly to: number;
}

interface PrefixReading {
  /** What is left before the sign and currency. */
  readonly rest: string;
  readonly sign: "+" | "-" | null;
  readonly currency: TypedCurrency | null;
}

/** A sign at the end of `prefix`, taken off. */
function signAtEnd(prefix: string): { rest: string; sign: "+" | "-" | null } {
  const sign = SIGNS[prefix.slice(-1)] ?? null;
  return { rest: sign ? prefix.slice(0, -1) : prefix, sign };
}

/** `[sign][currency][sign]` at the end of what precedes the number. */
function readPrefix(prefix: string, ctx: AmountContext): PrefixReading {
  const first = signAtEnd(prefix);
  const found = attachedAtEnd(
    foldForComparison(first.rest, ctx.locale),
    ctx.spellings,
  );
  if (!found) return { ...first, currency: null };
  const typed = [...first.rest].slice(-[...found[0]].length).join("");
  const beforeCurrency = first.rest.slice(0, first.rest.length - typed.length);
  const second = first.sign
    ? { rest: beforeCurrency, sign: first.sign }
    : signAtEnd(beforeCurrency);
  return {
    rest: second.rest,
    sign: second.sign,
    currency: { text: typed, codes: found[1] },
  };
}

/** Reads one token as `[sign][currency][sign]number[currency]`, or null. */
function readToken(token: string, ctx: AmountContext): TokenReading | null {
  const match = NUMBER.exec(token);
  if (!match) return null;
  const prefix = readPrefix(token.slice(0, match.index), ctx);
  // Anything left before the number has to be Han, kana or Hangul text it is
  // written against (`で500円`); `7-Eleven` and `a4` are not amounts.
  if (prefix.rest !== "" && !isCjkChar([...prefix.rest].slice(-1)[0])) {
    return null;
  }

  const rawSuffix = token.slice(match.index + match[0].length);
  const after = prefix.currency
    ? null
    : attachedAtStart(foldForComparison(rawSuffix, ctx.locale), ctx.spellings);
  const suffixCurrency = after
    ? [...rawSuffix].slice(0, [...after[0]].length).join("")
    : "";
  const suffix = rawSuffix.slice(suffixCurrency.length);
  const trailing = TRAILING_PUNCTUATION.test(suffix);
  if (!trailing && !isCjkChar([...suffix][0])) return null;

  return {
    core: match[0],
    sign: prefix.sign,
    currency:
      prefix.currency ??
      (after ? { text: suffixCurrency, codes: after[1] } : null),
    from: prefix.rest.length,
    to: token.length - (trailing ? 0 : suffix.length),
  };
}

/** Units of `token` covering its text's code-unit offsets `[from, to)`. */
function unitSpanOf(
  text: QuickAddText,
  token: FreeToken,
  from: number,
  to: number,
): UnitSpan {
  let offset = 0;
  let start = token.end;
  let end = token.start;
  for (let unit = token.start; unit < token.end; unit++) {
    const length = text.units[unit].text.length;
    if (offset >= from && offset < to) {
      start = Math.min(start, unit);
      end = Math.max(end, unit + 1);
    }
    offset += length;
  }
  return { start, end };
}

function groupSeparatorIsSpace(numberFormat: string): boolean {
  try {
    const group = new Intl.NumberFormat(numberFormat)
      .formatToParts(12345.6)
      .find((part) => part.type === "group")?.value;
    return !!group && /\s/u.test(group);
  } catch {
    return false;
  }
}

export interface AmountRead {
  readonly amount: TypedAmount;
  /** The units the amount, its sign and its currency took. */
  readonly spans: readonly UnitSpan[];
}

/**
 * The first number among the free tokens, with any sign and currency next to
 * it, or null when the text holds none.
 */
export function readAmount(
  text: QuickAddText,
  used: readonly boolean[],
  ctx: AmountContext,
): AmountRead | null {
  const tokens = freeTokens(text, used);
  for (const [index, token] of tokens.entries()) {
    const reading = readToken(token.text, ctx);
    if (!reading) continue;
    const spans: UnitSpan[] = [
      unitSpanOf(text, token, reading.from, reading.to),
    ];
    let core = reading.core;
    let nextIndex = index + 1;
    // `1 234,50`: a locale that groups thousands with a space, typed with one.
    const next = tokens[nextIndex];
    if (
      next &&
      reading.to === token.text.length &&
      !reading.currency &&
      /^\d{1,3}$/u.test(core) &&
      /^\d{3}(?:[.,]\d+)?$/u.test(next.text) &&
      separatedBySpace(text, token, next) &&
      groupSeparatorIsSpace(ctx.numberFormat)
    ) {
      core = `${core} ${next.text}`;
      spans.push(next);
      nextIndex += 1;
    }
    const value = parseAmount(core, ctx.numberFormat);
    if (value === null) continue;

    let currency = reading.currency;
    if (!currency) {
      const lastSpan = spans[spans.length - 1];
      const after = tokens[nextIndex];
      const before = tokens[index - 1];
      const fromAfter =
        after && separatedBySpace(text, lastSpan, after)
          ? separateCurrency(after.text, ctx)
          : null;
      const fromBefore =
        !fromAfter && before && separatedBySpace(text, before, token)
          ? separateCurrency(before.text, ctx)
          : null;
      currency = fromAfter ?? fromBefore;
      if (fromAfter) spans.push(after);
      if (fromBefore) spans.push(before);
    }
    return {
      amount: { value: Math.abs(value), sign: reading.sign, currency },
      spans,
    };
  }
  return null;
}
