import { createContext, RunnerContext } from "./postgres-context";
import { ensureCluster } from "./postgres-datadir";
import {
  createRedactor,
  messageOf,
  PostgresFailure,
  PostgresRunnerError,
} from "./postgres-errors";
import { createOsDeps } from "./postgres-os";
import { ensureDatabase } from "./postgres-ready";
import {
  clearPreviousServer,
  runningPostmaster,
  startServer,
  stopLeftover,
  stopServer,
} from "./postgres-server";
import {
  PostgresRunner,
  PostgresRunnerDeps,
  PostgresRunnerOptions,
} from "./postgres-types";

export { PostgresRunnerError } from "./postgres-errors";
export type { PostgresFailure } from "./postgres-errors";
export type {
  PostgresRunner,
  PostgresRunnerDeps,
  PostgresRunnerOptions,
  PostgresStatus,
  PostgresTimeouts,
} from "./postgres-types";

/**
 * The embedded PostgreSQL 16 server of the desktop shell: one cluster in the
 * user's data directory, listening on loopback only, driven through the
 * `initdb` and `pg_ctl` binaries in `binDir`.
 *
 * `start()`:
 *   1. first run only: initdb, then a completion marker (`postgres-datadir.ts`);
 *   2. settle a `postmaster.pid` left by an earlier session: stop a server
 *      that outlived its shell, clear the file a crash left
 *      (`postgres-server.ts`);
 *   3. `pg_ctl start` and wait for it;
 *   4. connect, and create the application database if it is absent
 *      (`postgres-ready.ts`).
 * `stop()`: `pg_ctl stop -m fast`, then `-m immediate` if that fails.
 *
 * The server is not a child of this process: pg_ctl starts it and exits, and
 * it keeps running if the shell dies. That is why every start begins at
 * step 2, and why nothing here relies on an exit hook.
 *
 * Calls are serialised, so a `stop()` issued while a `start()` is in flight
 * runs after it.
 */
export function createPostgresRunner(
  options: PostgresRunnerOptions,
  deps: PostgresRunnerDeps = createOsDeps(),
): PostgresRunner {
  const redact = createRedactor(options.password);
  let context: RunnerContext | undefined;
  let startedHere = false;
  let queue: Promise<void> = Promise.resolve();

  /** Runs one operation after the previous one, and types what it throws. */
  const serialised = (
    failure: PostgresFailure,
    operation: (context: RunnerContext) => Promise<void>,
  ): Promise<void> => {
    const run = async (): Promise<void> => {
      try {
        // Validated on first use, so a bad option rejects start() like any
        // other failure instead of throwing from the constructor.
        context ??= createContext(options, deps);
        await operation(context);
      } catch (error) {
        throw error instanceof PostgresRunnerError
          ? error
          : new PostgresRunnerError(failure, redact(messageOf(error)));
      }
    };
    const result = queue.then(run);
    queue = result.catch(() => undefined);
    return result;
  };

  const start = (): Promise<void> =>
    serialised("start", async (ctx) => {
      if (startedHere && (await runningPostmaster(ctx)) !== null) {
        return;
      }
      startedHere = false;
      const created = await ensureCluster(ctx);
      if (!created) {
        await clearPreviousServer(ctx);
      }
      ctx.status("starting");
      ctx.log(
        `postgres: starting the database server on 127.0.0.1:${ctx.options.port}`,
      );
      await startServer(ctx);
      try {
        await ensureDatabase(ctx);
      } catch (error) {
        await stopLeftover(ctx);
        throw error;
      }
      startedHere = true;
      ctx.log("postgres: the database server is ready");
      ctx.status("ready");
    });

  const stop = (): Promise<void> =>
    serialised("stop", async (ctx) => {
      startedHere = false;
      // Decided from the data directory, not from what this instance
      // remembers, so a server left by an earlier session is stopped too.
      if ((await runningPostmaster(ctx)) === null) {
        return;
      }
      ctx.status("stopping");
      ctx.log("postgres: shutting the database server down");
      await stopServer(ctx);
      ctx.log("postgres: the database server has stopped");
      ctx.status("stopped");
    });

  return { start, stop };
}
