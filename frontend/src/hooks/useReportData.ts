import {
  useState,
  useEffect,
  useLayoutEffect,
  useCallback,
  useRef,
  DependencyList,
} from "react";
import { createLogger } from "@/lib/logger";

const logger = createLogger("useReportData");

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
  /**
   * Adopt data a mutation already returned, instead of fetching it again. An
   * endpoint that answers with the refreshed report has done the work the next
   * fetch would repeat, so re-running it is a round trip that can only produce
   * the same thing -- or, if something changed in between, a surprise. Any
   * fetch still in flight is retired: this value is the newer one.
   *
   * Pass the `requestKey` the value was produced *for* to have it discarded
   * when the selection has moved on since. Without a key it is adopted
   * unconditionally, which is the behaviour every caller that does not pass a
   * `requestKey` has always had.
   */
  setData: (value: T, producedFor?: string) => void;
  /**
   * Adopt a value and **declare** the request key it belongs to, rather than
   * matching it against the current one.
   *
   * For a mutation that changes the selection itself -- creating or deleting
   * the thing being selected -- there is no earlier key to match: the response
   * *is* the new selection, and the state that would carry its key has not
   * rendered yet. Matching there drops a correct response; leaving it unkeyed
   * stamps it with the outgoing key, so the next render calls it stale and
   * fetches again. Both are wrong; declaring the key is the third option.
   *
   * Use `setData` for a mutation within the current selection. Use this only
   * where the mutation moved the selection.
   */
  adoptAs: (value: T, key: string) => void;
  /**
   * The `requestKey` the current `data` belongs to, or null before the first
   * load. Compare it with the key you are rendering for: when they differ, the
   * data on screen describes a different request and must not be acted on.
   */
  dataKey: string | null;
  /**
   * The `requestKey` the current `data` was **asked** for, which is not always
   * the one it turned out to belong to.
   *
   * `dataKey` says what the payload is; this says what question produced it.
   * They differ exactly when the server answered something else -- the GEM
   * report falling back to another scenario. A caller that reconciles its
   * selection with the response needs both, because "the answer to my current
   * question is about something else" (reconcile) and "I have just changed the
   * question and nothing has come back yet" (wait) are otherwise the same
   * state, and treating the second as the first undoes the change.
   */
  askedKey: string | null;
}

