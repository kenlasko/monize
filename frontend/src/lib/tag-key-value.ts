/**
 * KEY:VALUE tag convention (frontend mirror of the backend
 * `tag-key-value.util.ts`).
 *
 * A tag name may encode a namespaced dimension by embedding a single colon,
 * e.g. `country:poland` -> key `country`, value `poland`. Plain tags (no
 * colon) have no key. Keep this in sync with the backend parser: both must
 * agree so a tag renders and filters the same way on either side.
 */

export interface ParsedTag {
  /** Namespace key (original case) or null for a plain label. */
  key: string | null;
  /** Value under the key (original case), or null when key present but empty. */
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

/** Distinct namespace keys present in a set of tag names, case-folded, sorted. */
export function collectTagKeys(names: Iterable<string>): string[] {
  const keys = new Set<string>();
  for (const name of names) {
    const key = normalizeTagKey(name);
    if (key !== null) keys.add(key);
  }
  return [...keys].sort();
}
