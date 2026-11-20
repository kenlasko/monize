/**
 * Step 2 of the Quick Add reader (`docs/future-plans/quick-add.md`): account,
 * payee (name and import aliases) and category (leaf and "Parent: Child")
 * names found in the text. It runs before the amount so `7-Eleven` is a
 * payee, not 7. The longest match wins and matches never overlap.
 *
 * A span that names an account and also a payee or a category is the account
 * when a connector (`on`, `to`, `from`) stands right beside it, on the side
 * its language puts connectors, and otherwise the payee (or category); the
 * account it could have been is then offered among the account alternatives.
 */
import { matchesAliasPattern } from "../../payees/alias-match.util";
import {
  QuickAddCandidateAccount,
  QuickAddCandidateCategory,
  QuickAddCandidatePayee,
} from "./quick-add.types";
import {
  QuickAddText,
  UnitSpan,
  findOccurrences,
  findPhrase,
  foldForComparison,
  markUsed,
  selectLongest,
  spanFolded,
  withoutPunctuation,
} from "./quick-add-text.util";
import type { FoldedVocabularyWord } from "./quick-add-keywords.util";

export type AccountDirection = "to" | "from" | "on";

export interface AccountMention {
  /** Every account the span names (several share one name). */
  readonly candidates: readonly QuickAddCandidateAccount[];
  readonly direction: AccountDirection | null;
  readonly span: UnitSpan;
}

export interface NamesRead {
  /** In typed order, at most two. */
  readonly accounts: readonly AccountMention[];
  readonly accountAlternatives: readonly QuickAddCandidateAccount[];
  readonly payee: {
    readonly candidates: readonly QuickAddCandidatePayee[];
    readonly span: UnitSpan;
  } | null;
  readonly payeeAlternatives: readonly QuickAddCandidatePayee[];
  readonly category: {
    readonly candidates: readonly QuickAddCandidateCategory[];
    readonly span: UnitSpan;
  } | null;
  readonly categoryAlternatives: readonly QuickAddCandidateCategory[];
  readonly used: boolean[];
  /**
   * Each payee's name as folded for comparison, in the order of
   * `NamesInput.payees`: the partial match reads these rather than folding
   * every name again ("Bounds").
   */
  readonly foldedPayeeNames: readonly string[];
  /** `foldedPayeeNames` without punctuation, for the partial match's fallback. */
  readonly looseFoldedPayeeNames: readonly string[];
}

export interface NamesInput {
  readonly locale: string;
  readonly accounts: readonly QuickAddCandidateAccount[];
  readonly payees: readonly QuickAddCandidatePayee[];
  readonly categories: readonly QuickAddCandidateCategory[];
  readonly connectors: readonly FoldedVocabularyWord[];
  /** {@link ALIAS_GLOB_BUDGET} unless a spec needs a smaller one. */
  readonly aliasGlobBudget?: number;
}

type NameMatch =
  | { span: UnitSpan; kind: "account"; item: QuickAddCandidateAccount }
  | { span: UnitSpan; kind: "payee"; item: QuickAddCandidatePayee }
  | { span: UnitSpan; kind: "category"; item: QuickAddCandidateCategory };

/** How many words a wildcard alias may cover in the typed line. */
const ALIAS_MAX_WORDS = 6;
/** A wildcard alias with fewer literal characters would match nearly any word. */
const ALIAS_MIN_LITERAL = 2;
/**
 * The glob evaluations (`matchesAliasPattern` calls) one reading may spend on
 * wildcard aliases. The reading runs on the event loop that serves every
 * user, and a reader's aliases are theirs to multiply (an import, a restored
 * backup), so the work is bounded per request rather than per alias: once it
 * is spent, the aliases not yet tried match nothing and the reading goes on
 * with the names, plain aliases and spans already found. A 40-word line gives
 * an alias at most 40 x 6 runs, so the budget always covers dozens of aliases
 * whose literal parts all occur in the line, which is all a real line needs.
 */
export const ALIAS_GLOB_BUDGET = 12_000;
/**
 * The most spans one name contributes to a reading: an account's, a payee's
 * or a category's name, its path, a plain alias or a wildcard one. They are
 * its leftmost occurrences that do not overlap each other (two that overlap
 * can never both be chosen). The reading keeps one payee, one category and
 * two accounts, so a name needs a second occurrence only where a longer name
 * took its first, or to be both accounts of a transfer; four leaves room for
 * that twice over, and a name typed more often than that in one line is
 * read at its first four.
 */
