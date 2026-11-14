import { pathFor } from "../supervisor/postgres-args";
import { movesWithData } from "./layout";
import { LaunchPaths } from "./launch";
import { DataLocation, readLocationSync } from "./location";
import { MoveOutcome, runMove } from "./move";
import { messageOf, MoveFs, MoveProgress } from "./move-types";
import { inspectTarget, TargetVerdict } from "./target";
import { scanTree } from "./tree";

/**
 * "Move data folder" from the click to the restart, with every window and
 * every Electron call behind `MoveUi` and `CoordinatorDeps`, so the order of
 * things is unit-tested: ask, check, confirm, stop the stack, move, restart.
 *
 * Once the stack has been stopped the shell cannot start it again (the
 * controller's shutdown is final), so every ending from there is a restart:
 * on the new folder after a move, on the old one after a failure.
 */

export interface MovePlan {
  readonly source: string;
  readonly target: string;
  readonly bytes: number;
  readonly files: number;
}

export type NotMovable =
  | "env-override"
  | "update-running"
  /** The copy left by the last move has not been deleted or kept yet. */
  | "old-copy-pending";
export type FailedOutcome = Exclude<MoveOutcome, { kind: "moved" }>;

export interface MoveUi {
  notMovable(reason: NotMovable): Promise<void>;
  /** The folder picker; null when the person closed it. */
  pickFolder(): Promise<string | null>;
  targetRefused(verdict: TargetVerdict): Promise<void>;
  confirm(plan: MovePlan): Promise<boolean>;
  progress(progress: MoveProgress): void;
  /** Resolves when the person has read it; the shell restarts after. */
  moveFailed(outcome: FailedOutcome, source: string): Promise<void>;
}

export interface CoordinatorDeps {
  readonly launch: LaunchPaths;
  readonly platform: NodeJS.Platform;
  readonly fs: MoveFs;
  /** The installation folder when packaged, else null. */
  readonly installDir: string | null;
  readonly ui: MoveUi;
  /** The controller's `shutdown()`: resolves once PostgreSQL has stopped. */
  readonly stopStack: () => Promise<void>;
  readonly isQuitting: () => boolean;
  readonly isUpdateBusy: () => boolean;
  /** The move is going ahead: hide the window, remove the tray. */
  readonly beginMove: () => void;
  /** Start a new shell and end this one. */
  readonly relaunch: () => void;
  readonly newId: () => string;
  readonly now: () => Date;
  /** The pointer as it is on disk now; replaced in the spec. */
  readonly readLocation?: (file: string) => DataLocation | null;
  /**
   * Writes the move's log lines into a data folder's log. Called once, after
   * the move has ended: a line written into the folder while it was being
   * copied would make the copy differ from it.
   */
  readonly writeLog: (dataDir: string, lines: readonly string[]) => void;
}

export interface MoveCoordinator {
  /** The tray item. Does nothing while a move is already under way. */
  start(): Promise<void>;
  /** A quit was asked for: stop the copy at the next file. */
  cancel(): void;
  /** Resolves once no copy is running; the quit path waits on it. */
  working(): Promise<void>;
}

export function createMoveCoordinator(deps: CoordinatorDeps): MoveCoordinator {
  const { ui, launch, fs, platform } = deps;
  const path = pathFor(platform);
  const signal = { cancelled: false };
  let busy = false;
  let work: Promise<void> | null = null;

  async function plan(): Promise<MovePlan | null> {
    const { records } = launch;
    if (records === null) {
      await ui.notMovable("env-override");
      return null;
    }
    if (deps.isUpdateBusy()) {
      await ui.notMovable("update-running");
      return null;
    }
    // One old copy at a time: a second move would make this one's old
    // folder the "previous" one, and the first would never be offered for
    // deletion again.
    const read =
      deps.readLocation ?? ((file) => readLocationSync(file, platform));
    if ((read(records.locationFile)?.previousDataDir ?? null) !== null) {
      await ui.notMovable("old-copy-pending");
      return null;
    }
    const chosen = await ui.pickFolder();
    if (chosen === null) return null;
    const source = launch.paths.data.dataDir;
    const tree = await scanTree({ fs, path }, source, movesWithData);
    const verdict = await inspectTarget(fs, chosen, tree.bytes, {
      platform,
      source,
      defaultDataDir: records.defaultDataDir,
      installDir: deps.installDir,
    });
    if (verdict.problem !== null) {
      await ui.targetRefused(verdict);
      return null;
    }
    const proposed: MovePlan = {
      source,
      target: verdict.target,
      bytes: tree.bytes,
      files: tree.files,
    };
    return (await ui.confirm(proposed)) ? proposed : null;
  }

  async function perform(
    proposed: MovePlan,
    records: NonNullable<LaunchPaths["records"]>,
  ): Promise<MoveOutcome> {
    const lines: string[] = [];
    let outcome: MoveOutcome;
    try {
      ui.progress({ phase: "stopping", doneBytes: 0, totalBytes: 0 });
      await deps.stopStack();
      outcome = await runMove(
        {
          fs,
          path,
          platform,
          locationFile: records.locationFile,
          journalFile: records.journalFile,
          signal,
          onProgress: (progress) => ui.progress(progress),
          log: (line) => lines.push(line),
        },
        {
          id: deps.newId(),
          source: proposed.source,
          target: proposed.target,
          now: deps.now(),
        },
      );
    } catch (error) {
      // runMove reports failures as outcomes; this is a defect in it or a
      // stop that threw. Nothing is known to have been committed.
      outcome = { kind: "uncertain", message: messageOf(error) };
      lines.push(`move: unexpected error: ${messageOf(error)}`);
    }
    try {
      deps.writeLog(
        outcome.kind === "moved" ? proposed.target : proposed.source,
        lines,
      );
    } catch {
      // The log is a courtesy; the outcome stands without it.
    }
    return outcome;
  }

  async function run(): Promise<void> {
    let proposed: MovePlan | null;
    try {
      proposed = await plan();
    } catch (error) {
      await ui.moveFailed(
        {
          kind: "failed",
          failure: "copy-failed",
          message: messageOf(error),
          leftover: [],
        },
        launch.paths.data.dataDir,
      );
      // The stack was never stopped: Monize carries on as it was.
      return;
    }
    const { records } = launch;
    if (proposed === null || records === null || deps.isQuitting()) return;

    deps.beginMove();
    const moving = perform(proposed, records);
    work = moving.then(
      () => undefined,
      () => undefined,
    );
    const outcome = await moving;
    // A quit that arrived meanwhile ends the process itself; a restart here
    // would bring back the application the person, or the installer, closed.
    if (deps.isQuitting()) return;
    if (outcome.kind !== "moved") {
      await ui.moveFailed(outcome, proposed.source);
      if (deps.isQuitting()) return;
    }
    deps.relaunch();
  }

  return {
    async start() {
      if (busy || deps.isQuitting()) return;
      busy = true;
      try {
        await run();
      } finally {
        busy = false;
      }
    },
    cancel() {
      signal.cancelled = true;
    },
    working: () => work ?? Promise.resolve(),
  };
}
