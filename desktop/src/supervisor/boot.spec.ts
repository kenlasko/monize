import {
  BACKEND,
  BACKEND_URL,
  bootHarness,
  DB_INIT,
  DB_MIGRATE,
  deferred,
  FRONTEND,
  FRONTEND_URL,
  SPAWN_FRONTEND,
} from "../test-support/boot-harness";
import { flush } from "../test-support/manual-clock";
import { BootResult } from "./types";

function failureOf(result: BootResult) {
  if (result.outcome !== "failed") {
    throw new Error(`boot ended ${result.outcome}, expected failed`);
  }
  return result.failure;
}

describe("boot: the happy path", () => {
  it("runs postgres, db-init, db-migrate, backend, frontend in order, each only after the one before", async () => {
    const h = bootHarness();
    const gate = deferred();
    h.postgres.startGate = gate.promise;

    const started = h.supervisor.start();
    await flush();
    expect(h.journal).toEqual(["postgres.start"]);

    gate.resolve();
    await flush();
    expect(h.journal).toEqual(["postgres.start", `spawn ${DB_INIT}`]);

    h.proc(DB_INIT).exit(0);
    await flush();
    expect(h.journal.slice(2)).toEqual([
      `exit ${DB_INIT}`,
      `spawn ${DB_MIGRATE}`,
    ]);

    h.proc(DB_MIGRATE).exit(0);
    await flush();
    expect(h.journal.slice(4)).toEqual([
      `exit ${DB_MIGRATE}`,
      `spawn ${BACKEND}`,
    ]);

    // The frontend waits for the backend's readiness, not for its spawn.
    await h.clock.advance(1000);
    expect(h.journal).toHaveLength(6);
    h.fetch.respond(BACKEND_URL, 200);
    await h.clock.advance(250);
    expect(h.journal.slice(6)).toEqual([SPAWN_FRONTEND]);
    expect(h.supervisor.status).toBe("frontend");

    h.fetch.respond(FRONTEND_URL, 200);
    await h.clock.advance(250);

    await expect(started).resolves.toEqual({ outcome: "ready" });
    expect(h.statuses).toEqual([
      "postgres",
      "db-init",
      "db-migrate",
      "backend",
      "frontend",
      "ready",
    ]);
    expect(h.supervisor.status).toBe("ready");
    // Ready leaves nothing ticking: no poll, no deadline.
    expect(h.clock.pending).toBe(0);
    expect(h.fetch.open).toBe(0);
  });

  it("runs each child in its own layer's directory with its own environment", async () => {
    const h = bootHarness();
    await h.bootToReady();

    for (const script of [DB_INIT, DB_MIGRATE, BACKEND]) {
      expect(h.proc(script).options).toMatchObject({
        cwd: "/res/backend",
        env: { ROLE: "backend" },
      });
    }
    expect(h.proc(FRONTEND).options).toMatchObject({
      cwd: "/res/frontend",
      env: { ROLE: "frontend" },
    });
  });

  it("is one boot when start() is called twice, during the boot or after it", async () => {
    const h = bootHarness();
    const first = h.supervisor.start();
    const second = h.supervisor.start();
    expect(second).toBe(first);

    await h.bootToReady();

    expect(h.supervisor.start()).toBe(first);
    await flush();
    expect(h.spawner.processes).toHaveLength(4);
    expect(h.statuses.filter((status) => status === "postgres")).toHaveLength(
      1,
    );
  });
});

