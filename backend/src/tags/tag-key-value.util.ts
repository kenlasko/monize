/**
 * KEY:VALUE tag convention.
 *
 * A tag name may encode a namespaced dimension by embedding a single colon,
 * e.g. `country:poland` -> key `country`, value `poland`. This is a pure
 * naming convention on top of the existing free-form tag name -- there is no
 * schema change. Tags without a colon are plain labels (no key).
 *
 * Parsing rules (kept deliberately strict so ordinary tags are never
 * misread):
 * - Split on the FIRST colon only, so a value may itself contain colons.
 * - The key is everything before that colon, trimmed; it must be non-empty.
 * - The value is everything after, trimmed; an empty value (`country:` or
 *   `country: `) means "key present, no value".
 * - No colon, or an empty/whitespace key (`:poland`), is not a key:value tag:
 *   both key and value are null.
 *
 * Keys are compared case-insensitively (see {@link normalizeTagKey}); tag
 * names are already unique per user case-insensitively, so each value under a
 * key is itself unique.
 */

export interface ParsedTag {
  /** Namespace key (original case) or null when the tag is a plain label. */
  key: string | null;
  /**
   * Value under the key (original case), or null when the tag has a key but
   * no value (`country:`). Always null when {@link ParsedTag.key} is null.
   */
  value: string | null;
}

export function parseTag(name: string): ParsedTag {
  const raw = (name ?? "").trim();
  const idx = raw.indexOf(":");
  if (idx === -1) return { key: null, value: null };

  const key = raw.slice(0, idx).trim();
  if (key === "") return { key: null, value: null };

  const value = raw.slice(idx + 1).trim();
  return { key, value: value === "" ? null : value };
}

/** True when the tag name follows the `key:value` (or `key:`) convention. */
export function isKeyValueTag(name: string): boolean {
  return parseTag(name).key !== null;
}

/** Case-folded key for grouping/comparison. Null for plain-label tags. */
export function normalizeTagKey(name: string): string | null {
  const { key } = parseTag(name);
  return key === null ? null : key.toLowerCase();
}

/**
 * Distinct namespace keys present in a set of tag names, case-folded and
 * sorted, so callers can offer "chart/filter by key" choices.
 */
export function collectTagKeys(names: Iterable<string>): string[] {
  const keys = new Set<string>();
  for (const name of names) {
    const key = normalizeTagKey(name);
    if (key !== null) keys.add(key);
  }
  return [...keys].sort();
}
