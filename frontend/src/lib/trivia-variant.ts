const FNV_OFFSET = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

/** FNV-1a, 32 bits, over the UTF-16 code units of `text`. */
function fnv1a(text: string): number {
  let hash = FNV_OFFSET;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, FNV_PRIME);
  }
  return hash >>> 0;
}

/**
 * Which wording of a trivia fact to show: one of `keys`, picked by a hash of the
 * fact and the day, so a fact reads one way all day and may read another
 * tomorrow. No randomness: two tabs, or a reload, agree. `day` is the reader's
 * `useFinancialToday()`.
 */
export function pickTriviaVariant(keys: string[], factId: string, day: string): string {
  return keys[fnv1a(`${factId}|${day}`) % keys.length];
}