describe("boot: a failed step", () => {
  it("postgres failing starts nothing else and carries the runner's error and the postgres log", async () => {
    const h = bootHarness();
    const error = new Error("initdb failed");
    h.postgres.startError = error;
    h.logger.log("postgres", "error", "FATAL: could not create lock file");

    const failure = failureOf(await h.supervisor.start());

    expect(failure.step).toBe("postgres");
    expect(failure.cause).toEqual({
      kind: "error",
      message: "initdb failed",
      error,
    });
    expect(failure.logSource).toBe("postgres");
    expect(failure.logTail.map((record) => record.msg)).toEqual([
      "FATAL: could not create lock file",
    ]);
    // A start that failed part-way may have left a server: it is stopped.
    expect(h.journal).toEqual(["postgres.start", "postgres.stop"]);
    expect(h.supervisor.status).toBe("failed");
  });

  it("db-init exiting non-zero does not run db-migrate", async () => {
    const h = bootHarness();
    const started = h.supervisor.start();
    await flush();

    h.proc(DB_INIT).exit(1);

    const failure = failureOf(await started);
    expect(failure.step).toBe("db-init");
    expect(failure.cause).toEqual({ kind: "exited", code: 1, signal: null });
    expect(h.journal).toEqual([
      "postgres.start",
      `spawn ${DB_INIT}`,
      `exit ${DB_INIT}`,
      "postgres.stop",
    ]);
  });

  it("db-migrate exiting non-zero stops before the backend starts, with the last 50 backend log lines", async () => {
    const h = bootHarness();
    const started = h.supervisor.start();
    await flush();
    h.proc(DB_INIT).exit(0);
    await flush();
    const lines = Array.from({ length: 60 }, (_, index) => `line ${index + 1}`);
    h.proc(DB_MIGRATE).stderr.emit("data", `${lines.join("\n")}\n`);

    h.proc(DB_MIGRATE).exit(1);

    const failure = failureOf(await started);
    expect(failure.step).toBe("db-migrate");
    expect(failure.cause).toEqual({ kind: "exited", code: 1, signal: null });
    expect(failure.logSource).toBe("backend");
    expect(failure.logTail.map((record) => record.msg)).toEqual(
      lines.slice(10),
    );
    expect(h.journal).not.toContain(`spawn ${BACKEND}`);
    expect(h.journal[h.journal.length - 1]).toBe("postgres.stop");
    expect(h.statuses).toEqual(["postgres", "db-init", "db-migrate", "failed"]);
  });

  it("a backend that is never ready within its deadline is stopped, then PostgreSQL", async () => {
    const h = bootHarness({ backendReadyDeadlineMs: 120_000 });
    const { started } = await h.bootToBackend();
    h.journal.length = 0;

    await h.clock.advance(119_999);
    expect(h.journal).toEqual([]);
    await h.clock.advance(1);

    const failure = failureOf(await started);
    expect(failure.step).toBe("backend");
    expect(failure.cause).toEqual({
      kind: "timeout",
      deadlineMs: 120_000,
      lastStatus: null,
      lastError: "ECONNREFUSED",
    });
    expect(h.journal).toEqual([
      `kill ${BACKEND} SIGTERM`,
      `exit ${BACKEND}`,
      "postgres.stop",
    ]);
    expect(h.clock.pending).toBe(0);
  });

  it("waits out a slow first start with the default deadlines, saying so as it goes", async () => {
    // A real PC's first start after an install took the backend over two
    // minutes to begin; the old 120 s default failed it.
    const h = bootHarness();
    const slow: string[] = [];
    h.supervisor.onSlowStart((server) => slow.push(server));
    const { started } = await h.bootToBackend();
    const progress = () =>
      h.logger.records
        .filter((record) => record.source === "main")
        .map((record) => record.msg)
        .filter((msg) => msg.includes("still starting"));

    await h.clock.advance(19_999);
    expect(slow).toEqual([]);
    await h.clock.advance(1);
    expect(slow).toEqual(["backend"]);
    expect(progress()).toEqual([
      "The backend is still starting (20 s so far).",
    ]);

    await h.clock.advance(4 * 60_000);
    expect(slow).toEqual(["backend"]);
    expect(progress().at(-1)).toBe(
      "The backend is still starting (260 s so far).",
    );

    h.fetch.respond(BACKEND_URL, 200);
    h.fetch.respond(FRONTEND_URL, 200);
    await h.clock.advance(250);
    expect((await started).outcome).toBe("ready");
    const logged = progress().length;
    await h.clock.advance(60_000);
    expect(progress()).toHaveLength(logged);
    expect(slow).toEqual(["backend"]);
  });

  it("stops reporting progress when the wait is cancelled", async () => {
    const h = bootHarness();
    await h.bootToBackend();
    await h.clock.advance(20_000);
    await h.supervisor.stop();
    expect(h.clock.pending).toBe(0);
  });

  it("a backend that dies during startup fails the boot at once, not at the deadline", async () => {
    const h = bootHarness();
    const { started } = await h.bootToBackend();
    h.proc(BACKEND).stderr.emit("data", "Error: JWT_SECRET is required\n");

    h.proc(BACKEND).exit(1);

    const failure = failureOf(await started);
    expect(failure.step).toBe("backend");
    expect(failure.cause).toEqual({ kind: "exited", code: 1, signal: null });
    expect(failure.logTail.map((record) => record.msg)).toEqual([
      "Error: JWT_SECRET is required",
    ]);
    expect(h.clock.now()).toBe(0);
    expect(h.journal).not.toContain(SPAWN_FRONTEND);
    expect(h.journal[h.journal.length - 1]).toBe("postgres.stop");
  });

  it("an executable that cannot be started is a spawn error on that step", async () => {
    const h = bootHarness();
    const started = h.supervisor.start();
    await flush();

    h.proc(DB_INIT).failToStart("ENOENT");

    const failure = failureOf(await started);
    expect(failure.step).toBe("db-init");
    expect(failure.cause).toMatchObject({
      kind: "spawn-error",
      code: "ENOENT",
    });
    expect(h.journal[h.journal.length - 1]).toBe("postgres.stop");
  });

  it("a frontend that fails stops frontend, backend, then PostgreSQL, and only then reports", async () => {
    const h = bootHarness({ frontendReadyDeadlineMs: 60_000 });
    h.fetch.respond(BACKEND_URL, 200);
    h.fetch.respond(FRONTEND_URL, 503);
    const { started } = await h.bootToBackend();
    const stop = deferred();
    h.postgres.stopGate = stop.promise;
    let reported = false;
    void started.then(() => {
      reported = true;
    });
    h.journal.length = 0;

    await h.clock.advance(60_000);

    expect(h.journal).toEqual([
      `kill ${FRONTEND} SIGTERM`,
      `exit ${FRONTEND}`,
      `kill ${BACKEND} SIGTERM`,
      `exit ${BACKEND}`,
      "postgres.stop",
    ]);
    // Still tearing down: the result is not out, and neither is "failed".
    expect(reported).toBe(false);
    expect(h.supervisor.status).toBe("frontend");

    stop.resolve();
    const failure = failureOf(await started);
    expect(failure.step).toBe("frontend");
    expect(failure.cause).toMatchObject({ kind: "timeout", lastStatus: 503 });
    expect(failure.logSource).toBe("frontend");
    expect(h.supervisor.status).toBe("failed");
  });

  it("can be retried: start() after a failed boot is a new boot", async () => {
    const h = bootHarness();
    const first = h.supervisor.start();
    await flush();
    h.proc(DB_INIT).exit(1);
    expect((await first).outcome).toBe("failed");
    h.journal.length = 0;

    const second = h.supervisor.start();
    expect(second).not.toBe(first);
    // Two calls in one turn are still one retry.
    expect(h.supervisor.start()).toBe(second);
    await flush();
    h.fetch.respond(BACKEND_URL, 200);
    h.fetch.respond(FRONTEND_URL, 200);
    h.proc(DB_INIT).exit(0);
    await flush();
    h.proc(DB_MIGRATE).exit(0);

    await expect(second).resolves.toEqual({ outcome: "ready" });
    expect(h.journal.filter((entry) => entry === "postgres.start")).toEqual([
      "postgres.start",
    ]);
  });
});

