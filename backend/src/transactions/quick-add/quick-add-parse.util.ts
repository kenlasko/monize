/**
 * The Quick Add reader (`docs/future-plans/quick-add.md`, "Reading the
 * text"): a pure function from the typed line, the vocabulary and the
 * candidate lists to what the line says. No I/O. Each step reads only what
 * the steps before it left unused:
 *
 * 1. normalize (`quick-add-text.util.ts`);
 * 2. names: accounts, payees and their aliases, categories
 *    (`quick-add-names.util.ts`);
 * 3. the date (`quick-add-date-read.util.ts`);
 * 4. the amount, its sign and currency (`quick-add-amount.util.ts`);
 * 5. keywords: the kind, connectors and filler (`quick-add-keywords.util.ts`);
 * 6. leftover words: a partial payee match when no payee was named, then the
 *    words nothing used, in the order typed.
 *
 * What was not typed is filled in by `QuickAddInterpretService`
 * (`quick-add-fill.util.ts`), never here.
 */
import { QuickAddVocabularyWord } from "./quick-add-vocabulary";
import {
  QuickAddCandidateAccount,
  QuickAddCandidateCategory,
  QuickAddCandidatePayee,
  QuickAddKind,
} from "./quick-add.types";
import {
  FreeToken,
  buildQuickAddText,
  foldForComparison,
  freeTokens,
  markUsed,
  separatedBySpace,
} from "./quick-add-text.util";
import { AccountMention, readNames } from "./quick-add-names.util";
import { readDate } from "./quick-add-date-read.util";
import { TypedAmount, readAmount } from "./quick-add-amount.util";
import { HeldCurrency, currencySpellings } from "./quick-add-currency.util";
import {
  connectorWords,
  foldVocabulary,
  readKeywords,
} from "./quick-add-keywords.util";

export interface QuickAddParseInput {
  readonly text: string;
  /** YYYY-MM-DD, the reader's financial today. */
  readonly today: string;
  /** The reader's locale: vocabulary, `Intl` names and case folding. */
  readonly locale: string;
  readonly numberFormat: string;
  readonly dateFormat: string;
  readonly vocabulary: readonly QuickAddVocabularyWord[];
  readonly accounts: readonly QuickAddCandidateAccount[];
  readonly payees: readonly QuickAddCandidatePayee[];
  readonly categories: readonly QuickAddCandidateCategory[];
  /** The currencies the reader's accounts are held in. */
  readonly heldCurrencies: readonly HeldCurrency[];
  /** `ALIAS_GLOB_BUDGET` unless a spec needs a smaller one. */
  readonly aliasGlobBudget?: number;
}

export interface QuickAddReading {
  /** Typed: a kind word, or the amount's sign. */
  readonly kind: QuickAddKind | null;
  readonly amount: TypedAmount | null;
  readonly date: string | null;
  /** Accounts named, in typed order, at most two. */
  readonly accounts: readonly AccountMention[];
  /** Accounts a name could have been, read as a payee or category instead. */
  readonly accountAlternatives: readonly QuickAddCandidateAccount[];
  readonly payee: {
    readonly candidates: readonly QuickAddCandidatePayee[];
    /** A typed word starting the payees' names, not a whole name. */
    readonly partial: boolean;
  } | null;
  readonly payeeAlternatives: readonly QuickAddCandidatePayee[];
  readonly category: {
    readonly candidates: readonly QuickAddCandidateCategory[];
  } | null;
  readonly categoryAlternatives: readonly QuickAddCandidateCategory[];
  /**
   * The words nothing else used, in typed order; null when none. Without a
   * payee read from the text, these are the words a new payee is named from.
   */
  readonly leftover: string | null;
}

/** A partial match needs this many characters typed. */
export const PARTIAL_MATCH_MIN_LENGTH = 3;

const HAS_LETTER_OR_DIGIT = /[\p{L}\p{N}]/u;
const EDGE_SEPARATORS = /^[,;:]+|[,;:]+$/gu;

function wordTokens(tokens: readonly FreeToken[]): FreeToken[] {
  return tokens
    .map((token) => ({
      ...token,
      text: token.text.replace(EDGE_SEPARATORS, ""),
    }))
    .filter((token) => HAS_LETTER_OR_DIGIT.test(token.text));
}

/**
 * The first run of leftover words, of {@link PARTIAL_MATCH_MIN_LENGTH} or
 * more characters in its first word, that starts one or more payees' names;
 * the run is extended word by word while it still does.
 */
