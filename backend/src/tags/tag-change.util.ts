import type {
  AiActionSplitTagChangePreview,
  SplitTagChangeDescriptor,
} from "../ai/actions/ai-action.types";

/**
 * The four fields an edit's tag change travels in (`TagsService.previewTagChange`):
 * the names it adds, the new ones among them, and the carried tags it removes,
 * by id for the write and by name for the card. Each field is present only
 * when it says something, so a row without a tag change carries none of them.
 */
export interface TagChangeFields {
  tagNames?: string[];
  newTagNames?: string[];
  removeTagIds?: string[];
  removeTagNames?: string[];
}

const present = <K extends keyof TagChangeFields>(
  change: TagChangeFields,
  key: K,
): Pick<TagChangeFields, K> =>
  (change[key]?.length ? { [key]: [...change[key]!] } : {}) as Pick<
    TagChangeFields,
    K
  >;

/** All four fields: a preview the prep hands to the builder. */
export function tagChangeFields(change: TagChangeFields): TagChangeFields {
  return {
    ...tagChangeWriteFields(change),
    ...tagChangeDisplayFields(change),
  };
}

/** What a signed descriptor or batch row carries: names to add, ids to remove. */
export function tagChangeWriteFields(
  change: TagChangeFields,
): Pick<TagChangeFields, "tagNames" | "removeTagIds"> {
  return { ...present(change, "tagNames"), ...present(change, "removeTagIds") };
}

/** What a card shows: names added (new ones marked) and names removed. */
export function tagChangeDisplayFields(
  change: TagChangeFields,
): Pick<TagChangeFields, "tagNames" | "newTagNames" | "removeTagNames"> {
  return {
    ...present(change, "tagNames"),
    ...(change.tagNames?.length ? present(change, "newTagNames") : {}),
    ...present(change, "removeTagNames"),
  };
}

/**
 * The tag change an edit makes on one existing split line, as the preview
 * resolves it (`TransactionsService.previewUpdate`): the line, by id for the
 * write and by category and amount for the card, and its tag change. Only a
 * line whose tags change is listed.
 */
export interface SplitTagChangePreview extends TagChangeFields {
  splitId: string;
  categoryName: string | null;
  amount: number;
  memo: string | null;
  /** A transfer line: the account of the counterpart leg that changes too. */
  legAccountName?: string;
}

/** One split line's tag change as an approved edit writes it. */
export interface SplitTagChangeWrite {
  splitId: string;
  addTagNames?: readonly string[];
  removeTagIds?: readonly string[];
}

/** What a signed descriptor or batch row carries for the split lines' tags. */
export function splitTagChangeWriteFields(change: {
  splitTagChanges?: readonly SplitTagChangePreview[];
}): { splitTagChanges?: SplitTagChangeDescriptor[] } {
  if (!change.splitTagChanges?.length) return {};
  return {
    splitTagChanges: change.splitTagChanges.map((line) => ({
      splitId: line.splitId,
      ...tagChangeWriteFields(line),
    })),
  };
}

/** What a card shows for the split lines' tags. */
export function splitTagChangeDisplayFields(change: {
  splitTagChanges?: readonly SplitTagChangePreview[];
}): { splitTagChanges?: AiActionSplitTagChangePreview[] } {
  if (!change.splitTagChanges?.length) return {};
  return {
    splitTagChanges: change.splitTagChanges.map((line) => ({
      categoryName: line.categoryName,
      amount: line.amount,
      ...(line.memo ? { memo: line.memo } : {}),
      ...(line.legAccountName ? { legAccountName: line.legAccountName } : {}),
      ...tagChangeDisplayFields(line),
    })),
  };
}

/**
 * What a split-line tag change touched on one line, for the history entry:
 * the tags the edit named (`touched`), and which of them the line and its
 * counterpart leg carried at that moment. The entry stores this before and
 * after the write, so undo and redo set exactly those links back and touch no
 * other tag, on the line or on the leg.
 */
export interface SplitTagPlace {
  splitId: string;
  /** The counterpart leg that is the user's, whose tags mirror the line's. */
  legId: string | null;
  touched: string[];
  line: string[];
  leg: string[];
}
