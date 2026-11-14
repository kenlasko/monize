import {
  BrowserWindow,
  clipboard,
  dialog,
  MessageBoxOptions,
  shell,
} from "electron";

import { Logger } from "./logger";
import { describeCause, FatalFailure } from "./supervisor/types";
import { APP_NAME, TEXT } from "./shell/strings";

/**
 * The shell's message boxes. Text comes from `shell/strings.ts`; nothing here
 * logs the recovery key or writes it anywhere but the dialog and, on Copy,
 * the clipboard.
 */

async function ask(
  parent: BrowserWindow | null,
  options: MessageBoxOptions,
): Promise<number> {
  const result =
    parent === null
      ? await dialog.showMessageBox(options)
      : await dialog.showMessageBox(parent, options);
  return result.response;
}

export async function openFolder(path: string, logger: Logger): Promise<void> {
  const failure = await shell.openPath(path);
  if (failure !== "") logger.warn(`Could not open ${path}: ${failure}`);
}

/** A child failed after its one restart. Loops on Show logs until Quit. */
export async function showFatalDialog(
  failure: FatalFailure,
  context: {
    readonly parent: BrowserWindow | null;
    readonly logsDir: string;
    readonly logger: Logger;
    readonly quit: () => void;
  },
): Promise<void> {
  const buttons = [TEXT.showLogs, TEXT.quit];
  for (;;) {
    const response = await ask(context.parent, {
      type: "error",
      title: APP_NAME,
      message: TEXT.fatalTitle,
      detail: `${TEXT.fatalMessage}\n\n${TEXT.fatalChild[failure.child]} ${describeCause(failure.cause)}`,
      buttons,
      defaultId: 1,
      cancelId: 1,
      noLink: true,
    });
    if (response !== 0) break;
    await openFolder(context.logsDir, context.logger);
  }
  context.quit();
}

export async function showAddressChanged(
  origin: string,
  parent: BrowserWindow | null,
): Promise<void> {
  await ask(parent, {
    type: "info",
    title: APP_NAME,
    message: TEXT.addressChangedTitle,
    detail: `${TEXT.addressChangedMessage} ${origin}\n\n${TEXT.addressChangedDetail}`,
    buttons: [TEXT.close],
    noLink: true,
  });
}

/**
 * Plan D7: a confirmation first, then the key with Copy. Resolves true when
 * the key was copied, which the recovery reminder counts as saved.
 */
export async function showRecoveryKey(
  key: string,
  parent: BrowserWindow | null,
): Promise<boolean> {
  const confirmed = await ask(parent, {
    type: "warning",
    title: APP_NAME,
    message: TEXT.recoveryConfirmTitle,
    detail: TEXT.recoveryConfirmMessage,
    buttons: [TEXT.recoveryConfirmShow, TEXT.cancel],
    defaultId: 1,
    cancelId: 1,
    noLink: true,
  });
  if (confirmed !== 0) return false;
  const response = await ask(parent, {
    type: "info",
    title: TEXT.recoveryKeyTitle,
    message: TEXT.recoveryKeyMessage,
    detail: key,
    buttons: [TEXT.copy, TEXT.close],
    defaultId: 1,
    cancelId: 1,
    noLink: true,
  });
  if (response !== 0) return false;
  clipboard.writeText(key);
  await ask(parent, {
    type: "info",
    title: TEXT.recoveryKeyTitle,
    message: TEXT.recoveryKeyCopied,
    buttons: [TEXT.close],
    noLink: true,
  });
  return true;
}

export async function showUpToDate(
  version: string,
  parent: BrowserWindow | null,
): Promise<void> {
  await ask(parent, {
    type: "info",
    title: APP_NAME,
    message: TEXT.updateUpToDateTitle,
    detail: TEXT.updateUpToDateMessage(version),
    buttons: [TEXT.close],
    noLink: true,
  });
}

export async function showUpdateFailed(context: {
  readonly parent: BrowserWindow | null;
  readonly logsDir: string;
  readonly logger: Logger;
}): Promise<void> {
  const response = await ask(context.parent, {
    type: "warning",
    title: APP_NAME,
    message: TEXT.updateFailedTitle,
    detail: TEXT.updateFailedMessage,
    buttons: [TEXT.showLogs, TEXT.close],
    defaultId: 1,
    cancelId: 1,
    noLink: true,
  });
  if (response === 0) await openFolder(context.logsDir, context.logger);
}

/** True only for Restart now; closing the box is Later. */
export async function confirmInstallUpdate(
  version: string,
  parent: BrowserWindow | null,
): Promise<boolean> {
  const response = await ask(parent, {
    type: "question",
    title: APP_NAME,
    message: TEXT.updateReadyTitle(version),
    detail: TEXT.updateReadyMessage,
    buttons: [TEXT.updateRestartNow, TEXT.updateLater],
    defaultId: 0,
    cancelId: 1,
    noLink: true,
  });
  return response === 0;
}
