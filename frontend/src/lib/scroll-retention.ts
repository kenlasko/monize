/**
 * Where the reader was on each page that keeps its place
 * (`useRetainScrollPosition`), for the life of the tab. Held in memory only:
 * a scroll offset says nothing about anyone's money, and a reload starts the
 * page fresh, as a reload should.
 *
 * Keyed by path and query, so `/transactions?accountId=a` and `/transactions`
 * keep their own places. Bounded: the oldest entry goes once there are more
 * than `MAX_ENTRIES`, since every filter a register writes to its URL is a key.
 */
const MAX_ENTRIES = 50;
const positions = new Map<string, number>();

/** The key for the page now in the address bar. */
export function currentScrollKey(): string {
  return `${window.location.pathname}${window.location.search}`;
}

/** The offset last recorded for `key`, or `undefined` when it never kept one. */
export function retainedScroll(key: string): number | undefined {
  return positions.get(key);
}

export function rememberScroll(key: string, top: number): void {
  positions.delete(key);
  positions.set(key, Math.max(0, Math.round(top)));
  while (positions.size > MAX_ENTRIES) {
    const oldest = positions.keys().next().value;
    if (oldest === undefined) break;
    positions.delete(oldest);
  }
}

/** Forget every page's place. For tests. */
export function clearRetainedScroll(): void {
  positions.clear();
}
