import { PathModule } from "../supervisor/postgres-args";
import { isVolatile, STAGING_MARKER } from "./layout";
import {
  CancelSignal,
  FileDigest,
  messageOf,
  MoveError,
  MoveFs,
} from "./move-types";

/**
 * Copying a data folder and proving the copy: every file is hashed as it is
 * read, read back from the new place and hashed again, and the source is
 * looked at a second time to prove nothing wrote to it meanwhile.
 */

export interface TreeEntry {
  /** Relative to the root, `/`-separated; a directory precedes its content. */
  readonly rel: string;
  readonly kind: "file" | "dir";
  readonly size: number;
  readonly mtimeMs: number;
  readonly mode: number;
}

export interface Tree {
  readonly entries: readonly TreeEntry[];
  readonly files: number;
  readonly bytes: number;
}

export interface TreeContext {
  readonly fs: MoveFs;
  readonly path: PathModule;
}

const VOLATILE_ATTEMPTS = 5;
const VOLATILE_PAUSE_MS = 200;

export function absolute(path: PathModule, root: string, rel: string): string {
  return path.join(root, ...rel.split("/"));
}

/**
 * Lists what is under `root`, skipping (and not entering) what `include`
 * refuses. A link, a device or anything else that is neither a file nor a
 * folder stops the move: PostgreSQL uses links only for tablespaces, which
 * Monize never creates, so one here is something this code does not know.
 */
export async function scanTree(
  context: TreeContext,
  root: string,
  include: (rel: string) => boolean,
): Promise<Tree> {
  const { fs, path } = context;
  const entries: TreeEntry[] = [];
  let bytes = 0;
  let files = 0;
  const walk = async (dirRel: string): Promise<void> => {
    const dir = dirRel === "" ? root : absolute(path, root, dirRel);
    const names = [...(await fs.list(dir))].sort();
    for (const name of names) {
      const rel = dirRel === "" ? name : `${dirRel}/${name}`;
      if (!include(rel)) continue;
      const stat = await fs.lstat(absolute(path, root, rel));
      if (stat === null) continue;
      if (stat.kind === "other") {
        throw new MoveError(
          "unsupported-entry",
          `${absolute(path, root, rel)} is a link or a special file, which a move does not copy.`,
        );
      }
      const { kind, size, mtimeMs, mode } = stat;
      entries.push({
        rel,
        kind,
        size: kind === "dir" ? 0 : size,
        mtimeMs,
        mode,
      });
      if (kind === "dir") {
        await walk(rel);
      } else {
        files += 1;
        bytes += size;
      }
    }
  };
  await walk("");
  return { entries, files, bytes };
}

function assertNotCancelled(signal: CancelSignal): void {
  if (signal.cancelled) {
    throw new MoveError("cancelled", "The move was cancelled.");
  }
}

/** The digest of what was copied, or null for a volatile file that has gone. */
async function copyOne(
  context: TreeContext,
  from: string,
  to: string,
  entry: TreeEntry,
): Promise<FileDigest | null> {
  const { fs } = context;
  if (!isVolatile(entry.rel)) {
    return fs.copyFile(from, to, entry.mode);
  }
  // Chromium may be replacing the file, or the logger rotating it, right now.
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await fs.copyFile(from, to, entry.mode);
    } catch (error) {
      await fs.removeFile(to);
      if ((await fs.lstat(from)) === null) return null;
      if (attempt >= VOLATILE_ATTEMPTS) throw error;
      await fs.sleep(VOLATILE_PAUSE_MS);
    }
  }
}

export interface CopyResult {
  /** What the copy holds: `tree` less any volatile file that had gone. */
  readonly copied: readonly TreeEntry[];
  readonly digests: ReadonlyMap<string, FileDigest>;
}

