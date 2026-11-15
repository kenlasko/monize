import { startArgs, stopArgs } from "./postgres-args";
import { RunnerContext } from "./postgres-context";
import { messageOf, PostgresRunnerError } from "./postgres-errors";
import { RunResult } from "./postgres-types";

/**
 * Starting and stopping the server through `pg_ctl`, and settling what a
 * `postmaster.pid` found before a start means.
 *
 * Always pg_ctl, never `postgres` directly and never a kill: pg_ctl is what
 * drops administrator rights on Windows (the server refuses to run with them,
 * and pg_ctl starts it under a restricted token), and `pg_ctl stop` is a
 * shutdown request the server answers by checkpointing, where TerminateProcess
 * or SIGKILL is a crash.
 */

/** How long past pg_ctl's own `-t` bound this process waits for pg_ctl. */
const PG_CTL_MARGIN_MS = 15_000;
const PID_READ_ATTEMPTS = 3;
const PID_READ_PAUSE_MS = 200;
/**
 * What the server logs when it refuses to start because processes of a dead
 * server are still attached to the data directory's shared memory. A killed
 * server's backends exit on their own, at once when idle and at the end of
 * the statement they are running otherwise, so this one failure is waited
 * out. The server log is in English: initdb ran with `--locale=C`.
 */
const ORPHANED_BACKENDS = /pre-existing shared memory block/;
const ORPHAN_WAIT_MS = 20_000;
const ORPHAN_RETRY_PAUSE_MS = 1000;

export type PidFileState =
  | { readonly kind: "absent" }
  | { readonly kind: "unreadable" }
  | { readonly kind: "pid"; readonly pid: number };

/**
 * Line 1 of `postmaster.pid` is the server's pid (negative for a single-user
 * backend). The file is re-read a few times before it is called unreadable,
 * in case a server is writing it at this instant.
 */
export async function readPidFile(
  context: RunnerContext,
): Promise<PidFileState> {
  const { deps, pidFile } = context;
  for (let attempt = 1; ; attempt += 1) {
    if (!(await deps.fs.exists(pidFile))) {
      return { kind: "absent" };
    }
    const text = await deps.fs.readText(pidFile).catch(() => "");
    const firstLine = text.split("\n")[0].trim();
    if (/^-?\d+$/.test(firstLine)) {
      const pid = Math.abs(Number.parseInt(firstLine, 10));
      if (pid > 0) {
        return { kind: "pid", pid };
      }
    }
    if (attempt >= PID_READ_ATTEMPTS) {
      return { kind: "unreadable" };
    }
    await deps.sleep(PID_READ_PAUSE_MS);
  }
}

/** The pid of the server running in the data directory, or null. */
export async function runningPostmaster(
  context: RunnerContext,
): Promise<number | null> {
  const state = await readPidFile(context);
  if (state.kind !== "pid") {
    return null;
  }
  const kind = await context.deps.probeProcess(state.pid, {
    dataDir: context.options.dataDir,
    pgCtl: context.pgCtl,
  });
  return kind === "postmaster" ? state.pid : null;
}

function outcomeOf(result: RunResult, boundSeconds: number): string {
  if (result.timedOut) {
    return `no answer within ${boundSeconds} seconds`;
  }
  return result.code === null ? "no exit code" : `exit code ${result.code}`;
}

/**
 * Fast shutdown, then immediate if that fails or runs out of time. Only call
 * this once `runningPostmaster` has confirmed the pid file names this data
 * directory's server: on POSIX pg_ctl signals whatever process holds the pid.
 */
export async function stopServer(context: RunnerContext): Promise<void> {
  const { deps, options, timeouts } = context;
  const attempt = (mode: "fast" | "immediate", seconds: number) =>
    deps.run(
      context.pgCtl,
      stopArgs({ dataDir: options.dataDir, mode, timeoutSeconds: seconds }),
      { timeoutMs: seconds * 1000 + PG_CTL_MARGIN_MS },
    );

  const fast = await attempt("fast", timeouts.stopFastSeconds);
  if (fast.code === 0) {
    return;
  }
  context.log(
    `postgres: fast shutdown did not complete (${outcomeOf(fast, timeouts.stopFastSeconds)}); requesting an immediate shutdown`,
  );
  const immediate = await attempt("immediate", timeouts.stopImmediateSeconds);
  if (immediate.code === 0) {
    return;
  }
  // The fast shutdown can finish between the two commands, and the second
  // pg_ctl then fails for want of a server to stop.
  if ((await runningPostmaster(context)) === null) {
    return;
  }
  throw context.failure(
    "stop",
    `The database server did not shut down (fast: ${outcomeOf(fast, timeouts.stopFastSeconds)}; immediate: ${outcomeOf(immediate, timeouts.stopImmediateSeconds)}).`,
    `${fast.output}\n${immediate.output}`,
  );
}

