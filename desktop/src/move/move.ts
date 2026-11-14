import { PathModule } from "../supervisor/postgres-args";
import { CONFIG_FILE, movesWithData, POSTMASTER_PID } from "./layout";
import { DataLocation, readLocationSync, writeLocation } from "./location";
import {
  CancelSignal,
  messageOf,
  MoveError,
  MoveFailure,
  MoveFs,
  MoveProgress,
} from "./move-types";
import {
  isStagingOf,
  markerFileIn,
  MoveJournal,
  writeJournal,
  writeTombstone,
} from "./records";
import { stagingFor } from "./target";
import { absolute, copyTree, scanTree, verifyTree } from "./tree";

/**
 * The move itself, run with the whole stack stopped:
 *
 *   journal -> copy into `<target>.monize-partial` -> verify -> rename to
 *   `<target>` -> write the pointer (THE COMMIT) -> tombstone the old folder
 *
 * Bytes before the commit, deletes after it (`docs/external-side-effects.md`):
 * until the pointer is written the old folder is the data folder and the
 * copy is bytes nobody references, removed on any failure. After it the new
 * folder is the data folder, and the old one is left whole: nothing here
 * ever deletes it.
 */

export interface MoveRequest {
  /** Unique to this attempt; ties the journal to the folder it made. */
  readonly id: string;
  readonly source: string;
  readonly target: string;
  readonly now: Date;
}

export interface MoveDeps {
  readonly fs: MoveFs;
  readonly path: PathModule;
  readonly platform: NodeJS.Platform;
  readonly locationFile: string;
  readonly journalFile: string;
  readonly signal: CancelSignal;
  readonly onProgress: (progress: MoveProgress) => void;
  readonly log: (line: string) => void;
  /** Reads the pointer back after a failed write; replaced in the spec. */
  readonly readLocation?: (file: string) => DataLocation | null;
}

export type MoveOutcome =
  /** The pointer names the target; the old folder is intact and tombstoned. */
  | { readonly kind: "moved"; readonly warnings: readonly string[] }
  /**
   * The old folder is still the data folder. `leftover` lists what of the
   * copy could not be removed (normally nothing).
   */
  | {
      readonly kind: "failed";
      readonly failure: MoveFailure;
      readonly message: string;
      readonly leftover: readonly string[];
    }
  /**
   * The pointer write failed and the pointer could not be read back, so
   * which folder is current is not known here. Nothing was deleted; the next
   * launch reads the pointer and settles it (`recover.ts`).
   */
  | { readonly kind: "uncertain"; readonly message: string };

/** Removes a folder only when it carries this move's marker. */
async function removeOwn(
  deps: MoveDeps,
  dir: string,
  id: string,
): Promise<string | null> {
  const { fs, path } = deps;
  try {
    if ((await fs.lstat(dir)) === null) return null;
    if (!(await isStagingOf(fs, path, dir, id))) return null;
    await fs.removeTree(dir);
    return null;
  } catch (error) {
    deps.log(`move: could not remove ${dir}: ${messageOf(error)}`);
    return dir;
  }
}

async function discard(
  deps: MoveDeps,
  journal: MoveJournal,
): Promise<readonly string[]> {
  const leftover = [
    await removeOwn(deps, journal.staging, journal.id),
    await removeOwn(deps, journal.to, journal.id),
  ].filter((dir): dir is string => dir !== null);
  if (leftover.length === 0) {
    // With the journal gone nothing would ever look for a leftover again.
    await deps.fs.removeFile(deps.journalFile).catch(() => undefined);
  }
  return leftover;
}

async function assertQuiescent(deps: MoveDeps, source: string): Promise<void> {
  const { fs, path } = deps;
  if ((await fs.lstat(absolute(path, source, POSTMASTER_PID))) !== null) {
    throw new MoveError(
      "source-busy",
      "The database server did not shut down cleanly, so its files cannot be copied safely. Start Monize, quit it, and try the move again.",
    );
  }
  if ((await fs.lstat(absolute(path, source, CONFIG_FILE))) === null) {
    throw new MoveError("source-busy", `${source} holds no config.json.`);
  }
}

