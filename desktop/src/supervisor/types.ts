import { LogRecord, LogSource } from "../logger";

/**
 * What the supervisor says to the shell around it (the splash, the tray, the
 * dialogs). Everything here is an identifier or data, never a sentence: the
 * shell maps each identifier to text, so the text can be translated without
 * touching the state machine.
 */

/** The boot order (plan section 6). */
export const BOOT_STEPS = [
  "postgres",
  "db-init",
  "db-migrate",
  "backend",
  "frontend",
] as const;
export type BootStep = (typeof BOOT_STEPS)[number];

/** The two long-lived children, in start order. */
export const SERVER_NAMES = ["backend", "frontend"] as const;
export type ServerName = (typeof SERVER_NAMES)[number];

/**
 * Every status the supervisor reports, as a closed list so a
 * `Record<SupervisorStatus, string>` in the shell is checked for completeness.
 * A boot step's status is the step's own name: it means "this step is running".
 */
export const SUPERVISOR_STATUSES = [
  "idle",
  ...BOOT_STEPS,
  "ready",
  "restarting-backend",
  "restarting-frontend",
  /** A child failed again after its one restart; nothing restarts it now. */
  "fatal",
  /** A boot step failed; everything it had started has been stopped. */
  "failed",
  "stopping",
  "stopped",
] as const;
export type SupervisorStatus = (typeof SUPERVISOR_STATUSES)[number];

/** Why a step or a child failed. `message` fields are diagnostics for the log. */
export type FailureCause =
  /** The process ended: a one-shot step with a non-zero code, or a server that died. */
  | {
      readonly kind: "exited";
      readonly code: number | null;
      readonly signal: string | null;
    }
  /** The process never started (`ENOENT`, `EACCES`, ...). */
  | {
      readonly kind: "spawn-error";
      readonly code: string | null;
      readonly message: string;
    }
  /** A one-shot step did not finish, or a server did not answer 200, in time. */
  | {
      readonly kind: "timeout";
      readonly deadlineMs: number;
      /** The last health answer, for a server; null for a one-shot step. */
      readonly lastStatus: number | null;
      readonly lastError: string | null;
    }
  /** Something threw; for the `postgres` step, `error` is the runner's own typed error. */
  | {
      readonly kind: "error";
      readonly message: string;
      readonly error: unknown;
    };

export interface BootFailure {
  readonly step: BootStep;
  readonly cause: FailureCause;
  /** Which log file to open for "Show logs". */
  readonly logSource: LogSource;
  /** The last lines of that source at the moment the step failed. */
  readonly logTail: readonly LogRecord[];
}

/** A child that failed again after its one restart (after `ready`). */
export interface FatalFailure {
  readonly child: ServerName;
  readonly cause: FailureCause;
  readonly logSource: LogSource;
  readonly logTail: readonly LogRecord[];
}

/** How `start()` settles. It never rejects. */
export type BootResult =
  | { readonly outcome: "ready" }
  | { readonly outcome: "failed"; readonly failure: BootFailure }
  /** `stop()` was called before the boot finished. */
  | { readonly outcome: "cancelled" };

export type StopComponent = ServerName | "postgres";

/** How `stop()` settles. It never rejects; a component that failed to stop is listed. */
export interface StopReport {
  readonly errors: readonly {
    readonly component: StopComponent;
    readonly error: unknown;
  }[];
}

/**
 * The PostgreSQL runner (plan D5), taken as a dependency. Both calls are
 * idempotent. `start()` resolves once the server accepts authenticated
 * connections and the database exists. The server is detached (`pg_ctl`), so
 * there is no exit to observe: it is running from `start()` until `stop()`.
 */
export interface PostgresRunner {
  start(): Promise<void>;
  stop(): Promise<void>;
}

