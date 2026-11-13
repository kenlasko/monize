import { spawn } from "child_process";
import { promises as fsp } from "fs";
import { dirname } from "path";
import { Client } from "pg";
import { statusArgs } from "./postgres-args";
import {
  PgConnectConfig,
  PgSession,
  PostgresRunnerDeps,
  ProbeContext,
  ProcessKind,
  RunnerFs,
  RunOptions,
  RunResult,
} from "./postgres-types";

/** The real operating-system capabilities behind the PostgreSQL runner. */

const MAX_OUTPUT_CHARS = 64 * 1024;
/** How long after a binary exits its output pipes are given to drain. */
const DRAIN_MS = 1000;
/** How long a binary that ran out of time gets to exit when asked. */
const KILL_GRACE_MS = 5000;
const STATUS_TIMEOUT_MS = 15_000;

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

/**
 * The environment the binaries run in: this process's, minus every `PG*`
 * variable. initdb, pg_ctl and the server all read libpq-style variables
 * (`PGDATA`, `PGPORT`, `PGUSER`, `PGOPTIONS`, ...), and a developer's or
 * another product's setting must not redirect any of them. `LC_MESSAGES=C`
 * keeps the output shown on a failure in English and ASCII, whatever code
 * page the machine uses.
 */
export function binaryEnvironment(
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const kept = Object.entries(source).filter(([name]) => !/^PG/i.test(name));
  return { ...Object.fromEntries(kept), LC_MESSAGES: "C" };
}

/**
 * Runs a binary to completion from an argv array, with no shell and no
 * console window (`windowsHide`: the shell is a GUI process, and pg_ctl and
 * initdb are console programs).
 *
 * Captured: resolves when the output pipes close, or shortly after the exit
 * if something that outlives the binary is holding them open.
 *
 * Unattended: every stream is ignored. That is how `pg_ctl start` must run.
 * The server it launches inherits pg_ctl's handles (on Windows all of them,
 * `-l` or not), and a pipe held by the server would stay open for as long as
 * the server runs. Not `detached`: on Windows that removes the console
 * altogether and CMD.EXE, which pg_ctl uses to launch the server, would open
 * a visible one of its own.
 */
function runBinary(
  file: string,
  args: readonly string[],
  options: RunOptions,
  capture: boolean,
): Promise<RunResult> {
  return new Promise((resolve) => {
    let output = "";
    let timedOut = false;
    let settled = false;
    let drain: NodeJS.Timeout | undefined;
    let hardKill: NodeJS.Timeout | undefined;

    const child = spawn(file, [...args], {
      stdio: capture ? ["ignore", "pipe", "pipe"] : "ignore",
      windowsHide: true,
      shell: false,
      env: binaryEnvironment(),
    });
    // The binary is ended, never the server: this is pg_ctl or initdb.
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
      hardKill = setTimeout(() => child.kill("SIGKILL"), KILL_GRACE_MS);
    }, options.timeoutMs);

    const finish = (code: number | null): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      clearTimeout(drain);
      clearTimeout(hardKill);
      child.stdout?.destroy();
      child.stderr?.destroy();
      resolve({ code, output, timedOut });
    };
    const append = (chunk: string): void => {
      output = (output + chunk).slice(-MAX_OUTPUT_CHARS);
    };

    child.stdout?.setEncoding("utf8").on("data", append);
    child.stderr?.setEncoding("utf8").on("data", append);
    child.on("error", (error) => {
      output += `${file}: ${error.message}`;
      finish(null);
    });
    child.on("exit", (code) => {
      if (capture) {
        drain = setTimeout(() => finish(code), DRAIN_MS);
      } else {
        finish(code);
      }
    });
    child.on("close", (code) => finish(code));
  });
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: the process exists and belongs to another account.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Linux, from /proc: the server's executable is named `postgres`, and it
 * changes its working directory to its data directory at startup. Both must
 * match, so a pid recycled by any other program, another PostgreSQL instance
 * included, is never taken for this server and never signalled.
 */
async function probeOnLinux(
  pid: number,
  context: ProbeContext,
): Promise<ProcessKind> {
  if (!isAlive(pid)) {
    return "dead";
  }
  try {
    const [name, cwd, dataDir] = await Promise.all([
      fsp.readFile(`/proc/${pid}/comm`, "utf8"),
      fsp.readlink(`/proc/${pid}/cwd`),
      fsp.realpath(context.dataDir),
    ]);
    return name.trim() === "postgres" && cwd === dataDir
      ? "postmaster"
      : "other";
  } catch {
    // Exited in between, or another account's process /proc will not show.
    return isAlive(pid) ? "other" : "dead";
  }
}

