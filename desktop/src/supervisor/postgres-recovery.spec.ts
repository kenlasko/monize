import { createPostgresRunner, PostgresRunnerError } from "./postgres";
import {
  createWorld,
  failed,
  FakeWorld,
  pgError,
  timedOut,
} from "./postgres.fake";

const HOME = "/home/first last/.local/share/Monize";
const DATA = `${HOME}/pgdata`;
const PID_FILE = `${DATA}/postmaster.pid`;
const LOG_FILE = `${HOME}/logs/postgres.log`;

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

/** An initialized cluster whose `postmaster.pid` names the given pid. */
function worldWithPidFile(firstLine = "4242"): FakeWorld {
  const world = createWorld();
  world.files.set(`${DATA}/PG_VERSION`, "16\n");
  world.files.set(`${DATA}/monize.initialized`, "2026-11-01T09:00:00.000Z\n");
  world.files.set(PID_FILE, `${firstLine}\n${DATA}\n1794000000\n5433\n`);
  world.databases.add("monize");
  return world;
}

/** Makes the next `count` starts fail with the given server log output. */
function failStarts(world: FakeWorld, serverLog: string, count = Infinity) {
  let remaining = count;
  world.on.start = () => {
    if (remaining <= 0) {
      return undefined;
    }
    remaining -= 1;
    world.files.set(LOG_FILE, `${world.files.get(LOG_FILE) ?? ""}${serverLog}`);
    return failed();
  };
}

describe("createPostgresRunner: a postmaster.pid left behind", () => {
  it("removes the stale file when its process is gone, then starts", async () => {
    const world = worldWithPidFile();
    await runnerIn(world).start();
    expect(world.removed).toContain(PID_FILE);
    expect(world.commands()).toEqual(["pg_ctl start"]);
    expect(world.statuses).toEqual(["recovering", "starting", "ready"]);
    expect(world.logs.join("\n")).toContain("pid 4242 is gone");
  });

  it("removes the file when its pid now belongs to another program, and signals nothing", async () => {
    const world = worldWithPidFile();
    world.processes.set(4242, "other");
    await runnerIn(world).start();
    expect(world.removed).toContain(PID_FILE);
    expect(world.commands()).toEqual(["pg_ctl start"]);
    expect(world.processes.get(4242)).toBe("other");
    expect(world.logs.join("\n")).toContain(
      "pid 4242, which now belongs to another program",
    );
  });

  it("shuts down a server that outlived its shell, then starts its own", async () => {
    const world = worldWithPidFile();
    world.processes.set(4242, "postmaster");
    await runnerIn(world).start();
    expect(world.commands()).toEqual(["pg_ctl stop fast", "pg_ctl start"]);
    expect(world.processes.has(4242)).toBe(false);
    expect(world.files.get(PID_FILE)).toMatch(/^5001\n/);
    expect(world.statuses).toEqual(["recovering", "starting", "ready"]);
  });

  it("uses an immediate shutdown when the orphan does not answer a fast one", async () => {
    const world = worldWithPidFile();
    world.processes.set(4242, "postmaster");
    world.on.stop = (mode) => (mode === "fast" ? timedOut() : undefined);
    await runnerIn(world).start();
    expect(world.commands()).toEqual([
      "pg_ctl stop fast",
      "pg_ctl stop immediate",
      "pg_ctl start",
    ]);
  });

  it("does not start beside an orphan it cannot shut down", async () => {
    const world = worldWithPidFile();
    world.processes.set(4242, "postmaster");
    world.on.stop = () =>
      failed("pg_ctl: could not send stop signal (PID: 4242)\n");
    const error = await failureOf(runnerIn(world).start());
    expect(error.failure).toBe("recover");
    expect(error.message).toContain("pid 4242");
    expect(error.outputTail).toContain("could not send stop signal");
    expect(world.commands()).toEqual([
      "pg_ctl stop fast",
      "pg_ctl stop immediate",
    ]);
    expect(world.files.has(PID_FILE)).toBe(true);
  });

  it("reads the pid of a single-user backend, which the file stores negated", async () => {
    const world = worldWithPidFile("-4242");
    await runnerIn(world).start();
    expect(world.logs.join("\n")).toContain("pid 4242 is gone");
  });

  it("re-reads an empty file before removing it as damaged", async () => {
    const world = worldWithPidFile("");
    await runnerIn(world).start();
    expect(world.sleeps).toEqual([200, 200]);
    expect(world.removed).toContain(PID_FILE);
    expect(world.commands()).toEqual(["pg_ctl start"]);
    expect(world.logs.join("\n")).toContain("empty or damaged");
  });

  it("does not look for a pid file in a cluster it has just created", async () => {
    const world = createWorld();
    await runnerIn(world).start();
    expect(world.removed).not.toContain(PID_FILE);
    expect(world.statuses).not.toContain("recovering");
  });
});

