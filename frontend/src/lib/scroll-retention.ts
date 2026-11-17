/**
 * Where the reader was on each page that keeps its place
 * (`useRetainScrollPosition`), for the life of the tab. Held in memory only:
 * a scroll offset says nothing about anyone's money, and a reload starts the
 * page fresh, as a reload should.
 *
 * Keyed by path, with the content the offset was measured against beside it
 * (by default the query string; Transactions passes its register's request
 * key), so a place is restored only over the same content. The path alone is
 * the key because a page may rewrite its query after it draws (Transactions
 * puts its stored filters back into the address), and a lookup by the
 * address of the moment would miss the place it saved.
 */
export interface RetainedScroll {
  top: number;
  contentKey: string;
}

const positions = new Map<string, RetainedScroll>();

/** The place kept for `pathname`, or `undefined` when it never kept one. */
export function retainedScroll(pathname: string): RetainedScroll | undefined {
  return positions.get(pathname);
}

export function rememberScroll(pathname: string, top: number, contentKey: string): void {
  positions.set(pathname, { top: Math.max(0, Math.round(top)), contentKey });
}

/** Forget every page's place. For tests. */
export function clearRetainedScroll(): void {
  positions.clear();
}
