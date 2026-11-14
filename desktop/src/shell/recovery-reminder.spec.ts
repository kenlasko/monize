import { OWNED_TOP_LEVEL } from "../move/layout";
import {
  parseReminder,
  RECOVERY_REMINDER_FILE,
  REMINDER_BUTTONS,
  REMINDER_CANCEL_ID,
  REMINDER_CHOICES,
  reminderChoice,
  serializeReminder,
  statusAfter,
} from "./recovery-reminder";
import { TEXT } from "./strings";

describe("the recovery key reminder", () => {
  it("reminds when there is no file, or one it cannot make sense of", () => {
    for (const text of [
      null,
      "",
      "not json",
      "null",
      "[]",
      '{"status":"remind"}',
      '{"status":"later"}',
      '{"version":1}',
    ]) {
      expect({ text, status: parseReminder(text) }).toEqual({
        text,
        status: "remind",
      });
    }
  });

  it("reads back what it wrote", () => {
    const date = new Date("2026-11-14T15:00:00.000Z");
    for (const status of ["saved", "dismissed"] as const) {
      expect(parseReminder(serializeReminder(status, date))).toBe(status);
    }
    expect(JSON.parse(serializeReminder("saved", date))).toEqual({
      version: 1,
      status: "saved",
      at: "2026-11-14T15:00:00.000Z",
    });
  });

  it("stops only once the key has really been saved, or the person said so", () => {
    expect(statusAfter("export", true)).toBe("saved");
    expect(statusAfter("show", true)).toBe("saved");
    // Cancelled out of the dialog, or shown without copying: ask again.
    expect(statusAfter("export", false)).toBeNull();
    expect(statusAfter("show", false)).toBeNull();
    expect(statusAfter("later", false)).toBeNull();
    expect(statusAfter("never", false)).toBe("dismissed");
  });

  it("offers the four choices in order, and closing the box means later", () => {
    expect(REMINDER_CHOICES).toEqual(["export", "show", "later", "never"]);
    expect(REMINDER_BUTTONS).toEqual(
      REMINDER_CHOICES.map((choice) => TEXT.recoveryReminderButtons[choice]),
    );
    expect(reminderChoice(REMINDER_CANCEL_ID)).toBe("later");
    expect(reminderChoice(-1)).toBe("later");
    expect(reminderChoice(99)).toBe("later");
    expect(REMINDER_CHOICES.map((_, index) => reminderChoice(index))).toEqual(
      REMINDER_CHOICES,
    );
  });

  it("keeps its file among what Monize owns in a data folder, so it moves and is removed with the data", () => {
    expect(OWNED_TOP_LEVEL).toContain(RECOVERY_REMINDER_FILE);
  });

  it("never carries the key: the text says where to find it, not what it is", () => {
    expect(TEXT.recoveryReminderMessage).toContain("Show recovery key");
    expect(TEXT.recoveryReminderMessage).toContain("Export recovery key");
  });
});
