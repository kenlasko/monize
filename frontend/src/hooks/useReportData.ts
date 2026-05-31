import { useState, useEffect, useCallback, useRef, DependencyList } from 'react';
import { createLogger } from '@/lib/logger';

const logger = createLogger('useReportData');

interface UseReportDataResult<T> {
  /** The fetched data, or null before the first successful load. */
  data: T | null;
  /** True while a fetch is in flight (including the initial load). */
  isLoading: boolean;
  /**
   * Error from the most recent failed fetch, or null. Reports previously
   * swallowed fetch errors and rendered an empty state; surfacing this lets
   * the UI show a proper error message instead.
   */
  error: Error | null;
  /** Manually re-run the fetcher (e.g. after a mutation or a retry button). */
  reload: () => void;
}

/**
 * Shared data-loading hook for the report components. Collapses the repeated
 * `setIsLoading(true); try { await api } catch { logger.error } finally
 * { setIsLoading(false) }` block into one place AND, critically, tracks an
 * error state that the reports never did -- so a failed fetch can render an
 * error message instead of silently showing an empty report.
 *
 * The fetcher is re-run whenever `deps` change (same contract as useEffect's
 * dependency array). A run counter guards against out-of-order responses: if
 * deps change mid-flight, only the latest run is allowed to commit state.
 */
export function useReportData<T>(
  fetcher: () => Promise<T>,
  deps: DependencyList,
): UseReportDataResult<T> {
  const [data, setData] = useState<T | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  // Keep the latest fetcher in a ref so changing its identity (common with
  // inline closures) does not by itself retrigger a fetch -- only `deps` and
  // explicit reloads do. This matches the manual loadData pattern it replaces.
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;

  const runIdRef = useRef(0);

  const run = useCallback(() => {
    const runId = ++runIdRef.current;
    setIsLoading(true);
    setError(null);
    fetcherRef.current()
      .then((result) => {
        if (runId !== runIdRef.current) return;
        setData(result);
        setError(null);
      })
      .catch((err: unknown) => {
        if (runId !== runIdRef.current) return;
        logger.error('Failed to load report data:', err);
        setError(err instanceof Error ? err : new Error(String(err)));
      })
      .finally(() => {
        if (runId !== runIdRef.current) return;
        setIsLoading(false);
      });
  }, []);

  useEffect(() => {
    run();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  return { data, isLoading, error, reload: run };
}
