import { APP_NAME, TEXT } from "./strings";

/**
 * "Export recovery key..." (plan D7, D9). The file's text and the one log line
 * are composed here, pure, so a spec can hold the rule that matters: the key
 * appears in the file body and nowhere else. The dialogs and the write are in
 * `recovery-export.ts` beside `electron-main.ts`.
 */

export const RECOVERY_EXPORT_FILE_NAME = "Monize recovery key.txt";

/** What the file says, around the key. The key is on a line of its own. */
export function recoveryKeyFileText(input: {
  readonly key: string;
  readonly date: Date;
  readonly version: string;
}): string {
  const day = input.date.toISOString().slice(0, 10);
  return [
    `${APP_NAME} recovery key`,
    "",
    `Exported on ${day} from ${APP_NAME} ${input.version}.`,
    "",
    TEXT.recoveryExportFileExplanation,
    "",
    "Recovery key:",
    input.key,
    "",
    TEXT.recoveryExportFileKeepSafe,
    "",
  ].join("\n");
}

/** The log line for a written file: the path, never the key. */
export function recoveryExportLogMessage(path: string): string {
  return `Shell: the recovery key was exported to ${path}.`;
}
