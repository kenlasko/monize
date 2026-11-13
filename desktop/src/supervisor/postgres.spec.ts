import { createPostgresRunner, PostgresRunnerError } from "./postgres";
import {
  createWorld,
  failed,
  FakeWorld,
  PASSWORD,
  pgError,
  timedOut,
} from "./postgres.fake";

const HOME = "/home/first last/.local/share/Monize";
const DATA = `${HOME}/pgdata`;
const PW_FILE = `${HOME}/pgdata.initdb-password`;
const MARKER = `${DATA}/monize.initialized`;
const SETTINGS =
  "-c listen_addresses=127.0.0.1 -c port=5433 -c unix_socket_directories= -c timezone=UTC -c log_timezone=UTC -c log_checkpoints=off";

const runnerIn = (world: FakeWorld) =>
  createPostgresRunner(world.options, world.deps);

async function failureOf(promise: Promise<void>): Promise<PostgresRunnerError> {
  const error = await promise.then(
    () => undefined,
    (reason: unknown) => reason,
  );
  expect(error).toBeInstanceOf(PostgresRunnerError);
  return error as PostgresRunnerError;
}

/** A world whose cluster was created by an earlier run. */
function initializedWorld(): FakeWorld {
  const world = createWorld();
  world.files.set(`${DATA}/PG_VERSION`, "16\n");
  world.files.set(MARKER, "2026-11-01T09:00:00.000Z\n");
  world.databases.add("monize");
  return world;
}

describe("createPostgresRunner: first run", () => {
  it("runs initdb, marks the cluster, starts the server and creates the database", async () => {
    const world = createWorld();
    await runnerIn(world).start();

    expect(world.commands()).toEqual(["initdb", "pg_ctl start"]);
    const [initdb, start] = world.calls;
    expect(initdb.binary).toBe("initdb");
    expect(initdb.attended).toBe(true);
    expect(initdb.args).toEqual([
      `--pgdata=${DATA}`,
      "--username=monize",
      `--pwfile=${PW_FILE}`,
      "--auth=scram-sha-256",
      "--encoding=UTF8",
      "--locale=C",
    ]);
    expect(start.binary).toBe("pg_ctl");
    // The server would inherit a captured pipe and pg_ctl would never return.
    expect(start.attended).toBe(false);
    expect(start.args).toEqual([
      "start",
      "-D",
      DATA,
      "-w",
      "-t",
      "120",
      "-l",
      `${HOME}/logs/postgres.log`,
      "-o",
      SETTINGS,
    ]);
    expect(start.timeoutMs).toBe(135_000);

    expect(world.files.get(MARKER)).toBe("2026-11-13T10:00:00.000Z\n");
    expect(world.connections).toEqual([
      {
        host: "127.0.0.1",
        port: 5433,
        user: "monize",
        password: PASSWORD,
        database: "postgres",
        connectTimeoutMs: 5000,
      },
    ]);
    expect(world.queries).toEqual([
      "SELECT 1",
      "SELECT 1 FROM pg_database WHERE datname = $1",
      'CREATE DATABASE "monize" OWNER "monize"',
    ]);
    expect(world.databases.has("monize")).toBe(true);
    expect(world.statuses).toEqual(["initializing", "starting", "ready"]);
  });

  it("initializes a data directory that exists and is empty", async () => {
    const world = createWorld();
    world.emptyDirs.add(DATA);
    await runnerIn(world).start();
    expect(world.commands()).toEqual(["initdb", "pg_ctl start"]);
    expect(world.renames).toEqual([]);
  });

  it("hands initdb the password in a private file beside the data directory, then removes it", async () => {
    const world = createWorld();
    await runnerIn(world).start();
    expect(world.secretFiles).toEqual([
      { path: PW_FILE, content: `${PASSWORD}\n` },
    ]);
    expect(world.passwordSeenByInitdb).toBe(`${PASSWORD}\n`);
    expect(world.files.has(PW_FILE)).toBe(false);
  });

  it("removes the password file and writes no marker when initdb fails", async () => {
    const world = createWorld();
    world.on.initdb = () =>
      failed("initdb: error: could not create directory: Permission denied\n");
    const error = await failureOf(runnerIn(world).start());

    expect(error.failure).toBe("init");
    expect(error.message).toContain("initdb exited with code 1");
    expect(error.outputTail).toContain("Permission denied");
    expect(world.passwordSeenByInitdb).toBe(`${PASSWORD}\n`);
    expect(world.files.has(PW_FILE)).toBe(false);
    expect(world.files.has(MARKER)).toBe(false);
    expect(world.commands()).toEqual(["initdb"]);
  });

  it("removes the password file when initdb runs out of time", async () => {
    const world = createWorld();
    world.on.initdb = () => timedOut();
    const error = await failureOf(runnerIn(world).start());
    expect(error.message).toContain("did not finish within 300 seconds");
    expect(world.files.has(PW_FILE)).toBe(false);
    expect(world.files.has(MARKER)).toBe(false);
  });

  it("clears a password file left by a shell that died during an earlier initdb", async () => {
    const world = initializedWorld();
    world.files.set(PW_FILE, "an-older-password\n");
    await runnerIn(world).start();
    expect(world.files.has(PW_FILE)).toBe(false);
  });

  it("appends .exe and keeps Windows paths with spaces as single arguments", async () => {
    const world = createWorld("win32");
    await runnerIn(world).start();
    const home = "C:\\Users\\First Last\\AppData\\Local\\Monize";
    const [initdb, start] = world.calls;
    expect(initdb.binary).toBe("initdb.exe");
    expect(initdb.args.slice(0, 3)).toEqual([
      `--pgdata=${home}\\pgdata`,
      "--username=monize",
      `--pwfile=${home}\\pgdata.initdb-password`,
    ]);
    expect(start.binary).toBe("pg_ctl.exe");
    expect(start.args).toEqual([
      "start",
      "-D",
      `${home}\\pgdata`,
      "-w",
      "-t",
      "120",
      "-l",
      `${home}\\logs\\postgres.log`,
      "-o",
      SETTINGS,
    ]);
  });
});

