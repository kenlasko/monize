import { FetchLike, HealthOutcome, waitForHealthy } from "../health";
import { Logger, LogSource } from "../logger";
import {
  BACKEND_ONE_SHOT_STEPS,
  LayerRuntime,
  exitCause,
  runBackendOneShot,
  startBackendServer,
} from "./backend";
import { ChildExit, ChildHandle, ChildLauncher } from "./child";
import { Clock, systemClock } from "./clock";
import { messageOf } from "./errors";
import { startFrontendServer } from "./frontend";
import {
  BootOptions,
  BootResult,
  BOOT_STEPS,
  BootStep,
  DEFAULT_BOOT_OPTIONS,
  describeCause,
  FailureCause,
  FatalFailure,
  PostgresRunner,
  SERVER_NAMES,
  ServerName,
  StopReport,
  Supervisor,
  SupervisorStatus,
  withDefaults,
} from "./types";
import { createWatchdog } from "./watchdog";

/**
 * The boot state machine: `postgres -> db-init -> db-migrate -> backend ->
 * frontend -> ready` (plan section 6), and its way back down.
 *
 * One rule keeps the concurrency honest: a single coroutine, the boot, starts
 * things, and it is also the one that stops them when it fails or is
 * cancelled. `stop()` aborts the lifetime signal, waits for that coroutine to
 * finish, then tears down whatever is left. So nothing is ever started and
 * stopped by two callers at once, and a process started just before a
 * `stop()` is registered before `stop()` looks for it.
 */

/** A layer's runtime plus the URL that says its server is up. */
export interface LayerTarget extends LayerRuntime {
  readonly healthUrl: string;
}

export interface BootDeps {
  readonly postgres: PostgresRunner;
  readonly launch: ChildLauncher;
  readonly logger: Logger;
  readonly backend: LayerTarget;
  readonly frontend: LayerTarget;
  readonly fetch?: FetchLike;
  readonly clock?: Clock;
  readonly options?: Partial<BootOptions>;
}

const READY: BootResult = { outcome: "ready" };
const CANCELLED: BootResult = { outcome: "cancelled" };

/** Teardown order: the reverse of the start order, PostgreSQL last. */
const SERVERS_IN_STOP_ORDER: readonly ServerName[] = [
  ...SERVER_NAMES,
].reverse();

const LOG_SOURCE_OF: Readonly<Record<BootStep, LogSource>> = {
  postgres: "postgres",
  "db-init": "backend",
  "db-migrate": "backend",
  backend: "backend",
  frontend: "frontend",
};

