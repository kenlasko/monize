import { dataPathsFor } from "../app-paths";
import { PortName } from "../ports";
import { Runtime } from "../runtime";
import {
  BootResult,
  FatalFailure,
  StopReport,
  Supervisor,
  SupervisorStatus,
} from "../supervisor/types";
import { memoryLogger, MemoryLogger } from "./memory-logger";

/**
 * A `Runtime` whose supervisor the spec drives by hand: each `start()` waits
 * until the spec settles it, and status and fatal events are emitted on
 * demand. For the shell controller's specs.
 */
export interface FakeRuntime extends Runtime {
  readonly logger: MemoryLogger;
  readonly calls: string[];
  /** Settles the oldest pending `start()`. */
  settleStart(result: BootResult): Promise<void>;
  emitStatus(status: SupervisorStatus): void;
  emitFatal(failure: FatalFailure): void;
  /** Lets the spec hold `stop()` open. */
  holdStop(): () => void;
}

export const FAKE_ORIGIN = "http://127.0.0.1:3380";

export const FAKE_SECRETS = {
  jwtSecret: "j".repeat(64),
  encryptionKey: "e".repeat(64),
  databasePassword: "d".repeat(64),
  databaseAppPassword: "a".repeat(64),
} as const;

export function fakeRuntime(movedPorts: readonly PortName[] = []): FakeRuntime {
  const logger = memoryLogger();
  const calls: string[] = [];
  const starts: ((result: BootResult) => void)[] = [];
  const statusListeners: ((status: SupervisorStatus) => void)[] = [];
  const fatalListeners: ((failure: FatalFailure) => void)[] = [];
  let stopGate: Promise<void> = Promise.resolve();
  let stopping: Promise<StopReport> | null = null;

  const supervisor: Supervisor = {
    status: "idle",
    fatal: null,
    start: () => {
      calls.push("start");
      return new Promise((resolve) => starts.push(resolve));
    },
    stop: () => {
      calls.push("stop");
      stopping ??= stopGate.then(() => ({ errors: [] }));
      return stopping;
    },
    onStatus: (listener) => {
      statusListeners.push(listener);
      return () => undefined;
    },
    onFatal: (listener) => {
      fatalListeners.push(listener);
      return () => undefined;
    },
  };

  return {
    paths: { resourcesDir: "/res", data: dataPathsFor("/data", "linux") },
    logger,
    bootstrap: {
      config: {
        version: 1,
        ports: { frontend: 3380, backend: 3381, postgres: 5433 },
        secrets: {
          jwtSecret: { enc: "plain", value: "" },
          encryptionKey: { enc: "plain", value: "" },
          databasePassword: { enc: "plain", value: "" },
          databaseAppPassword: { enc: "plain", value: "" },
        },
      },
      secrets: FAKE_SECRETS,
      firstRun: false,
      movedPorts,
    },
    supervisor,
    origin: FAKE_ORIGIN,
    calls,
    async settleStart(result) {
      const resolve = starts.shift();
      if (resolve === undefined) throw new Error("no start() is pending");
      resolve(result);
      await new Promise((done) => setImmediate(done));
    },
    emitStatus: (status) => statusListeners.forEach((fn) => fn(status)),
    emitFatal: (failure) => fatalListeners.forEach((fn) => fn(failure)),
    holdStop() {
      let release: () => void = () => undefined;
      stopGate = new Promise((resolve) => {
        release = resolve;
      });
      return release;
    },
  };
}
