import { BadRequestException } from "@nestjs/common";
import { tr } from "../i18n/translate";

/** An existing split line as `findOne` loads it: its category, amount and tags. */
export interface ExistingSplitLine {
  id: string;
  categoryId: string | null;
  amount: number | string;
  tags?: readonly { id: string; name: string }[] | null;
}

/** A replacement line: its category and amount, and the line it names, if any. */
export interface ReplacementSplitLine {
  categoryId: string;
  amount: number;
  /** The existing line this one continues, as a read tool returned it. */
  splitId?: string;
}

/** The tags a replacement line keeps: ids for the write, names for the card. */
export interface CarriedSplitTags {
  tagIds: string[];
  tagNames: string[];
}

/**
 * Which existing line's tags each replacement line keeps when a tool resends a
 * split transaction's COMPLETE splits array. Replacing the set deletes the old
 * lines, so a line that carried tags would lose them unless the new line says
 * which line it continues:
 *
 * 1. a line naming `splitId` continues that line, which must belong to this
 *    transaction and be named once;
 * 2. any other line continues an unclaimed line of the same category and
 *    amount, else one of the same category;
 * 3. a line that continues none starts with no tags.
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

  const unclaimed = (predicate: (candidate: ExistingSplitLine) => boolean) =>
    existing.find(
      (candidate) => !claimed.has(candidate.id) && predicate(candidate),
    );

  // Exact (category and amount) matches first, so a line whose amount changed
  // cannot take the tags of a sibling that kept its amount.
  for (const [index, line] of replacement.entries()) {
    if (line.splitId !== undefined) continue;
    const exact = unclaimed(
      (c) =>
        c.categoryId === line.categoryId && Number(c.amount) === line.amount,
    );
    if (exact) {
      claimed.add(exact.id);
      matched[index] = exact;
    }
  }
  for (const [index, line] of replacement.entries()) {
    if (line.splitId !== undefined || matched[index]) continue;
    const sameCategory = unclaimed((c) => c.categoryId === line.categoryId);
    if (sameCategory) {
      claimed.add(sameCategory.id);
      matched[index] = sameCategory;
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