export interface UseReportDataOptions<T = unknown> {
  /**
   * Identity of the request the fetcher answers -- everything that selects
   * *what* is being loaded, not merely when. Supplying it makes the returned
   * data attributable, so a caller can refuse to act on a report that belongs
   * to a selection the user has already left.
   */
  requestKey?: string;
  /** Hide data/errors belonging to another key without unmounting filter controls. */
  maskStaleData?: boolean;
  /**
   * The key a *response* belongs to, read off the response itself.
   *
   * A server may answer a different question from the one it was asked. Ask
   * for a scenario that has since been deleted and the GEM report falls back
   * to the user's default one -- deliberately, because an empty page is a
   * worse answer. But the payload is then a report of A while the request that
   * produced it named B, and stamping it with the key it was *started* for
   * says the opposite: the page believes it is showing B, offers B's actions,
   * and sends A's signal id under B's `strategyId` when one is used. The
   * server rejects that pair, and the screen has no way back.
   *
   * Supplying this makes the response's own identity the authority. The key it
   * returns is also remembered as adopted, so the caller moving its selection
   * to match does not trigger a fetch for something already in hand.
   *
   * Return `null` to keep the started key -- the right answer when the
   * response carries nothing that identifies it.
   */
  keyForResult?: (value: T) => string | null;
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
  options: UseReportDataOptions<T> = {},
): UseReportDataResult<T> {
  const [data, setData] = useState<T | null>(null);
  const [dataKey, setDataKey] = useState<string | null>(null);
  // The key the held data's request was started for. See `askedKey`.
  const [askedKey, setAskedKey] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const [errorKey, setErrorKey] = useState<string | null>(null);

  // Read through a ref so a key changing does not itself retrigger a fetch --
  // `deps` remains the only trigger, exactly as before.
  const requestKeyRef = useRef(options.requestKey);

  // Keep the latest fetcher in a ref so changing its identity (common with
  // inline closures) does not by itself retrigger a fetch -- only `deps` and
  // explicit reloads do. This matches the manual loadData pattern it replaces.
  const fetcherRef = useRef(fetcher);

  // Same reasoning as the fetcher: read through a ref so redefining it inline
  // does not become a fetch trigger.
  const keyForResultRef = useRef(options.keyForResult);

  // Refreshed after every commit rather than during render. A layout effect
  // runs before every passive effect in the tree, so the fetch effect below and
  // any child effect that calls `reload` or `setData` see this commit's values.
  useLayoutEffect(() => {
    requestKeyRef.current = options.requestKey;
    fetcherRef.current = fetcher;
    keyForResultRef.current = options.keyForResult;
  });

  const runIdRef = useRef(0);

  /**
   * The key `adoptAs` last supplied, so the dependency change it causes does
   * not immediately re-fetch what it just delivered.
   *
   * Moving the selection is what makes the caller's `deps` change, so the
   * effect below fires on the very next render -- for a report the server has
   * already returned in full. That round trip can only produce the same thing,
   * and when it fails it replaces a successful create or delete with an error
   * screen.
   *
   * Only ever set for a key that differs from the current one. Setting it for
   * the key already selected would strand it: the deps do not change, so the
   * effect never runs to consume it, and the *next* genuine navigation back to
   * that key would be skipped and show whatever was on screen. Reachable when
   * a delete falls back to the scenario already selected.
   */
  const adoptedKeyRef = useRef<string | null>(null);

  const run = useCallback(() => {
    const runId = ++runIdRef.current;
    const startedFor = requestKeyRef.current;
    // Snapshotted with the key, not read back on settle.
    //
    // The interpreter closes over the selectors it needs to name a response --
    // for the GEM report, the chart range -- so reading the *current* one when
    // an old response lands names that response with the new range's key. The
    // run counter does not catch it: between the render that changed the range
    // and the effect that starts its fetch, `runIdRef` still belongs to the
    // old run, so the stale payload commits and briefly becomes the report for
    // a range it is not a report of. Both halves of the identity have to be
    // fixed at the same instant, which is when the request was made.
    const interpretResult = keyForResultRef.current;
    setIsLoading(true);
    setError(null);
    fetcherRef
      .current()
      .then((result) => {
        if (runId !== runIdRef.current) return;
        // The response's own identity wins over the one it was asked for: the
        // server may have answered a different question, and the payload is a
        // report of what it says it is.
        const settledFor = interpretResult?.(result) ?? startedFor ?? null;
        setData(result);
        setDataKey(settledFor);
        setAskedKey(startedFor ?? null);
        // The caller is about to move its selection onto this key, which
        // changes `deps`. Without this the effect would fetch again for the
        // report already on screen -- and a failure of that superfluous read
        // would replace a good result with an error.
        adoptedKeyRef.current =
          settledFor !== null && settledFor !== requestKeyRef.current
            ? settledFor
            : null;
        setError(null);
      })
      .catch((err: unknown) => {
        if (runId !== runIdRef.current) return;
        logger.error("Failed to load report data:", err);
        // `dataKey` is deliberately left alone: it describes the data that
        // is actually held, and a failed load did not produce any. Stamping it
        // with the key that failed would tell the caller the old report now
        // belongs to the new selection -- the precise claim this exists to
        // prevent.
        setErrorKey(startedFor ?? null);
        setError(err instanceof Error ? err : new Error(String(err)));
      })
      .finally(() => {
        if (runId !== runIdRef.current) return;
        setIsLoading(false);
      });
  }, []);

  const replace = useCallback((value: T, producedFor?: string) => {
    // A response produced for a selection the user has since left is not the
    // newer value, it is a different one: adopting it would put scenario A's
    // report on screen under scenario B's selection, and the next action would
    // then be aimed at whichever of the two the caller happened to read.
    if (producedFor !== undefined && producedFor !== requestKeyRef.current) {
      return;
    }
    // Retire whatever is in flight: it was started earlier than this value was
    // produced, so letting it commit would put the stale answer back.
    runIdRef.current += 1;
    setData(value);
    setDataKey(requestKeyRef.current ?? null);
    setAskedKey(requestKeyRef.current ?? null);
    setError(null);
    setIsLoading(false);
  }, []);

  const adoptAs = useCallback((value: T, key: string) => {
    runIdRef.current += 1;
    adoptedKeyRef.current = key === requestKeyRef.current ? null : key;
    setData(value);
    setDataKey(key);
    // The response declares what it is a report of, and the caller is moving
    // its selection there: asked and answered are the same key by construction.
    setAskedKey(key);
    setError(null);
    setIsLoading(false);
  }, []);

  useEffect(() => {
    if (
      adoptedKeyRef.current !== null &&
      adoptedKeyRef.current === requestKeyRef.current
    ) {
      adoptedKeyRef.current = null;
      return;
    }
    adoptedKeyRef.current = null;
    run();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  const mask = options.maskStaleData === true && options.requestKey !== undefined;
  return {
    data: mask && dataKey !== options.requestKey ? null : data,
    dataKey,
    isLoading: isLoading || (mask && dataKey !== options.requestKey && errorKey !== options.requestKey),
    error: mask && errorKey !== options.requestKey ? null : error,
    reload: run,
    setData: replace,
    adoptAs,
    askedKey,
  };
}
