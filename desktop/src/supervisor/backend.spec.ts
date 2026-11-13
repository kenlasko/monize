import { fakeSpawner } from "../test-support/fake-process";
import { flush, manualClock } from "../test-support/manual-clock";
import { memoryLogger } from "../test-support/memory-logger";
import {
  BACKEND_BOOT_SCRIPTS,
  BACKEND_ONE_SHOT_STEPS,
  BACKEND_SERVER_SCRIPT,
  BackendOneShotStep,
  exitCause,
  runBackendOneShot,
  startBackendServer,
} from "./backend";
import { createChildLauncher } from "./child";

const RUNTIME = { cwd: "/res/backend", env: { DATABASE_NAME: "monize" } };
const [DB_INIT, DB_MIGRATE] = BACKEND_ONE_SHOT_STEPS;

function setup() {
  const spawner = fakeSpawner();
  const clock = manualClock();
  const logger = memoryLogger();
  const launch = createChildLauncher({
    execPath: "/opt/monize/Monize",
    logger,
    spawn: spawner.spawn,
    clock,
  });
  const controller = new AbortController();
  const run = (step: BackendOneShotStep = DB_MIGRATE, deadlineMs = 60_000) =>
    runBackendOneShot(step, {
      launch,
      runtime: RUNTIME,
      clock,
      deadlineMs,
      signal: controller.signal,
    });
  return { spawner, clock, launch, controller, run };
}

describe("the backend boot sequence", () => {
  it("is db-init, db-migrate, then the server", () => {
    expect(BACKEND_BOOT_SCRIPTS).toEqual([
      "dist/db-init.js",
      "dist/db-migrate.js",
      "dist/main.js",
    ]);
    expect(BACKEND_ONE_SHOT_STEPS.map((oneShot) => oneShot.step)).toEqual([
      "db-init",
      "db-migrate",
    ]);
  });
});

describe("runBackendOneShot", () => {
  it("runs the script in the backend directory with the backend environment", async () => {
    const { spawner, run } = setup();

    const running = run(DB_INIT);
    await flush();

    const [spawned] = spawner.processes;
    expect(spawned.args).toEqual(["dist/db-init.js"]);
    expect(spawned.options.cwd).toBe("/res/backend");
    expect(spawned.options.env).toEqual({ DATABASE_NAME: "monize" });
    spawned.exit(0);
    await expect(running).resolves.toEqual({ kind: "ok" });
  });

  it("is ok only on exit code 0, and leaves no deadline timer armed", async () => {
    const { spawner, clock, run } = setup();

    const running = run();
    await flush();
    spawner.processes[0].exit(0);

    await expect(running).resolves.toEqual({ kind: "ok" });
    expect(clock.pending).toBe(0);
  });

  it("fails with the exit code on a non-zero exit", async () => {
    const { spawner, run } = setup();

    const running = run();
    await flush();
    spawner.processes[0].exit(1);

    await expect(running).resolves.toEqual({
      kind: "failed",
      cause: { kind: "exited", code: 1, signal: null },
    });
  });

  it("fails when the script is ended by a signal it was not sent by us", async () => {
    const { spawner, run } = setup();

    const running = run();
    await flush();
    spawner.processes[0].exit(null, "SIGKILL");

    await expect(running).resolves.toEqual({
      kind: "failed",
      cause: { kind: "exited", code: null, signal: "SIGKILL" },
    });
  });

  it("fails with the spawn error when the executable cannot be started", async () => {
    const { spawner, run } = setup();

    const running = run();
    await flush();
    spawner.processes[0].failToStart("ENOENT");

    await expect(running).resolves.toMatchObject({
      kind: "failed",
      cause: { kind: "spawn-error", code: "ENOENT" },
    });
  });

  it("stops the script at its deadline and fails with a timeout", async () => {
    const { spawner, clock, run } = setup();

    const running = run(DB_MIGRATE, 60_000);
    await clock.advance(59_999);
    expect(spawner.processes[0].kills).toEqual([]);
    await clock.advance(1);

    await expect(running).resolves.toEqual({
      kind: "failed",
      cause: {
        kind: "timeout",
        deadlineMs: 60_000,
        lastStatus: null,
        lastError: null,
      },
    });
    // Stopped before the result is returned, never left running behind it.
    expect(spawner.processes[0].kills).toEqual(["SIGTERM"]);
    expect(spawner.processes[0].running).toBe(false);
  });

  it("stops the script when aborted, and is cancelled rather than failed", async () => {
    const { spawner, clock, controller, run } = setup();

    const running = run();
    await flush();
    controller.abort();

    await expect(running).resolves.toEqual({ kind: "cancelled" });
    expect(spawner.processes[0].kills).toEqual(["SIGTERM"]);
    expect(spawner.processes[0].running).toBe(false);
    expect(clock.pending).toBe(0);
  });

  it("does not resolve a cancel until a slow-to-die script is gone", async () => {
    const { spawner, clock, controller, run } = setup();
    spawner.onSpawn = (spawned) => spawned.ignore("SIGTERM");

    let done = false;
    const running = run().then((result) => {
      done = true;
      return result;
    });
    await flush();
    controller.abort();
    await clock.advance(4999);
    expect(done).toBe(false);
    await clock.advance(1);

    await expect(running).resolves.toEqual({ kind: "cancelled" });
    expect(spawner.processes[0].kills).toEqual(["SIGTERM", "SIGKILL"]);
  });

  it("starts nothing when it is already aborted", async () => {
    const { spawner, controller, run } = setup();
    controller.abort();

    await expect(run()).resolves.toEqual({ kind: "cancelled" });
    expect(spawner.processes).toHaveLength(0);
  });
});

describe("startBackendServer", () => {
  it("starts the server script and hands back its handle", () => {
    const { spawner, launch } = setup();

    const handle = startBackendServer(launch, RUNTIME);

    expect(spawner.processes[0].args).toEqual([BACKEND_SERVER_SCRIPT]);
    expect(spawner.processes[0].options.cwd).toBe("/res/backend");
    expect(handle.pid).toBe(spawner.processes[0].pid);
  });
});

describe("exitCause", () => {
  it("names a process that never started a spawn error", () => {
    expect(
      exitCause({
        code: null,
        signal: null,
        error: Object.assign(new Error("spawn EACCES"), { code: "EACCES" }),
      }),
    ).toEqual({ kind: "spawn-error", code: "EACCES", message: "spawn EACCES" });
  });

  it("names any other end an exit, code 0 included", () => {
    expect(exitCause({ code: 0, signal: null })).toEqual({
      kind: "exited",
      code: 0,
      signal: null,
    });
  });
});
