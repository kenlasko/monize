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
  /** A payee is pinned: leftover words are the memo, never a partial match. */
  readonly payeePinned?: boolean;
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
  /** The words nothing else used, in typed order; null when none. */
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
  locale: string,
): {
  first: number;
  last: number;
  candidates: QuickAddCandidatePayee[];
} | null {
  const folded = payees.map((payee) => ({
    payee,
    name: foldForComparison(payee.name, locale),
  }));
  for (const [first, token] of tokens.entries()) {
    const head = foldForComparison(token.text, locale);
    if ([...head].length < PARTIAL_MATCH_MIN_LENGTH) continue;
    let best: { last: number; candidates: QuickAddCandidatePayee[] } | null =
      null;
    let run = "";
    for (let last = first; last < tokens.length; last++) {
      if (
        last > first &&
        !separatedBySpace(text, tokens[last - 1], tokens[last])
      ) {
        break;
      }
      run =
        last === first
          ? head
          : `${run} ${foldForComparison(tokens[last].text, locale)}`;
      const candidates = folded
        .filter(({ name }) => name.startsWith(run))
        .map(({ payee }) => payee);
      if (candidates.length === 0) break;
      best = { last, candidates };
    }
    if (best) return { first, ...best };
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
  });

  const dated = readDate(text, names.used, input);
  const afterDate = (dated?.spans ?? []).reduce(markUsed, names.used);

  const amountRead = readAmount(text, afterDate, {
    locale: input.locale,
    numberFormat: input.numberFormat,
    spellings: currencySpellings(input.locale, input.heldCurrencies),
    heldCodes: new Set(input.heldCurrencies.map((c) => c.code.toUpperCase())),
  });
  const afterAmount = (amountRead?.spans ?? []).reduce(markUsed, afterDate);

  const keywords = readKeywords(text, afterAmount, vocabulary);
  const leftoverTokens = wordTokens(freeTokens(text, keywords.used));

  const partial =
    names.payee || input.payeePinned
      ? null
      : partialPayee(text, leftoverTokens, input.payees, input.locale);
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
