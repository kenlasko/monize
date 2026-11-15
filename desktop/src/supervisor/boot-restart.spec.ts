import {
  BACKEND,
  BACKEND_URL,
  bootHarness,
  DB_INIT,
  DB_MIGRATE,
  FRONTEND,
  FRONTEND_URL,
  SPAWN_FRONTEND,
} from "../test-support/boot-harness";
import { flush } from "../test-support/manual-clock";

const BACKOFF = 2000;
const WINDOW = 60_000;
const OPTIONS = { restartBackoffMs: BACKOFF, restartWindowMs: WINDOW };

describe("after ready: a child that exits", () => {
  it("restarts a crashed frontend once, after the backoff", async () => {
    const h = bootHarness(OPTIONS);
    await h.bootToReady();

    h.proc(FRONTEND).exit(1);
    await h.clock.advance(BACKOFF - 1);
    expect(h.journal).toEqual([`exit ${FRONTEND}`]);
    expect(h.supervisor.status).toBe("restarting-frontend");

    await h.clock.advance(1);

    expect(h.journal).toEqual([`exit ${FRONTEND}`, SPAWN_FRONTEND]);
    expect(h.proc(FRONTEND).running).toBe(true);
    expect(h.statuses.slice(-3)).toEqual([
      "ready",
      "restarting-frontend",
      "ready",
    ]);
    expect(h.fatals).toEqual([]);
    expect(h.clock.pending).toBe(0);
  });

  it("restarts a crashed backend with main.js only: db-init and db-migrate do not run again", async () => {
    const h = bootHarness(OPTIONS);
    await h.bootToReady();

    h.proc(BACKEND).exit(1);
    await h.clock.advance(BACKOFF);

    expect(h.journal).toEqual([`exit ${BACKEND}`, `spawn ${BACKEND}`]);
    expect(
      h.spawner.processes.filter((process) =>
        [DB_INIT, DB_MIGRATE].includes(process.script),
      ),
    ).toHaveLength(2);
    expect(h.proc(BACKEND).options).toMatchObject({ cwd: "/res/backend" });
    expect(h.statuses.slice(-2)).toEqual(["restarting-backend", "ready"]);
  });

  it("stays restarting until the restarted child answers its health route", async () => {
    const h = bootHarness(OPTIONS);
    await h.bootToReady();
    h.fetch.respond(BACKEND_URL, "refused");

    h.proc(BACKEND).exit(1);
    await h.clock.advance(BACKOFF + 1000);
    expect(h.supervisor.status).toBe("restarting-backend");

    h.fetch.respond(BACKEND_URL, 200);
    await h.clock.advance(250);
    expect(h.supervisor.status).toBe("ready");
  });

  it("raises a fatal failure with the log tail on a second exit within the window, and stops trying", async () => {
    const h = bootHarness(OPTIONS);
    await h.bootToReady();
    h.proc(FRONTEND).exit(1);
    await h.clock.advance(BACKOFF);
    h.proc(FRONTEND).stderr.emit("data", "Error: EADDRINUSE 3380\n");

    await h.clock.advance(WINDOW - BACKOFF);
    h.proc(FRONTEND).exit(7);
    await flush();

    expect(h.fatals).toHaveLength(1);
    expect(h.fatals[0]).toMatchObject({
      child: "frontend",
      cause: { kind: "exited", code: 7, signal: null },
      logSource: "frontend",
    });
    expect(h.fatals[0].logTail.map((record) => record.msg)).toEqual([
      "Error: EADDRINUSE 3380",
    ]);
    expect(h.supervisor.status).toBe("fatal");
    expect(h.supervisor.fatal).toBe(h.fatals[0]);

    // It stops trying: no third process, however long we wait.
    const spawned = h.spawner.processes.length;
    await h.clock.advance(10 * WINDOW);
    expect(h.spawner.processes).toHaveLength(spawned);
    expect(h.fatals).toHaveLength(1);
    expect(h.clock.pending).toBe(0);
  });

  it("forgives a restart once the window has passed: a later exit is restarted again", async () => {
    const h = bootHarness(OPTIONS);
    await h.bootToReady();
    h.proc(BACKEND).exit(1);
    await h.clock.advance(BACKOFF);

    await h.clock.advance(WINDOW - BACKOFF + 1);
    h.proc(BACKEND).exit(1);
    await h.clock.advance(BACKOFF);

    expect(h.fatals).toEqual([]);
    expect(h.supervisor.status).toBe("ready");
    expect(
      h.spawner.processes.filter((process) => process.script === BACKEND),
    ).toHaveLength(3);
  });

  it("gives each child its own restart: a frontend crash does not spend the backend's", async () => {
    const h = bootHarness(OPTIONS);
    await h.bootToReady();

    h.proc(FRONTEND).exit(1);
    h.proc(BACKEND).exit(1);
    await flush();
    expect(h.supervisor.status).toBe("restarting-backend");
    await h.clock.advance(BACKOFF);

    expect(h.fatals).toEqual([]);
    expect(h.proc(FRONTEND).running).toBe(true);
    expect(h.proc(BACKEND).running).toBe(true);
    expect(h.supervisor.status).toBe("ready");
  });

  it("is fatal when the restarted child exits before it is healthy, whatever the window", async () => {
    const h = bootHarness({ ...OPTIONS, restartWindowMs: 0 });
    await h.bootToReady();
    h.fetch.respond(BACKEND_URL, "refused");
    h.proc(BACKEND).exit(1);
    await h.clock.advance(BACKOFF + 5000);

    h.proc(BACKEND).exit(1);
    await flush();

    expect(h.fatals).toHaveLength(1);
    expect(h.fatals[0].cause).toEqual({
      kind: "exited",
      code: 1,
      signal: null,
    });
    expect(h.clock.pending).toBe(0);
    expect(h.fetch.open).toBe(0);
  });

  it("is fatal when the restarted child never becomes healthy", async () => {
    const h = bootHarness({ ...OPTIONS, backendReadyDeadlineMs: 30_000 });
    await h.bootToReady();
    h.fetch.respond(BACKEND_URL, 503);
    h.proc(BACKEND).exit(1);
    await h.clock.advance(BACKOFF);

    await h.clock.advance(30_000);

    expect(h.fatals).toHaveLength(1);
    expect(h.fatals[0]).toMatchObject({
      child: "backend",
      cause: { kind: "timeout", deadlineMs: 30_000, lastStatus: 503 },
    });
    expect(h.supervisor.status).toBe("fatal");
  });

  it("restarts a backend that died while the frontend was still starting", async () => {
    const h = bootHarness(OPTIONS);
    h.fetch.respond(BACKEND_URL, 200);
    const { started } = await h.bootToBackend();
    h.proc(BACKEND).exit(1);
    h.fetch.respond(FRONTEND_URL, 200);
    await h.clock.advance(250);
    await expect(started).resolves.toEqual({ outcome: "ready" });

    await h.clock.advance(BACKOFF);

    expect(h.proc(BACKEND).running).toBe(true);
    expect(h.supervisor.status).toBe("ready");
  });
});