export interface Supervisor {
  readonly status: SupervisorStatus;
  /** Set once the `fatal` status has been reached. */
  readonly fatal: FatalFailure | null;
  /**
   * Boot the stack. A boot in flight, or one that reached `ready`, is returned
   * as is: calling twice is one boot. After a `failed` boot it starts a new one
   * (the splash's Retry). After `stop()` it settles as `cancelled`.
   */
  start(): Promise<BootResult>;
  /**
   * Stop frontend, backend, then PostgreSQL, awaiting each. Cancels a boot in
   * flight. Idempotent and safe to call concurrently: every call gets the same
   * promise. Terminal: build a new supervisor to start again.
   */
  stop(): Promise<StopReport>;
  /** Called on every status change. Returns the unsubscribe function. */
  onStatus(listener: (status: SupervisorStatus) => void): () => void;
  /** Called once if the `fatal` status is reached. Returns the unsubscribe function. */
  onFatal(listener: (failure: FatalFailure) => void): () => void;
  /**
   * Called when a server has been starting for `startupProgressMs` without
   * answering, once per wait (a boot step, or a restart). Returns the
   * unsubscribe function.
   */
  onSlowStart(listener: (server: ServerName) => void): () => void;
}

export interface BootOptions {
  /** `db-init` applies `schema.sql` on first run and exits at once afterwards. */
  readonly dbInitDeadlineMs: number;
  /**
   * `db-migrate` on a large database after a long-skipped upgrade is the slow
   * step, and stopping it only rolls back the migration it was in, so the
   * bound is there to surface a hang, not to hurry the work.
   */
  readonly dbMigrateDeadlineMs: number;
  /**
   * From spawning `main.js` to a 200 from its readiness route. Generous on
   * purpose: the first start after an install or an update reads every file
   * of the module graph for the first time, with the antivirus scanning each
   * one, and a real PC took over two minutes where a CI runner takes five
   * seconds. A server that dies ends the wait at once, so the bound only
   * costs time on a real hang.
   */
  readonly backendReadyDeadlineMs: number;
  /** From spawning `server.js` to a 200 from its liveness route; as above. */
  readonly frontendReadyDeadlineMs: number;
  /**
   * While a server is starting, how often the log says it still is. The first
   * time is also when `onSlowStart` fires, so the splash can say a long wait
   * is expected.
   */
  readonly startupProgressMs: number;
  readonly healthIntervalMs: number;
  readonly healthRequestTimeoutMs: number;
  /** The pause before the one restart of a child that exited after `ready`. */
  readonly restartBackoffMs: number;
  /** A second exit of the same child within this long is fatal. */
  readonly restartWindowMs: number;
  /** Lines of log carried on a failure. */
  readonly logTailLines: number;
}

export const DEFAULT_BOOT_OPTIONS: BootOptions = {
  dbInitDeadlineMs: 5 * 60_000,
  dbMigrateDeadlineMs: 30 * 60_000,
  backendReadyDeadlineMs: 10 * 60_000,
  frontendReadyDeadlineMs: 5 * 60_000,
  startupProgressMs: 20_000,
  healthIntervalMs: 250,
  healthRequestTimeoutMs: 3000,
  restartBackoffMs: 2000,
  restartWindowMs: 60_000,
  logTailLines: 50,
};

/** `defaults` with every defined key of `overrides` applied. */
export function withDefaults<T extends object>(
  defaults: T,
  overrides: Partial<T> | undefined,
): T {
  const defined = Object.fromEntries(
    Object.entries(overrides ?? {}).filter(([, value]) => value !== undefined),
  );
  return { ...defaults, ...defined };
}

/** One line for the log file. Not for a dialog: the shell maps `kind` to text. */
export function describeCause(cause: FailureCause): string {
  switch (cause.kind) {
    case "exited":
      return cause.signal !== null
        ? `ended by ${cause.signal}`
        : `exit code ${cause.code ?? "unknown"}`;
    case "spawn-error":
      return `could not be started: ${cause.message}`;
    case "timeout": {
      const last =
        cause.lastStatus !== null
          ? `; last answer was HTTP ${cause.lastStatus}`
          : cause.lastError !== null
            ? `; last attempt: ${cause.lastError}`
            : "";
      return `not done within ${cause.deadlineMs} ms${last}`;
    }
    case "error":
      return cause.message;
  }
}
