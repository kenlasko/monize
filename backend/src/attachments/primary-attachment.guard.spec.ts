import { readdirSync, readFileSync, statSync } from "fs";
import { join, relative } from "path";

import {
  PRIMARY_ATTACHMENT_SQL,
  primaryAttachmentSql,
  primaryAttachmentWhere,
} from "./primary-attachment.util";

const SRC_ROOT = join(__dirname, "..");

/** The file that owns the rule. */
const ALLOWED = new Set(["attachments/primary-attachment.util.ts"]);

/**
 * Files that name the column for a reason other than deciding visibility, with
 * that reason. This list may shrink; it grows only with an argument.
 */
const REVIEWED: Record<string, string> = {
  "attachments/entities/transaction-attachment.entity.ts":
    "declares the column and its relation -- the mapping itself, not a read " +
    "that decides which attachments a user sees",
  "attachments/attachments.service.ts":
    "sets the link when writing a pair, and names it in the delete so the " +
    "original's storage key is RETURNED for a prompt sweep; both of its " +
    "visibility reads go through the shared predicate",
  "backup/restore-plan.ts":
    "defers the self-referential foreign key and repairs it in Phase 3 -- a " +
    "restore ordering concern, and it must name the column to defer it",
};

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === "node_modules" || entry === "dist") continue;
      out.push(...sourceFiles(full));
      continue;
    }
    if (!entry.endsWith(".ts")) continue;
    if (entry.endsWith(".spec.ts")) continue;
    out.push(full);
  }
  return out;
}

/**
 * Blank out comments while preserving every line break, so a reported offender
 * still points at the right line.
 *
 * The scan's own subject has to be named in prose -- this file does it, the
 * util does it, and the service's comments explain the pair -- so a scan over
 * raw text would fail on its own explanations, and the cheap way out is
 * weakening the comments, which is the opposite of the point.
 */
export function blankComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, " "))
    .replace(/(^|[^:])\/\/[^\n]*/g, (match, prefix: string) =>
      prefix.concat(" ".repeat(match.length - prefix.length)),
    );
}

/**
 * "Is this a visible attachment?" is one predicate, in one file.
 *
 * A scanned document is two rows -- what the user sees and the photo it came
 * from -- and four separate reads decide which of them count: the
 * per-transaction cap, the attachments list, the register's `attachmentCount`
 * and the `hasAttachments` filter. Spelled out at each site, the fourth is how
 * a list showing one attachment ends up beside a register cell reading "2".
 *
 * So the condition lives in `primary-attachment.util.ts` and this scan fails
 * when the column is named anywhere else without a reason on the record.
 */
describe("the visible-attachment predicate is written once", () => {
  const files = sourceFiles(SRC_ROOT);

  it("finds source files to scan", () => {
    // A broken walk would make every assertion below vacuous.
    expect(files.length).toBeGreaterThan(100);
  });

  it("names the column nowhere but the util and the reviewed files", () => {
    const offenders: string[] = [];

    for (const file of files) {
      const rel = relative(SRC_ROOT, file).split("\\").join("/");
      if (ALLOWED.has(rel) || REVIEWED[rel]) continue;

      const lines = blankComments(readFileSync(file, "utf8")).split("\n");
      for (const [index, line] of lines.entries()) {
        if (/original_of_attachment_id|originalOfAttachmentId/.test(line)) {
          offenders.push(`${rel}:${index + 1}`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });

  it("keeps every reviewed exemption documented and real", () => {
    for (const [path, reason] of Object.entries(REVIEWED)) {
      expect(reason.length).toBeGreaterThan(20);
      expect(files.some((f) => f.endsWith(path))).toBe(true);
    }
  });

  // The scan is only worth its exemption list if it would actually catch the
  // thing it bans, so both directions are asserted rather than assumed.
  describe("the scan itself", () => {
    it("catches the column in code", () => {
      const code = 'where("ta.original_of_attachment_id IS NULL")';
      expect(/original_of_attachment_id/.test(blankComments(code))).toBe(true);
    });

    it("ignores the column in a line comment and a block comment", () => {
      expect(
        /original_of_attachment_id/.test(
          blankComments("// original_of_attachment_id is the link"),
        ),
      ).toBe(false);
      expect(
        /originalOfAttachmentId/.test(
          blankComments("/* originalOfAttachmentId names the original */"),
        ),
      ).toBe(false);
    });

    it("keeps line numbers stable across a multi-line block comment", () => {
      const blanked = blankComments("a\n/* one\ntwo\nthree */\nb");
      expect(blanked.split("\n")).toHaveLength(5);
      expect(blanked.split("\n")[4]).toBe("b");
    });

    it("does not mistake a URL's slashes for a comment", () => {
      // `https://...` would end the line at `//` under a naive stripper, which
      // would silently blank real code that follows on the same line.
      const code = 'const u = "https://example.com"; // trailing';
      expect(blankComments(code)).toContain('"https://example.com"');
    });
  });

  // The two dialects have to mean the same thing; they are used by different
  // callers and only the SQL one is visible to a reader of a query.
  describe("the predicate's two forms agree", () => {
    it("expresses 'no original recorded' in raw SQL", () => {
      expect(PRIMARY_ATTACHMENT_SQL).toBe("original_of_attachment_id IS NULL");
      expect(primaryAttachmentSql("ta")).toBe(
        "ta.original_of_attachment_id IS NULL",
      );
    });

    it("expresses the same condition for TypeORM", () => {
      // IsNull() has no public value to compare, so the assertion is that the
      // fragment targets the mapped property and asks for NULL.
      expect(Object.keys(primaryAttachmentWhere)).toEqual([
        "originalOfAttachmentId",
      ]);
      expect(String(primaryAttachmentWhere.originalOfAttachmentId.type)).toBe(
        "isNull",
      );
    });
  });
});