describe("createPostgresRunner: a start that fails", () => {
  it("reports what the server logged during this attempt only", async () => {
    const world = worldWithPidFile();
    world.files.delete(PID_FILE);
    world.files.set(LOG_FILE, "LOG:  an older, unrelated line\n");
    failStarts(
      world,
      'LOG:  could not bind IPv4 address "127.0.0.1": Address already in use\nFATAL:  could not create any TCP/IP sockets\n',
    );
    const error = await failureOf(runnerIn(world).start());
    expect(error.failure).toBe("start");
    expect(error.message).toBe(
      "The database server did not start on 127.0.0.1:5433 (pg_ctl: exit code 1).",
    );
    expect(error.outputTail).toBe(
      'LOG:  could not bind IPv4 address "127.0.0.1": Address already in use\nFATAL:  could not create any TCP/IP sockets',
    );
    expect(world.commands()).toEqual(["pg_ctl start"]);
    expect(world.statuses).toEqual(["starting"]);
  });

  it("shuts down a server pg_ctl stopped waiting for", async () => {
    const world = worldWithPidFile();
    world.files.delete(PID_FILE);
    world.on.start = () => {
      // Still replaying its log when pg_ctl's -t passed.
      world.processes.set(7000, "postmaster");
      world.files.set(PID_FILE, "7000\n");
      return failed();
    };
    const error = await failureOf(runnerIn(world).start());
    expect(error.failure).toBe("start");
    expect(world.commands()).toEqual(["pg_ctl start", "pg_ctl stop fast"]);
    expect(world.processes.has(7000)).toBe(false);
  });

  it("waits for the backends of a killed server to exit", async () => {
    const world = worldWithPidFile();
    failStarts(
      world,
      "FATAL:  pre-existing shared memory block (key 36126617, ID 32772) is still in use\n",
      3,
    );
    await runnerIn(world).start();
    expect(world.commands()).toEqual([
      "pg_ctl start",
      "pg_ctl start",
      "pg_ctl start",
      "pg_ctl start",
    ]);
    expect(world.sleeps).toEqual([1000, 1000, 1000]);
    expect(
      world.logs.filter((line) => line.includes("still exiting")),
    ).toHaveLength(1);
  });

  it("stops waiting for them after twenty seconds", async () => {
    const world = worldWithPidFile();
    failStarts(
      world,
      "FATAL:  pre-existing shared memory block is still in use\n",
    );
    const error = await failureOf(runnerIn(world).start());
    expect(error.failure).toBe("start");
    expect(error.outputTail).toContain("pre-existing shared memory block");
    expect(world.sleeps.reduce((sum, ms) => sum + ms, 0)).toBe(20_000);
  });

  it("does not retry any other failure", async () => {
    const world = worldWithPidFile();
    failStarts(world, "FATAL:  could not create any TCP/IP sockets\n");
    await failureOf(runnerIn(world).start());
    expect(world.commands()).toEqual(["pg_ctl start"]);
  });
});

describe("createPostgresRunner: readiness", () => {
  it("retries the connection until the server accepts it", async () => {
    const world = createWorld();
    const refusals = [
      pgError("ECONNREFUSED", "connect ECONNREFUSED 127.0.0.1:5433"),
      pgError("57P03", "the database system is starting up"),
    ];
    world.on.connect = () => refusals.shift();
    await runnerIn(world).start();
    expect(world.connections).toHaveLength(3);
    expect(world.sleeps).toEqual([250, 250]);
    expect(world.statuses).toEqual(["initializing", "starting", "ready"]);
  });

  it("reports a rejected password at once and shuts the server down again", async () => {
    const world = createWorld();
    world.on.connect = () =>
      pgError("28P01", 'password authentication failed for user "monize"');
    const error = await failureOf(runnerIn(world).start());
    expect(error.failure).toBe("auth");
    expect(error.message).toContain("rejected the stored password");
    expect(error.outputTail).toContain("password authentication failed");
    expect(world.connections).toHaveLength(1);
    expect(world.commands()).toEqual([
      "initdb",
      "pg_ctl start",
      "pg_ctl stop fast",
    ]);
    expect(world.files.has(PID_FILE)).toBe(false);
    expect(world.statuses).not.toContain("ready");
  });

  it("gives up when no connection is accepted within the bound, and shuts down", async () => {
    const world = createWorld("linux", { timeouts: { readySeconds: 2 } });
    world.on.connect = () => pgError("ECONNRESET", "read ECONNRESET");
    const error = await failureOf(runnerIn(world).start());
    expect(error.failure).toBe("ready");
    expect(error.message).toContain("within 2 seconds");
    expect(error.outputTail).toBe("read ECONNRESET");
    expect(world.commands().at(-1)).toBe("pg_ctl stop fast");
    expect(world.files.has(PID_FILE)).toBe(false);
  });

  it("reports a failed CREATE DATABASE and shuts down", async () => {
    const world = createWorld();
    world.on.query = (text) =>
      text.startsWith("CREATE DATABASE")
        ? pgError("53100", "could not extend file: No space left on device")
        : undefined;
    const error = await failureOf(runnerIn(world).start());
    expect(error.failure).toBe("database");
    expect(error.outputTail).toContain("No space left on device");
    expect(world.commands().at(-1)).toBe("pg_ctl stop fast");
  });

  it("starts again cleanly after a failed start", async () => {
    const world = createWorld();
    world.on.start = () => failed();
    const runner = runnerIn(world);
    await failureOf(runner.start());
    world.on.start = undefined;
    await runner.start();
    expect(world.commands()).toEqual([
      "initdb",
      "pg_ctl start",
      "pg_ctl start",
    ]);
    expect(world.statuses.at(-1)).toBe("ready");
  });
});
