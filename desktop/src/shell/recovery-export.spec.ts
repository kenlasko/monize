import {
  RECOVERY_EXPORT_FILE_NAME,
  recoveryExportLogMessage,
  recoveryKeyFileText,
} from "./recovery-export";
import { TEXT } from "./strings";

const KEY = "k3y-0123456789abcdef-SECRET";
const INPUT = {
  key: KEY,
  date: new Date("2026-11-13T09:30:00Z"),
  version: "1.21.0",
};

describe("recoveryKeyFileText", () => {
  const text = recoveryKeyFileText(INPUT);

  it("holds the key exactly once, on a line of its own", () => {
    expect(text.split(KEY)).toHaveLength(2);
    expect(text.split("\n")).toContain(KEY);
  });

  it("holds the date and the application version", () => {
    expect(text).toContain("2026-11-13");
    expect(text).toContain("Monize 1.21.0");
  });

  it("says what the key restores and where to keep the file", () => {
    expect(text).toContain(TEXT.recoveryExportFileExplanation);
    expect(text).toContain(TEXT.recoveryExportFileKeepSafe);
  });

  it("ends with a newline", () => {
    expect(text.endsWith("\n")).toBe(true);
  });
});

describe("what the key never reaches", () => {
  it("is absent from the log message, which names the path only", () => {
    const message = recoveryExportLogMessage("C:\\Users\\A B\\Monize.txt");
    expect(message).toContain("C:\\Users\\A B\\Monize.txt");
    expect(message).not.toContain(KEY);
  });

  it("is absent from every dialog sentence", () => {
    const sentences = [
      TEXT.recoveryExportConfirmTitle,
      TEXT.recoveryExportConfirmMessage,
      TEXT.recoveryExportSavedMessage("C:\\x.txt"),
      TEXT.recoveryExportFailedMessage("Disk full."),
    ];
    for (const sentence of sentences) expect(sentence).not.toContain(KEY);
  });

  it("proposes the agreed file name", () => {
    expect(RECOVERY_EXPORT_FILE_NAME).toBe("Monize recovery key.txt");
  });
});
