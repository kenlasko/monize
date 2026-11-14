import { PathModule } from "../supervisor/postgres-args";
import {
  AftermathDeps,
  canRollBack,
  confirmMove,
  forgetOldCopy,
  removeOldCopy,
  RemoveOldResult,
  rollbackMove,
} from "./aftermath";
import { LaunchPaths } from "./launch";
import { DataLocation } from "./location";
import { messageOf, MoveFs } from "./move-types";
import { recoverInterruptedMove, RecoveryResult } from "./recover";

/**
 * A launch's side of a move: tidy up one that was interrupted, offer the way
 * back when the moved folder will not start, confirm it when it does, and
 * offer (never perform unasked) the deletion of the old copy.
 */

export type CleanupChoice = "delete" | "keep" | "later";

export interface AfterRestartUi {
  /** A move was interrupted and its copy discarded. */
  interrupted(
    result: Extract<RecoveryResult, { kind: "discarded" }>,
    current: string,
  ): Promise<void>;
  /** True for "Go back to the previous folder". */
  offerRollback(current: string, previous: string): Promise<boolean>;
  rollbackRefused(message: string): Promise<void>;
  offerCleanup(current: string, old: string): Promise<CleanupChoice>;
  cleanupResult(result: RemoveOldResult, old: string): Promise<void>;
}

export interface AfterRestartDeps {
  readonly launch: LaunchPaths;
  readonly platform: NodeJS.Platform;
  readonly path: PathModule;
  readonly fs: MoveFs;
  readonly ui: AfterRestartUi;
  readonly stopStack: () => Promise<void>;
  readonly isQuitting: () => boolean;
  readonly relaunch: () => void;
  readonly now: () => Date;
  readonly log: (line: string) => void;
}

export interface AfterRestart {
  /** Before the stack starts. Never rejects. */
  recover(): Promise<void>;
  /** A boot attempt failed, or the runtime could not be created. */
  bootFailed(): Promise<void>;
  /** The stack reached `ready` for the first time this launch. */
  stackReady(): Promise<void>;
}

export function createAfterRestart(deps: AfterRestartDeps): AfterRestart {
  const { launch, fs, path, platform, ui } = deps;
  const { records } = launch;
  const current = launch.paths.data.dataDir;
  let location: DataLocation | null =
    launch.origin === "pointer" ? launch.location : null;
  let asking = false;

  const aftermath = (file: string): AftermathDeps => ({
    fs,
    path,
    platform,
    locationFile: file,
    log: deps.log,
  });

  async function rollBack(file: string, pending: DataLocation): Promise<void> {
    const previous = pending.previousDataDir;
    if (previous === null) return;
    if (!(await ui.offerRollback(current, previous))) return;
    if (deps.isQuitting()) return;
    // The stack is stopped for good by this, so every ending is a restart.
    await deps.stopStack();
    const result = await rollbackMove(aftermath(file), pending, deps.now());
    if (result.kind === "refused") {
      await ui.rollbackRefused(result.message);
    }
    if (!deps.isQuitting()) deps.relaunch();
  }

  async function settleOldCopy(
    file: string,
    confirmed: DataLocation,
  ): Promise<void> {
    const old = confirmed.previousDataDir;
    if (old === null) return;
    if ((await fs.lstat(old)) === null) {
      location = await forgetOldCopy(aftermath(file), confirmed);
      return;
    }
    const choice = await ui.offerCleanup(current, old);
    if (choice === "later") return;
    if (choice === "keep") {
      location = await forgetOldCopy(aftermath(file), confirmed);
      return;
    }
    const result = await removeOldCopy(aftermath(file), confirmed);
    if (result.kind === "removed")
      location = { ...confirmed, previousDataDir: null };
    await ui.cleanupResult(result, old);
  }

  return {
    async recover() {
      if (records === null) return;
      try {
        const result = await recoverInterruptedMove({
          fs,
          path,
          journalFile: records.journalFile,
          location: launch.location,
          log: deps.log,
        });
        if (result.kind === "discarded") {
          void ui.interrupted(result, current).catch(() => undefined);
        }
      } catch (error) {
        deps.log(`move: recovery failed: ${messageOf(error)}`);
      }
    },

    async bootFailed() {
      if (records === null || location === null || asking) return;
      if (deps.isQuitting()) return;
      asking = true;
      try {
        if (await canRollBack(aftermath(records.locationFile), location)) {
          await rollBack(records.locationFile, location);
        }
      } catch (error) {
        deps.log(`move: going back failed: ${messageOf(error)}`);
      } finally {
        asking = false;
      }
    },

    async stackReady() {
      if (records === null || location === null) return;
      try {
        location = await confirmMove(aftermath(records.locationFile), location);
        await settleOldCopy(records.locationFile, location);
      } catch (error) {
        deps.log(`move: ${messageOf(error)}`);
      }
    },
  };
}
