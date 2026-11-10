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