/**
 * Settles a `postmaster.pid` left by an earlier session, before a start.
 *
 * - The pid is this data directory's server, still running: the shell that
 *   started it died. It is shut down so the server this session uses is one it
 *   started, with the settings it passed.
 * - The pid is gone, or now belongs to another program: the server crashed or
 *   was killed. The stale file is removed, because on POSIX the server refuses
 *   to start while any live process holds the pid the file names. Removing it
 *   does not disable the server's own guard against a second instance, which
 *   is keyed on the data directory (its shared memory), not on this file.
 */
export async function clearPreviousServer(
  context: RunnerContext,
): Promise<void> {
  const { deps, options, pidFile } = context;
  const state = await readPidFile(context);
  if (state.kind === "absent") {
    return;
  }
  context.status("recovering");
  if (state.kind === "unreadable") {
    context.log(
      "postgres: postmaster.pid is empty or damaged; removing it, the server will recover from its log",
    );
    await deps.fs.remove(pidFile);
    return;
  }

  const kind = await deps.probeProcess(state.pid, {
    dataDir: options.dataDir,
    pgCtl: context.pgCtl,
  });
  if (kind === "postmaster") {
    context.log(
      `postgres: a database server from an earlier session is still running (pid ${state.pid}); shutting it down before starting a new one`,
    );
    try {
      await stopServer(context);
    } catch (error) {
      throw context.failure(
        "recover",
        `A database server from an earlier session (pid ${state.pid}) is still running and could not be shut down. ${messageOf(error)}`,
        error instanceof PostgresRunnerError ? error.outputTail : "",
      );
    }
  } else if (kind === "dead") {
    context.log(
      `postgres: the database server was not shut down last time (pid ${state.pid} is gone); removing the stale postmaster.pid, the server will recover from its log`,
    );
  } else {
    context.log(
      `postgres: postmaster.pid names pid ${state.pid}, which now belongs to another program; removing the stale file, the server will recover from its log`,
    );
  }
  await deps.fs.remove(pidFile);
}

/** Stops whatever a failed start left running, so a failure leaves nothing. */
export async function stopLeftover(context: RunnerContext): Promise<void> {
  try {
    if ((await runningPostmaster(context)) !== null) {
      await stopServer(context);
    }
  } catch (error) {
    context.log(
      `postgres: could not stop the server after a failed start: ${messageOf(error)}`,
    );
  }
}

export async function startServer(context: RunnerContext): Promise<void> {
  const { deps, options, timeouts } = context;
  const giveUpAt = deps.now().getTime() + ORPHAN_WAIT_MS;
  let announced = false;
  for (;;) {
    // pg_ctl runs with its output ignored, so the reason for a failure is
    // whatever the server appended to its log during this attempt.
    const offset = await deps.fs.size(options.serverLogFile);
    const result = await deps.runUnattended(
      context.pgCtl,
      startArgs({
        dataDir: options.dataDir,
        serverLogFile: options.serverLogFile,
        port: options.port,
        timeoutSeconds: timeouts.startSeconds,
      }),
      { timeoutMs: timeouts.startSeconds * 1000 + PG_CTL_MARGIN_MS },
    );
    if (result.code === 0) {
      return;
    }
    const serverLog = await deps.fs
      .readFrom(options.serverLogFile, offset)
      .catch(() => "");
    // pg_ctl gives up waiting without stopping a server that is still
    // coming up.
    await stopLeftover(context);
    if (
      !ORPHANED_BACKENDS.test(serverLog) ||
      deps.now().getTime() >= giveUpAt
    ) {
      throw context.failure(
        "start",
        `The database server did not start on 127.0.0.1:${options.port} (pg_ctl: ${outcomeOf(result, timeouts.startSeconds)}).`,
        serverLog,
      );
    }
    if (!announced) {
      announced = true;
      context.log(
        "postgres: processes of the previous server are still exiting; waiting for them before starting",
      );
    }
    await deps.sleep(ORPHAN_RETRY_PAUSE_MS);
  }
}
