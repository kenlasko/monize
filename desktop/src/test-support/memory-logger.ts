import { LineSink, Logger, LogLevel, LogRecord, LogSource } from "../logger";

/**
 * A `Logger` that keeps every record in memory and touches no file, for specs
 * only. It splits child output into lines as the real one does and records
 * what it was asked to redact; the real redaction is `logger.spec.ts`'s
 * subject, not this fake's.
 */
export interface MemoryLogger extends Logger {
  readonly records: readonly LogRecord[];
  readonly redacted: readonly string[];
  /** The messages of one source, in order. */
  messages(source: LogSource): readonly string[];
}

export function memoryLogger(): MemoryLogger {
  const records: LogRecord[] = [];
  const redacted: string[] = [];

  function log(source: LogSource, level: LogLevel, msg: string): void {
    records.push({ time: "2026-01-01T00:00:00.000Z", level, source, msg });
  }

  function lineSink(source: LogSource, level: LogLevel): LineSink {
    let pending = "";
    return {
      write(chunk) {
        const lines = (pending + chunk.toString()).split("\n");
        pending = lines.pop() ?? "";
        for (const line of lines) log(source, level, line);
      },
      end() {
        if (pending.length > 0) log(source, level, pending);
        pending = "";
      },
    };
  }

  const ofSource = (source: LogSource): LogRecord[] =>
    records.filter((record) => record.source === source);

  return {
    records,
    redacted,
    log,
    info: (msg) => log("main", "info", msg),
    warn: (msg) => log("main", "warn", msg),
    error: (msg) => log("main", "error", msg),
    tail: (source, n) => (n <= 0 ? [] : ofSource(source).slice(-n)),
    lineSink,
    redact: (secret) => {
      redacted.push(secret);
    },
    close: () => undefined,
    messages: (source) => ofSource(source).map((record) => record.msg),
  };
}
