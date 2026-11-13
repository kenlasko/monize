import { initdbArgs } from "./postgres-args";
import { INIT_MARKER, RunnerContext } from "./postgres-context";
import { messageOf } from "./postgres-errors";

/**
 * First-run handling of the data directory.
 *
 * initdb writes `PG_VERSION` in its first second and can be killed at any
 * point in the next thirty, so the presence of a cluster's files proves
 * nothing. The runner writes its own marker after initdb has exited 0, and a
 * directory is a cluster only once it holds that marker.
 *
 * A directory with content and no marker is an initdb that never finished:
 * the application database was never created in it, so it holds no user data.
 * It is still renamed aside rather than deleted, so that a marker lost for any
 * other reason (a restore by hand, a sync tool) can never cost a real database.
 */

export type DataDirState = "absent" | "empty" | "initialized" | "incomplete";

export async function classifyDataDir(
  context: RunnerContext,
): Promise<DataDirState> {
  const { deps, options } = context;
  if (!(await deps.fs.exists(options.dataDir))) {
    return "absent";
  }
  const entries = await deps.fs.list(options.dataDir);
  if (entries.length === 0) {
    return "empty";
  }
  return entries.includes(INIT_MARKER) ? "initialized" : "incomplete";
}

/** `20261113T144205123Z`: sortable, and free of the colon Windows forbids. */
function timestampOf(date: Date): string {
  return date.toISOString().replace(/[-:.]/g, "");
}

async function setIncompleteAside(context: RunnerContext): Promise<void> {
  const { deps, options } = context;
  const aside = `${options.dataDir}.incomplete-${timestampOf(deps.now())}`;
  try {
    await deps.fs.rename(options.dataDir, aside);
  } catch (error) {
    throw context.failure(
      "init",
      `The database directory ${options.dataDir} holds an initialization that never finished, and it could not be moved aside: ${messageOf(error)}`,
    );
  }
  context.log(
    `postgres: ${options.dataDir} held an initialization that never finished; moved it to ${aside} and starting over`,
  );
}

async function runInitdb(context: RunnerContext): Promise<void> {
  const { deps, options } = context;
  try {
    // Mode 0600 on POSIX. Windows ignores the mode; the file inherits the
    // per-user ACL of %LOCALAPPDATA%, which is why it is written there.
    //
    // Run by an administrator on Windows, initdb re-executes itself under a
    // restricted token, the same reduced identity pg_ctl later gives the
    // server, so the cluster's files are created by the account that will
    // open them. The runner creates nothing inside the data directory but
    // its marker, and never the server's log file, for the same reason.
    await deps.fs.writeSecret(context.pwFile, `${options.password}\n`);
    const result = await deps.run(
      context.initdb,
      initdbArgs({
        dataDir: options.dataDir,
        superuser: options.superuser,
        pwFile: context.pwFile,
      }),
      { timeoutMs: context.timeouts.initSeconds * 1000 },
    );
    if (result.code !== 0) {
      const why = result.timedOut
        ? `did not finish within ${context.timeouts.initSeconds} seconds`
        : `exited with ${result.code === null ? "no exit code" : `code ${result.code}`}`;
      throw context.failure(
        "init",
        `Creating the database cluster failed: initdb ${why}.`,
        result.output,
      );
    }
  } finally {
    await deps.fs.remove(context.pwFile).catch((error: unknown) => {
      context.log(
        `postgres: could not remove ${context.pwFile}: ${messageOf(error)}`,
      );
    });
  }
}

/**
 * Makes the data directory a completed cluster. Returns true when this call
 * created it, which tells the caller no earlier server can be running in it.
 */
export async function ensureCluster(context: RunnerContext): Promise<boolean> {
  const { deps, options, path } = context;
  await deps.fs.makeDir(path.dirname(options.dataDir));
  await deps.fs.makeDir(path.dirname(options.serverLogFile));
  // A shell that died between writing the password file and the finally in
  // runInitdb left it behind. Cleared on every start, whatever the state.
  await deps.fs.remove(context.pwFile);

  const state = await classifyDataDir(context);
  if (state === "initialized") {
    return false;
  }
  context.status("initializing");
  if (state === "incomplete") {
    await setIncompleteAside(context);
  }
  context.log(`postgres: creating the database cluster in ${options.dataDir}`);
  await runInitdb(context);
  await deps.fs.writeDurable(
    context.markerFile,
    `${deps.now().toISOString()}\n`,
  );
  context.log("postgres: database cluster created");
  return true;
}
