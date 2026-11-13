import { Clock } from "../supervisor/clock";

/**
 * What `--quit` does after it has asked the running shell to stop: it waits
 * until that shell has gone, so that whoever ran it (the installer, the
 * uninstaller, the CI smoke test) can touch the application's files as soon
 * as the command returns.
 *
 * "Gone" is read from the single-instance lock, which the running shell holds
 * until its process ends, and its process ends only after the frontend, the
 * backend and PostgreSQL have stopped (`quit-gate.ts`). Each failed attempt
 * to take the lock also repeats the request to quit, which the quit gate
 * joins to the shutdown already under way.
 */

/**
 * Longer than the worst clean stop: two children at their grace period and a
 * PostgreSQL that needs both its fast and its immediate shutdown.
 */
export const QUIT_WAIT_MS = 120_000;
export const QUIT_POLL_MS = 500;

/** The exit code of a `--quit` that gave up waiting. */
export const QUIT_TIMED_OUT_EXIT_CODE = 3;

export interface QuitWaitDeps {
  /** Electron's `requestSingleInstanceLock`: true once nobody else holds it. */
  readonly tryLock: () => boolean;
  readonly clock: Clock;
  readonly timeoutMs?: number;
  readonly pollMs?: number;
}

/** Resolves true when the other shell has exited, false when the wait ran out. */
export async function waitForOtherShellToExit(
  deps: QuitWaitDeps,
): Promise<boolean> {
  const { clock } = deps;
  const pollMs = deps.pollMs ?? QUIT_POLL_MS;
  const deadline = clock.now() + (deps.timeoutMs ?? QUIT_WAIT_MS);
  while (clock.now() < deadline) {
    await clock.sleep(Math.min(pollMs, deadline - clock.now()));
    if (deps.tryLock()) {
      return true;
    }
  }
  return false;
}

export function quitExitCode(otherShellExited: boolean): number {
  return otherShellExited ? 0 : QUIT_TIMED_OUT_EXIT_CODE;
}
