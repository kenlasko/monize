/**
 * Step 5 of the Quick Add reader (`docs/future-plans/quick-add.md`): the
 * vocabulary's words set the kind (`deposit`, `payment`, `transfer`), and
 * connector and filler words are dropped. The directions `to` and `from`
 * were already read beside the account names in step 2.
 */
import type { QuickAddKind } from "./quick-add.types";
import {
  QuickAddConnectorPosition,
  QuickAddVocabularyRole,
  QuickAddVocabularyWord,
} from "./quick-add-vocabulary";
import {
  QuickAddText,
  UnitSpan,
  findPhrase,
  foldForComparison,
  isCjkChar,
  markUsed,
  selectLongest,
  touchesUsed,
} from "./quick-add-text.util";

export interface FoldedVocabularyWord {
  readonly folded: string;
  readonly role: QuickAddVocabularyRole;
  readonly position: QuickAddConnectorPosition;
}

const CONNECTOR_ROLES: ReadonlySet<QuickAddVocabularyRole> = new Set([
  "to",
  "from",
  "on",
]);

const KIND_ROLES: Readonly<
  Partial<Record<QuickAddVocabularyRole, QuickAddKind>>
> = {
  deposit: "deposit",
  payment: "payment",
  transfer: "transfer",
};

/**
 * The vocabulary folded in the reader's locale, each word once: the first
 * listing of a word (the reader's own language) decides its role.
 */
export function foldVocabulary(
  words: readonly QuickAddVocabularyWord[],
  locale: string,
): FoldedVocabularyWord[] {
  const seen = new Set<string>();
  return words.flatMap(({ word, role, position }) => {
    const folded = foldForComparison(word, locale);
    if (folded === "" || seen.has(folded)) return [];
    seen.add(folded);
    return [{ folded, role, position }];
  });
}

export function connectorWords(
  vocabulary: readonly FoldedVocabularyWord[],
): FoldedVocabularyWord[] {
  return vocabulary.filter((word) => CONNECTOR_ROLES.has(word.role));
}

export interface KeywordsRead {
  /** The kind each kind word names, in typed order. */
  readonly kinds: readonly QuickAddKind[];
  readonly used: boolean[];
}

/**
 * A one-character Han, kana or Hangul word (`で`, `에`, `的`) is a particle
 * only where it touches something already read; inside a leftover name it is
 * part of the name.
 */
function particleStandsAlone(
  folded: string,
  span: UnitSpan,
  used: readonly boolean[],
): boolean {
  const chars = [...folded];
  return chars.length === 1 && isCjkChar(chars[0]) && !touchesUsed(used, span);
}

export function readKeywords(
  text: QuickAddText,
  used: readonly boolean[],
  vocabulary: readonly FoldedVocabularyWord[],
): KeywordsRead {
  const matches = vocabulary.flatMap((word) =>
    findPhrase(text, word.folded, used)
      .filter((span) => !particleStandsAlone(word.folded, span, used))
      .map((span) => ({ span, word })),
  );
  const groups = selectLongest(matches, used).sort(
    (a, b) => a.span.start - b.span.start,
  );
  return {
    kinds: groups.flatMap((g) => {
      const kind = KIND_ROLES[g.items[0].word.role];
      return kind ? [kind] : [];
    }),
    used: groups.reduce((mask, g) => markUsed(mask, g.span), [...used]),
  };
}
