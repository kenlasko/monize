import { spawn } from "child_process";
import { existsSync } from "fs";

import { ChildEnv } from "../env";
import { Logger, LogSource } from "../logger";
import { Clock, systemClock } from "./clock";
import { asError, messageOf } from "./errors";
import { ParentWatchMissingError, parentWatchArgs } from "./parent-watch";
import { withDefaults } from "./types";

/**
 * One backend or frontend child process: Electron's own binary running as
 * Node (`ELECTRON_RUN_AS_NODE=1`, set by `desktop/src/env.ts`), started in the
 * layer's resource directory with the composed environment as its WHOLE
 * environment, its output going line by line to the logger.
 *
 * ## Stopping, and why a hard stop is accepted on Windows
 *
 * `stop()` sends SIGTERM, waits `stopGraceMs`, then sends SIGKILL. On POSIX
 * that is a polite request followed by a forced one. Windows has no signals:
 * `kill()` with either name is `TerminateProcess`, so there the first call is
 * already the hard stop and the grace period only waits for the exit to be
 * reported. A cooperative channel that leaves the two layers byte-identical to
 * what the containers run would have to be a desktop-owned `--require` preload
 * listening for a message and exiting the process from inside. It was rejected:
 * it buys nothing (see below), it makes the command line differ from the
 * container's (the do-not-drift guard in `boot-contract.guard.spec.ts` compares
 * them), and it adds a way for shutdown to hang.
 *
 * Why terminating each child is safe:
 *
 * - **The backend (`dist/main.js`)** installs no signal handler and does not
 *   enable Nest's shutdown hooks, so the SIGTERM a container sends on every
 *   `docker stop` already kills it without running a line of its code.
 *   Termination is the shutdown path production exercises daily, not a new
 *   one. Its durable state is in PostgreSQL, where a dropped connection rolls
 *   its open transaction back. The only files it writes are automatic backups
 *   and local attachments, both through the temp-file-then-rename helper in
 *   `backend/src/backup/atomic-file.ts`, so a kill leaves the previous file or
 *   the complete new one under the final name, plus at worst a dot-prefixed
 *   temporary file that the helper's own stale-file sweep removes. Everything
 *   else (cron timers, caches) is memory, rebuilt on start.
 * - **`dist/db-init.js` and `dist/db-migrate.js`** are only stopped when a
 *   boot is cancelled or overruns its deadline, or end themselves through the
 *   parent watch below when the shell dies mid-step. `schema.sql` is sent as one
 *   statement batch and each migration runs between BEGIN and COMMIT with its
 *   ledger row, so PostgreSQL rolls back whatever was in flight when the
 *   connection drops, and the session advisory lock they hold is released with
 *   it. The next boot runs the same step again from a clean state.
 * - **The frontend (`server.js`)** holds no durable state: it renders pages
 *   and forwards `/api` to the backend. The signal handler Next.js installs
 *   only closes the listener and exits.
 *
 * The clean shutdown that does matter is PostgreSQL's, and it comes last, after
 * both children are gone, through the runner's own `stop()`.
 *
 * ## When the shell itself dies
 *
 * `stop()` needs a live shell. For a shell that is killed (Task Manager, a
 * crash) every child runs with the orphan guard of `parent-watch.ts`: a
 * desktop-owned `--require` preload that exits the process when its stdin
 * pipe, held open by this module for the child's whole life, reaches
 * end-of-file. It is not the cooperative stop channel rejected above: nothing
 * is ever sent on it and `stop()` does not use it, so it cannot make a
 * shutdown hang, and the do-not-drift guard accounts for its two arguments as
 * a named desktop-only prefix. `stop()` does not close the pipe first either:
 * the signal that follows at once ends the process just as soon on POSIX and
 * is `TerminateProcess` on Windows, so it would add a second way to stop for
 * no earlier exit. A missing preload fails the start (`ParentWatchMissingError`)
 * rather than running a child unguarded.
 *
 * `TerminateProcess` ends one process, not its descendants. Neither layer
 * starts a second process today (plan section 4); if one ever does, this is
 * the place that needs a job object.
 */