describe("createPostgresRunner: later runs", () => {
  it("performs no init and leaves an existing database alone", async () => {
    const world = initializedWorld();
    await runnerIn(world).start();
    expect(world.commands()).toEqual(["pg_ctl start"]);
    expect(world.secretFiles).toEqual([]);
    expect(world.queries).toEqual([
      "SELECT 1",
      "SELECT 1 FROM pg_database WHERE datname = $1",
    ]);
    expect(world.statuses).toEqual(["starting", "ready"]);
  });

  it("creates the database when an earlier run died before creating it", async () => {
    const world = initializedWorld();
    world.databases.delete("monize");
    await runnerIn(world).start();
    expect(world.queries).toContain('CREATE DATABASE "monize" OWNER "monize"');
  });
});

describe("createPostgresRunner: interrupted first run", () => {
  it("renames the directory aside and initializes afresh, deleting nothing", async () => {
    const world = createWorld();
    world.files.set(`${DATA}/PG_VERSION`, "16\n");
    world.files.set(`${DATA}/base/1/1259`, "half a catalog");
    await runnerIn(world).start();

    const aside = `${DATA}.incomplete-20261113T100000000Z`;
    expect(world.renames).toEqual([{ from: DATA, to: aside }]);
    expect(world.files.get(`${aside}/base/1/1259`)).toBe("half a catalog");
    expect(world.removed.filter((file) => file !== PW_FILE)).toEqual([]);
    expect(world.commands()).toEqual(["initdb", "pg_ctl start"]);
    expect(world.files.has(MARKER)).toBe(true);
    expect(world.logs.join("\n")).toContain(
      `held an initialization that never finished; moved it to ${aside}`,
    );
  });

  it("fails without running initdb when the directory cannot be moved", async () => {
    const world = createWorld();
    world.files.set(`${DATA}/PG_VERSION`, "16\n");
    world.deps = {
      ...world.deps,
      fs: {
        ...world.deps.fs,
        rename: async () => {
          throw new Error("EBUSY: resource busy or locked");
        },
      },
    };
    const error = await failureOf(runnerIn(world).start());
    expect(error.failure).toBe("init");
    expect(error.message).toContain("EBUSY");
    expect(world.calls).toEqual([]);
    expect(world.files.has(`${DATA}/PG_VERSION`)).toBe(true);
  });
});

