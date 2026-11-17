/**
 * The last data each main page drew, kept in memory for the life of the tab,
 * so returning to the page draws it at once and refreshes underneath instead
 * of showing its loading spinner again. A snapshot is only ever the page's own
 * last successful answer to the same request: a page writes one after a load
 * succeeds, never after a failure (a failed load is not an empty list), and a
 * page whose answer depends on a selection keys the snapshot by it.
 *
 * Memory only, never `localStorage` or `sessionStorage`: it holds balances and
 * account names, and a reload starts from the server. It holds one identity's
 * data, so `authStore.logout` clears it; a delegate context switch reloads the
 * page, which clears it too.
 */
const snapshots = new Map<string, unknown>();

export function readPageSnapshot<T>(key: string): T | undefined {
  return snapshots.get(key) as T | undefined;
}

export function writePageSnapshot<T>(key: string, value: T): void {
  snapshots.set(key, value);
}

/**
 * Drop one page's snapshot. For a load that drew a new answer but could not
 * keep it (a side request failed): the older snapshot would otherwise be drawn
 * on the next return, older than what the reader last saw.
 */
export function forgetPageSnapshot(key: string): void {
  snapshots.delete(key);
}

/** Drop every page's snapshot: the identity on this tab changed. */
export function clearPageSnapshots(): void {
  snapshots.clear();
}
