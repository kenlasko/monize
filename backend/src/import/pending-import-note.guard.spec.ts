import * as fs from "fs";
import * as path from "path";
import * as ts from "typescript";

/**
 * Whether an amount is provisional is read from
 * `transactions.amount_is_provisional` and nowhere else (design P1 of
 * docs/specs/provisional-amounts.md, issue #2400). The importer used to
 * mark such a leg with a note in its description, a field the reader can edit,
 * and every reader that matched the text could be fooled by an edit. The note
 * is retired: nothing writes it, and the only code that still knows the text is
 * the restore normalization that strips it from a backup taken before the
 * column existed.
 *
 * The scan reads code, not prose: comments are blanked first, so a comment may
 * name the old text to explain it. Specs are not scanned; they hold the text as
 * an adversarial fixture (a confirmed row whose description says it).
 */
const SRC = path.join(__dirname, "..");

/** The one file that may hold the old text: it strips it on restore. */
const ALLOWED = new Set(["backup/restore-legacy-normalizations.ts"]);

/** The marker word pair, in any case and with any separator. */
const OLD_TEXT = /PENDING[\s_-]*IMPORT/i;

/**
 * Comments blanked, line count preserved. The comment ranges come from
 * TypeScript's parser, so a `//` or `/*` inside a string, a template or a
 * regular expression is code and never hides what follows it on the line.
 */
export function stripComments(source: string): string {
  const file = ts.createSourceFile(
    "scan.ts",
    source,
    ts.ScriptTarget.Latest,
    false,
  );
  const out = source.split("");
  const blank = (ranges: readonly ts.CommentRange[] | undefined) => {
    for (const { pos, end } of ranges ?? []) {
      for (let i = pos; i < end; i++) {
        if (out[i] !== "\n") out[i] = " ";
      }
    }
  };
  const visit = (node: ts.Node) => {
    blank(ts.getLeadingCommentRanges(source, node.pos));
    blank(ts.getTrailingCommentRanges(source, node.end));
    node.getChildren(file).forEach(visit);
  };
  visit(file);
  return out.join("");
}

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir).flatMap((entry) => {
    const full = path.join(dir, entry);
    if (fs.statSync(full).isDirectory()) {
      return entry === "node_modules" || entry === "dist"
        ? []
        : sourceFiles(full);
    }
    if (!entry.endsWith(".ts") || entry.endsWith(".spec.ts")) return [];
    return [full];
  });
}

/** `file:line` for every code line holding the old text. */
export function offendersIn(rel: string, source: string): string[] {
  if (ALLOWED.has(rel)) return [];
  return stripComments(source)
    .split("\n")
    .flatMap((line, index) =>
      OLD_TEXT.test(line) ? [`${rel}:${index + 1}`] : [],
    );
}

describe("the PENDING IMPORT description note stays retired", () => {
  const files = sourceFiles(SRC);

  it("finds source files to scan", () => {
    expect(files.length).toBeGreaterThan(100);
  });

  it("holds the old text nowhere in backend/src outside the restore normalization", () => {
    const offenders = files.flatMap((file) =>
      offendersIn(
        path.relative(SRC, file).split(path.sep).join("/"),
        fs.readFileSync(file, "utf8"),
      ),
    );
    // The ban is deliberately the two words, not only the note's exact text:
    // a reader of the state would not spell the note out. An unrelated name
    // that happens to say them (a job state, a key) is renamed rather than
    // exempted.
    if (offenders.length > 0) {
      throw new Error(
        "The retired PENDING IMPORT description note is back at " +
          offenders.join(", ") +
          ". Whether an amount is provisional is `amountIsProvisional` " +
          "(`t.amount_is_provisional`), never the description (design P1, " +
          "INV-FX-006): read or write the column. A name unrelated to the " +
          "note takes other words.",
      );
    }
  });

  it("keeps the allowed file real", () => {
    for (const rel of ALLOWED) {
      expect(fs.existsSync(path.join(SRC, rel))).toBe(true);
    }
  });

  describe("the scan itself", () => {
    it("fails a reintroduced description LIKE", () => {
      const reintroduced = [
        "qb.andWhere(\"t.description LIKE '%PENDING IMPORT%'\");",
      ].join("\n");
      expect(offendersIn("import/x.service.ts", reintroduced)).toEqual([
        "import/x.service.ts:1",
      ]);
    });

    it("fails a constant, an ILIKE in another case and an includes()", () => {
      const source = [
        'export const PENDING_IMPORT_MARKER = "x";',
        "where: { description: ILike('%pending import%') },",
        'if (tx.description?.includes("Pending Import")) {}',
      ].join("\n");
      expect(offendersIn("reports/y.ts", source)).toEqual([
        "reports/y.ts:1",
        "reports/y.ts:2",
        "reports/y.ts:3",
      ]);
    });

    it("lets a comment name the old text, and still sees the code after it", () => {
      const source = [
        "/* the old PENDING IMPORT note",
        "   is retired */",
        "// a PENDING IMPORT comment",
        "const a = 1; // PENDING IMPORT",
        "const b = 'PENDING IMPORT';",
      ].join("\n");
      expect(offendersIn("z.ts", source)).toEqual(["z.ts:5"]);
    });

    it("is not blinded by a comment opener inside a string, a template or a regex", () => {
      const source = [
        'const u = "https://x"; if (d.includes("PENDING IMPORT")) {}',
        "const g = '/* not a comment'; const n = 'PENDING IMPORT'; // */",
        "const t = `a // ${x} b`; const m = /PENDING IMPORT/;",
        "const r = /\\/\\//; const k = `PENDING_IMPORT`;",
      ].join("\n");
      expect(offendersIn("w.ts", source)).toEqual([
        "w.ts:1",
        "w.ts:2",
        "w.ts:3",
        "w.ts:4",
      ]);
    });

    it("exempts the restore normalization only", () => {
      const source = "const NOTE = 'PENDING IMPORT';";
      expect(
        offendersIn("backup/restore-legacy-normalizations.ts", source),
      ).toEqual([]);
      expect(offendersIn("backup/backup-restore.service.ts", source)).toEqual([
        "backup/backup-restore.service.ts:1",
      ]);
    });
  });
});
