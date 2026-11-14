import { PathModule } from "../supervisor/postgres-args";
import { DataLocation } from "./location";
import { messageOf, MoveFs } from "./move-types";
import {
  isStagingOf,
  markerFileIn,
  readJournal,
  writeTombstone,
} from "./records";

/**
 * What a launch does about a move that did not end: the shell was killed, or
 * the power went, between the journal's creation and its removal. The
 * pointer decides, and only the pointer:
 *
 * - it names the journal's target: the move was committed. Its last steps
 *   are repeated (tombstone the old folder, drop the marker and the journal).
 * - it names anything else: the move never committed, whatever was already
 *   copied or renamed. The old folder is the data folder, and the copy, in
 *   its staging name or already under the target's name, is removed, but
 *   only when it carries this journal's marker.
 *
 * Runs after the single-instance lock is taken and before anything starts.
 */

export type RecoveryResult =
  | { readonly kind: "none" }
  | { readonly kind: "completed"; readonly to: string }
  | {
      readonly kind: "discarded";
      readonly to: string;
      /** Folders of the abandoned copy that could not be removed. */
      readonly leftover: readonly string[];
    }
  | { readonly kind: "unreadable-journal" };

export interface RecoverDeps {
  readonly fs: MoveFs;
  readonly path: PathModule;
  readonly journalFile: string;
  /** The pointer as this launch read it; null when there is none. */
  readonly location: DataLocation | null;
  readonly log: (line: string) => void;
}

export async function recoverInterruptedMove(
  deps: RecoverDeps,
): Promise<RecoveryResult> {
  const { fs, path, location } = deps;
  const journal = await readJournal(fs, deps.journalFile);
  if (journal === null) return { kind: "none" };
  if (journal === "unreadable") {
    // Never act on a record that cannot be read; say so and leave it.
    deps.log(`move: ${deps.journalFile} is damaged; nothing was removed`);
    return { kind: "unreadable-journal" };
  }

  if (location !== null && location.dataDir === journal.to) {
    deps.log(`move: finishing the move to ${journal.to}`);
    try {
      if (location.previousDataDir === journal.from) {
        const old = await fs.lstat(journal.from);
        if (old !== null && old.kind === "dir") {
          await writeTombstone(fs, path, journal.from, {
            movedTo: journal.to,
            movedAt: location.movedAt,
          });
        }
      }
      await fs.removeFile(markerFileIn(path, journal.to));
      await fs.removeFile(deps.journalFile);
    } catch (error) {
      deps.log(`move: could not finish tidying up: ${messageOf(error)}`);
    }
    return { kind: "completed", to: journal.to };
  }

  deps.log(
    `move: a move to ${journal.to} did not finish; removing the incomplete copy`,
  );
  const leftover: string[] = [];
  for (const dir of [journal.staging, journal.to]) {
    try {
      if ((await fs.lstat(dir)) === null) continue;
      if (!(await isStagingOf(fs, path, dir, journal.id))) continue;
      await fs.removeTree(dir);
    } catch (error) {
      deps.log(`move: could not remove ${dir}: ${messageOf(error)}`);
      leftover.push(dir);
    }
  }
  if (leftover.length === 0) {
    await fs.removeFile(deps.journalFile).catch(() => undefined);
  }
  return { kind: "discarded", to: journal.to, leftover };
}
