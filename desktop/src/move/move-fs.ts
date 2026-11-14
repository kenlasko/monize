import { createHash } from "crypto";
import { createReadStream, promises as fs } from "fs";

import { writeFileAtomic } from "../atomic-write";
import { EntryStat, FileDigest, MoveFs } from "./move-types";

/** The real filesystem behind `MoveFs`. */

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

async function lstat(path: string): Promise<EntryStat | null> {
  try {
    const stat = await fs.lstat(path);
    return {
      kind: stat.isFile() ? "file" : stat.isDirectory() ? "dir" : "other",
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      mode: stat.mode & 0o777,
    };
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
}

/** Reads the file once, hashing it and handing each chunk to `sink`. */
async function readThrough(
  path: string,
  sink: (chunk: Buffer) => Promise<void>,
): Promise<FileDigest> {
  const hash = createHash("sha256");
  let size = 0;
  for await (const chunk of createReadStream(path) as AsyncIterable<Buffer>) {
    hash.update(chunk);
    size += chunk.length;
    await sink(chunk);
  }
  return { size, sha256: hash.digest("hex") };
}

async function copyFile(
  from: string,
  to: string,
  mode: number,
): Promise<FileDigest> {
  // "wx": never write over something that is already there.
  const handle = await fs.open(to, "wx", mode);
  try {
    const digest = await readThrough(from, async (chunk) => {
      let written = 0;
      while (written < chunk.length) {
        const result = await handle.write(chunk, written);
        if (result.bytesWritten <= 0) {
          throw new Error(`Write stalled in ${to}`);
        }
        written += result.bytesWritten;
      }
    });
    // The process umask may have narrowed the mode given to open().
    await handle.chmod(mode).catch(() => undefined);
    // A backup's date in the application is its file's modification time.
    const source = await fs.stat(from);
    await handle.utimes(source.atime, source.mtime).catch(() => undefined);
    await handle.sync();
    return digest;
  } finally {
    await handle.close();
  }
}

async function syncDir(path: string): Promise<void> {
  let handle: fs.FileHandle | undefined;
  try {
    handle = await fs.open(path, "r");
    await handle.sync();
  } catch {
    // Windows refuses to open a directory for this; nothing depends on it.
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function freeBytes(path: string): Promise<number | null> {
  try {
    const stat = await fs.statfs(path);
    return stat.bavail * stat.bsize;
  } catch {
    return null;
  }
}

export const nodeMoveFs: MoveFs = {
  lstat,
  list: (dir) => fs.readdir(dir),
  async mkdir(path, mode) {
    await fs.mkdir(path, { mode });
    await fs.chmod(path, mode).catch(() => undefined);
  },
  copyFile,
  digest: (path) => readThrough(path, async () => undefined),
  rename: (from, to) => fs.rename(from, to),
  rmdir: (path) => fs.rmdir(path),
  removeFile: (path) => fs.rm(path, { force: true }),
  removeTree: (path) =>
    fs.rm(path, { recursive: true, force: true, maxRetries: 3 }),
  async readFile(path) {
    try {
      return await fs.readFile(path);
    } catch (error) {
      if (isMissing(error)) return null;
      throw error;
    }
  },
  writeFileAtomic: (path, data) => writeFileAtomic(path, data),
  syncDir,
  realpath: (path) => fs.realpath(path),
  freeBytes,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};