/** Steps up to and including the rename; throws `MoveError`. */
async function buildCopy(deps: MoveDeps, journal: MoveJournal): Promise<void> {
  const { fs, path, signal } = deps;
  const { from: source, to: target, staging } = journal;
  const report =
    (phase: MoveProgress["phase"], total: number) => (done: number) =>
      deps.onProgress({ phase, doneBytes: done, totalBytes: total });

  deps.onProgress({ phase: "preparing", doneBytes: 0, totalBytes: 0 });
  const tree = await scanTree(deps, source, movesWithData);
  try {
    await fs.mkdir(staging, 0o700);
    await fs.writeFileAtomic(
      markerFileIn(path, staging),
      Buffer.from(`${journal.id}\n`, "utf8"),
    );
  } catch (error) {
    // Created but not marked: it is empty, and rmdir removes nothing else.
    await fs.rmdir(staging).catch(() => undefined);
    throw new MoveError(
      "copy-failed",
      `The folder for the copy could not be created (${staging}): ${messageOf(error)}`,
    );
  }
  deps.log(
    `move: copying ${tree.files} files, ${tree.bytes} bytes, from ${source} to ${staging}`,
  );
  const copy = await copyTree(
    deps,
    source,
    staging,
    tree,
    signal,
    report("copying", tree.bytes),
  );
  await verifyTree(
    deps,
    source,
    staging,
    tree,
    copy,
    movesWithData,
    signal,
    report("verifying", tree.bytes),
  );
  deps.log("move: the copy is complete and reads back identical");
  await fs.syncDir(staging);

  deps.onProgress({ phase: "switching", doneBytes: 0, totalBytes: 0 });
  // The folder was empty or absent when it was chosen. An empty one is
  // removed so the copy can take its name; rmdir refuses anything else.
  const existing = await fs.lstat(target);
  if (existing !== null) {
    try {
      await fs.rmdir(target);
    } catch (error) {
      throw new MoveError(
        "target-not-empty",
        `${target} is no longer empty, so nothing was put there: ${messageOf(error)}`,
      );
    }
  }
  if (signal.cancelled) {
    throw new MoveError("cancelled", "The move was cancelled.");
  }
  try {
    await fs.rename(staging, target);
  } catch (error) {
    throw new MoveError(
      "place-failed",
      `The copy could not be given the name ${target}: ${messageOf(error)}`,
    );
  }
  await fs.syncDir(path.dirname(target));
}

/** After the commit: none of these can undo the move, each is retried at launch. */
async function finish(
  deps: MoveDeps,
  journal: MoveJournal,
  movedAt: string,
): Promise<readonly string[]> {
  const { fs, path } = deps;
  const warnings: string[] = [];
  const attempt = async (what: string, step: () => Promise<void>) => {
    try {
      await step();
    } catch (error) {
      warnings.push(`${what}: ${messageOf(error)}`);
      deps.log(`move: ${what} failed: ${messageOf(error)}`);
    }
  };
  await attempt("marking the old folder as moved", () =>
    writeTombstone(fs, path, journal.from, { movedTo: journal.to, movedAt }),
  );
  await attempt("removing the copy's marker", () =>
    fs.removeFile(markerFileIn(path, journal.to)),
  );
  if (warnings.length === 0) {
    await attempt("removing the move's journal", () =>
      fs.removeFile(deps.journalFile),
    );
  }
  return warnings;
}

export async function runMove(
  deps: MoveDeps,
  request: MoveRequest,
): Promise<MoveOutcome> {
  const { fs } = deps;
  const journal: MoveJournal = {
    id: request.id,
    from: request.source,
    to: request.target,
    staging: stagingFor(request.target),
    startedAt: request.now.toISOString(),
  };
  const failed = (
    error: unknown,
    leftover: readonly string[],
  ): MoveOutcome => ({
    kind: "failed",
    failure: error instanceof MoveError ? error.failure : "copy-failed",
    message: messageOf(error),
    leftover,
  });

  try {
    await assertQuiescent(deps, request.source);
    await writeJournal(fs, deps.journalFile, journal);
  } catch (error) {
    // Nothing was created, so there is nothing to remove.
    return failed(error, []);
  }
  try {
    await buildCopy(deps, journal);
  } catch (error) {
    deps.log(`move: stopped before the switch: ${messageOf(error)}`);
    return failed(error, await discard(deps, journal));
  }

  const location: DataLocation = {
    dataDir: request.target,
    previousDataDir: request.source,
    state: "pending",
    movedAt: journal.startedAt,
  };
  try {
    await writeLocation(deps.locationFile, location, (file, data) =>
      fs.writeFileAtomic(file, data),
    );
  } catch (error) {
    // Did the write take effect anyway? Only the pointer can say.
    const read =
      deps.readLocation ?? ((file) => readLocationSync(file, deps.platform));
    let current: DataLocation | null;
    try {
      current = read(deps.locationFile);
    } catch (readError) {
      return {
        kind: "uncertain",
        message: `The new location could not be recorded (${messageOf(error)}), and the record could not be read back (${messageOf(readError)}).`,
      };
    }
    if (current?.dataDir !== request.target) {
      deps.log(`move: the pointer was not written: ${messageOf(error)}`);
      return failed(
        new MoveError(
          "pointer-failed",
          `The new location could not be recorded: ${messageOf(error)}`,
        ),
        await discard(deps, journal),
      );
    }
  }
  deps.log(`move: the data folder is now ${request.target}`);
  return {
    kind: "moved",
    warnings: await finish(deps, journal, location.movedAt),
  };
}
