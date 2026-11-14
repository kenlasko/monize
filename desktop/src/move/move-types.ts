/**
 * The contract of "Move data folder": every filesystem capability the move
 * uses, as an interface, so each failure (a copy that stops midway, a file
 * that reads back differently, a pointer that cannot be written) is a spec
 * with one capability replaced. The real ones are in `move-fs.ts`.
 */

export type EntryKind = "file" | "dir" | "other";

export interface EntryStat {
  readonly kind: EntryKind;
  readonly size: number;
  readonly mtimeMs: number;
  /** Permission bits (POSIX); PostgreSQL refuses a `pgdata` that is not 0700. */
  readonly mode: number;
}

export interface FileDigest {
  readonly size: number;
  /** SHA-256 of the content, hex. */
  readonly sha256: string;
}

export interface MoveFs {
  /** The entry itself, never what a link points to; null when absent. */
  lstat(path: string): Promise<EntryStat | null>;
  list(dir: string): Promise<readonly string[]>;
  /** Creates one directory; rejects when it exists or its parent does not. */
  mkdir(path: string, mode: number): Promise<void>;
  /**
   * Copies one file to a path that must not exist, flushes it to disk, and
   * returns the size and hash of the bytes it read from the source.
   */
  copyFile(from: string, to: string, mode: number): Promise<FileDigest>;
  /** The size and hash of a file as it reads back. */
  digest(path: string): Promise<FileDigest>;
  rename(from: string, to: string): Promise<void>;
  /** Removes an EMPTY directory; rejects when it holds anything. */
  rmdir(path: string): Promise<void>;
  /** Removes a file; resolves when it is already absent. */
  removeFile(path: string): Promise<void>;
  /** Removes a directory and everything in it; resolves when absent. */
  removeTree(path: string): Promise<void>;
  /** The file's bytes, or null when it does not exist. */
  readFile(path: string): Promise<Buffer | null>;
  /** Crash-atomic replacement (`atomic-write.ts`). */
  writeFileAtomic(path: string, data: Buffer): Promise<void>;
  /** Best effort: Windows cannot flush a directory. */
  syncDir(path: string): Promise<void>;
  /** The path with every link resolved; rejects when it does not exist. */
  realpath(path: string): Promise<string>;
  /** Bytes available to this user on the volume, or null when unknown. */
  freeBytes(path: string): Promise<number | null>;
  sleep(ms: number): Promise<void>;
}

/** Set by a quit request; the copy stops between two files. */
export interface CancelSignal {
  readonly cancelled: boolean;
}

export type MovePhase =
  "stopping" | "preparing" | "copying" | "verifying" | "switching";

export interface MoveProgress {
  readonly phase: MovePhase;
  readonly doneBytes: number;
  readonly totalBytes: number;
}

/** Why a move stopped before the pointer was written. */
export type MoveFailure =
  | "source-busy"
  | "unsupported-entry"
  | "copy-failed"
  | "source-changed"
  | "verify-mismatch"
  | "target-not-empty"
  | "place-failed"
  | "pointer-failed"
  | "cancelled";

export class MoveError extends Error {
  constructor(
    readonly failure: MoveFailure,
    message: string,
  ) {
    super(message);
    this.name = "MoveError";
  }
}

export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
