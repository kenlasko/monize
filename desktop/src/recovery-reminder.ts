import { BrowserWindow, dialog } from "electron";
import { readFile } from "fs/promises";

import { writeFileAtomic } from "./atomic-write";
import { showRecoveryKey } from "./dialogs";
import { Logger } from "./logger";
import { exportRecoveryKey } from "./recovery-export";
import {
  parseReminder,
  REMINDER_BUTTONS,
  REMINDER_CANCEL_ID,
  reminderChoice,
  ReminderStatus,
  serializeReminder,
  statusAfter,
} from "./shell/recovery-reminder";
import { APP_NAME, TEXT } from "./shell/strings";

/**
 * The glue for the recovery-key reminder (`shell/recovery-reminder.ts` has
 * the rules): read what was decided, ask, run the chosen dialog, record the
 * outcome. A file that cannot be read or written only means the reminder
 * comes back next launch, so neither is an error the person sees.
 */

export interface RecoveryReminderContext {
  /** `<data folder>/recovery-reminder.json`. */
  readonly file: string;
  readonly key: string;
  readonly version: string;
  readonly documentsDir: string;
  readonly parent: BrowserWindow;
  readonly logger: Logger;
}

async function readStatus(
  file: string,
  logger: Logger,
): Promise<ReminderStatus> {
  try {
    return parseReminder(await readFile(file, "utf8"));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") {
      logger.warn(
        `Shell: could not read ${file} (${code ?? String(error)}); reminding.`,
      );
    }
    return "remind";
  }
}

async function record(
  file: string,
  status: Exclude<ReminderStatus, "remind">,
  logger: Logger,
): Promise<void> {
  try {
    await writeFileAtomic(
      file,
      Buffer.from(serializeReminder(status, new Date()), "utf8"),
    );
    logger.info(`Shell: recovery key reminder: ${status}.`);
  } catch (error) {
    logger.warn(
      `Shell: could not write ${file}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/** The tray's Show or Export saved the key: the reminder stops. */
export async function recordRecoveryKeySaved(
  file: string,
  logger: Logger,
): Promise<void> {
  if ((await readStatus(file, logger)) !== "saved") {
    await record(file, "saved", logger);
  }
}

export async function remindToSaveRecoveryKey(
  context: RecoveryReminderContext,
): Promise<void> {
  const { file, logger, parent } = context;
  if ((await readStatus(file, logger)) !== "remind") return;
  if (parent.isDestroyed()) return;
  const { response } = await dialog.showMessageBox(parent, {
    type: "warning",
    title: APP_NAME,
    message: TEXT.recoveryReminderTitle,
    detail: TEXT.recoveryReminderMessage,
    buttons: [...REMINDER_BUTTONS],
    defaultId: 0,
    cancelId: REMINDER_CANCEL_ID,
    noLink: true,
  });
  const choice = reminderChoice(response);
  let keySaved = false;
  if (choice === "export") {
    keySaved = await exportRecoveryKey({
      key: context.key,
      version: context.version,
      documentsDir: context.documentsDir,
      parent,
      logger,
    });
  } else if (choice === "show") {
    keySaved = await showRecoveryKey(context.key, parent);
  }
  const status = statusAfter(choice, keySaved);
  if (status !== null) await record(file, status, logger);
}
