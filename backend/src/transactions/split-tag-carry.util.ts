import { BadRequestException } from "@nestjs/common";
import { tr } from "../i18n/translate";

/** An existing split line as `findOne` loads it: its category, amount, memo and tags. */
export interface ExistingSplitLine {
  id: string;
  categoryId: string | null;
  amount: number | string;
  memo?: string | null;
  tags?: readonly { id: string; name: string }[] | null;
}

/** A replacement line: its category, amount and memo, and the line it names, if any. */
export interface ReplacementSplitLine {
  categoryId: string;
  amount: number;
  memo?: string | null;
  /** The existing line this one continues, as a read tool returned it. */
  splitId?: string;
}

/** The tags a replacement line keeps: ids for the write, names for the card. */
export interface CarriedSplitTags {
  tagIds: string[];
  tagNames: string[];
}

type Key<L> = (line: L) => string;

const memoOf = (memo: string | null | undefined): string => memo?.trim() ?? "";

/**
 * How an unnamed line finds the line it continues, most specific first: the
 * same category, amount and memo; then the same category and amount; then the
 * same category.
 */
const TIERS: readonly [Key<ExistingSplitLine>, Key<ReplacementSplitLine>][] = [
  [
    (c) => JSON.stringify([c.categoryId, Number(c.amount), memoOf(c.memo)]),
    (l) => JSON.stringify([l.categoryId, l.amount, memoOf(l.memo)]),
  ],
  [
    (c) => JSON.stringify([c.categoryId, Number(c.amount)]),
    (l) => JSON.stringify([l.categoryId, l.amount]),
  ],
  [
    (c) => JSON.stringify([c.categoryId]),
    (l) => JSON.stringify([l.categoryId]),
  ],
];

const tagSet = (line: ExistingSplitLine): string =>
  JSON.stringify((line.tags ?? []).map((tag) => tag.id).sort());

const sameLine = (a: ReplacementSplitLine, b: ReplacementSplitLine): boolean =>
  a.categoryId === b.categoryId &&
  a.amount === b.amount &&
  memoOf(a.memo) === memoOf(b.memo);

/**
 * Which existing line's tags each replacement line keeps when a tool resends a
 * split transaction's COMPLETE splits array. Replacing the set deletes the old
 * lines, so a line that carried tags would lose them unless the new line says
 * which line it continues:
 *
 * 1. a line naming `splitId` continues that line, which must belong to this
 *    transaction and be named once;
 * 2. any other line continues an unclaimed line of the same category, amount
 *    and memo, else of the same category and amount, else of the same
 *    category (`TIERS`);
 * 3. a line that continues none starts with no tags.
 *
 * Within a step, the unnamed lines and the unclaimed lines that share a key
 * are paired in order only when the pairing cannot change which tags end up
 * where: the candidates all carry the same tags and each line gets one, or
 * the lines are indistinguishable and every candidate is continued. Otherwise
 * which line continues which is a guess (two "Gifts -25" lines with different
 * memos and different tags, resent with new memos), and the request is
 * refused until each line names its `splitId`.
 *
 * Each existing line is continued at most once, so one line's tags are never
 * copied onto two. Returns one entry per replacement line, in order; `null`
 * where the line keeps nothing.
 */
export function carrySplitTags(
  existing: readonly ExistingSplitLine[],
  replacement: readonly ReplacementSplitLine[],
): (CarriedSplitTags | null)[] {
  const byId = new Map(existing.map((line) => [line.id, line]));
  const claimed = new Set<string>();
  const matched: (ExistingSplitLine | null)[] = replacement.map(() => null);

  for (const [index, line] of replacement.entries()) {
    if (line.splitId === undefined) continue;
    const named = byId.get(line.splitId);
    if (!named) {
      throw new BadRequestException(
        tr(
          "errors.transactions.splitIdNotOnTransaction",
          `splitId ${line.splitId} is not a split line of this transaction. Read the transaction's split lines again and use their splitId values.`,
          { splitId: line.splitId },
        ),
      );
    }
    if (claimed.has(named.id)) {
      throw new BadRequestException(
        tr(
          "errors.transactions.splitIdRepeated",
          `splitId ${line.splitId} is named by more than one line. Each existing line can be continued once.`,
          { splitId: line.splitId },
        ),
      );
    }
    claimed.add(named.id);
    matched[index] = named;
  }

  // Exact matches first, so a line whose amount or memo changed cannot take
  // the tags of a sibling that kept its own.
  for (const [existingKey, replacementKey] of TIERS) {
    const groups = new Map<string, number[]>();
    for (const [index, line] of replacement.entries()) {
      if (line.splitId !== undefined || matched[index]) continue;
      const key = replacementKey(line);
      groups.set(key, [...(groups.get(key) ?? []), index]);
    }
    for (const [key, indexes] of groups) {
      const candidates = existing.filter(
        (c) => !claimed.has(c.id) && existingKey(c) === key,
      );
      if (candidates.length === 0) continue;
      const sameTags = new Set(candidates.map(tagSet)).size === 1;
      const lines = indexes.map((index) => replacement[index]);
      const indistinguishable = lines.every((l) => sameLine(l, lines[0]));
      const determined =
        (sameTags && indexes.length <= candidates.length) ||
        (indistinguishable && candidates.length <= indexes.length);
      if (!determined) {
        throw new BadRequestException(
          tr(
            "errors.transactions.splitTagCarryAmbiguous",
            "More than one existing split line matches a resent line and they carry different tags, so which line keeps which tags is ambiguous. Give each resent line the splitId of the line it continues, as the transaction's split lines were read.",
          ),
        );
      }
      for (const [n, index] of indexes.entries()) {
        const candidate = candidates[n];
        if (!candidate) break;
        claimed.add(candidate.id);
        matched[index] = candidate;
      }
    }
  }

  return matched.map((line) => {
    const tags = line?.tags ?? [];
    if (tags.length === 0) return null;
    return {
      tagIds: tags.map((tag) => tag.id),
      tagNames: tags.map((tag) => tag.name),
    };
  });
}
