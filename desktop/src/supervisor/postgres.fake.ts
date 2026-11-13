import { pathFor } from "./postgres-args";
import {
  PgConnectConfig,
  PostgresRunnerDeps,
  PostgresRunnerOptions,
  ProcessKind,
  RunResult,
} from "./postgres-types";

/**
 * An in-memory machine for the runner's specs: a file system, a process
 * table, and stand-ins for `initdb`, `pg_ctl` and the server that behave like
 * the real ones in the ways the runner depends on. A spec changes one thing
 * through `on` and asserts on what was run, written and logged.
 */

export const PASSWORD = "s3cr3t-Pa55word";

export interface RecordedCall {
  readonly binary: string;
  readonly args: readonly string[];
  readonly attended: boolean;
  readonly timeoutMs: number;
}

export interface FakeWorld {
  readonly options: PostgresRunnerOptions;
  deps: PostgresRunnerDeps;
  readonly files: Map<string, string>;
  /** Directories that exist without holding a file. */
  readonly emptyDirs: Set<string>;
  readonly calls: RecordedCall[];
  readonly logs: string[];
  readonly statuses: string[];
  readonly queries: string[];
  readonly connections: PgConnectConfig[];
  readonly processes: Map<number, ProcessKind>;
  readonly databases: Set<string>;
  readonly secretFiles: { path: string; content: string }[];
  readonly removed: string[];
  readonly renames: { from: string; to: string }[];
  readonly sleeps: number[];
  /** What initdb found in the password file while it ran. */
  passwordSeenByInitdb: string | undefined;
  /** Returning a result replaces the stand-in's own behaviour for one call. */
  on: {
    initdb?: () => RunResult | undefined;
    start?: () => RunResult | undefined;
    stop?: (mode: string) => RunResult | undefined;
    connect?: () => Error | undefined;
    query?: (text: string) => Error | undefined;
  };
  join(...parts: string[]): string;
  commands(): string[];
}

export const ok = (output = ""): RunResult => ({
  code: 0,
  output,
  timedOut: false,
});
export const failed = (output = "", code = 1): RunResult => ({
  code,
  output,
  timedOut: false,
});
export const timedOut = (): RunResult => ({
  code: null,
  output: "",
  timedOut: true,
});

export function pgError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}

