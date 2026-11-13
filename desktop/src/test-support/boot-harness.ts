import { createBootSupervisor } from "../supervisor/boot";
import { ChildOptions, createChildLauncher } from "../supervisor/child";
import {
  BootOptions,
  BootResult,
  FatalFailure,
  PostgresRunner,
  Supervisor,
  SupervisorStatus,
} from "../supervisor/types";
import { FakeFetch, fakeFetch } from "./fake-fetch";
import {
  FakeProcess,
  FakeSpawner,
  FAKE_PARENT_WATCH_DEPS,
  fakeSpawner,
} from "./fake-process";
import { flush, ManualClock, manualClock } from "./manual-clock";
import { MemoryLogger, memoryLogger } from "./memory-logger";

/**
 * The boot state machine over fakes, for specs only: a fake PostgreSQL
 * runner, a fake spawner under the real `child.ts`, a scripted `fetch` and a
 * manual clock. `journal` is one ordered record of everything that was
 * started, signalled and stopped, so an ordering claim is one array compare.
 */

export const BACKEND_URL = "http://127.0.0.1:3381/api/v1/health/ready";
export const FRONTEND_URL = "http://127.0.0.1:3380/api/v1/health/live";

export const DB_INIT = "dist/db-init.js";
export const DB_MIGRATE = "dist/db-migrate.js";
export const BACKEND = "dist/main.js";
export const FRONTEND = "server.js";
export const SPAWN_FRONTEND =
  "spawn --require ./server-log-format.cjs server.js";

type Gate = Promise<void> | null;

export interface FakePostgres extends PostgresRunner {
  /** When set, `start()` / `stop()` does not settle before this promise does. */
  startGate: Gate;
  stopGate: Gate;
  /** When set, `start()` / `stop()` rejects with it. */
  startError: Error | null;
  stopError: Error | null;
}

export function fakePostgres(journal: string[]): FakePostgres {
  const runner: FakePostgres = {
    startGate: null,
    stopGate: null,
    startError: null,
    stopError: null,
    async start() {
      journal.push("postgres.start");
      await runner.startGate;
      if (runner.startError !== null) throw runner.startError;
    },
    async stop() {
      journal.push("postgres.stop");
      await runner.stopGate;
      if (runner.stopError !== null) throw runner.stopError;
    },
  };
  return runner;
}

export interface Deferred {
  readonly promise: Promise<void>;
  resolve(): void;
}

export function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

export interface BootHarness {
  readonly supervisor: Supervisor;
  readonly journal: string[];
  readonly statuses: SupervisorStatus[];
  readonly fatals: FatalFailure[];
  readonly postgres: FakePostgres;
  readonly spawner: FakeSpawner;
  readonly fetch: FakeFetch;
  readonly clock: ManualClock;
  readonly logger: MemoryLogger;
  /** The most recent process running `script`. */
  proc(script: string): FakeProcess;
  /**
   * Start, run both one-shot steps to exit 0, and leave the backend starting.
   * The boot's own promise comes back wrapped, so awaiting this does not wait
   * for the boot.
   */
  bootToBackend(): Promise<{ readonly started: Promise<BootResult> }>;
  /** Boot all the way to `ready` and clear the journal. */
  bootToReady(): Promise<void>;
}

export function bootHarness(
  options: Partial<BootOptions> = {},
  childOptions: Partial<ChildOptions> = {},
): BootHarness {
  const journal: string[] = [];
  const statuses: SupervisorStatus[] = [];
  const fatals: FatalFailure[] = [];
  const postgres = fakePostgres(journal);
  const spawner = fakeSpawner(journal);
  const fetch = fakeFetch();
  const clock = manualClock();
  const logger = memoryLogger();
  const supervisor = createBootSupervisor({
    postgres,
    launch: createChildLauncher({
      execPath: "/opt/monize/Monize",
      ...FAKE_PARENT_WATCH_DEPS,
      logger,
      spawn: spawner.spawn,
      clock,
      options: childOptions,
    }),
    logger,
    backend: {
      cwd: "/res/backend",
      env: { ROLE: "backend" },
      healthUrl: BACKEND_URL,
    },
    frontend: {
      cwd: "/res/frontend",
      env: { ROLE: "frontend" },
      healthUrl: FRONTEND_URL,
    },
    fetch: fetch.fetch,
    clock,
    options,
  });
  supervisor.onStatus((status) => statuses.push(status));
  supervisor.onFatal((failure) => fatals.push(failure));

  async function bootToBackend(): Promise<{
    readonly started: Promise<BootResult>;
  }> {
    const started = supervisor.start();
    await flush();
    spawner.find(DB_INIT).exit(0);
    await flush();
    spawner.find(DB_MIGRATE).exit(0);
    await flush();
    return { started };
  }

  return {
    supervisor,
    journal,
    statuses,
    fatals,
    postgres,
    spawner,
    fetch,
    clock,
    logger,
    proc: (script) => spawner.find(script),
    bootToBackend,
    async bootToReady() {
      fetch.respond(BACKEND_URL, 200);
      fetch.respond(FRONTEND_URL, 200);
      const result = await (await bootToBackend()).started;
      if (result.outcome !== "ready") {
        throw new Error(`boot ended ${result.outcome}, expected ready`);
      }
      journal.length = 0;
    },
  };
}
