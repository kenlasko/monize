import {
  BACKEND,
  BACKEND_URL,
  bootHarness,
  DB_INIT,
  DB_MIGRATE,
  deferred,
  FRONTEND,
  FRONTEND_URL,
} from "../test-support/boot-harness";
import { flush } from "../test-support/manual-clock";

describe("boot: stop() while booting", () => {
  it("during the postgres step waits for the start to settle, then stops PostgreSQL", async () => {
    const h = bootHarness();
    const gate = deferred();
    h.postgres.startGate = gate.promise;
    const started = h.supervisor.start();
    await flush();

    const stopped = h.supervisor.stop();
    await flush();
    // start() cannot be interrupted, and stopping under it is not attempted.
    expect(h.journal).toEqual(["postgres.start"]);

    gate.resolve();
    await expect(started).resolves.toEqual({ outcome: "cancelled" });
    await expect(stopped).resolves.toEqual({ errors: [] });
    expect(h.journal).toEqual(["postgres.start", "postgres.stop"]);
    expect(h.statuses).toEqual(["postgres", "stopping", "stopped"]);
  });

  it("is cancelled, not failed, when the postgres start rejects after the stop", async () => {
    const h = bootHarness();
    const gate = deferred();
    h.postgres.startGate = gate.promise;
    const started = h.supervisor.start();
    await flush();

    const stopped = h.supervisor.stop();
    h.postgres.startError = new Error("interrupted");
    gate.resolve();

    await expect(started).resolves.toEqual({ outcome: "cancelled" });
    await stopped;
    expect(h.supervisor.status).toBe("stopped");
  });

  it("during db-migrate stops the migration and PostgreSQL, and starts no backend", async () => {
    const h = bootHarness();
    const started = h.supervisor.start();
    await flush();
    h.proc(DB_INIT).exit(0);
    await flush();
    h.journal.length = 0;

    const stopped = h.supervisor.stop();

    await expect(started).resolves.toEqual({ outcome: "cancelled" });
    await stopped;
    expect(h.journal).toEqual([
      `kill ${DB_MIGRATE} SIGTERM`,
      `exit ${DB_MIGRATE}`,
      "postgres.stop",
    ]);
    expect(h.clock.pending).toBe(0);
  });

  it("while the backend is starting cancels the health wait and stops the backend", async () => {
    const h = bootHarness();
    h.fetch.respond(BACKEND_URL, "hang");
    const { started } = await h.bootToBackend();
    h.journal.length = 0;

    const stopped = h.supervisor.stop();

    await expect(started).resolves.toEqual({ outcome: "cancelled" });
    await expect(stopped).resolves.toEqual({ errors: [] });
    expect(h.journal).toEqual([
      `kill ${BACKEND} SIGTERM`,
      `exit ${BACKEND}`,
      "postgres.stop",
    ]);
    expect(h.fetch.open).toBe(0);
    expect(h.clock.pending).toBe(0);
    expect(h.statuses.slice(-2)).toEqual(["stopping", "stopped"]);
  });

  it("while the frontend is starting stops frontend, backend, then PostgreSQL", async () => {
    const h = bootHarness();
    h.fetch.respond(BACKEND_URL, 200);
    const { started } = await h.bootToBackend();
    h.journal.length = 0;

    const stopped = h.supervisor.stop();

    await expect(started).resolves.toEqual({ outcome: "cancelled" });
    await stopped;
    expect(h.journal).toEqual([
      `kill ${FRONTEND} SIGTERM`,
      `exit ${FRONTEND}`,
      `kill ${BACKEND} SIGTERM`,
      `exit ${BACKEND}`,
      "postgres.stop",
    ]);
  });

  it("in the same turn as start() starts nothing at all", async () => {
    const h = bootHarness();

    const started = h.supervisor.start();
    const stopped = h.supervisor.stop();

    await expect(started).resolves.toEqual({ outcome: "cancelled" });
    await stopped;
    expect(h.journal).toEqual([]);
    expect(h.statuses).toEqual(["stopping", "stopped"]);
  });

  it("never reports ready for a boot whose last step finished as the stop arrived", async () => {
    const h = bootHarness();
    h.fetch.respond(BACKEND_URL, 200);
    const { started } = await h.bootToBackend();
    h.fetch.respond(FRONTEND_URL, 200);

    // The next poll would make the boot ready; the stop gets in first.
    const stopped = h.supervisor.stop();
    await h.clock.advance(250);

    await expect(started).resolves.toEqual({ outcome: "cancelled" });
    await stopped;
    expect(h.statuses).not.toContain("ready");
    expect(h.proc(FRONTEND).running).toBe(false);
    expect(h.proc(BACKEND).running).toBe(false);
  });
});

