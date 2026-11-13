/**
 * The contract of the embedded PostgreSQL runner: what the boot state machine
 * passes in, what it gets back, and every operating-system capability the
 * runner uses. The capabilities are an interface so the sequencing (first run,
 * crash recovery, shutdown) is unit-tested against fakes; the real ones are in
 * `postgres-os.ts`.
 */

export type PostgresStatus =
  "initializing" | "recovering" | "starting" | "ready" | "stopping" | "stopped";

/** Bounds, in seconds, on each step that waits for a PostgreSQL binary. */
export interface PostgresTimeouts {
  readonly initSeconds: number;
  readonly startSeconds: number;
  readonly readySeconds: number;
  readonly stopFastSeconds: number;
  readonly stopImmediateSeconds: number;
}

export interface PostgresRunnerOptions {
  /** Holds `initdb`, `pg_ctl` and `postgres` (`.exe` appended on Windows). */
  readonly binDir: string;
  /** The cluster directory. Never under the install directory. */
  readonly dataDir: string;
  readonly port: number;
  readonly superuser: string;
  /** Never logged, never put in an argument list, never in an error. */
  readonly password: string;
  /** The application database, created on first start if it is absent. */
  readonly database: string;
  /** Where the server appends its own log (`pg_ctl -l`). */
  readonly serverLogFile: string;
  readonly log: (line: string) => void;
  readonly onStatus?: (status: PostgresStatus) => void;
  readonly timeouts?: Partial<PostgresTimeouts>;
}

export interface PostgresRunner {
  /**
   * Resolves once the server accepts an authenticated connection on
   * `127.0.0.1:<port>` and the application database exists. A rejection means
   * no server was left running. Idempotent.
   */
  start(): Promise<void>;
  /** Shuts the server down; a no-op when none is running. Idempotent. */
  stop(): Promise<void>;
}

export interface RunResult {
  /** The exit code, or null when the binary was killed or never started. */
  readonly code: number | null;
  /** stdout and stderr in arrival order; empty for an unattended run. */
  readonly output: string;
  readonly timedOut: boolean;
}

export interface RunOptions {
  readonly timeoutMs: number;
}

/**
 * What the process behind a pid found in `postmaster.pid` is: gone, the
 * postmaster of this data directory, or something else that was handed the
 * same pid after the server died.
 */
export type ProcessKind = "dead" | "postmaster" | "other";

export interface ProbeContext {
  readonly dataDir: string;
  readonly pgCtl: string;
}

export interface PgConnectConfig {
  readonly host: string;
  readonly port: number;
  readonly user: string;
  readonly password: string;
  readonly database: string;
  readonly connectTimeoutMs: number;
}

export interface PgSession {
  query(
    text: string,
    values?: readonly unknown[],
  ): Promise<{ readonly rows: readonly unknown[] }>;
  end(): Promise<void>;
}

export interface RunnerFs {
  exists(path: string): Promise<boolean>;
  list(dir: string): Promise<readonly string[]>;
  readText(path: string): Promise<string>;
  /** Creates the file exclusively with mode 0600. */
  writeSecret(path: string, content: string): Promise<void>;
  /** Writes and flushes the file to disk before resolving. */
  writeDurable(path: string, content: string): Promise<void>;
  /** Removes a file; resolves when it is already absent. */
  remove(path: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  makeDir(path: string): Promise<void>;
  /** The size in bytes, 0 when the file is absent. */
  size(path: string): Promise<number>;
  /** The text from a byte offset to the end, empty when absent. */
  readFrom(path: string, offset: number): Promise<string>;
}

export interface PostgresRunnerDeps {
  readonly platform: NodeJS.Platform;
  /** Runs a binary to completion and captures its output. */
  run(
    file: string,
    args: readonly string[],
    options: RunOptions,
  ): Promise<RunResult>;
  /**
   * Runs a binary to completion with every stdio stream ignored, for the one
   * command that leaves a long-lived process behind (`pg_ctl start`).
   */
  runUnattended(
    file: string,
    args: readonly string[],
    options: RunOptions,
  ): Promise<RunResult>;
  readonly fs: RunnerFs;
  probeProcess(pid: number, context: ProbeContext): Promise<ProcessKind>;
  connect(config: PgConnectConfig): Promise<PgSession>;
  now(): Date;
  sleep(ms: number): Promise<void>;
}
