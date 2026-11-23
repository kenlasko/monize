/**
 * Loose text matching for type-to-filter lists (payees, categories, tags...).
 *
 * Case and punctuation are ignored, so "zehrs" finds "Zehr's Supermarket" and
 * "att" finds "AT&T". Spaces are kept so word boundaries still count.
 */

const PUNCTUATION = /[\p{P}\p{S}]/gu;

/** Lower-cases and strips punctuation/symbols, for use as a search key. */
export function normalizeForSearch(text: string): string {
  return text.toLowerCase().replace(PUNCTUATION, '');
}

/**
 * Normalises a typed query. A query made only of punctuation (e.g. "&") would
 * normalise to nothing and match everything, so it falls back to a plain
 * lower-cased match instead.
 */
function needleOf(query: string): { needle: string; normalize: (s: string) => string } {
  const needle = normalizeForSearch(query);
  if (needle.trim()) return { needle, normalize: normalizeForSearch };
  return { needle: query.toLowerCase(), normalize: (s) => s.toLowerCase() };
}

/** True when `text` contains `query`, ignoring case and punctuation. */
export function searchIncludes(text: string | null | undefined, query: string): boolean {
  if (!text) return false;
  const { needle, normalize } = needleOf(query);
  return normalize(text).includes(needle);
}

/** True when `text` starts with `query`, ignoring case and punctuation. */
export function searchStartsWith(text: string | null | undefined, query: string): boolean {
  if (!text) return false;
  const { needle, normalize } = needleOf(query);
  return normalize(text).startsWith(needle);
}

/**
 * One query, many candidates. The query is normalised once, and a candidate
 * may pass its `normalizeForSearch` key precomputed, so filtering a long list
 * does no regex work per candidate per keystroke.
 */
export interface SearchMatcher {
  /** `searchIncludes(text, query)`; `key` is `normalizeForSearch(text)`. */
  includes(text: string | null | undefined, key?: string): boolean;
  /** `searchStartsWith(text, query)`; `key` is `normalizeForSearch(text)`. */
  startsWith(text: string | null | undefined, key?: string): boolean;
}

export function createSearchMatcher(query: string): SearchMatcher {
  const { needle, normalize } = needleOf(query);
  // A punctuation-only query matches lower-cased text, which a stripped key
  // cannot answer, so the key is only used in the normal case.
  const keyed = normalize === normalizeForSearch;
  const subject = (text: string, key: string | undefined) =>
    keyed && key !== undefined ? key : normalize(text);
  return {
    includes: (text, key) => (text ? subject(text, key).includes(needle) : false),
    startsWith: (text, key) => (text ? subject(text, key).startsWith(needle) : false),
  };
}