export interface ChildSpec {
  /** Which log the output goes to. */
  readonly source: LogSource;
  /**
   * The layer's own arguments, relative to `cwd`: what follows `node` in the
   * container. The parent-watch prefix is added in front of them here.
   */
  readonly args: readonly string[];
  /** The layer's resource directory. */
  readonly cwd: string;
  /** The whole environment of the child; nothing is inherited beyond it. */
  readonly env: ChildEnv;
}

export interface ChildExit {
  readonly code: number | null;
  readonly signal: string | null;
  /** Set when the process never started; `code` and `signal` are then null. */
  readonly error?: NodeJS.ErrnoException;
}

export interface ChildHandle {
  /** Undefined when the process never started. */
  readonly pid: number | undefined;
  /** Settles once the process is gone and its output is flushed. Never rejects. */
  readonly exited: Promise<ChildExit>;
  /**
   * Ask the process to end, force it after a bound, resolve once it is gone.
   * Idempotent. Rejects with `ChildStopError` only if it outlives the kill.
   */
  stop(): Promise<void>;
}

export interface OutputStream {
  on(event: "data", listener: (chunk: Buffer | string) => void): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
}

/** The child's stdin: never written to, never ended; only its errors are read. */
export interface InputStream {
  on(event: "error", listener: (error: Error) => void): unknown;
}

/** The part of Node's `ChildProcess` the supervisor uses. */
export interface SpawnedProcess {
  readonly pid?: number;
  readonly stdin: InputStream | null;
  readonly stdout: OutputStream | null;
  readonly stderr: OutputStream | null;
  kill(signal?: NodeJS.Signals): boolean;
  on(event: "error", listener: (error: Error) => void): unknown;
  on(
    event: "exit" | "close",
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): unknown;
}

export interface ChildSpawnOptions {
  readonly cwd: string;
  readonly env: ChildEnv;
  /** stdin is the parent-watch pipe; stdout and stderr go to the logger. */
  readonly stdio: readonly ["pipe", "pipe", "pipe"];
  readonly windowsHide: true;
  readonly shell: false;
}

export type SpawnFn = (
  command: string,
  args: readonly string[],
  options: ChildSpawnOptions,
) => SpawnedProcess;

export const nodeSpawn: SpawnFn = (command, args, options) =>
  spawn(command, [...args], {
    cwd: options.cwd,
    env: { ...options.env },
    stdio: [...options.stdio],
    windowsHide: options.windowsHide,
    shell: options.shell,
  });

export interface ChildOptions {
  /** After SIGTERM, how long before SIGKILL. */
  readonly stopGraceMs: number;
  /** After SIGKILL, how long before `stop()` gives up with `ChildStopError`. */
  readonly killTimeoutMs: number;
  /** After exit, how long to wait for the output pipes to close. */
  readonly drainTimeoutMs: number;
}

export const DEFAULT_CHILD_OPTIONS: ChildOptions = {
  stopGraceMs: 5000,
  killTimeoutMs: 5000,
  drainTimeoutMs: 2000,
};

export interface ChildDeps {
  /** `process.execPath` in production: Electron's binary. */
  readonly execPath: string;
  /** Absolute path of the parent-watch preload (`parentWatchPath`). */
  readonly parentWatch: string;
  readonly logger: Logger;
  readonly spawn?: SpawnFn;
  /** Whether a file exists; `fs.existsSync` unless a spec replaces it. */
  readonly fileExists?: (path: string) => boolean;
  readonly clock?: Clock;
  readonly options?: Partial<ChildOptions>;
}

export type ChildLauncher = (spec: ChildSpec) => ChildHandle;

export class ChildStopError extends Error {
  constructor(
    readonly source: LogSource,
    readonly pid: number | undefined,
  ) {
    super(`The ${source} process (pid ${pid ?? "unknown"}) did not exit.`);
    this.name = "ChildStopError";
  }
}

