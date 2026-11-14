import { Clock, systemClock } from "./supervisor/clock";
import { codeOf, messageOf } from "./supervisor/errors";

/**
 * Poll a health URL until it answers 200, a deadline passes, the caller
 * aborts, or the process being waited for exits.
 *
 * Anything other than a 200 is "not yet": a refused connection (the listener
 * is not up), a 503 (the backend's readiness while its database check fails),
 * a request that does not answer in time. None of them is an error; the last
 * one seen is carried on a timeout so the failure can say what the server was
 * doing instead of answering.
 *
 * `exited` is the race the supervisor needs: a server that dies during startup
 * ends the wait at once with its exit, instead of after the whole deadline.
 */

export type FetchLike = (
  url: string,
  init: { readonly signal: AbortSignal },
) => Promise<{ readonly status: number }>;

export interface HealthOptions<E = never> {
  readonly deadlineMs: number;
  readonly intervalMs?: number;
  /** One request may take this long before it counts as "not yet". */
  readonly requestTimeoutMs?: number;
  readonly signal?: AbortSignal;
  /** Settles when the process behind the URL is gone. Must not reject. */
  readonly exited?: Promise<E>;
  readonly fetch?: FetchLike;
  readonly clock?: Clock;
}

export interface HealthObservation {
  readonly attempts: number;
  /** The last HTTP status seen, or null when the last attempt got none. */
  readonly lastStatus: number | null;
  /** Why the last attempt got no response, or null when it got one. */
  readonly lastError: string | null;
}

export type HealthOutcome<E = never> =
  | ({ readonly kind: "healthy" } & HealthObservation)
  | ({
      readonly kind: "timeout";
      readonly deadlineMs: number;
    } & HealthObservation)
  | { readonly kind: "aborted" }
  | { readonly kind: "exited"; readonly exit: E };

export const DEFAULT_HEALTH_INTERVAL_MS = 250;
/** The bound the frontend's own readiness route puts on the same request. */
export const DEFAULT_HEALTH_REQUEST_TIMEOUT_MS = 3000;

/**
 * Node's built-in fetch. A redirect is not followed: a health route answers
 * for itself, and a 200 from wherever a redirect leads would prove nothing.
 */
const builtinFetch: FetchLike = (url, init) =>
  fetch(url, { signal: init.signal, redirect: "manual" });

type Attempt = { readonly status: number } | { readonly error: string };

/** `ECONNREFUSED` rather than fetch's own "fetch failed", when there is a code. */
function describeError(error: unknown): string {
  return codeOf(error) ?? messageOf(error);
}

async function attempt(
  url: string,
  timeoutMs: number,
  doFetch: FetchLike,
  clock: Clock,
  signal: AbortSignal,
): Promise<Attempt> {
  // One controller per request: aborting it in `finally` cancels a request
  // that is still open, releases the body of one that answered, and clears the
  // timeout timer, whichever of the two finished first.
  const request = new AbortController();
  const forward = (): void => request.abort();
  signal.addEventListener("abort", forward, { once: true });
  try {
    return await Promise.race([
      Promise.resolve()
        .then(() => doFetch(url, { signal: request.signal }))
        .then(
          (response): Attempt => ({ status: response.status }),
          (error: unknown): Attempt => ({ error: describeError(error) }),
        ),
      clock
        .sleep(timeoutMs, request.signal)
        .then((): Attempt => ({ error: `no response within ${timeoutMs} ms` })),
    ]);
  } finally {
    request.abort();
    signal.removeEventListener("abort", forward);
  }
}

async function poll(
  url: string,
  options: HealthOptions<unknown>,
  signal: AbortSignal,
): Promise<HealthOutcome<never>> {
  const clock = options.clock ?? systemClock;
  const doFetch = options.fetch ?? builtinFetch;
  const intervalMs = options.intervalMs ?? DEFAULT_HEALTH_INTERVAL_MS;
  const requestTimeoutMs =
    options.requestTimeoutMs ?? DEFAULT_HEALTH_REQUEST_TIMEOUT_MS;
  const startedAt = clock.now();
  const remaining = (): number =>
    options.deadlineMs - (clock.now() - startedAt);
  let seen: HealthObservation = {
    attempts: 0,
    lastStatus: null,
    lastError: null,
  };

  for (;;) {
    if (signal.aborted) return { kind: "aborted" };
    if (remaining() <= 0) {
      return { kind: "timeout", deadlineMs: options.deadlineMs, ...seen };
    }
    const result = await attempt(
      url,
      Math.min(requestTimeoutMs, remaining()),
      doFetch,
      clock,
      signal,
    );
    if (signal.aborted) return { kind: "aborted" };
    seen =
      "status" in result
        ? {
            attempts: seen.attempts + 1,
            lastStatus: result.status,
            lastError: null,
          }
        : {
            attempts: seen.attempts + 1,
            lastStatus: null,
            lastError: result.error,
          };
    if (seen.lastStatus === 200) return { kind: "healthy", ...seen };
    if (remaining() > 0) {
      await clock.sleep(Math.min(intervalMs, remaining()), signal);
    }
  }
}

export async function waitForHealthy<E = never>(
  url: string,
  options: HealthOptions<E>,
): Promise<HealthOutcome<E>> {
  // Ends everything this call started, whichever way it finishes: when the
  // process exits first, the poll loop and its open request stop too.
  const done = new AbortController();
  const forward = (): void => done.abort();
  if (options.signal?.aborted) done.abort();
  options.signal?.addEventListener("abort", forward, { once: true });
  try {
    const racers: Promise<HealthOutcome<E>>[] = [
      poll(url, options, done.signal),
    ];
    if (options.exited !== undefined) {
      racers.push(
        options.exited.then((exit) => ({ kind: "exited" as const, exit })),
      );
    }
    return await Promise.race(racers);
  } finally {
    done.abort();
    options.signal?.removeEventListener("abort", forward);
  }
}