export const NAME_MAX_SPANS = 4;
/**
 * The spans one reading collects over every name, after which no further
 * span is collected and the reading goes on with those it has. Each is keyed
 * and sorted before the longest are chosen, so without a cap a reader's
 * names multiply that work (a thousand payees with twenty short aliases each
 * over a line of one repeated kana gave two million). A real line's names
 * contribute a few spans each, a few dozen in all; a thousand is far above
 * that and costs well under a millisecond to choose from.
 */
export const NAME_SPAN_BUDGET = 1_000;

/** What is left of {@link ALIAS_GLOB_BUDGET} for this reading. */
export interface GlobBudget {
  remaining: number;
}

/** The words of the line, as unit spans. */
function wordSpans(text: QuickAddText): UnitSpan[] {
  const spans: UnitSpan[] = [];
  let start = -1;
  for (const [index, unit] of text.units.entries()) {
    if (unit.space) {
      if (start !== -1) spans.push({ start, end: index });
      start = -1;
    } else if (start === -1) {
      start = index;
    }
  }
  if (start !== -1) spans.push({ start, end: text.units.length });
  return spans;
}

/** The folded line and each run of up to {@link ALIAS_MAX_WORDS} whole words. */
interface WordRuns {
  readonly line: string;
  readonly words: readonly UnitSpan[];
  /** `folded[i][k]`: words `i` to `i + k`, folded. */
  readonly folded: readonly (readonly string[])[];
}

function wordRuns(text: QuickAddText): WordRuns {
  const words = wordSpans(text);
  const folded = words.map((first, i) =>
    words
      .slice(i, i + ALIAS_MAX_WORDS)
      .map((last) => spanFolded(text, { start: first.start, end: last.end })),
  );
  return { line: text.folded, words, folded };
}

/** Whether `literals` occur in `line` in order, without overlapping. */
function occursInOrder(line: string, literals: readonly string[]): boolean {
  let from = 0;
  for (const literal of literals) {
    const at = line.indexOf(literal, from);
    if (at === -1) return false;
    from = at + literal.length;
  }
  return true;
}

/**
 * The smallest runs of whole words a wildcard alias matches
 * (`matchesAliasPattern`, the importer's glob): a run that still matches
 * without its first or last word is not taken, so `*coffee*` takes `coffee`
 * and never the amount typed before it. An alias whose literal parts do not
 * all occur in the line, in order, is skipped before any run is tried. Each
 * run tried spends one of `budget`; when it runs out the alias stops, keeping
 * only the spans already proven smallest, and at most `limit`.
 */
function aliasSpans(
  runs: WordRuns,
  pattern: string,
  budget: GlobBudget,
  limit: number,
): UnitSpan[] {
  if (limit <= 0) return [];
  const literals = pattern.split("*").filter((part) => part !== "");
  const literalLength = literals.join("").length;
  if (literalLength < ALIAS_MIN_LITERAL) return [];
  if (!occursInOrder(runs.line, literals)) return [];
  const { words, folded } = runs;
  const answers = new Map<number, boolean>();
  /** Whether words `i`..`j` match; null once the budget is spent. */
  const matches = (i: number, j: number): boolean | null => {
    const run = i <= j ? folded[i]?.[j - i] : undefined;
    if (run === undefined) return false;
    const key = i * ALIAS_MAX_WORDS + (j - i);
    const known = answers.get(key);
    if (known !== undefined) return known;
    if (budget.remaining <= 0) return null;
    budget.remaining -= 1;
    const answer = matchesAliasPattern(run, pattern);
    answers.set(key, answer);
    return answer;
  };
  const found: UnitSpan[] = [];
  for (let i = 0; i < words.length; i++) {
    for (let j = i; j < Math.min(words.length, i + ALIAS_MAX_WORDS); j++) {
      const whole = matches(i, j);
      if (whole === null) return found;
      if (!whole) continue;
      const withoutFirst = matches(i + 1, j);
      const withoutLast = matches(i, j - 1);
      if (withoutFirst === null || withoutLast === null) return found;
      if (withoutFirst || withoutLast) continue;
      found.push({ start: words[i].start, end: words[j].end });
      if (found.length >= limit) return found;
    }
  }
  return found;
}