describe("boot: listeners", () => {
  it("keeps going when a status listener throws, and tells the others", async () => {
    const h = bootHarness();
    h.supervisor.onStatus(() => {
      throw new Error("splash is gone");
    });
    const seen: string[] = [];
    h.supervisor.onStatus((status) => seen.push(status));

    await h.bootToReady();

    expect(seen[seen.length - 1]).toBe("ready");
    expect(h.logger.messages("main").join("\n")).toMatch(/splash is gone/);
  });

  it("stops telling a listener that unsubscribed", async () => {
    const h = bootHarness();
    const seen: string[] = [];
    const unsubscribe = h.supervisor.onStatus((status) => seen.push(status));
    unsubscribe();

    await h.bootToReady();

    expect(seen).toEqual([]);
  });

  it("is safe against a listener that calls stop() from inside a status change", async () => {
    const h = bootHarness();
    const stops: Promise<unknown>[] = [];
    h.supervisor.onStatus((status) => {
      if (status === "db-init" || status === "stopping") {
        stops.push(h.supervisor.stop());
      }
    });

    await expect(h.supervisor.start()).resolves.toEqual({
      outcome: "cancelled",
    });
    await Promise.all(stops);

    expect(stops).toHaveLength(2);
    expect(stops[1]).toBe(stops[0]);
    expect(h.journal.filter((entry) => entry === "postgres.stop")).toHaveLength(
      1,
    );
  });
});