/** Copies `tree` from `source` into the existing, empty `dest`. */
export async function copyTree(
  context: TreeContext,
  source: string,
  dest: string,
  tree: Tree,
  signal: CancelSignal,
  onBytes: (done: number) => void,
): Promise<CopyResult> {
  const { fs, path } = context;
  const digests = new Map<string, FileDigest>();
  const copied: TreeEntry[] = [];
  let done = 0;
  for (const entry of tree.entries) {
    assertNotCancelled(signal);
    const from = absolute(path, source, entry.rel);
    const to = absolute(path, dest, entry.rel);
    let digest: FileDigest | null = null;
    try {
      if (entry.kind === "dir") {
        await fs.mkdir(to, entry.mode);
      } else {
        digest = await copyOne(context, from, to, entry);
      }
    } catch (error) {
      throw new MoveError(
        "copy-failed",
        `Copying ${from} failed: ${messageOf(error)}`,
      );
    }
    if (entry.kind === "dir" || digest !== null) copied.push(entry);
    if (digest === null) continue;
    if (!isVolatile(entry.rel) && digest.size !== entry.size) {
      throw new MoveError(
        "source-changed",
        `${from} changed size while it was being copied.`,
      );
    }
    digests.set(entry.rel, digest);
    done += digest.size;
    onBytes(done);
  }
  return { copied, digests };
}

function shapeOf(
  entries: readonly TreeEntry[],
  sizes: (entry: TreeEntry) => number,
): string[] {
  return entries.map((entry) => `${entry.kind} ${entry.rel} ${sizes(entry)}`);
}

function firstDifference(a: readonly string[], b: readonly string[]): string {
  const inB = new Set(b);
  const inA = new Set(a);
  return (
    a.find((line) => !inB.has(line)) ?? b.find((line) => !inA.has(line)) ?? ""
  );
}

/**
 * Proves `dest` holds exactly what was read from `source`, and that `source`
 * is still what it was when the copy began. Throws `verify-mismatch` or
 * `source-changed`.
 */
export async function verifyTree(
  context: TreeContext,
  source: string,
  dest: string,
  tree: Tree,
  { copied, digests }: CopyResult,
  include: (rel: string) => boolean,
  signal: CancelSignal,
  onBytes: (done: number) => void,
): Promise<void> {
  const { fs, path } = context;
  const copiedSize = (entry: TreeEntry): number =>
    entry.kind === "dir" ? 0 : (digests.get(entry.rel)?.size ?? -1);

  // 1. The same folders and files, each file the size that was read.
  const there = await scanTree(context, dest, (rel) => rel !== STAGING_MARKER);
  const expected = shapeOf(copied, copiedSize);
  const actual = shapeOf(there.entries, (entry) => entry.size);
  const different = firstDifference(expected, actual);
  if (expected.length !== actual.length || different !== "") {
    throw new MoveError(
      "verify-mismatch",
      `The copy does not hold the same files as the original (${copied.length} expected, ${there.entries.length} found; first difference: ${different}).`,
    );
  }

  // 2. The same content, read back from the new place.
  let done = 0;
  for (const entry of copied) {
    if (entry.kind === "dir") continue;
    assertNotCancelled(signal);
    const file = absolute(path, dest, entry.rel);
    const readBack = await fs.digest(file);
    const copied = digests.get(entry.rel);
    if (
      copied === undefined ||
      readBack.size !== copied.size ||
      readBack.sha256 !== copied.sha256
    ) {
      throw new MoveError(
        "verify-mismatch",
        `${file} does not read back as it was written.`,
      );
    }
    done += readBack.size;
    onBytes(done);
  }

  // 3. Nothing wrote to the original while it was being copied.
  const stable = (entry: TreeEntry): boolean => !isVolatile(entry.rel);
  const identity = (entry: TreeEntry): string =>
    `${entry.kind} ${entry.rel} ${entry.size} ${entry.kind === "dir" ? "" : entry.mtimeMs}`;
  const before = tree.entries.filter(stable).map(identity);
  const now = await scanTree(context, source, include);
  const after = now.entries.filter(stable).map(identity);
  const changed = firstDifference(before, after);
  if (before.length !== after.length || changed !== "") {
    throw new MoveError(
      "source-changed",
      `The data folder changed while it was being copied (${changed}), so the copy cannot be trusted.`,
    );
  }
}