describe("createPostgresRunner: the password stays secret", () => {
  const leaks = (world: FakeWorld, error?: PostgresRunnerError): string[] =>
    [
      ...world.calls.flatMap((call) => call.args),
      ...world.logs,
      error?.message ?? "",
      error?.outputTail ?? "",
      error?.stack ?? "",
    ].filter((text) => text.includes(PASSWORD));

  it("is in no argument list and no log line on a clean first run and stop", async () => {
    const world = createWorld();
    const runner = runnerIn(world);
    await runner.start();
    await runner.stop();
    expect(leaks(world)).toEqual([]);
  });

  it.each([
    [
      "initdb echoes it",
      (world: FakeWorld) => {
        world.on.initdb = () => failed(`initdb: bad password "${PASSWORD}"\n`);
      },
    ],
    [
      "the server log holds it",
      (world: FakeWorld) => {
        world.on.start = () => {
          world.files.set(
            world.options.serverLogFile,
            `FATAL: password is ${PASSWORD}\n`,
          );
          return failed();
        };
      },
    ],
    [
      "the driver reports it",
      (world: FakeWorld) => {
        world.on.connect = () =>
          pgError("28P01", `password "${PASSWORD}" rejected for monize`);
      },
    ],
    [
      "a query error quotes it",
      (world: FakeWorld) => {
        world.on.query = () => new Error(`syntax error near ${PASSWORD}`);
      },
    ],
    [
      "pg_ctl stop prints it",
      (world: FakeWorld) => {
        world.on.connect = () => new Error("connection refused");
        world.on.stop = () => failed(`pg_ctl: ${PASSWORD}\n`);
      },
    ],
  ])("is redacted from the error when %s", async (_case, arrange) => {
    const world = createWorld();
    arrange(world);
    const error = await failureOf(runnerIn(world).start());
    expect(leaks(world, error)).toEqual([]);
  });

  it("is redacted from an unexpected failure of a capability", async () => {
    const world = createWorld();
    world.deps = {
      ...world.deps,
      fs: {
        ...world.deps.fs,
        makeDir: async () => {
          throw new Error(`EACCES: ${PASSWORD}`);
        },
      },
    };
    const error = await failureOf(runnerIn(world).start());
    expect(error.failure).toBe("start");
    expect(error.message).toBe("EACCES: [redacted]");
  });
});

describe("createPostgresRunner: options", () => {
  it.each([
    ["a port out of range", { port: 70000 }, "port"],
    ["a fractional port", { port: 5433.5 }, "port"],
    ["a database name needing quotes", { database: 'mon"ize' }, "database"],
    ["an upper-case superuser", { superuser: "Monize" }, "superuser"],
    ["an empty password", { password: "" }, "password"],
    ["a two-line password", { password: "one\ntwo" }, "password"],
    ["a relative data directory", { dataDir: "pgdata" }, "data directory"],
    [
      "a data directory the shell would expand",
      { dataDir: "/home/$USER/pgdata" },
      "data directory",
    ],
    [
      "a log path with a double quote",
      { serverLogFile: '/var/log/"pg".log' },
      "server log file",
    ],
  ])("rejects %s before running anything", async (_case, override, named) => {
    const world = createWorld("linux", override);
    const error = await failureOf(runnerIn(world).start());
    expect(error.failure).toBe("config");
    expect(error.message).toContain(named);
    expect(world.calls).toEqual([]);
    expect(world.secretFiles).toEqual([]);
  });

  it("never repeats a rejected password in the error", async () => {
    const world = createWorld("linux", { password: "alpha\nbravo" });
    const error = await failureOf(runnerIn(world).start());
    expect(error.message).not.toContain("alpha");
    expect(error.message).not.toContain("bravo");
  });
});
