import {
  binaryPath,
  DEFAULT_TIMEOUTS,
  pathFor,
  PathModule,
  shellUnsafeIn,
} from "./postgres-args";
import {
  createRedactor,
  PostgresFailure,
  PostgresRunnerError,
  tailOf,
} from "./postgres-errors";
import {
  PostgresRunnerDeps,
  PostgresRunnerOptions,
  PostgresStatus,
  PostgresTimeouts,
} from "./postgres-types";

/** Written inside the data directory once initdb has exited 0. */
export const INIT_MARKER = "monize.initialized";
export const PID_FILE = "postmaster.pid";

/**
 * Everything the runner's steps share: the validated options, the derived
 * paths, the injected capabilities, and the only two ways a line or a failure
 * leaves the runner, both of which strip the password.
 */
export interface RunnerContext {
  readonly options: PostgresRunnerOptions;
  readonly deps: PostgresRunnerDeps;
  readonly path: PathModule;
  readonly timeouts: PostgresTimeouts;
  readonly initdb: string;
  readonly pgCtl: string;
  readonly pidFile: string;
  readonly markerFile: string;
  /** Beside the data directory, never in the shared system temp directory. */
  readonly pwFile: string;
  log(line: string): void;
  status(status: PostgresStatus): void;
  failure(
    failure: PostgresFailure,
    message: string,
    output?: string,
  ): PostgresRunnerError;
}

const IDENTIFIER = /^[a-z_][a-z0-9_]{0,62}$/;

function configProblem(
  options: PostgresRunnerOptions,
  platform: NodeJS.Platform,
): string | undefined {
  const path = pathFor(platform);
  if (
    !Number.isInteger(options.port) ||
    options.port < 1 ||
    options.port > 65535
  ) {
    return "the port is not a TCP port number";
  }
  if (!IDENTIFIER.test(options.superuser)) {
    return "the superuser name is not a plain lower-case identifier";
  }
  if (!IDENTIFIER.test(options.database)) {
    return "the database name is not a plain lower-case identifier";
  }
  // initdb reads the first line of the password file.
  if (options.password.length === 0 || /[\r\n\0]/.test(options.password)) {
    return "the password is empty or spans more than one line";
  }
  const paths = {
    "binaries directory": options.binDir,
    "data directory": options.dataDir,
    "server log file": options.serverLogFile,
  };
  for (const [label, value] of Object.entries(paths)) {
    if (!path.isAbsolute(value)) {
      return `the ${label} is not an absolute path: ${value}`;
    }
    const unsafe = shellUnsafeIn(value, platform);
    if (unsafe !== undefined) {
      return `the ${label} contains ${JSON.stringify(unsafe)}, which pg_ctl cannot pass to the server: ${value}`;
    }
  }
  return undefined;
}

export function createContext(
  options: PostgresRunnerOptions,
  deps: PostgresRunnerDeps,
): RunnerContext {
  const path = pathFor(deps.platform);
  const redact = createRedactor(options.password);
  const failure = (
    kind: PostgresFailure,
    message: string,
    output = "",
  ): PostgresRunnerError =>
    new PostgresRunnerError(kind, redact(message), redact(tailOf(output)));

  const problem = configProblem(options, deps.platform);
  if (problem !== undefined) {
    throw failure("config", `PostgreSQL cannot be started: ${problem}`);
  }

  // Normalised so no path ends in a separator: a trailing backslash would
  // escape the closing quote pg_ctl puts around -D on Windows.
  const dataDir = path.resolve(options.dataDir);
  const resolved: PostgresRunnerOptions = {
    ...options,
    dataDir,
    binDir: path.resolve(options.binDir),
    serverLogFile: path.resolve(options.serverLogFile),
  };

  return {
    options: resolved,
    deps,
    path,
    timeouts: { ...DEFAULT_TIMEOUTS, ...options.timeouts },
    initdb: binaryPath(resolved.binDir, "initdb", deps.platform),
    pgCtl: binaryPath(resolved.binDir, "pg_ctl", deps.platform),
    pidFile: path.join(dataDir, PID_FILE),
    markerFile: path.join(dataDir, INIT_MARKER),
    pwFile: path.join(
      path.dirname(dataDir),
      `${path.basename(dataDir)}.initdb-password`,
    ),
    log: (line) => options.log(redact(line)),
    status: (status) => options.onStatus?.(status),
    failure,
  };
}
