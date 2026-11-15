/**
 * Which step of the runner failed. The splash window shows the message and
 * the output tail; the boot state machine may branch on the step (`auth` is
 * the one a retry cannot fix).
 */
export type PostgresFailure =
  | "config"
  | "init"
  | "recover"
  | "start"
  | "ready"
  | "auth"
  | "database"
  | "stop";

export class PostgresRunnerError extends Error {
  readonly failure: PostgresFailure;
  /** The last lines the failing binary (or the server log) printed. */
  readonly outputTail: string;

  constructor(failure: PostgresFailure, message: string, outputTail = "") {
    super(message);
    this.name = "PostgresRunnerError";
    this.failure = failure;
    this.outputTail = outputTail;
  }
}

const TAIL_LINES = 25;
const TAIL_CHARS = 4000;

/** The end of a binary's output, bounded so it fits a dialog and a log line. */
export function tailOf(output: string): string {
  const lines = output.replace(/\r\n/g, "\n").trimEnd().split("\n");
  const tail = lines.slice(-TAIL_LINES).join("\n");
  return tail.length > TAIL_CHARS ? tail.slice(-TAIL_CHARS) : tail;
}

export type Redactor = (text: string) => string;

/**
 * Removes a secret from text on its way to a log or an error. The runner never
 * hands the password to anything that echoes it, so this is the second line
 * of defence, not the first.
 */
export function createRedactor(secret: string): Redactor {
  if (secret.length === 0) {
    return (text) => text;
  }
  return (text) => text.split(secret).join("[redacted]");
}

export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