export function createBootSupervisor(deps: BootDeps): Supervisor {
  const { logger, postgres } = deps;
  const clock = deps.clock ?? systemClock;
  const options = withDefaults(DEFAULT_BOOT_OPTIONS, deps.options);
  const lifetime = new AbortController();
  const statusListeners = new Set<(status: SupervisorStatus) => void>();
  const fatalListeners = new Set<(failure: FatalFailure) => void>();
  const servers = new Map<ServerName, ChildHandle>();
  let status: SupervisorStatus = "idle";
  let fatal: FatalFailure | null = null;
  let boot: Promise<BootResult> | null = null;
  /** The last boot ended `failed`, so `start()` may begin another. */
  let retryable = false;
  let stopping: Promise<StopReport> | null = null;
  let postgresStarted = false;

  function notify<T>(
    listeners: ReadonlySet<(value: T) => void>,
    value: T,
  ): void {
    for (const listener of [...listeners]) {
      try {
        listener(value);
      } catch (error) {
        logger.error(`A supervisor listener threw: ${messageOf(error)}`);
      }
    }
  }

  function setStatus(next: SupervisorStatus): void {
    // Once stopping has begun the only way is on to stopped.
    const closing = status === "stopping" || status === "stopped";
    if (status === next || (closing && next !== "stopped")) return;
    status = next;
    logger.info(`Supervisor status: ${next}`);
    notify(statusListeners, next);
  }

  function startServer(name: ServerName): ChildHandle {
    const handle =
      name === "backend"
        ? startBackendServer(deps.launch, deps.backend)
        : startFrontendServer(deps.launch, deps.frontend);
    servers.set(name, handle);
    return handle;
  }

  function waitHealthy(
    name: ServerName,
    handle: ChildHandle,
  ): Promise<HealthOutcome<ChildExit>> {
    return waitForHealthy(deps[name].healthUrl, {
      deadlineMs:
        name === "backend"
          ? options.backendReadyDeadlineMs
          : options.frontendReadyDeadlineMs,
      intervalMs: options.healthIntervalMs,
      requestTimeoutMs: options.healthRequestTimeoutMs,
      signal: lifetime.signal,
      exited: handle.exited,
      fetch: deps.fetch,
      clock,
    });
  }

  const watchdog = createWatchdog({
    clock,
    logger,
    options,
    signal: lifetime.signal,
    current: (name) => servers.get(name),
    restart: startServer,
    waitHealthy,
    setStatus,
    onFatal(failure) {
      fatal = failure;
      setStatus("fatal");
      notify(fatalListeners, failure);
    },
  });

  function failed(step: BootStep, cause: FailureCause): BootResult {
    const logSource = LOG_SOURCE_OF[step];
    logger.error(`Boot step ${step} failed: ${describeCause(cause)}`);
    return {
      outcome: "failed",
      failure: {
        step,
        cause,
        logSource,
        // Taken now, before the teardown adds its own lines to the same log.
        logTail: logger.tail(logSource, options.logTailLines),
      },
    };
  }

  async function runSteps(): Promise<BootResult> {
    const { signal } = lifetime;
    if (signal.aborted) return CANCELLED;

    setStatus("postgres");
    // Marked before the call: a start that fails part-way may have left the
    // server running, and the runner's `stop()` is idempotent.
    postgresStarted = true;
    try {
      await postgres.start();
    } catch (error) {
      return failed("postgres", {
        kind: "error",
        message: messageOf(error),
        error,
      });
    }
    if (signal.aborted) return CANCELLED;

    for (const oneShot of BACKEND_ONE_SHOT_STEPS) {
      setStatus(oneShot.step);
      const result = await runBackendOneShot(oneShot, {
        launch: deps.launch,
        runtime: deps.backend,
        clock,
        deadlineMs:
          oneShot.step === "db-init"
            ? options.dbInitDeadlineMs
            : options.dbMigrateDeadlineMs,
        signal,
      });
      if (result.kind === "cancelled") return CANCELLED;
      if (result.kind === "failed") return failed(oneShot.step, result.cause);
    }

    for (const name of SERVER_NAMES) {
      setStatus(name);
      const handle = startServer(name);
      const outcome = await waitHealthy(name, handle);
      if (outcome.kind === "aborted" || signal.aborted) return CANCELLED;
      if (outcome.kind === "exited")
        return failed(name, exitCause(outcome.exit));
      if (outcome.kind === "timeout") {
        return failed(name, {
          kind: "timeout",
          deadlineMs: outcome.deadlineMs,
          lastStatus: outcome.lastStatus,
          lastError: outcome.lastError,
        });
      }
    }

    setStatus("ready");
    for (const name of SERVER_NAMES) {
      watchdog.watch(name, servers.get(name) as ChildHandle);
    }
    return READY;
  }

  /**
   * Stop everything that was started: frontend, backend, then PostgreSQL,
   * each awaited. A component that fails to stop is recorded and the next one
   * is still stopped; PostgreSQL's clean shutdown matters most and comes last.
   * A component is forgotten only once it has stopped, so a later call retries
   * exactly what is left.
   */
  async function teardown(): Promise<StopReport["errors"]> {
    const errors: { component: ServerName | "postgres"; error: unknown }[] = [];
    for (const name of SERVERS_IN_STOP_ORDER) {
      const handle = servers.get(name);
      if (handle === undefined) continue;
      try {
        await handle.stop();
        servers.delete(name);
      } catch (error) {
        logger.error(`Stopping the ${name} failed: ${messageOf(error)}`);
        errors.push({ component: name, error });
      }
    }
    if (postgresStarted) {
      try {
        await postgres.stop();
        postgresStarted = false;
      } catch (error) {
        logger.error(`Stopping PostgreSQL failed: ${messageOf(error)}`);
        errors.push({ component: "postgres", error });
      }
    }
    return errors;
  }

  async function runBoot(): Promise<BootResult> {
    let result: BootResult;
    try {
      result = await runSteps();
    } catch (error) {
      // Nothing in `runSteps` is meant to throw; if something does, it is a
      // failure of the step that was running, not an unhandled rejection.
      const step = BOOT_STEPS.find((name) => name === status) ?? "postgres";
      result = failed(step, {
        kind: "error",
        message: messageOf(error),
        error,
      });
    }
    // A stop that arrived while the last step was finishing wins: whatever the
    // step concluded, the caller asked for the stack to come down.
    if (lifetime.signal.aborted) result = CANCELLED;
    if (result.outcome === "ready") return result;
    await teardown();
    if (result.outcome === "failed") {
      retryable = true;
      setStatus("failed");
    }
    return result;
  }

  async function runStop(): Promise<StopReport> {
    setStatus("stopping");
    if (boot !== null) await boot;
    const errors = await teardown();
    setStatus("stopped");
    return { errors };
  }

  return {
    get status() {
      return status;
    },
    get fatal() {
      return fatal;
    },
    start() {
      if (stopping !== null) return Promise.resolve(CANCELLED);
      if (boot === null || retryable) {
        // Recorded before the boot runs its first line, for the same reason
        // as in `stop()`: a second call in the same turn is the same boot.
        retryable = false;
        boot = Promise.resolve().then(runBoot);
      }
      return boot;
    },
    stop() {
      if (stopping === null) {
        // Recorded before anything else runs, so a second call (Electron
        // fires `before-quit` and `window-all-closed` close together) and any
        // listener that calls back in get this same promise.
        stopping = Promise.resolve().then(runStop);
        lifetime.abort();
      }
      return stopping;
    },
    onStatus(listener) {
      statusListeners.add(listener);
      return () => statusListeners.delete(listener);
    },
    onFatal(listener) {
      fatalListeners.add(listener);
      return () => fatalListeners.delete(listener);
    },
  };
}
