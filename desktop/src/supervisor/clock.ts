/**
 * The supervisor's only source of time, so every deadline, backoff and kill
 * bound is driven by a fake in the specs.
 *
 * `sleep` never rejects: it resolves when the time has passed or as soon as
 * the signal aborts, and the caller reads `signal.aborted` to tell which. That
 * keeps cancellation a plain `await` with no rejection to route.
 */
export interface Clock {
  /** Milliseconds on a monotonic scale; only differences mean anything. */
  now(): number;
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
}

/** `setTimeout` treats a longer delay as 1 ms. */
const MAX_TIMEOUT_MS = 2 ** 31 - 1;

/**
 * Real time. Every timer is unref'd, so a pending deadline never keeps the
 * process alive, and is cleared when its signal aborts, so nothing fires after
 * the supervisor has stopped. A non-finite delay waits for the signal alone.
 */
export const systemClock: Clock = {
  now: () => performance.now(),
  sleep(ms, signal) {
    return new Promise<void>((resolve) => {
      if (signal?.aborted) {
        resolve();
        return;
      }
      const timer = Number.isFinite(ms)
        ? setTimeout(finish, Math.min(Math.max(0, ms), MAX_TIMEOUT_MS))
        : undefined;
      timer?.unref();
      function finish(): void {
        clearTimeout(timer);
        signal?.removeEventListener("abort", finish);
        resolve();
      }
      signal?.addEventListener("abort", finish, { once: true });
    });
  },
};
