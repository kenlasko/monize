/**
 * Shared "did you mean" suggestion helper for name-resolution failures.
 *
 * When an AI tool passes an account / category / payee name that does not match
 * any of the user's records, returning just "call list_X" forces the model to
 * make an extra round trip and guess again. Surfacing the closest valid names in
 * the error lets the model self-correct on the next call (often the same turn).
 *
 * Pure, dependency-free: case-insensitive substring matching plus a small
 * Levenshtein edit distance so near-misses ("Savings" -> "Savings Account",
 * "grocries" -> "Groceries") rank ahead of unrelated names.
 */

/** Classic iterative Levenshtein edit distance between two strings. */
export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  // Single row, rolled forward, to keep the allocation O(min(len)).
  const prev = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;

  for (let i = 1; i <= a.length; i++) {
    let diagonal = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const above = prev[j];
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      prev[j] = Math.min(
        prev[j] + 1, // deletion
        prev[j - 1] + 1, // insertion
        diagonal + cost, // substitution
      );
      diagonal = above;
    }
  }
  return prev[b.length];
}

/**
 * Return up to `limit` of the candidate names that most closely match `input`,
 * ordered best-first. A candidate qualifies when it shares a case-insensitive
 * substring with the input or its edit distance is within roughly a third of the
 * input length (a typo budget that grows with longer names). Unrelated names are
 * dropped so the suggestion stays trustworthy. The original casing is preserved.
 */
export function suggestClosestNames(
  input: string,
  candidates: readonly string[],
  limit = 3,
): string[] {
  const needle = input.trim().toLowerCase();
  if (needle.length === 0 || candidates.length === 0) return [];

  // A typo budget proportional to the input length, with a small floor so very
  // short names still tolerate a one-character slip.
  const maxDistance = Math.max(1, Math.floor(needle.length / 3));

  const scored = candidates
    .map((name) => {
      const hay = name.toLowerCase();
      const substring = hay.includes(needle) || needle.includes(hay);
      const distance = levenshtein(needle, hay);
      return { name, substring, distance };
    })
    .filter((c) => c.substring || c.distance <= maxDistance)
    // Substring matches first, then by edit distance, then alphabetically for
    // a stable, predictable order.
    .sort((a, b) => {
      if (a.substring !== b.substring) return a.substring ? -1 : 1;
      if (a.distance !== b.distance) return a.distance - b.distance;
      return a.name.localeCompare(b.name);
    });

  return scored.slice(0, limit).map((c) => c.name);
}

/**
 * Render a "Did you mean ...?" fragment for the given suggestions, or an empty
 * string when there are none. Quotes each name and joins with "or".
 */
export function formatDidYouMean(suggestions: readonly string[]): string {
  if (suggestions.length === 0) return "";
  const quoted = suggestions.map((s) => `'${s}'`);
  const list =
    quoted.length === 1
      ? quoted[0]
      : `${quoted.slice(0, -1).join(", ")} or ${quoted[quoted.length - 1]}`;
  return ` Did you mean ${list}?`;
}

/**
 * Convenience wrapper: build the closest-match fragment for an unknown name in
 * one call. Returns "" when nothing is close enough.
 */
export function didYouMean(
  input: string,
  candidates: readonly string[],
  limit = 3,
): string {
  return formatDidYouMean(suggestClosestNames(input, candidates, limit));
}
