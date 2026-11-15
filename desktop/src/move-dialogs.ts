import { BrowserWindow, dialog, MessageBoxOptions } from "electron";

import { AfterRestartUi } from "./move/after-restart";
import { MoveUi, NotMovable } from "./move/coordinator";
import { MoveProgress } from "./move/move-types";
import { formatBytes } from "./shell/move-view";
import { APP_NAME, TEXT } from "./shell/strings";

/**
 * The windows of "Move data folder": the folder picker and the message
 * boxes. Text comes from `shell/move-strings.ts`. The destructive or
 * irreversible choice is never the default button.
 */

const T = TEXT.move;

const NOT_MOVABLE: Readonly<Record<NotMovable, string>> = {
  "env-override": T.envOverride,
  "update-running": T.updateRunning,
  "old-copy-pending": T.oldCopyPending,
};

export interface MoveDialogContext {
  /** The main window while it is showing, else null. */
  readonly parent: () => BrowserWindow | null;
  readonly showProgress: (progress: MoveProgress) => void;
}

async function ask(
  parent: BrowserWindow | null,
  options: MessageBoxOptions,
): Promise<number> {
  const full = { title: APP_NAME, noLink: true, ...options };
  const result =
    parent === null || parent.isDestroyed() || !parent.isVisible()
      ? await dialog.showMessageBox(full)
      : await dialog.showMessageBox(parent, full);
  return result.response;
}

export async function showMoveMessage(
  parent: BrowserWindow | null,
  type: "info" | "warning" | "error",
  message: string,
  detail: string,
  button: string = TEXT.close,
): Promise<void> {
  await ask(parent, { type, message, detail, buttons: [button] });
}

/** Two buttons, the second one the default and what Escape means. */
export async function askMoveQuestion(
  parent: BrowserWindow | null,
  message: string,
  detail: string,
  yes: string,
  no: string,
): Promise<boolean> {
  const response = await ask(parent, {
    type: "question",
    message,
    detail,
    buttons: [yes, no],
    defaultId: 1,
    cancelId: 1,
  });
  return response === 0;
}

export function createMoveDialogs(context: MoveDialogContext): MoveUi {
  const { parent } = context;
  return {
    notMovable: (reason) =>
      showMoveMessage(parent(), "info", T.notMovableTitle, NOT_MOVABLE[reason]),
    async pickFolder() {
      const options = {
        title: T.pickTitle,
        buttonLabel: T.pickButton,
        properties: ["openDirectory", "createDirectory", "promptToCreate"],
      } as const;
      const window = parent();
      const result =
        window === null
          ? await dialog.showOpenDialog({
              ...options,
              properties: [...options.properties],
            })
          : await dialog.showOpenDialog(window, {
              ...options,
              properties: [...options.properties],
            });
      return result.canceled || result.filePaths.length === 0
        ? null
        : result.filePaths[0];
    },
    targetRefused: (verdict) =>
      showMoveMessage(
        parent(),
        "warning",
        T.refusedTitle,
        [
          verdict.target,
          verdict.problem === null ? "" : T.targetProblem[verdict.problem],
          verdict.problem === "no-space" && verdict.freeBytes !== null
            ? T.spaceDetail(
                formatBytes(verdict.neededBytes),
                formatBytes(verdict.freeBytes),
              )
            : "",
        ]
          .filter((line) => line !== "")
          .join("\n\n"),
      ),
    confirm: (plan) =>
      askMoveQuestion(
        parent(),
        T.confirmTitle,
        T.confirmDetail(
          plan.source,
          plan.target,
          formatBytes(plan.bytes),
          plan.files,
        ),
        T.confirmMove,
        TEXT.cancel,
      ),
    progress: (progress) => context.showProgress(progress),
    moveFailed: (outcome, source) =>
      showMoveMessage(
        null,
        "error",
        T.failedTitle,
        outcome.kind === "uncertain"
          ? T.uncertainDetail(outcome.message)
          : [
              T.failedDetail(source, outcome.message),
              outcome.leftover.length === 0
                ? ""
                : T.failedLeftover(outcome.leftover.join(", ")),
            ]
              .filter((line) => line !== "")
              .join("\n\n"),
        T.restart,
      ),
  };
}

export function createAfterRestartDialogs(
  context: Pick<MoveDialogContext, "parent">,
): AfterRestartUi {
  const { parent } = context;
  return {
    interrupted: (result, current) =>
      showMoveMessage(
        parent(),
        "warning",
        T.interruptedTitle,
        [
          T.interruptedDetail(result.to, current),
          result.leftover.length === 0
            ? ""
            : T.interruptedLeftover(result.leftover.join(", ")),
        ]
          .filter((line) => line !== "")
          .join("\n\n"),
      ),
    offerRollback: (current, previous) =>
      askMoveQuestion(
        parent(),
        T.bootFailedTitle,
        T.bootFailedDetail(current, previous),
        T.goBack,
        T.keepTrying,
      ),
    rollbackRefused: (message) =>
      showMoveMessage(
        null,
        "error",
        T.rollbackRefusedTitle,
        message,
        T.restart,
      ),
    async offerCleanup(current, old) {
      const response = await ask(parent(), {
        type: "question",
        message: T.cleanupTitle,
        detail: T.cleanupDetail(current, old),
        buttons: [T.cleanupDelete, T.cleanupKeep, T.cleanupLater],
        defaultId: 2,
        cancelId: 2,
      });
      return response === 0 ? "delete" : response === 1 ? "keep" : "later";
    },
    cleanupResult: (result, old) =>
      result.kind === "removed"
        ? showMoveMessage(
            parent(),
            "info",
            T.cleanupDoneTitle,
            result.folderGone ? old : T.cleanupFolderRemains(old),
          )
        : showMoveMessage(
            parent(),
            "warning",
            T.cleanupFailedTitle,
            result.message,
          ),
  };
}
