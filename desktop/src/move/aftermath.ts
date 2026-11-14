import { PathModule } from "../supervisor/postgres-args";
import {
  CONFIG_FILE,
  OWNED_TOP_LEVEL,
  POSTMASTER_PID,
  TOMBSTONE_FILE,
} from "./layout";
import { DataLocation, writeLocation } from "./location";
import { messageOf, MoveFs } from "./move-types";
import { parseTombstone, tombstoneFileIn, writeTombstone } from "./records";
import { relationOf } from "./target";
import { absolute } from "./tree";

/**
 * What happens to a move after the restart: the new folder proves itself
 * (`confirmMove`), or it does not and the person goes back (`rollbackMove`);
 * and, only when the person asks, the old copy is deleted (`removeOldCopy`).
 */

export interface AftermathDeps {
  readonly fs: MoveFs;
  readonly path: PathModule;
  readonly platform: NodeJS.Platform;
  readonly locationFile: string;
  readonly log: (line: string) => void;
}

function save(deps: AftermathDeps, location: DataLocation): Promise<void> {
  return writeLocation(deps.locationFile, location, (file, data) =>
    deps.fs.writeFileAtomic(file, data),
  );
}

async function isFolder(fs: MoveFs, dir: string): Promise<boolean> {
  return (await fs.lstat(dir))?.kind === "dir";
}

/**
 * The stack reached `ready` on the moved folder. From here on the person may
 * have entered data in it, so going back is no longer offered. Also repeats
 * the tombstone, in case the move was killed before it wrote one.
 */
export async function confirmMove(
  deps: AftermathDeps,
  location: DataLocation,
): Promise<DataLocation> {
  const { fs, path } = deps;
  const previous = location.previousDataDir;
  if (previous !== null && (await isFolder(fs, previous))) {
    await writeTombstone(fs, path, previous, {
      movedTo: location.dataDir,
      movedAt: location.movedAt,
    }).catch((error: unknown) =>
      deps.log(
        `move: could not mark ${previous} as moved: ${messageOf(error)}`,
      ),
    );
  }
  if (location.state === "confirmed") return location;
  const confirmed: DataLocation = { ...location, state: "confirmed" };
  await save(deps, confirmed);
  deps.log(`move: ${location.dataDir} started; the move is confirmed`);
  return confirmed;
}

/** Whether "Go back to the previous folder" can be offered. */
export async function canRollBack(
  deps: AftermathDeps,
  location: DataLocation | null,
): Promise<boolean> {
  if (location === null || location.state !== "pending") return false;
  const previous = location.previousDataDir;
  if (previous === null) return false;
  return (await deps.fs.lstat(deps.path.join(previous, CONFIG_FILE))) !== null;
}

export type RollbackResult =
  | { readonly kind: "rolled-back"; readonly dataDir: string }
  | { readonly kind: "refused"; readonly message: string };

/**
 * Makes the previous folder the data folder again. Only while the move is
 * `pending` (the new folder never ran, so nothing is lost) and only once no
 * PostgreSQL has the new folder open. The new folder is left where it is,
 * tombstoned, never deleted.
 */
export async function rollbackMove(
  deps: AftermathDeps,
  location: DataLocation,
  now: Date,
): Promise<RollbackResult> {
  const { fs, path } = deps;
  const previous = location.previousDataDir;
  if (previous === null || !(await canRollBack(deps, location))) {
    return {
      kind: "refused",
      message: "The previous data folder is not available to go back to.",
    };
  }
  if (
    (await fs.lstat(absolute(path, location.dataDir, POSTMASTER_PID))) !== null
  ) {
    return {
      kind: "refused",
      message: `A database server still has ${location.dataDir} open.`,
    };
  }
  try {
    // Before the commit: without this the previous folder would refuse to
    // start. If the pointer write below fails, the next start on the new
    // folder puts the tombstone back (`confirmMove`).
    await fs.removeFile(tombstoneFileIn(path, previous));
    await save(deps, {
      dataDir: previous,
      previousDataDir: null,
      state: "confirmed",
      movedAt: now.toISOString(),
    });
  } catch (error) {
    return { kind: "refused", message: messageOf(error) };
  }
  deps.log(`move: went back to ${previous}; ${location.dataDir} is kept`);
  if (await isFolder(fs, location.dataDir)) {
    await writeTombstone(fs, path, location.dataDir, {
      movedTo: previous,
      movedAt: now.toISOString(),
    }).catch(() => undefined);
  }
  return { kind: "rolled-back", dataDir: previous };
}

/** The person keeps the old copy: stop offering to delete it. */
export async function forgetOldCopy(
  deps: AftermathDeps,
  location: DataLocation,
): Promise<DataLocation> {
  const kept: DataLocation = { ...location, previousDataDir: null };
  await save(deps, kept);
  return kept;
}

export type RemoveOldResult =
  | { readonly kind: "removed"; readonly folderGone: boolean }
  | { readonly kind: "refused"; readonly message: string }
  | { readonly kind: "failed"; readonly message: string };

/**
 * Deletes the old copy, on the person's request and never otherwise. It must
 * be a folder apart from the current one that carries a tombstone naming the
 * current one: proof that it is the copy this data was moved from. Only what
 * Monize created in it is removed; the folder itself goes only if that
 * leaves it empty. The tombstone goes last, so a deletion that stops halfway
 * leaves a folder the shell still refuses to start on.
 */
export async function removeOldCopy(
  deps: AftermathDeps,
  location: DataLocation,
): Promise<RemoveOldResult> {
  const { fs, path } = deps;
  const old = location.previousDataDir;
  if (old === null || location.state !== "confirmed") {
    return { kind: "refused", message: "There is no old copy to delete yet." };
  }
  if (relationOf(old, location.dataDir, deps.platform) !== "apart") {
    return {
      kind: "refused",
      message: `${old} is not apart from the current data folder.`,
    };
  }
  try {
    if (!(await isFolder(fs, old))) {
      await forgetOldCopy(deps, location);
      return { kind: "removed", folderGone: true };
    }
    const tombstone = parseTombstone(
      await fs.readFile(tombstoneFileIn(path, old)),
    );
    if (
      tombstone === null ||
      relationOf(tombstone.movedTo, location.dataDir, deps.platform) !== "same"
    ) {
      return {
        kind: "refused",
        message: `${old} is not marked as the copy this data was moved from, so it was left alone.`,
      };
    }
    for (const name of OWNED_TOP_LEVEL) {
      await fs.removeTree(path.join(old, name));
    }
    await fs.removeFile(path.join(old, TOMBSTONE_FILE));
    const folderGone = await fs.rmdir(old).then(
      () => true,
      () => false,
    );
    await forgetOldCopy(deps, location);
    deps.log(`move: the old copy in ${old} was deleted`);
    return { kind: "removed", folderGone };
  } catch (error) {
    deps.log(`move: deleting ${old} stopped: ${messageOf(error)}`);
    return { kind: "failed", message: messageOf(error) };
  }
}