/**
 * Windows has no /proc and no signals. `pg_ctl status` exits 0 exactly when
 * the pid in this data directory's `postmaster.pid` answers on the named pipe
 * every PostgreSQL server process opens (`\\.\pipe\pgsignal_<pid>`), which is
 * the same channel `pg_ctl stop` would use. A pid recycled by an unrelated
 * program has no such pipe. A pid recycled by a process of a different
 * PostgreSQL instance does, and cannot be told apart here.
 */
async function probeOnWindows(
  pid: number,
  context: ProbeContext,
): Promise<ProcessKind> {
  const status = await runBinary(
    context.pgCtl,
    statusArgs(context.dataDir),
    { timeoutMs: STATUS_TIMEOUT_MS },
    true,
  );
  if (status.code === 0) {
    return "postmaster";
  }
  return isAlive(pid) ? "other" : "dead";
}

export function probeProcess(
  pid: number,
  context: ProbeContext,
): Promise<ProcessKind> {
  if (process.platform === "win32") {
    return probeOnWindows(pid, context);
  }
  if (process.platform === "linux") {
    return probeOnLinux(pid, context);
  }
  return Promise.reject(
    new Error(
      `the embedded PostgreSQL runner supports Windows and Linux, not ${process.platform}`,
    ),
  );
}

async function syncDirectory(dir: string): Promise<void> {
  // A directory cannot be opened for sync on Windows; NTFS journals the entry.
  if (process.platform === "win32") {
    return;
  }
  const handle = await fsp.open(dir, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export const osFs: RunnerFs = {
  async exists(path) {
    try {
      await fsp.access(path);
      return true;
    } catch {
      return false;
    }
  },
  list: (dir) => fsp.readdir(dir),
  readText: (path) => fsp.readFile(path, "utf8"),
  writeSecret: (path, content) =>
    fsp.writeFile(path, content, { flag: "wx", mode: 0o600 }),
  async writeDurable(path, content) {
    const handle = await fsp.open(path, "w");
    try {
      await handle.writeFile(content);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await syncDirectory(dirname(path));
  },
  remove: (path) => fsp.rm(path, { force: true }),
  rename: (from, to) => fsp.rename(from, to),
  async makeDir(path) {
    await fsp.mkdir(path, { recursive: true });
  },
  async size(path) {
    try {
      return (await fsp.stat(path)).size;
    } catch (error) {
      if (isMissing(error)) {
        return 0;
      }
      throw error;
    }
  },
  async readFrom(path, offset) {
    let handle;
    try {
      handle = await fsp.open(path, "r");
    } catch (error) {
      if (isMissing(error)) {
        return "";
      }
      throw error;
    }
    try {
      const { size } = await handle.stat();
      const start = Math.max(Math.min(offset, size), size - MAX_OUTPUT_CHARS);
      const buffer = Buffer.alloc(size - start);
      await handle.read(buffer, 0, buffer.length, start);
      return buffer.toString("utf8");
    } finally {
      await handle.close();
    }
  },
};

/**
 * A node-postgres session with everything a stray environment variable could
 * change pinned: `pg` falls back to `PGSSLMODE`, `PGHOST` and the rest for
 * whatever it is not given.
 */
export async function connect(config: PgConnectConfig): Promise<PgSession> {
  const client = new Client({
    host: config.host,
    port: config.port,
    user: config.user,
    password: config.password,
    database: config.database,
    ssl: false,
    connectionTimeoutMillis: config.connectTimeoutMs,
    application_name: "monize-desktop-supervisor",
  });
  // An idle connection the server drops emits "error"; unhandled, that event
  // would take the Electron main process down.
  client.on("error", () => undefined);
  try {
    await client.connect();
  } catch (error) {
    // Not awaited: after a failed connect the socket is already gone and the
    // promise may never settle.
    void client.end().catch(() => undefined);
    throw error;
  }
  return {
    query: async (text, values) => {
      const result = values
        ? await client.query(text, [...values])
        : await client.query(text);
      return { rows: result.rows as readonly unknown[] };
    },
    end: () => client.end(),
  };
}

export function createOsDeps(): PostgresRunnerDeps {
  return {
    platform: process.platform,
    run: (file, args, options) => runBinary(file, args, options, true),
    runUnattended: (file, args, options) =>
      runBinary(file, args, options, false),
    fs: osFs,
    probeProcess,
    connect,
    now: () => new Date(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  };
}