/**
 * The spans one reading collects, each once per item (a name and its aliases
 * often agree), within {@link NAME_SPAN_BUDGET}. It lives for one reading;
 * a span is keyed as one number, so no key is built per span.
 */
interface SpanCollector {
  /** What is left of {@link NAME_SPAN_BUDGET}. */
  readonly remaining: number;
  /** How many spans the next name may still contribute. */
  readonly limit: number;
  /** Starts the spans of the next item. */
  nextItem(): void;
  /** Where `name` (already folded) occurs, as far as the budget allows. */
  occurrences(name: string): UnitSpan[];
  /** Whether `span` is new for this item; a kept span spends the budget. */
  keep(span: UnitSpan): boolean;
}

function spanCollector(
  text: QuickAddText,
  used: readonly boolean[],
): SpanCollector {
  const seen = new Set<number>();
  const stride = text.units.length + 1;
  let remaining = NAME_SPAN_BUDGET;
  const limit = () => Math.min(NAME_MAX_SPANS, remaining);
  return {
    get remaining() {
      return remaining;
    },
    get limit() {
      return limit();
    },
    nextItem: () => seen.clear(),
    occurrences: (name) => findOccurrences(text, name, used, limit()),
    keep: (span) => {
      if (remaining <= 0) return false;
      const key = span.start * stride + span.end;
      if (seen.has(key)) return false;
      seen.add(key);
      remaining -= 1;
      return true;
    },
  };
}

/**
 * Every name's spans in the line, each candidate name folded once
 * (`docs/future-plans/quick-add.md`, "Bounds"), and the payees' folded names
 * for the partial match. Once {@link NAME_SPAN_BUDGET} is spent the names
 * still to come contribute nothing, though every payee's name is still
 * folded for the partial match.
 */
function collectMatches(
  text: QuickAddText,
  used: readonly boolean[],
  input: NamesInput,
): {
  matches: NameMatch[];
  foldedPayeeNames: string[];
  looseFoldedPayeeNames: string[];
} {
  const runs = wordRuns(text);
  const budget: GlobBudget = {
    remaining: input.aliasGlobBudget ?? ALIAS_GLOB_BUDGET,
  };
  const spans = spanCollector(text, used);
  const fold = (value: string) => foldForComparison(value, input.locale);
  // One list, appended to in place: a reader may hold thousands of names,
  // nearly all of which match nothing.
  const matches: NameMatch[] = [];
  for (const item of input.accounts) {
    if (spans.remaining <= 0) break;
    spans.nextItem();
    for (const span of spans.occurrences(fold(item.name))) {
      if (spans.keep(span)) matches.push({ span, kind: "account", item });
    }
  }
  const foldedPayeeNames: string[] = [];
  const looseFoldedPayeeNames: string[] = [];
  for (const item of input.payees) {
    const name = fold(item.name);
    const loose = withoutPunctuation(name);
    foldedPayeeNames.push(name);
    looseFoldedPayeeNames.push(loose);
    if (spans.remaining <= 0) continue;
    spans.nextItem();
    // Each name and plain alias is also looked for without its punctuation,
    // so `zehrs` finds `Zehr's Supermarket`.
    const plain = loose === name ? [name] : [name, loose];
    const wildcard: string[] = [];
    for (const alias of item.aliases) {
      if (!alias.includes("*")) {
        const folded = fold(alias);
        plain.push(folded, withoutPunctuation(folded));
      } else if (budget.remaining > 0) wildcard.push(fold(alias));
    }
    for (const phrase of plain.length === 1 ? plain : new Set(plain)) {
      for (const span of spans.occurrences(phrase)) {
        if (spans.keep(span)) matches.push({ span, kind: "payee", item });
      }
    }
    for (const pattern of wildcard) {
      for (const span of aliasSpans(runs, pattern, budget, spans.limit)) {
        if (spans.keep(span)) matches.push({ span, kind: "payee", item });
      }
    }
  }
  for (const item of input.categories) {
    if (spans.remaining <= 0) break;
    spans.nextItem();
    const name = fold(item.name);
    const looseName = withoutPunctuation(name);
    const path = fold(item.path);
    for (const phrase of new Set([name, looseName, path])) {
      for (const span of spans.occurrences(phrase)) {
        if (spans.keep(span)) matches.push({ span, kind: "category", item });
      }
    }
  }
  return { matches, foldedPayeeNames, looseFoldedPayeeNames };
}

