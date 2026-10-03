import { readdirSync, readFileSync, statSync } from "fs";
import { join, relative } from "path";

/**
 * INV-RECEIPT-001, the mailbox is read and never written, held by a scan of the
 * source rather than by convention: the IMAP client module exposes no flag,
 * move, copy, delete or append call, and nothing under `email-receipts/` calls
 * one. The two third-party libraries are each confined to one file, so there is
 * exactly one place to read to know what is done with a mailbox and with mail.
 */

const SRC_ROOT = join(__dirname, "..", "..");
const RECEIPTS_ROOT = join(__dirname, "..");

/** The client calls that change a mailbox or a message, spelled as data. */
const WRITE_CALLS = [
  "messageFlagsAdd",
  "messageFlagsSet",
  "messageFlagsRemove",
  "messageMove",
  "messageCopy",
  "messageDelete",
  "setFlagColor",
  "mailboxCreate",
  "mailboxDelete",
  "mailboxRename",
  "mailboxSubscribe",
  "mailboxUnsubscribe",
  "expunge",
];
const WRITE_CALL = new RegExp(
  `\\b(?:${WRITE_CALLS.join("|")})\\b|\\bappend\\s*\\(`,
);

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === "node_modules" || entry === "dist") continue;
      out.push(...sourceFiles(full));
      continue;
    }
    if (!entry.endsWith(".ts") || entry.endsWith(".spec.ts")) continue;
    out.push(full);
  }
  return out;
}

const rel = (path: string): string => relative(SRC_ROOT, path);

describe("email receipts never write to a mailbox (INV-RECEIPT-001)", () => {
  const files = sourceFiles(RECEIPTS_ROOT);

  it("finds the files it is scanning", () => {
    // A scan that silently matches nothing is the failure mode of every guard
    // in this repo, so it asserts its own subject exists first.
    const names = files.map(rel);
    expect(names).toContain("email-receipts/imap/imap-mailbox-client.ts");
    expect(names).toContain("email-receipts/imap/mail-text.util.ts");
  });

  it("calls no flag, move, copy, delete, append or expunge method anywhere under email-receipts", () => {
    const offenders = files.flatMap((file) => {
      const source = readFileSync(file, "utf8");
      const match = WRITE_CALL.exec(source);
      return match ? [`${rel(file)}: ${match[0]}`] : [];
    });
    expect(offenders).toEqual([]);
  });

  it("opens the folder read-only, in the one place a folder is opened", () => {
    const client = readFileSync(
      join(RECEIPTS_ROOT, "imap", "imap-mailbox-client.ts"),
      "utf8",
    );
    const opens = client.match(/mailboxOpen\(/g) ?? [];
    const readOnlyOpens = client.match(/readOnly:\s*true/g) ?? [];
    // Two call sites (test and fetch), each with `readOnly: true` (the fetch
    // one is split across lines, which the regex tolerates).
    expect(opens.length).toBeGreaterThanOrEqual(2);
    expect(readOnlyOpens.length).toBeGreaterThanOrEqual(opens.length - 1);
    expect(client).not.toMatch(/readOnly:\s*false/);
    expect(client).not.toMatch(/getMailboxLock\(/);
  });

  it("fetches a body with source: true, which imapflow sends as BODY.PEEK, and never a bare download", () => {
    const client = readFileSync(
      join(RECEIPTS_ROOT, "imap", "imap-mailbox-client.ts"),
      "utf8",
    );
    expect(client).toMatch(/source:\s*true/);
    expect(client).not.toMatch(/\.download\(/);
    expect(client).not.toMatch(/\.downloadMany\(/);
  });
});

describe("the third-party mail libraries are confined to one file each", () => {
  const all = sourceFiles(SRC_ROOT);
  const importing = (library: string): string[] =>
    all
      .filter((file) =>
        new RegExp(
          `(?:from\\s+|require\\(\\s*|import\\(\\s*)["']${library}(?:/[^"']*)?["']`,
        ).test(readFileSync(file, "utf8")),
      )
      .map(rel);

  it("imports imapflow only in imap-mailbox-client.ts", () => {
    expect(importing("imapflow")).toEqual([
      "email-receipts/imap/imap-mailbox-client.ts",
    ]);
  });

  it("imports mailparser only in mail-text.util.ts", () => {
    expect(importing("mailparser")).toEqual([
      "email-receipts/imap/mail-text.util.ts",
    ]);
  });
});
