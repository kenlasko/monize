import { readFileSync, readdirSync } from "fs";
import { join, relative } from "path";

/**
 * A sync the user starts by hand reports through its own toast and writes no
 * notification (docs/specs/bank-sync-notifications.md sections 1 and 8). A mock
 * proves a call, not its absence, so this scans the source instead: the only
 * bank-sync files that may reach the notification layer are the two producers,
 * and the daily cron is the only caller of the outcome notifier.
 *
 * A manual sync is `BankSyncService.syncAccount` / `syncConnection` behind the
 * controller. If one of them (or the connection, match, preview or writer
 * services) needed a notification, this fails and names the file, and the
 * decision is made on purpose rather than by an import.
 */
const ROOT = __dirname;

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sources(path);
    return entry.name.endsWith(".ts") && !entry.name.endsWith(".spec.ts")
      ? [path]
      : [];
  });
}

const FILES = sources(ROOT).map((path) => ({
  name: relative(ROOT, path),
  text: readFileSync(path, "utf8"),
}));

const filesMatching = (pattern: RegExp): string[] =>
  FILES.filter((file) => pattern.test(file.text))
    .map((file) => file.name)
    .sort();

describe("which bank-sync files write notifications", () => {
  it("scans the files it thinks it does", () => {
    expect(FILES.map((f) => f.name)).toEqual(
      expect.arrayContaining([
        "bank-sync.service.ts",
        "bank-sync-cron.service.ts",
        "bank-sync-consent-reminder.service.ts",
        "bank-sync-outcome-notifier.service.ts",
      ]),
    );
  });

  it("only the two producers reach the notification layer", () => {
    expect(
      filesMatching(
        /NotificationDispatchService|NotificationService|notification-center\/notification\.service|\.notify\(/,
      ),
    ).toEqual([
      "bank-sync-consent-reminder.service.ts",
      "bank-sync-notifications.ts", // imports the input type only
      "bank-sync-outcome-notifier.service.ts",
      "bank-sync.module.ts", // the import that wires the producers
    ]);
  });

  it("only the daily cron calls the outcome notifier", () => {
    expect(filesMatching(/BankSyncOutcomeNotifier/)).toEqual([
      "bank-sync-cron.service.ts",
      "bank-sync-outcome-notifier.service.ts",
      "bank-sync.module.ts",
    ]);
  });

  it("the manual-sync services and the controller do not import the notification layer at all", () => {
    for (const name of [
      "bank-sync.service.ts",
      "bank-sync.controller.ts",
      "bank-sync-connections.service.ts",
      "bank-sync-writer.service.ts",
      "bank-sync-preview.service.ts",
      "bank-sync-match.service.ts",
    ]) {
      const text = FILES.find((f) => f.name === name)?.text ?? "";
      expect(text).not.toMatch(/notification/i);
    }
  });
});
