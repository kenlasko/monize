import {
  closeSync,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  renameSync,
  rmSync,
  writeSync,
} from "fs";
import { join } from "path";
import { StringDecoder } from "string_decoder";

/**
 * The desktop package's one logger, and the only module that writes to stdout.
 *
 * One JSON-lines file per source under `logs/` (`main.log`, `postgres.log`,
 * `backend.log`, `frontend.log`), rotated by size, plus an in-memory ring per
 * source so the supervisor can show the last lines when a boot step fails.
 * stdout gets the human shape of `frontend/server-log-format.cjs`
 * (`<ISO> [<source>] <LEVEL>: <message>`).
 *
 * Writes are synchronous: a line is on disk before the call returns, so the
 * last thing a crashing child said is in its file. Any value passed to
 * `redact` is replaced in every line, child output included, before it reaches
 * a file, the ring or stdout.
 */

export const LOG_SOURCES = ["main", "postgres", "backend", "frontend"] as const;
export type LogSource = (typeof LOG_SOURCES)[number];
export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogRecord {
  readonly time: string;
  readonly level: LogLevel;
  readonly source: LogSource;
  readonly msg: string;
}

export interface LineSink {
  /** A raw chunk from a child's stdout or stderr; may end mid-line. */
  write(chunk: Buffer | string): void;
  /** Flush a trailing partial line (call on the stream's `end`). */
  end(): void;
}

export interface Logger {
  log(source: LogSource, level: LogLevel, msg: string): void;
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
  tail(source: LogSource, n: number): readonly LogRecord[];
  lineSink(source: LogSource, level: LogLevel): LineSink;
  redact(secret: string): void;
  close(): void;
}

export interface LoggerOptions {
  readonly logsDir: string;
  readonly maxBytes?: number;
  /** Files kept per source, the live one included. */
  readonly maxFiles?: number;
  readonly ringSize?: number;
  /** Where human-readable lines go; null for none. Default `process.stdout`. */
  readonly stdout?: { write(text: string): unknown } | null;
  readonly now?: () => Date;
}

export const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;
export const DEFAULT_MAX_FILES = 5;
export const DEFAULT_RING_SIZE = 200;
/** A child line longer than this is cut and emitted, so memory stays bounded. */
export const MAX_LINE_CHARS = 64 * 1024;
const REDACTED = "[redacted]";

export function formatLogLine(record: LogRecord): string {
  return `${JSON.stringify(record)}\n`;
}

export function formatConsoleLine(record: LogRecord): string {
  return `${record.time} [${record.source}] ${record.level.toUpperCase()}: ${record.msg}\n`;
}

interface SourceFile {
  fd: number | null;
  size: number;
  failed: boolean;
}

export function createLogger(options: LoggerOptions): Logger {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const maxFiles = Math.max(1, options.maxFiles ?? DEFAULT_MAX_FILES);
  const ringSize = Math.max(1, options.ringSize ?? DEFAULT_RING_SIZE);
  const stdout = options.stdout === undefined ? process.stdout : options.stdout;
  const now = options.now ?? (() => new Date());
  const secrets: string[] = [];
  const rings = new Map<LogSource, LogRecord[]>(
    LOG_SOURCES.map((source) => [source, []]),
  );
  const files = new Map<LogSource, SourceFile>(
    LOG_SOURCES.map((source) => [source, { fd: null, size: 0, failed: false }]),
  );

  const pathOf = (source: LogSource, index: number): string =>
    join(
      options.logsDir,
      index === 0 ? `${source}.log` : `${source}.log.${index}`,
    );

  function open(source: LogSource, file: SourceFile): void {
    mkdirSync(options.logsDir, { recursive: true });
    file.fd = openSync(pathOf(source, 0), "a");
    file.size = fstatSync(file.fd).size;
  }

  function rotate(source: LogSource, file: SourceFile): void {
    if (file.fd !== null) closeSync(file.fd);
    file.fd = null;
    rmSync(pathOf(source, maxFiles - 1), { force: true });
    for (let index = maxFiles - 2; index >= 0; index--) {
      const from = pathOf(source, index);
      if (existsSync(from)) renameSync(from, pathOf(source, index + 1));
    }
    open(source, file);
  }

  function toFile(source: LogSource, line: string): void {
    const file = files.get(source) as SourceFile;
    if (file.failed) return;
    try {
      if (file.fd === null) open(source, file);
      const bytes = Buffer.byteLength(line);
      if (file.size > 0 && file.size + bytes > maxBytes) rotate(source, file);
      writeSync(file.fd as number, line);
      file.size += bytes;
    } catch (error) {
      // A log folder we cannot write to must not take the app down; the ring
      // and stdout still work, and this says so once.
      file.failed = true;
      stdout?.write(
        `${now().toISOString()} [main] ERROR: cannot write ${source}.log ` +
          `(${(error as NodeJS.ErrnoException).code ?? "unknown error"}); ` +
          "file logging for it is off.\n",
      );
    }
  }

  function scrub(msg: string): string {
    return secrets.reduce(
      (text, secret) => text.split(secret).join(REDACTED),
      msg,
    );
  }

  function log(source: LogSource, level: LogLevel, msg: string): void {
    const record: LogRecord = {
      time: now().toISOString(),
      level,
      source,
      msg: scrub(msg),
    };
    const ring = rings.get(source) as LogRecord[];
    ring.push(record);
    if (ring.length > ringSize) ring.splice(0, ring.length - ringSize);
    toFile(source, formatLogLine(record));
    stdout?.write(formatConsoleLine(record));
  }

  function lineSink(source: LogSource, level: LogLevel): LineSink {
    const decoder = new StringDecoder("utf8");
    let pending = "";
    const emit = (line: string): void =>
      log(source, level, line.replace(/\r$/, ""));
    return {
      write(chunk) {
        pending += typeof chunk === "string" ? chunk : decoder.write(chunk);
        let newline = pending.indexOf("\n");
        while (newline !== -1) {
          emit(pending.slice(0, newline));
          pending = pending.slice(newline + 1);
          newline = pending.indexOf("\n");
        }
        while (pending.length > MAX_LINE_CHARS) {
          emit(pending.slice(0, MAX_LINE_CHARS));
          pending = pending.slice(MAX_LINE_CHARS);
        }
      },
      end() {
        pending += decoder.end();
        if (pending.length > 0) emit(pending);
        pending = "";
      },
    };
  }

  return {
    log,
    info: (msg) => log("main", "info", msg),
    warn: (msg) => log("main", "warn", msg),
    error: (msg) => log("main", "error", msg),
    tail(source, n) {
      const ring = rings.get(source) as LogRecord[];
      return n <= 0 ? [] : ring.slice(-n);
    },
    lineSink,
    redact(secret) {
      if (secret.length > 0 && !secrets.includes(secret)) secrets.push(secret);
    },
    close() {
      for (const file of files.values()) {
        if (file.fd !== null) closeSync(file.fd);
        file.fd = null;
      }
    },
  };
}