describe("boot: stop() after ready", () => {
  it("stops frontend, then backend, then PostgreSQL, awaiting each", async () => {
    const h = bootHarness();
    await h.bootToReady();
    h.proc(FRONTEND).ignore("SIGTERM");
    const stop = deferred();
    h.postgres.stopGate = stop.promise;

    const stopped = h.supervisor.stop();
    await h.clock.advance(4999);
    // The frontend is not gone yet, so the backend has not been touched.
    expect(h.journal).toEqual([`kill ${FRONTEND} SIGTERM`]);

    await h.clock.advance(1);
    expect(h.journal).toEqual([
      `kill ${FRONTEND} SIGTERM`,
      `kill ${FRONTEND} SIGKILL`,
      `exit ${FRONTEND}`,
      `kill ${BACKEND} SIGTERM`,
      `exit ${BACKEND}`,
      "postgres.stop",
    ]);
    expect(h.supervisor.status).toBe("stopping");

    stop.resolve();
    await expect(stopped).resolves.toEqual({ errors: [] });
    expect(h.supervisor.status).toBe("stopped");
  });

  it("is idempotent and safe to call concurrently: one teardown, one promise", async () => {
    const h = bootHarness();
    await h.bootToReady();

    const first = h.supervisor.stop();
    const second = h.supervisor.stop();
    await Promise.all([first, second]);
    const third = h.supervisor.stop();
    await third;

    expect(second).toBe(first);
    expect(third).toBe(first);
    expect(h.journal).toEqual([
      `kill ${FRONTEND} SIGTERM`,
      `exit ${FRONTEND}`,
      `kill ${BACKEND} SIGTERM`,
      `exit ${BACKEND}`,
      "postgres.stop",
    ]);
  });

  it("does not take the exits it caused for crashes", async () => {
    const h = bootHarness();
    await h.bootToReady();

    await h.supervisor.stop();
    await h.clock.advance(120_000);

    expect(h.spawner.processes).toHaveLength(4);
    expect(h.fatals).toEqual([]);
    expect(h.statuses.slice(-3)).toEqual(["ready", "stopping", "stopped"]);
    expect(h.clock.pending).toBe(0);
  });

  it("still stops the backend and PostgreSQL when the frontend will not die", async () => {
    const h = bootHarness();
    await h.bootToReady();
    h.proc(FRONTEND).ignore("SIGTERM", "SIGKILL");

    const stopped = h.supervisor.stop();
    await h.clock.advance(10_000);

    const report = await stopped;
    expect(report.errors.map((entry) => entry.component)).toEqual(["frontend"]);
    expect(h.journal.slice(-3)).toEqual([
      `kill ${BACKEND} SIGTERM`,
      `exit ${BACKEND}`,
      "postgres.stop",
    ]);
    expect(h.supervisor.status).toBe("stopped");
  });

  it("still stops PostgreSQL when the backend will not die, and reports a PostgreSQL stop that fails", async () => {
    const h = bootHarness();
    await h.bootToReady();
    h.proc(BACKEND).ignore("SIGTERM", "SIGKILL");
    const error = new Error("pg_ctl: server does not shut down");
    h.postgres.stopError = error;

    const stopped = h.supervisor.stop();
    await h.clock.advance(10_000);

    const report = await stopped;
    expect(report.errors.map((entry) => entry.component)).toEqual([
      "backend",
      "postgres",
    ]);
    expect(report.errors[1].error).toBe(error);
    expect(h.journal[h.journal.length - 1]).toBe("postgres.stop");
  });

  it("makes start() settle as cancelled from then on, starting nothing", async () => {
    const h = bootHarness();
    await h.bootToReady();
    await h.supervisor.stop();
    h.journal.length = 0;

    await expect(h.supervisor.start()).resolves.toEqual({
      outcome: "cancelled",
    });
    expect(h.journal).toEqual([]);
  });

  it("before any start() just becomes stopped", async () => {
    const h = bootHarness();

    await expect(h.supervisor.stop()).resolves.toEqual({ errors: [] });

    expect(h.journal).toEqual([]);
    expect(h.supervisor.status).toBe("stopped");
    await expect(h.supervisor.start()).resolves.toEqual({
      outcome: "cancelled",
    });
  });
});