export function startChild(spec: ChildSpec, deps: ChildDeps): ChildHandle {
  const { logger } = deps;
  const clock = deps.clock ?? systemClock;
  const options = withDefaults(DEFAULT_CHILD_OPTIONS, deps.options);
  const label = `${spec.source} process (${spec.args.join(" ")})`;
  const out = logger.lineSink(spec.source, "info");
  const err = logger.lineSink(spec.source, "warn");
  const gone = new AbortController();
  let resolveExited!: (exit: ChildExit) => void;
  const exited = new Promise<ChildExit>((resolve) => {
    resolveExited = resolve;
  });

  function finish(exit: ChildExit): void {
    if (gone.signal.aborted) return;
    gone.abort();
    out.end();
    err.end();
    resolveExited(exit);
  }

  function neverStarted(error: unknown): void {
    logger.error(`The ${label} could not be started: ${messageOf(error)}`);
    finish({ code: null, signal: null, error: asError(error) });
  }

  const notStarted: ChildHandle = {
    pid: undefined,
    exited,
    stop: () => Promise.resolve(),
  };
  if (!(deps.fileExists ?? existsSync)(deps.parentWatch)) {
    neverStarted(new ParentWatchMissingError(deps.parentWatch));
    return notStarted;
  }

  let child: SpawnedProcess;
  try {
    child = (deps.spawn ?? nodeSpawn)(
      deps.execPath,
      [...parentWatchArgs(deps.parentWatch), ...spec.args],
      {
        cwd: spec.cwd,
        env: spec.env,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
        shell: false,
      },
    );
  } catch (error) {
    neverStarted(error);
    return notStarted;
  }

  // The pipe stays open, unwritten, until the process is gone; Node destroys
  // it on exit. An EPIPE from a child that died first is not news.
  child.stdin?.on("error", () => undefined);
  child.stdout?.on("data", (chunk) => out.write(chunk));
  child.stderr?.on("data", (chunk) => err.write(chunk));
  child.stdout?.on("error", () => undefined);
  child.stderr?.on("error", () => undefined);
  child.on("error", (error) => {
    // Without a pid this is the spawn failing (ENOENT, EACCES), reported
    // asynchronously and with no `exit` to follow. With one it is a failed
    // signal, and the process is still there.
    if (child.pid === undefined) neverStarted(error);
    else logger.warn(`The ${label} reported: ${error.message}`);
  });
  child.on("exit", (code, signal) => {
    // `close` follows once both pipes have drained, which is when the last
    // lines are in the log. Do not wait for it forever: a pipe can be held
    // open by something other than the process that just ended.
    void clock
      .sleep(options.drainTimeoutMs, gone.signal)
      .then(() => finish({ code, signal }));
  });
  child.on("close", (code, signal) => finish({ code, signal }));
  if (child.pid !== undefined) {
    logger.info(`Started the ${label}, pid ${child.pid}.`);
  }

  function send(signal: NodeJS.Signals): void {
    try {
      child.kill(signal);
    } catch (error) {
      logger.warn(`Sending ${signal} to the ${label}: ${messageOf(error)}`);
    }
  }

  let stopping: Promise<void> | null = null;
  async function stopOnce(): Promise<void> {
    if (gone.signal.aborted) return;
    send("SIGTERM");
    await clock.sleep(options.stopGraceMs, gone.signal);
    if (gone.signal.aborted) return;
    logger.warn(
      `The ${label} was still running ${options.stopGraceMs} ms after it was asked to stop; killing it.`,
    );
    send("SIGKILL");
    await clock.sleep(options.killTimeoutMs, gone.signal);
    if (!gone.signal.aborted) throw new ChildStopError(spec.source, child.pid);
  }

  return {
    pid: child.pid,
    exited,
    stop() {
      stopping ??= stopOnce();
      return stopping;
    },
  };
}

export function createChildLauncher(deps: ChildDeps): ChildLauncher {
  return (spec) => startChild(spec, deps);
}