describe("after ready: stop() and the restart policy", () => {
  it("during the backoff restarts nothing and leaves no timer armed", async () => {
    const h = bootHarness(OPTIONS);
    await h.bootToReady();
    h.proc(FRONTEND).exit(1);
    await flush();
    expect(h.clock.pending).toBe(1);

    await h.supervisor.stop();
    await h.clock.advance(10 * BACKOFF);

    expect(h.journal).toEqual([
      `exit ${FRONTEND}`,
      `kill ${BACKEND} SIGTERM`,
      `exit ${BACKEND}`,
      "postgres.stop",
    ]);
    expect(h.clock.pending).toBe(0);
    expect(h.statuses.slice(-2)).toEqual(["stopping", "stopped"]);
  });

  it("while a restarted child is starting stops that new child", async () => {
    const h = bootHarness(OPTIONS);
    await h.bootToReady();
    h.fetch.respond(BACKEND_URL, "hang");
    h.proc(BACKEND).exit(1);
    await h.clock.advance(BACKOFF);
    const restarted = h.proc(BACKEND);
    h.journal.length = 0;

    await h.supervisor.stop();

    expect(restarted.running).toBe(false);
    expect(h.journal).toEqual([
      `kill ${FRONTEND} SIGTERM`,
      `exit ${FRONTEND}`,
      `kill ${BACKEND} SIGTERM`,
      `exit ${BACKEND}`,
      "postgres.stop",
    ]);
    expect(h.fatals).toEqual([]);
    expect(h.fetch.open).toBe(0);
    expect(h.clock.pending).toBe(0);
  });

  it("after a fatal failure still stops what is running, in order", async () => {
    const h = bootHarness(OPTIONS);
    await h.bootToReady();
    h.proc(FRONTEND).exit(1);
    await h.clock.advance(BACKOFF);
    h.proc(FRONTEND).exit(1);
    await flush();
    expect(h.supervisor.status).toBe("fatal");
    h.journal.length = 0;

    await expect(h.supervisor.stop()).resolves.toEqual({ errors: [] });

    expect(h.journal).toEqual([
      `kill ${BACKEND} SIGTERM`,
      `exit ${BACKEND}`,
      "postgres.stop",
    ]);
    expect(h.statuses.slice(-3)).toEqual(["fatal", "stopping", "stopped"]);
  });

  it("does not restart a child on a fatal failure of the other", async () => {
    const h = bootHarness(OPTIONS);
    await h.bootToReady();
    h.proc(FRONTEND).exit(1);
    await h.clock.advance(BACKOFF);
    h.proc(FRONTEND).exit(1);
    await flush();
    const spawned = h.spawner.processes.length;

    h.proc(BACKEND).exit(1);
    await h.clock.advance(10 * BACKOFF);

    expect(h.spawner.processes).toHaveLength(spawned);
    expect(h.fatals).toHaveLength(1);
  });
});
