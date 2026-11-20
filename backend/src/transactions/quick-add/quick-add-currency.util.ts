/**
 * The currency a Quick Add amount was typed in (`docs/future-plans/quick-add.md`,
 * "Reading the text", step 4): a symbol or code written next to the number.
 *
 * A spelling maps to every currency it may name (`$` is the US, Canadian,
 * Australian ... dollar), and the interpretation compares the account's
 * currency against that set: a spelling that may be the account's is dropped,
 * anything else is a foreign currency the full form has to handle.
 *
 * Two lists, because a letter spelling standing apart is often an ordinary
 * word (`top`, `all` and `try` are ISO codes, `R` is the rand):
 * - **attached** (`€20`, `20eur`, `500円`): every known spelling.
 * - **separate** (`20 €`, `EUR 20`): spellings holding a currency sign, the
 *   CJK unit characters, a code typed in capitals, and every spelling of a
 *   currency one of the reader's accounts is held in, in any case.
 */
import { CURRENCY_METADATA } from "../../currencies/currency-metadata";
import { foldForComparison } from "./quick-add-text.util";

/** A currency one of the reader's accounts is held in. */
export interface HeldCurrency {
  readonly code: string;
  /** `currencies.symbol`. */
  readonly symbol: string | null;
}

export interface CurrencySpellings {
  /** Folded spelling -> the codes it may name, longest spelling first. */
  readonly attached: ReadonlyArray<readonly [string, readonly string[]]>;
  readonly separate: ReadonlyMap<string, readonly string[]>;
}

/** The written unit after an amount in Han, kana or Hangul text. */
const CJK_UNITS: ReadonlyArray<readonly [string, readonly string[]]> = [
  ["円", ["JPY"]],
  ["元", ["CNY", "TWD", "HKD"]],
  ["圓", ["TWD"]],
  ["块", ["CNY"]],
  ["塊", ["TWD"]],
  ["원", ["KRW"]],
];

const ISO_CODES: readonly string[] = (
  Intl as unknown as { supportedValuesOf(key: "currency"): string[] }
).supportedValuesOf("currency");

const ONLY_LETTERS = /^\p{L}+$/u;

function intlSymbol(
  locale: string,
  code: string,
  display: "symbol" | "narrowSymbol",
): string | null {
  try {
    return (
      new Intl.NumberFormat(locale, {
        style: "currency",
        currency: code,
        currencyDisplay: display,
      })
        .formatToParts(1)
        .find((part) => part.type === "currency")?.value ?? null
    );
  } catch {
    return null;
  }
}

function symbolsOf(code: string, locale: string): string[] {
  return [locale, "en"].flatMap((l) =>
    [intlSymbol(l, code, "symbol"), intlSymbol(l, code, "narrowSymbol")].filter(
      (s): s is string => !!s,
    ),
  );
}

type SpellingMap = Map<string, Set<string>>;

function add(map: SpellingMap, spelling: string, code: string, locale: string) {
  const folded = foldForComparison(spelling, locale);
  if (folded === "" || /\s/u.test(folded) || /\d/u.test(folded)) return;
  const codes = map.get(folded) ?? new Set<string>();
  codes.add(code);
  map.set(folded, codes);
}

const STATIC_BY_LOCALE = new Map<string, SpellingMap>();

/** The spellings every reader in `locale` shares; memoized, `Intl` data only. */
function staticSpellings(locale: string): SpellingMap {
  const cached = STATIC_BY_LOCALE.get(locale);
  if (cached) return cached;
  const map: SpellingMap = new Map();
  for (const code of ISO_CODES) add(map, code, code, locale);
  for (const [code, meta] of Object.entries(CURRENCY_METADATA)) {
    add(map, meta.symbol, code, locale);
    for (const symbol of symbolsOf(code, locale))
      add(map, symbol, code, locale);
  }
  for (const [unit, codes] of CJK_UNITS) {
    for (const code of codes) add(map, unit, code, locale);
  }
  STATIC_BY_LOCALE.set(locale, map);
  return map;
}

function frozen(map: SpellingMap): Map<string, readonly string[]> {
  return new Map(
    [...map.entries()].map(([spelling, codes]) => [
      spelling,
      [...codes].sort(),
    ]),
  );
}

/** The spellings a reader in `locale` holding `held` is understood in. */
export function currencySpellings(
  locale: string,
  held: readonly HeldCurrency[],
): CurrencySpellings {
  const attached: SpellingMap = new Map(
    [...staticSpellings(locale).entries()].map(([k, v]) => [k, new Set(v)]),
  );
  const separate: SpellingMap = new Map();
  for (const [spelling, codes] of attached.entries()) {
    const cjkUnit = CJK_UNITS.some(([unit]) => unit === spelling);
    if (cjkUnit || !ONLY_LETTERS.test(spelling)) {
      separate.set(spelling, new Set(codes));
    }
  }
  for (const { code, symbol } of held) {
    const spellings = [
      code,
      ...(symbol ? [symbol] : []),
      ...symbolsOf(code, locale),
    ];
    for (const spelling of spellings) {
      add(attached, spelling, code, locale);
      add(separate, spelling, code, locale);
    }
  }
  const ordered = [...frozen(attached).entries()].sort(
    (a, b) => b[0].length - a[0].length || a[0].localeCompare(b[0]),
  );
  return { attached: ordered, separate: frozen(separate) };
}

/** A code typed in capitals, which names a currency even standing apart. */
export function capitalIsoCode(typed: string): string | null {
  return /^[A-Z]{3}$/u.test(typed) && ISO_CODES.includes(typed) ? typed : null;
}
