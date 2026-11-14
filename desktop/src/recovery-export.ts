import { BrowserWindow, dialog } from "electron";
import { join } from "path";

import { writeFileAtomic } from "./atomic-write";
import { Logger } from "./logger";
import {
  RECOVERY_EXPORT_FILE_NAME,
  recoveryExportLogMessage,
  recoveryKeyFileText,
} from "./shell/recovery-export";
import { APP_NAME, TEXT } from "./shell/strings";

/**
 * The glue for "Export recovery key...": a confirmation that says what the
 * file is and where it must be kept, a save dialog in Documents, then the
 * atomic write. The key goes into the file and nowhere else; the log line
 * names the path (`shell/recovery-export.ts`).
 */

export interface RecoveryExportContext {
  readonly key: string;
  readonly version: string;
  readonly documentsDir: string;
  readonly parent: BrowserWindow | null;
  readonly logger: Logger;
}

async function box(
  parent: BrowserWindow | null,
  options: Electron.MessageBoxOptions,
): Promise<number> {
  const result =
    parent === null
      ? await dialog.showMessageBox(options)
      : await dialog.showMessageBox(parent, options);
  return result.response;
}

async function pickPath(
  context: RecoveryExportContext,
): Promise<string | null> {
  const options = {
    title: TEXT.recoveryExportSaveTitle,
    defaultPath: join(context.documentsDir, RECOVERY_EXPORT_FILE_NAME),
    filters: [{ name: "Text", extensions: ["txt"] }],
  };
  const result =
    context.parent === null
      ? await dialog.showSaveDialog(options)
      : await dialog.showSaveDialog(context.parent, options);
  return result.canceled || result.filePath === "" ? null : result.filePath;
}

/** Resolves true when the file was written. */
export async function exportRecoveryKey(
  context: RecoveryExportContext,
): Promise<boolean> {
  const confirmed = await box(context.parent, {
    type: "warning",
    title: APP_NAME,
    message: TEXT.recoveryExportConfirmTitle,
    detail: TEXT.recoveryExportConfirmMessage,
    buttons: [TEXT.recoveryExportConfirmSave, TEXT.cancel],
    defaultId: 1,
    cancelId: 1,
    noLink: true,
  });
  if (confirmed !== 0) return false;
  const path = await pickPath(context);
  if (path === null) return false;
  try {
    const text = recoveryKeyFileText({
      key: context.key,
      date: new Date(),
      version: context.version,
    });
    await writeFileAtomic(path, Buffer.from(text, "utf8"));
  } catch (error) {
    // The message of a file-system error can carry the path, not the key.
    context.logger.warn(
      `Shell: the recovery key could not be exported to ${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
    await box(context.parent, {
      type: "error",
      title: APP_NAME,
      message: TEXT.recoveryExportFailedTitle,
      detail: TEXT.recoveryExportFailedMessage(
        error instanceof Error ? error.message : String(error),
      ),
      buttons: [TEXT.close],
      noLink: true,
    });
    return false;
  }
  context.logger.info(recoveryExportLogMessage(path));
  await box(context.parent, {
    type: "info",
    title: APP_NAME,
    message: TEXT.recoveryExportSavedTitle,
    detail: TEXT.recoveryExportSavedMessage(path),
    buttons: [TEXT.close],
    noLink: true,
  });
  return true;
}