function partialPayee(
  text: ReturnType<typeof buildQuickAddText>,
  tokens: readonly FreeToken[],
  payees: readonly QuickAddCandidatePayee[],
  /** `payees`' names as the names step folded them, in the same order. */
  foldedNames: readonly string[],
  locale: string,
): {
  first: number;
  last: number;
  candidates: QuickAddCandidatePayee[];
} | null {
  const fold = (value: string) => foldForComparison(value, locale);
  const folded = payees.map((payee, i) => ({ payee, name: foldedNames[i] }));
  for (const [first, token] of tokens.entries()) {
    const head = fold(token.text);
    if ([...head].length < PARTIAL_MATCH_MIN_LENGTH) continue;
    let best: { last: number; candidates: typeof folded } | null = null;
    let run = "";
    for (let last = first; last < tokens.length; last++) {
      if (
        last > first &&
        !separatedBySpace(text, tokens[last - 1], tokens[last])
      ) {
        break;
      }
      const piece = last === first ? head : ` ${fold(tokens[last].text)}`;
      const at = run.length;
      run += piece;
      // A longer run starts only names the shorter one did, so only the
      // word it adds is compared, where it falls in the name.
      const candidates = (best?.candidates ?? folded).filter(({ name }) =>
        name.startsWith(piece, at),
      );
      if (candidates.length === 0) break;
      best = { last, candidates };
    }
    if (best) {
      return {
        first,
        last: best.last,
        candidates: best.candidates.map(({ payee }) => payee),
      };
    }
  }
  return null;
}

/** Transfer word, then the amount's sign, then a payment or deposit word. */
function typedKind(
  kinds: readonly QuickAddKind[],
  sign: TypedAmount["sign"] | undefined,
): QuickAddKind | null {
  if (kinds.includes("transfer")) return "transfer";
  if (sign === "+") return "deposit";
  if (sign === "-") return "payment";
  return kinds[0] ?? null;
}

export function readQuickAddText(input: QuickAddParseInput): QuickAddReading {
  const text = buildQuickAddText(input.text, input.locale);
  const vocabulary = foldVocabulary(input.vocabulary, input.locale);
  const initial = text.units.map(() => false);

  const names = readNames(text, initial, {
    locale: input.locale,
    accounts: input.accounts,
    payees: input.payees,
    categories: input.categories,
    connectors: connectorWords(vocabulary),
    aliasGlobBudget: input.aliasGlobBudget,
  });

  const amountContext = {
    locale: input.locale,
    numberFormat: input.numberFormat,
    spellings: currencySpellings(input.locale, input.heldCurrencies),
    heldCodes: new Set(input.heldCurrencies.map((c) => c.code.toUpperCase())),
  };
  const dateThenAmount = (skipMonthNames: boolean) => {
    const dated = readDate(text, names.used, input, { skipMonthNames });
    const afterDate = (dated?.spans ?? []).reduce(markUsed, names.used);
    const amountRead = readAmount(text, afterDate, amountContext);
    return { dated, afterDate, amountRead };
  };
  // A month name's only neighbouring number is the amount when the line
  // holds no other: `20 may flowers` is 20, not the twentieth of May. A
  // month-name date that took a year is a date, and is never read again.
  const first = dateThenAmount(false);
  const retried =
    !first.amountRead && first.dated?.dayMayBeAmount
      ? dateThenAmount(true)
      : null;
  const { dated, afterDate, amountRead } = retried?.amountRead
    ? retried
    : first;
  const afterAmount = (amountRead?.spans ?? []).reduce(markUsed, afterDate);

  const keywords = readKeywords(text, afterAmount, vocabulary);
  const leftoverTokens = wordTokens(freeTokens(text, keywords.used));

  const partial = names.payee
    ? null
    : partialPayee(
        text,
        leftoverTokens,
        input.payees,
        // Folded once, by the names step ("Bounds").
        names.foldedPayeeNames,
        input.locale,
      );
  const remaining = partial
    ? leftoverTokens.filter((_t, i) => i < partial.first || i > partial.last)
    : leftoverTokens;
  const leftover = remaining.map((token) => token.text).join(" ");

  return {
    kind: typedKind(keywords.kinds, amountRead?.amount.sign),
    amount: amountRead?.amount ?? null,
    date: dated?.date ?? null,
    accounts: names.accounts,
    accountAlternatives: names.accountAlternatives,
    payee: names.payee
      ? { candidates: names.payee.candidates, partial: false }
      : partial
        ? { candidates: partial.candidates, partial: true }
        : null,
    payeeAlternatives: names.payeeAlternatives,
    category: names.category ? { candidates: names.category.candidates } : null,
    categoryAlternatives: names.categoryAlternatives,
    leftover: leftover === "" ? null : leftover,
  };
}
