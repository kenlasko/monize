/**
 * Map over a list of items, running `mapper` for each but never allowing more
 * than `limit` invocations to be in flight at once.
 *
 * This is the bounded-concurrency replacement for `Promise.all(items.map(...))`
 * at sites that fan out to external services (Yahoo, MSN, FX providers) or open
 * a database/HTTP connection per item. An unbounded `Promise.all` over a large
 * array can launch hundreds of simultaneous requests, exhausting connection
 * pools and tripping provider rate limits. Capping concurrency keeps throughput
 * high while staying within those limits.
 *
 * Results are returned in the same order as `items`, regardless of completion
 * order, so callers can rely on positional correspondence just like
 * `Promise.all`. If any mapper rejects, the returned promise rejects (the first
 * rejection wins); in-flight mappers are allowed to settle but no further items
 * are started.
 *
 * @param items   The input list.
 * @param limit   Maximum number of mappers running concurrently (must be >= 1).
 * @param mapper  Async function applied to each item; receives the item and its
 *                index.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  mapper: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (limit < 1) {
    throw new Error("mapWithConcurrency: limit must be at least 1");
  }

  const results = new Array<R>(items.length);
  if (items.length === 0) {
    return results;
  }

  const effectiveLimit = Math.min(limit, items.length);
  let nextIndex = 0;
  let failed = false;

  const worker = async (): Promise<void> => {
    while (!failed) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      if (currentIndex >= items.length) {
        return;
      }
      try {
        results[currentIndex] = await mapper(items[currentIndex], currentIndex);
      } catch (error) {
        // Stop scheduling new work; let the rejection propagate to the caller.
        failed = true;
        throw error;
      }
    }
  };

  const workers = Array.from({ length: effectiveLimit }, () => worker());
  await Promise.all(workers);
  return results;
}