export function createWorld(
  platform: NodeJS.Platform = "linux",
  overrides: Partial<PostgresRunnerOptions> = {},
): FakeWorld {
  const path = pathFor(platform);
  const home =
    platform === "win32"
      ? "C:\\Users\\First Last\\AppData\\Local\\Monize"
      : "/home/first last/.local/share/Monize";
  const resources =
    platform === "win32"
      ? "C:\\Program Files\\Monize\\resources\\postgres\\bin"
      : "/opt/Monize/resources/postgres/bin";
  let clock = Date.parse("2026-11-13T10:00:00.000Z");
  let nextPid = 5000;

  const world: FakeWorld = {
    options: {
      binDir: resources,
      dataDir: path.join(home, "pgdata"),
      port: 5433,
      superuser: "monize",
      password: PASSWORD,
      database: "monize",
      serverLogFile: path.join(home, "logs", "postgres.log"),
      log: (line) => world.logs.push(line),
      onStatus: (status) => world.statuses.push(status),
      ...overrides,
    },
    files: new Map(),
    emptyDirs: new Set(),
    calls: [],
    logs: [],
    statuses: [],
    queries: [],
    connections: [],
    processes: new Map(),
    databases: new Set(["postgres", "template0", "template1"]),
    secretFiles: [],
    removed: [],
    renames: [],
    sleeps: [],
    passwordSeenByInitdb: undefined,
    on: {},
    join: (...parts) => path.join(...parts),
    commands: () =>
      world.calls.map((call) =>
        call.binary.startsWith("initdb")
          ? "initdb"
          : `pg_ctl ${call.args[0]}${call.args[0] === "stop" ? ` ${call.args[call.args.indexOf("-m") + 1]}` : ""}`,
      ),
    deps: undefined as unknown as PostgresRunnerDeps,
  };

  const { dataDir } = world.options;
  const pidFile = path.join(dataDir, "postmaster.pid");
  const under = (dir: string) => `${dir}${path.sep}`;
  const livePostmaster = (): number | undefined => {
    const pid = Number.parseInt(world.files.get(pidFile) ?? "", 10);
    return world.processes.get(pid) === "postmaster" ? pid : undefined;
  };

  const initdb = (args: readonly string[]): RunResult => {
    const pwArg = args.find((arg) => arg.startsWith("--pwfile=")) ?? "";
    world.passwordSeenByInitdb = world.files.get(
      pwArg.slice("--pwfile=".length),
    );
    const scripted = world.on.initdb?.();
    if (scripted) {
      return scripted;
    }
    world.files.set(path.join(dataDir, "PG_VERSION"), "16\n");
    return ok("Success. You can now start the database server.\n");
  };

  const pgCtl = (args: readonly string[]): RunResult => {
    if (args[0] === "start") {
      const scripted = world.on.start?.();
      if (scripted) {
        return scripted;
      }
      nextPid += 1;
      world.processes.set(nextPid, "postmaster");
      world.files.set(pidFile, `${nextPid}\n${dataDir}\n1794650400\n5433\n`);
      return ok();
    }
    const scripted = world.on.stop?.(args[args.indexOf("-m") + 1]);
    if (scripted) {
      return scripted;
    }
    const pid = livePostmaster();
    if (pid === undefined) {
      return failed("pg_ctl: PID file does not exist\nIs server running?\n");
    }
    world.processes.delete(pid);
    world.files.delete(pidFile);
    return ok("waiting for server to shut down.... done\nserver stopped\n");
  };

  const run =
    (attended: boolean): PostgresRunnerDeps["run"] =>
    async (file, args, options) => {
      const binary = path.basename(file);
      world.calls.push({
        binary,
        args,
        attended,
        timeoutMs: options.timeoutMs,
      });
      return binary.startsWith("initdb") ? initdb(args) : pgCtl(args);
    };

  world.deps = {
    platform,
    run: run(true),
    runUnattended: run(false),
    fs: {
      exists: async (target) =>
        world.files.has(target) ||
        world.emptyDirs.has(target) ||
        [...world.files.keys()].some((file) => file.startsWith(under(target))),
      list: async (dir) => [
        ...new Set(
          [...world.files.keys()]
            .filter((file) => file.startsWith(under(dir)))
            .map((file) => file.slice(under(dir).length).split(path.sep)[0]),
        ),
      ],
      readText: async (file) => {
        const content = world.files.get(file);
        if (content === undefined) {
          throw new Error(`ENOENT: ${file}`);
        }
        return content;
      },
      writeSecret: async (file, content) => {
        if (world.files.has(file)) {
          throw new Error(`EEXIST: ${file}`);
        }
        world.secretFiles.push({ path: file, content });
        world.files.set(file, content);
      },
      writeDurable: async (file, content) => {
        world.files.set(file, content);
      },
      remove: async (file) => {
        world.removed.push(file);
        world.files.delete(file);
      },
      rename: async (from, to) => {
        world.renames.push({ from, to });
        for (const [file, content] of [...world.files]) {
          if (file.startsWith(under(from))) {
            world.files.delete(file);
            world.files.set(`${to}${file.slice(from.length)}`, content);
          }
        }
      },
      makeDir: async () => undefined,
      size: async (file) => world.files.get(file)?.length ?? 0,
      readFrom: async (file, offset) =>
        (world.files.get(file) ?? "").slice(offset),
    },
    probeProcess: async (pid) => world.processes.get(pid) ?? "dead",
    connect: async (config) => {
      world.connections.push(config);
      const scripted = world.on.connect?.();
      if (scripted) {
        throw scripted;
      }
      if (livePostmaster() === undefined) {
        throw pgError("ECONNREFUSED", "connect ECONNREFUSED 127.0.0.1:5433");
      }
      return {
        query: async (text, values) => {
          world.queries.push(text);
          const scriptedError = world.on.query?.(text);
          if (scriptedError) {
            throw scriptedError;
          }
          const created = /^CREATE DATABASE "([^"]+)"/.exec(text);
          if (created) {
            world.databases.add(created[1]);
          }
          const found =
            text.includes("pg_database") &&
            !world.databases.has(String(values?.[0]));
          return { rows: found ? [] : [{}] };
        },
        end: async () => undefined,
      };
    },
    now: () => new Date(clock),
    sleep: async (ms) => {
      world.sleeps.push(ms);
      clock += ms;
    },
  };
  return world;
}
