import { randomUUID } from "crypto";
import { promises as fs } from "fs";
import { basename, dirname, join } from "path";

/**
 * Crash-atomic file replacement for `config.json`, the same shape as
 * `backend/src/backup/atomic-file.ts`: write a private temporary name in the
 * same directory, fsync it, check its size, rename it over the final name,
 * then fsync the directory. A reader sees the previous file or the complete
 * new one, never a truncated config that would read as a damaged install.
 */

const TEMP_PREFIX = ".monize-tmp-";

function tempPathFor(finalPath: string): string {
  return join(
    dirname(finalPath),
    `${TEMP_PREFIX}${process.pid}-${randomUUID()}-${basename(finalPath)}`,
  );
}

/** Best-effort: Windows refuses to open a directory for fsync. */
async function syncDirectory(path: string): Promise<void> {
  let handle: fs.FileHandle | undefined;
  try {
    handle = await fs.open(path, "r");
    await handle.sync();
  } catch {
    // Not fatal; the rename has already happened.
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

/** `write(2)` may write less than asked and say so; loop until done. */
async function writeFully(handle: fs.FileHandle, data: Buffer): Promise<void> {
  let written = 0;
  while (written < data.length) {
    const { bytesWritten } = await handle.write(
      data,
      written,
      data.length - written,
    );
    if (bytesWritten <= 0) {
      throw new Error(`Write stalled after ${written} of ${data.length} bytes`);
    }
    written += bytesWritten;
  }
}

/**
 * Replace `finalPath` with `data`. `mode` applies to the new file (POSIX only;
 * Windows ignores it, where the per-user profile directory is the boundary).
 */
export async function writeFileAtomic(
  finalPath: string,
  data: Buffer,
  mode = 0o600,
): Promise<void> {
  const tempPath = tempPathFor(finalPath);
  let handle: fs.FileHandle | undefined;
  try {
    handle = await fs.open(tempPath, "wx", mode);
    await writeFully(handle, data);
    await handle.sync();
    const { size } = await handle.stat();
    if (size !== data.length) {
      throw new Error(
        `Refusing to publish ${finalPath}: temporary file is ${size} bytes, expected ${data.length}`,
      );
    }
    await handle.close();
    handle = undefined;
    await fs.rename(tempPath, finalPath);
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await fs.unlink(tempPath).catch(() => undefined);
    throw error;
  }
  await syncDirectory(dirname(finalPath));
}
