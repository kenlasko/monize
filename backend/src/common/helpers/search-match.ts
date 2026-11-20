/**
 * Loose name matching for payee, category and tag lookups.
 *
 * Case and punctuation are ignored, so "zehrs" finds "Zehr's Supermarket" and
 * "att" finds "AT&T". Spaces are kept so word boundaries still count. Mirrors
 * `frontend/src/lib/helpers/search-match.ts` so the assistant finds what the
 * pickers find.
 */

const PUNCTUATION = /[\p{P}\p{S}]/gu;

/** Lower-cases and strips punctuation/symbols, for use as a search key. */
export function normalizeForSearch(text: string): string {
  return text.toLowerCase().replace(PUNCTUATION, "");
}

/**
 * A query made only of punctuation (e.g. "&") would normalise to nothing and
 * match everything, so it falls back to a plain lower-cased match instead.
 */
function needleOf(query: string): {
  needle: string;
  normalize: (s: string) => string;
} {
  const needle = normalizeForSearch(query);
  if (needle.trim()) return { needle, normalize: normalizeForSearch };
  return { needle: query.toLowerCase(), normalize: (s) => s.toLowerCase() };
}

/** True when `text` contains `query`, ignoring case and punctuation. */
export function searchIncludes(
  text: string | null | undefined,
  query: string,
): boolean {
  if (!text) return false;
  const { needle, normalize } = needleOf(query);
  return normalize(text).includes(needle);
}

/** True when `text` starts with `query`, ignoring case and punctuation. */
export function searchStartsWith(
  text: string | null | undefined,
  query: string,
): boolean {
  if (!text) return false;
  const { needle, normalize } = needleOf(query);
  return normalize(text).startsWith(needle);
}