function uniqueById<T extends { id: string }>(items: readonly T[]): T[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    if (seen.has(item.id)) return false;
    seen.add(item.id);
    return true;
  });
}

/** The connector right beside `span` on its language's side, if any. */
function connectorBeside(
  text: QuickAddText,
  span: UnitSpan,
  occurrences: ReadonlyArray<{ span: UnitSpan; word: FoldedVocabularyWord }>,
): AccountDirection | null {
  const touches = (left: number, right: number) =>
    left === right || (left + 1 === right && text.units[left].space);
  const found = occurrences.find(({ span: c, word }) =>
    word.position === "before"
      ? touches(c.end, span.start)
      : touches(span.end, c.start),
  );
  return found ? (found.word.role as AccountDirection) : null;
}

type Classified =
  | {
      role: "account";
      span: UnitSpan;
      accounts: QuickAddCandidateAccount[];
      direction: AccountDirection | null;
    }
  | { role: "payee"; span: UnitSpan; payees: QuickAddCandidatePayee[] }
  | {
      role: "category";
      span: UnitSpan;
      categories: QuickAddCandidateCategory[];
    };

export function readNames(
  text: QuickAddText,
  used: readonly boolean[],
  input: NamesInput,
): NamesRead {
  const { matches, foldedPayeeNames, looseFoldedPayeeNames } = collectMatches(
    text,
    used,
    input,
  );
  const groups = selectLongest(matches, used);
  const selectedMask = groups.reduce(
    (mask, g) => markUsed(mask, g.span),
    [...used],
  );
  const connectorOccurrences = input.connectors.flatMap((word) =>
    findPhrase(text, word.folded, selectedMask).map((span) => ({ span, word })),
  );

  const accountAlternatives: QuickAddCandidateAccount[] = [];
  const payeeAlternatives: QuickAddCandidatePayee[] = [];
  const categoryAlternatives: QuickAddCandidateCategory[] = [];

  const classified: Classified[] = groups.map(({ span, items }) => {
    const accounts = uniqueById(
      items.flatMap((m) => (m.kind === "account" ? [m.item] : [])),
    );
    const payees = uniqueById(
      items.flatMap((m) => (m.kind === "payee" ? [m.item] : [])),
    );
    const categories = uniqueById(
      items.flatMap((m) => (m.kind === "category" ? [m.item] : [])),
    );
    const direction = connectorBeside(text, span, connectorOccurrences);
    const onlyAccounts = payees.length + categories.length === 0;
    if (accounts.length > 0 && (direction !== null || onlyAccounts)) {
      payeeAlternatives.push(...payees);
      categoryAlternatives.push(...categories);
      return { role: "account", span, accounts, direction };
    }
    accountAlternatives.push(...accounts);
    if (payees.length > 0) {
      categoryAlternatives.push(...categories);
      return { role: "payee", span, payees };
    }
    return { role: "category", span, categories };
  });

  const payeeGroup = classified.find((c) => c.role === "payee");
  const categoryGroup = classified.find((c) => c.role === "category");
  const accountGroups = classified
    .flatMap((c) => (c.role === "account" ? [c] : []))
    .sort((a, b) => a.span.start - b.span.start)
    .slice(0, 2);
  const kept = [
    ...(payeeGroup ? [payeeGroup.span] : []),
    ...(categoryGroup ? [categoryGroup.span] : []),
    ...accountGroups.map((g) => g.span),
  ];

  return {
    accounts: accountGroups.map((g) => ({
      candidates: g.accounts,
      direction: g.direction,
      span: g.span,
    })),
    accountAlternatives: uniqueById(accountAlternatives),
    payee:
      payeeGroup?.role === "payee"
        ? { candidates: payeeGroup.payees, span: payeeGroup.span }
        : null,
    payeeAlternatives: uniqueById(payeeAlternatives),
    category:
      categoryGroup?.role === "category"
        ? { candidates: categoryGroup.categories, span: categoryGroup.span }
        : null,
    categoryAlternatives: uniqueById(categoryAlternatives),
    used: kept.reduce((mask, span) => markUsed(mask, span), [...used]),
    foldedPayeeNames,
    looseFoldedPayeeNames,
  };
}
