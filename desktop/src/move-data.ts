import { app, BrowserWindow, dialog } from "electron";
import { randomUUID } from "crypto";
import { existsSync, readFileSync } from "fs";
import { homedir } from "os";
import { dirname, join } from "path";

import { createLogger } from "./logger";
import { createMoveDialogs, createAfterRestartDialogs } from "./move-dialogs";
import { AfterRestartUi, createAfterRestart } from "./move/after-restart";
import { rollbackMove } from "./move/aftermath";
import { createMoveCoordinator, MoveUi } from "./move/coordinator";
import {
  LaunchPaths,
  LaunchVerdict,
  launchVerdict,
  resolveLaunchPaths,
} from "./move/launch";
import { nodeMoveFs } from "./move/move-fs";
import { MoveProgress } from "./move/move-types";
import { withFault } from "./move/test-faults";
import {
  unattendedOptionsFrom,
  unattendedUi,
  withoutTestFlags,
} from "./move/unattended";
import { TEXT } from "./shell/strings";
import { pathFor } from "./supervisor/postgres-args";

/**
 * "Move data folder" wired to Electron: which folder a launch uses, the
 * launches that must not start, and the feature the tray item and the boot
 * sequence call. The sequence itself is in `move/`, free of Electron.
 */

/** The `--test-move-*` flags work only from a checkout, never when installed. */
const unattended = app.isPackaged ? null : unattendedOptionsFrom(process.argv);

export function resolveLaunch(desktopRoot: string): LaunchPaths {
  return resolveLaunchPaths({
    env: process.env,
    platform: process.platform,
    isPackaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    desktopRoot,
    homeDir: homedir(),
  });
}

/** Starts a new shell when this one has ended, then ends this one. */
export function relaunchShell(): void {
  app.relaunch({ args: withoutTestFlags(process.argv.slice(1)) });
  app.exit(0);
}

function writeLines(dataDir: string, lines: readonly string[]): void {
  const logger = createLogger({ logsDir: join(dataDir, "logs"), stdout: null });
  for (const line of lines) logger.info(line);
  logger.close();
}

async function goBackFromMissing(launch: LaunchPaths): Promise<void> {
  const { records, location } = launch;
  if (records === null || location === null) return;
  const result = await rollbackMove(
    {
      fs: nodeMoveFs,
      path: pathFor(process.platform),
      platform: process.platform,
      locationFile: records.locationFile,
      log: () => undefined,
    },
    location,
    new Date(),
  );
  if (result.kind === "rolled-back") {
    relaunchShell();
    return;
  }
  dialog.showErrorBox(TEXT.move.rollbackRefusedTitle, result.message);
  app.exit(1);
}

async function showBlocked(
  launch: LaunchPaths,
  verdict: Exclude<LaunchVerdict, { kind: "ok" }>,
): Promise<void> {
  const T = TEXT.move;
  if (unattended !== null) {
    process.stderr.write(
      `Monize: launch refused: ${JSON.stringify(verdict)}\n`,
    );
    if (
      verdict.kind === "missing" &&
      verdict.canGoBack &&
      unattended.answers.includes("rollback")
    ) {
      await goBackFromMissing(launch);
    } else {
      app.exit(1);
    }
    return;
  }
  if (verdict.kind === "moved-away") {
    dialog.showErrorBox(
      T.movedAwayTitle,
      T.movedAwayDetail(verdict.dataDir, verdict.movedTo),
    );
    app.exit(1);
    return;
  }
  const previous = launch.location?.previousDataDir ?? "";
  const buttons = verdict.canGoBack ? [T.goBack, TEXT.quit] : [TEXT.quit];
  const { response } = await dialog.showMessageBox({
    type: "error",
    title: T.missingTitle,
    message: T.missingTitle,
    detail: verdict.canGoBack
      ? `${T.missingDetail(verdict.dataDir)}\n\n${previous}`
      : T.missingDetail(verdict.dataDir),
    buttons,
    defaultId: buttons.length - 1,
    cancelId: buttons.length - 1,
    noLink: true,
  });
  if (verdict.canGoBack && response === 0) {
    await goBackFromMissing(launch);
  } else {
    app.exit(1);
  }
}

/**
 * True when this launch must not start: the folder's data was moved away,
 * or the folder a move recorded is not there. Says why and exits, without
 * taking the single-instance lock, since nothing is started.
 */
export function refuseBlockedLaunch(launch: LaunchPaths): boolean {
  const verdict = launchVerdict(launch, process.platform, {
    exists: (path) => existsSync(path),
    read: (path) => {
      try {
        return readFileSync(path);
      } catch {
        return null;
      }
    },
  });
  if (verdict.kind === "ok") return false;
  void app.whenReady().then(() => showBlocked(launch, verdict));
  return true;
}

export interface MoveFeatureContext {
  readonly launch: LaunchPaths;
  /** The main window, once there is one. */
  readonly window: () => BrowserWindow | null;
  readonly showProgress: (progress: MoveProgress) => void;
  /** The controller's `shutdown()`. */
  readonly stopStack: () => Promise<void>;
  readonly isQuitting: () => boolean;
  readonly isUpdateBusy: () => boolean;
  /** Hide the window and remove the tray: the stack is about to stop. */
  readonly beginMove: () => void;
  /** A line for the running shell's log. */
  readonly log: (line: string) => void;
}

export interface MoveFeature {
  /** The tray item. */
  start(): void;
  /** The quit path: stop a running copy and wait until it has stopped. */
  cancelAndWait(): Promise<void>;
  recover(): Promise<void>;
  bootFailed(): void;
  stackReady(): void;
}

export function createMoveFeature(context: MoveFeatureContext): MoveFeature {
  const { launch } = context;
  const visibleWindow = (): BrowserWindow | null => context.window();
  const ui: MoveUi & AfterRestartUi =
    unattended !== null
      ? unattendedUi(unattended, context.log)
      : {
          ...createMoveDialogs({
            parent: visibleWindow,
            showProgress: context.showProgress,
          }),
          ...createAfterRestartDialogs({ parent: visibleWindow }),
        };
  const fs =
    unattended?.fault == null
      ? nodeMoveFs
      : withFault(nodeMoveFs, unattended.fault);

  const coordinator = createMoveCoordinator({
    launch,
    platform: process.platform,
    fs,
    installDir: app.isPackaged ? dirname(process.execPath) : null,
    ui:
      unattended === null
        ? ui
        : {
            ...ui,
            progress: (progress) => {
              ui.progress(progress);
              context.showProgress(progress);
            },
          },
    stopStack: context.stopStack,
    isQuitting: context.isQuitting,
    isUpdateBusy: context.isUpdateBusy,
    beginMove: context.beginMove,
    relaunch: relaunchShell,
    newId: () => randomUUID(),
    now: () => new Date(),
    writeLog: writeLines,
  });
  const after = createAfterRestart({
    launch,
    platform: process.platform,
    path: pathFor(process.platform),
    fs: nodeMoveFs,
    ui,
    stopStack: context.stopStack,
    isQuitting: context.isQuitting,
    relaunch: relaunchShell,
    now: () => new Date(),
    log: context.log,
  });

  return {
    start: () => void coordinator.start(),
    async cancelAndWait() {
      coordinator.cancel();
      await coordinator.working();
    },
    recover: () => after.recover(),
    bootFailed: () => void after.bootFailed(),
    stackReady() {
      void after.stackReady().then(() => {
        if (unattended !== null && unattended.target !== null) {
          void coordinator.start();
        }
      });
    },
  };
}
