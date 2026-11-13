import { join } from "path";

import { readConfig } from "./app-config";
import { AppPaths } from "./app-paths";
import { BootstrapResult, loadOrCreateConfig } from "./config-bootstrap";
import { DATABASE_NAME, DATABASE_USER, frontendOrigin } from "./env";
import { createLogger, Logger } from "./logger";
import { PORT_NAMES, PortName, PortProber, Ports, probePort } from "./ports";
import { SafeStorageLike, secretPolicyFrom } from "./secrets";
import { createSupervisor, Supervisor, SupervisorInput } from "./supervisor";
import { Clock, systemClock } from "./supervisor/clock";
import {
  createPostgresRunner,
  PostgresRunner,
  PostgresRunnerOptions,
} from "./supervisor/postgres";

/**
 * The one composition of the desktop stack: data folder, config and secrets,
 * the PostgreSQL runner and the supervisor. The Electron main process and the
 * no-Electron development script (`scripts/dev-boot.mjs`) both call it, so
 * the stack a developer boots on Linux is wired exactly as the installed
 * application is. Nothing here imports `electron`.
 */

export interface RuntimeInput {
  readonly paths: AppPaths;
  /** Electron's `safeStorage`, or a stand-in that reports it is unavailable. */
  readonly safeStorage: SafeStorageLike;
  /** `process.env`. */
  readonly baseEnv: Readonly<Record<string, string | undefined>>;
  /** `process.execPath`: Electron's binary run as Node, or Node itself. */
  readonly execPath: string;
  readonly platform?: NodeJS.Platform;
  /** Where human-readable log lines go; null for none. */
  readonly stdout?: { write(text: string): unknown } | null;
  /** Replaced by fakes in the spec. */
  readonly deps?: Partial<RuntimeDeps>;
}

export interface RuntimeDeps {
  readonly createPostgres: (options: PostgresRunnerOptions) => PostgresRunner;
  readonly createSupervisor: (input: SupervisorInput) => Supervisor;
  readonly probe: PortProber;
  readonly clock: Clock;
}

export interface Runtime {
  readonly paths: AppPaths;
  readonly logger: Logger;
  readonly bootstrap: BootstrapResult;
  readonly supervisor: Supervisor;
  /** The origin the window loads: `http://127.0.0.1:<frontend port>`. */
  readonly origin: string;
}

/** How long a persisted port may stay busy before it is moved. */
export const PORT_RELEASE_WAIT_MS = 5_000;
const PORT_RELEASE_POLL_MS = 250;

/**
 * `stop()` works from the data directory alone (`pg_ctl stop -D`); the port
 * and the password are never used by it, but the runner validates both.
 */
const STOP_ONLY_PORT = 1;
const STOP_ONLY_PASSWORD = "not-used-by-stop";

const SERVER_LOG_FILE = "postgres-server.log";

function postgresOptions(
  paths: AppPaths,
  logger: Logger,
  port: number,
  password: string,
): PostgresRunnerOptions {
  return {
    binDir: join(paths.resourcesDir, "postgres", "bin"),
    dataDir: paths.data.pgdata,
    port,
    superuser: DATABASE_USER,
    password,
    database: DATABASE_NAME,
    serverLogFile: join(paths.data.logs, SERVER_LOG_FILE),
    log: (line) => logger.log("postgres", "info", line),
  };
}

/**
 * A previous session that was killed leaves its PostgreSQL running (it is
 * detached, not a child) and, for a moment, its backend and frontend. Each
 * still holds a persisted port, and a busy persisted port is moved, which
 * changes the application's origin (plan D8). So before the ports are probed:
 * stop the leftover server, then give the persisted ports a bounded time to
 * come free. A port still busy after that belongs to another program and is
 * moved by `loadOrCreateConfig` as usual.
 */
async function releasePersistedPorts(
  paths: AppPaths,
  logger: Logger,
  deps: RuntimeDeps,
): Promise<void> {
  const persisted = await readConfig(paths.data.configFile).catch(() => null);
  if (persisted === null) {
    return;
  }
  try {
    await deps
      .createPostgres(
        postgresOptions(paths, logger, STOP_ONLY_PORT, STOP_ONLY_PASSWORD),
      )
      .stop();
  } catch (error) {
    // start() meets the same server again and reports it properly.
    logger.warn(
      `A database server left by an earlier session could not be stopped: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  const deadline = deps.clock.now() + PORT_RELEASE_WAIT_MS;
  let busy = await busyPorts(persisted.ports, deps.probe);
  while (busy.length > 0 && deps.clock.now() < deadline) {
    await deps.clock.sleep(PORT_RELEASE_POLL_MS);
    busy = await busyPorts(persisted.ports, deps.probe);
  }
  if (busy.length > 0) {
    logger.warn(`Still in use by another program: port ${busy.join(", ")}.`);
  }
}

async function busyPorts(
  ports: Ports,
  probe: PortProber,
): Promise<readonly PortName[]> {
  const free = await Promise.all(PORT_NAMES.map((name) => probe(ports[name])));
  return PORT_NAMES.filter((_, index) => !free[index]);
}

/**
 * Builds the runtime without starting anything: the caller owns
 * `supervisor.start()` and `supervisor.stop()`. Rejects with the typed errors
 * of the modules it calls (`ConfigError`, `SecretError`, `PortError`,
 * `ChildEnvError`), each written to be shown to the person as it is.
 */
export async function createRuntime(input: RuntimeInput): Promise<Runtime> {
  const deps: RuntimeDeps = {
    createPostgres: (options) => createPostgresRunner(options),
    createSupervisor,
    probe: probePort,
    clock: systemClock,
    ...input.deps,
  };
  const { paths } = input;
  const logger = createLogger({
    logsDir: paths.data.logs,
    ...(input.stdout === undefined ? {} : { stdout: input.stdout }),
  });

  try {
    await releasePersistedPorts(paths, logger, deps);
    const bootstrap = await loadOrCreateConfig({
      paths: paths.data,
      policy: secretPolicyFrom(input.safeStorage, input.baseEnv),
      probe: deps.probe,
    });
    logger.redact(bootstrap.secrets.databasePassword);
    if (bootstrap.movedPorts.length > 0) {
      logger.warn(
        `Moved to a free port: ${bootstrap.movedPorts.join(", ")}. ` +
          "The application's address changed.",
      );
    }
    const postgres = deps.createPostgres(
      postgresOptions(
        paths,
        logger,
        bootstrap.config.ports.postgres,
        bootstrap.secrets.databasePassword,
      ),
    );
    const supervisor = deps.createSupervisor({
      paths,
      config: bootstrap.config,
      secrets: bootstrap.secrets,
      logger,
      postgres,
      baseEnv: input.baseEnv,
      execPath: input.execPath,
      ...(input.platform === undefined ? {} : { platform: input.platform }),
    });
    return {
      paths,
      logger,
      bootstrap,
      supervisor,
      origin: frontendOrigin(bootstrap.config.ports),
    };
  } catch (error) {
    logger.close();
    throw error;
  }
}
