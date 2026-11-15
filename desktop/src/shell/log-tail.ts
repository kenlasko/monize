import { promises as fs } from "fs";
import { join } from "path";

import {
  displayLine,
  VIEWER_SOURCE_FILES,
  ViewerSourceId,
} from "./log-sources";

/**
 * The last lines of a log file, read from the end in chunks so a file of any
 * size costs at most `MAX_TAIL_BYTES` of memory. Pure Node: the log viewer's
 * main side calls it, and a spec runs it over temp files.
 */

export const MAX_TAIL_BYTES = 1024 * 1024;
const CHUNK_BYTES = 64 * 1024;
/** `logger.ts` keeps five files per source: `x.log` and `x.log.1` to `.4`. */
export const MAX_ROTATED_FILES = 4;

function isMissing(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}

function countNewlines(chunk: Buffer): number {
  let count = 0;
  for (const byte of chunk) if (byte === 0x0a) count++;
  return count;
}

/**
 * The last `maxLines` non-empty lines of `path`, oldest first; `null` when
 * the file does not exist. A last line with no newline yet (a write in
 * progress) is returned as it stands. When the read stopped before the start
 * of the file, the first line of the window may be cut and is dropped, unless
 * it is the only one.
 */
export async function readFileTail(
  path: string,
  maxLines: number,
  maxBytes = MAX_TAIL_BYTES,
): Promise<string[] | null> {
  let handle: fs.FileHandle;
  try {
    handle = await fs.open(path, "r");
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
  try {
    const { size } = await handle.stat();
    const chunks: Buffer[] = [];
    let position = size;
    let total = 0;
    let newlines = 0;
    while (position > 0 && total < maxBytes && newlines <= maxLines) {
      const length = Math.min(CHUNK_BYTES, position, maxBytes - total);
      position -= length;
      const chunk = Buffer.alloc(length);
      const { bytesRead } = await handle.read(chunk, 0, length, position);
      const data = chunk.subarray(0, bytesRead);
      chunks.unshift(data);
      total += bytesRead;
      newlines += countNewlines(data);
    }
    const pieces = Buffer.concat(chunks).toString("utf8").split("\n");
    if (position > 0 && pieces.length > 1) pieces.shift();
    const lines = pieces
      .map((piece) => piece.replace(/\r$/, ""))
      .filter((piece) => piece !== "");
    return lines.slice(-maxLines);
  } finally {
    await handle.close();
  }
}

export interface SourceTail {
  /** False when no file of the source exists yet. */
  readonly found: boolean;
  /** Display lines, oldest first. */
  readonly lines: readonly string[];
}

/**
 * The tail of one source: its live file, then the rotated files (`.1`, `.2`,
 * ...) while more lines are wanted, so a fresh rotation does not empty the
 * viewer.
 */
export async function readSourceTail(
  logsDir: string,
  source: ViewerSourceId,
  maxLines: number,
): Promise<SourceTail> {
  const file = VIEWER_SOURCE_FILES[source];
  let lines: string[] = [];
  let found = false;
  for (let index = 0; index <= MAX_ROTATED_FILES; index++) {
    const name = index === 0 ? file : `${file}.${index}`;
    const part = await readFileTail(
      join(logsDir, name),
      maxLines - lines.length,
    );
    if (part === null) {
      if (index === 0) continue;
      break;
    }
    found = true;
    lines = [...part, ...lines];
    if (lines.length >= maxLines) break;
  }
  return { found, lines: lines.map(displayLine) };
}
