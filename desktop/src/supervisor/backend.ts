import { ChildEnv } from "../env";
import { ChildExit, ChildHandle, ChildLauncher } from "./child";
import { Clock } from "./clock";
import { FailureCause } from "./types";

/**
 * The backend's boot sequence, the same one `backend/docker-entrypoint.sh`
 * runs in a container: each one-shot script to exit code 0, in order, then the
 * server. Paths are relative to the working directory, `<resources>/backend`,
 * exactly as they are relative to `/app` in the image.
 *
 * `boot-contract.guard.spec.ts` parses the entrypoint and fails when its
 * unconditional steps are not exactly `BACKEND_BOOT_SCRIPTS`, so a step added
 * there cannot be forgotten here. The entrypoint's one conditional step, the
 * `DEMO_MODE` seed, is not run: the desktop environment never sets `DEMO_MODE`
 * (the same spec holds that too).
 */
export const BACKEND_ONE_SHOT_STEPS = [
  { step: "db-init", script: "dist/db-init.js" },
  { step: "db-migrate", script: "dist/db-migrate.js" },
] as const;
export type BackendOneShotStep = (typeof BACKEND_ONE_SHOT_STEPS)[number];

export const BACKEND_SERVER_SCRIPT = "dist/main.js";

/** Every script the backend boot runs, in order; the last one keeps running. */
export const BACKEND_BOOT_SCRIPTS: readonly string[] = [
  ...BACKEND_ONE_SHOT_STEPS.map((oneShot) => oneShot.script),
  BACKEND_SERVER_SCRIPT,
];

/**
 * The backend's readiness route: the `api/v1` global prefix of
 * `backend/src/main.ts`, then `backend/src/health/health.controller.ts`.
 * It answers 200 only while the database check passes.
 */
export const BACKEND_HEALTH_PATH = "/api/v1/health/ready";

/** Where a layer runs: its resource directory and its composed environment. */
export interface LayerRuntime {
  readonly cwd: string;
  readonly env: ChildEnv;
}

export type OneShotResult =
  | { readonly kind: "ok" }
  | { readonly kind: "cancelled" }
  | { readonly kind: "failed"; readonly cause: FailureCause };

/** A process that ended, as a failure cause. Exit code 0 is still "exited". */
export function exitCause(exit: ChildExit): FailureCause {
  if (exit.error !== undefined) {
    return {
      kind: "spawn-error",
      code: exit.error.code ?? null,
      message: exit.error.message,
    };
  }
  return { kind: "exited", code: exit.code, signal: exit.signal };
}

/** Stop a child whose fate no longer matters; a failure to stop is its own log line. */
async function stopQuietly(child: ChildHandle): Promise<void> {
  try {
    await child.stop();
  } catch {
    // `ChildStopError` is logged by the child; there is no one to tell here.
  }
}

/**
 * Run one of the one-shot scripts to completion. Only exit code 0 is success.
 * An abort or the deadline stops the process before this returns, so a caller
 * never moves on while the script is still running.
 */
export async function runBackendOneShot(
  oneShot: BackendOneShotStep,
  deps: {
    readonly launch: ChildLauncher;
    readonly runtime: LayerRuntime;
    readonly clock: Clock;
    readonly deadlineMs: number;
    readonly signal: AbortSignal;
  },
): Promise<OneShotResult> {
  const { signal } = deps;
  if (signal.aborted) return { kind: "cancelled" };
  const child = deps.launch({
    source: "backend",
    args: [oneShot.script],
    cwd: deps.runtime.cwd,
    env: deps.runtime.env,
  });

  // Wakes on the deadline or on the caller's abort, and is cancelled when the
  // process ends first so its timer does not outlive the step.
  const wake = new AbortController();
  const forward = (): void => wake.abort();
  signal.addEventListener("abort", forward, { once: true });
  const exit = await Promise.race([
    child.exited,
    deps.clock.sleep(deps.deadlineMs, wake.signal).then(() => null),
  ]);
  wake.abort();
  signal.removeEventListener("abort", forward);

  if (exit === null) await stopQuietly(child);
  if (signal.aborted) return { kind: "cancelled" };
  if (exit === null) {
    return {
      kind: "failed",
      cause: {
        kind: "timeout",
        deadlineMs: deps.deadlineMs,
        lastStatus: null,
        lastError: null,
      },
    };
  }
  if (exit.error === undefined && exit.code === 0) return { kind: "ok" };
  return { kind: "failed", cause: exitCause(exit) };
}

/** Start `dist/main.js`; the caller keeps the handle and waits for readiness. */
export function startBackendServer(
  launch: ChildLauncher,
  runtime: LayerRuntime,
): ChildHandle {
  return launch({
    source: "backend",
    args: [BACKEND_SERVER_SCRIPT],
    cwd: runtime.cwd,
    env: runtime.env,
  });
}
