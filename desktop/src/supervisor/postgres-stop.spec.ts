import { createPostgresRunner, PostgresRunnerError } from "./postgres";
import { createWorld, failed, FakeWorld, timedOut } from "./postgres.fake";

const HOME = "/home/first last/.local/share/Monize";
const DATA = `${HOME}/pgdata`;
const PID_FILE = `${DATA}/postmaster.pid`;

const runnerIn = (world: FakeWorld) =>
  createPostgresRunner(world.options, world.deps);

/** A world with a server this runner started, and the call log cleared. */
async function startedWorld() {
  const world = createWorld();
  const runner = runnerIn(world);
  await runner.start();
  world.calls.length = 0;
  world.statuses.length = 0;
  return { world, runner };
}

describe("createPostgresRunner: stop", () => {
  it("requests a fast shutdown and waits for it", async () => {
    const { world, runner } = await startedWorld();
    await runner.stop();
    expect(world.calls).toEqual([
      {
        binary: "pg_ctl",
        args: ["stop", "-D", DATA, "-m", "fast", "-w", "-t", "30"],
        attended: true,
        timeoutMs: 45_000,
      },
    ]);
    expect(world.files.has(PID_FILE)).toBe(false);
    expect(world.statuses).toEqual(["stopping", "stopped"]);
  });

  it.each([
    ["fails", failed("pg_ctl: server does not shut down\n")],
    ["runs out of time", timedOut()],
  ])(
    "falls back to an immediate shutdown when the fast one %s",
    async (_case, fast) => {
      const { world, runner } = await startedWorld();
      world.on.stop = (mode) => (mode === "fast" ? fast : undefined);
      await runner.stop();
      expect(world.calls.map((call) => call.args)).toEqual([
        ["stop", "-D", DATA, "-m", "fast", "-w", "-t", "30"],
        ["stop", "-D", DATA, "-m", "immediate", "-w", "-t", "15"],
      ]);
      expect(world.files.has(PID_FILE)).toBe(false);
      expect(world.statuses).toEqual(["stopping", "stopped"]);
      expect(world.logs.join("\n")).toContain(
        "requesting an immediate shutdown",
      );
    },
  );

  it("rejects when neither shutdown stops the server", async () => {
    const { world, runner } = await startedWorld();
    world.on.stop = (mode) => failed(`pg_ctl: ${mode} shutdown refused\n`);
    const error = await runner.stop().then(
      () => undefined,
      (reason: unknown) => reason as PostgresRunnerError,
    );
    expect(error).toBeInstanceOf(PostgresRunnerError);
    expect(error?.failure).toBe("stop");
    expect(error?.message).toContain(
      "fast: exit code 1; immediate: exit code 1",
    );
    expect(error?.outputTail).toBe(
      "pg_ctl: fast shutdown refused\n\npg_ctl: immediate shutdown refused",
    );
    expect(world.statuses).toEqual(["stopping"]);
  });

  it("counts a server that finished stopping between the two attempts as stopped", async () => {
    const { world, runner } = await startedWorld();
    world.on.stop = (mode) => {
      if (mode === "fast") {
        return timedOut();
      }
      world.processes.clear();
      world.files.delete(PID_FILE);
      return failed("pg_ctl: PID file does not exist\n");
    };
    await runner.stop();
    expect(world.statuses).toEqual(["stopping", "stopped"]);
  });

  it("is a no-op when nothing is running", async () => {
    const world = createWorld();
    await runnerIn(world).stop();
    expect(world.calls).toEqual([]);
    expect(world.statuses).toEqual([]);
  });

  it("is a no-op, and signals nothing, when the pid file is stale", async () => {
    const world = createWorld();
    world.files.set(PID_FILE, "4242\n");
    world.processes.set(4242, "other");
    await runnerIn(world).stop();
    expect(world.calls).toEqual([]);
    expect(world.files.has(PID_FILE)).toBe(true);
  });

  it("is a no-op the second time", async () => {
    const { world, runner } = await startedWorld();
    await runner.stop();
    await runner.stop();
    expect(world.commands()).toEqual(["pg_ctl stop fast"]);
  });

  it("stops a server an earlier session left running", async () => {
    const world = createWorld();
    world.files.set(PID_FILE, "4242\n");
    world.processes.set(4242, "postmaster");
    await runnerIn(world).stop();
    expect(world.commands()).toEqual(["pg_ctl stop fast"]);
    expect(world.processes.has(4242)).toBe(false);
  });
});

describe("createPostgresRunner: idempotence and ordering", () => {
  it("starts once however often start is called", async () => {
    const world = createWorld();
    const runner = runnerIn(world);
    await Promise.all([runner.start(), runner.start()]);
    await runner.start();
    expect(world.commands()).toEqual(["initdb", "pg_ctl start"]);
    expect(world.statuses).toEqual(["initializing", "starting", "ready"]);
  });

  it("runs a stop issued during a start after it", async () => {
    const world = createWorld();
    const runner = runnerIn(world);
    const starting = runner.start();
    const stopping = runner.stop();
    await Promise.all([starting, stopping]);
    expect(world.commands()).toEqual([
      "initdb",
      "pg_ctl start",
      "pg_ctl stop fast",
    ]);
    expect(world.files.has(PID_FILE)).toBe(false);
  });

  it("starts again after a stop", async () => {
    const { world, runner } = await startedWorld();
    await runner.stop();
    await runner.start();
    expect(world.commands()).toEqual(["pg_ctl stop fast", "pg_ctl start"]);
  });

  it("starts a new server when the one it started has died", async () => {
    const { world, runner } = await startedWorld();
    world.processes.clear();
    await runner.start();
    expect(world.removed).toContain(PID_FILE);
    expect(world.commands()).toEqual(["pg_ctl start"]);
    expect(world.statuses).toEqual(["recovering", "starting", "ready"]);
  });

  it("keeps serving calls after one of them has failed", async () => {
    const world = createWorld();
    world.on.initdb = () => failed("initdb: error\n");
    const runner = runnerIn(world);
    await expect(runner.start()).rejects.toBeInstanceOf(PostgresRunnerError);
    world.on.initdb = undefined;
    await runner.start();
    expect(world.statuses.at(-1)).toBe("ready");
  });
});
