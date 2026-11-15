import { TEXT } from "./strings";

/**
 * The reminder to save the recovery key. It is shown each time the main
 * window first appears in a launch, until the key has been saved (exported
 * to a file, or shown and copied) or the person has said not to remind them
 * again. What was decided is kept in `recovery-reminder.json` at the top of
 * the data folder, so it moves with the data and goes with "Remove my data".
 *
 * Everything here is pure; the dialogs and the file are in
 * `recovery-reminder.ts` beside `electron-main.ts`. The key itself is never
 * in this file's text, the reminder's file or a log line.
 */

export const RECOVERY_REMINDER_FILE = "recovery-reminder.json";

/** What the file records. No file, or one that cannot be read, means "remind". */
export type ReminderStatus = "remind" | "saved" | "dismissed";

const RECORDED: readonly ReminderStatus[] = ["saved", "dismissed"];

/** `null` is a missing file. Anything unexpected reads as "remind". */
export function parseReminder(text: string | null): ReminderStatus {
  if (text === null) return "remind";
  try {
    const data: unknown = JSON.parse(text);
    if (typeof data !== "object" || data === null) return "remind";
    const status = (data as { status?: unknown }).status;
    return RECORDED.includes(status as ReminderStatus)
      ? (status as ReminderStatus)
      : "remind";
  } catch {
    return "remind";
  }
}

export function serializeReminder(
  status: Exclude<ReminderStatus, "remind">,
  date: Date,
): string {
  return `${JSON.stringify({ version: 1, status, at: date.toISOString() }, null, 2)}\n`;
}

export type ReminderChoice = "export" | "show" | "later" | "never";

/** The buttons, in order; the index is what the message box answers. */
export const REMINDER_CHOICES: readonly ReminderChoice[] = [
  "export",
  "show",
  "later",
  "never",
];

export const REMINDER_BUTTONS: readonly string[] = REMINDER_CHOICES.map(
  (choice) => TEXT.recoveryReminderButtons[choice],
);

/** Escape, or closing the box, is "later". */
export const REMINDER_CANCEL_ID = REMINDER_CHOICES.indexOf("later");

export function reminderChoice(response: number): ReminderChoice {
  return REMINDER_CHOICES[response] ?? "later";
}

/**
 * What to record after a choice: `saved` only when the key really left the
 * dialog (a file was written, or it was copied), `null` for nothing to
 * record, so the reminder comes back next launch.
 */
export function statusAfter(
  choice: ReminderChoice,
  keySaved: boolean,
): Exclude<ReminderStatus, "remind"> | null {
  if (choice === "never") return "dismissed";
  if ((choice === "export" || choice === "show") && keySaved) return "saved";
  return null;
}
