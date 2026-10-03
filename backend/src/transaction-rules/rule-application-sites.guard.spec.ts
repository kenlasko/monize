import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  findRepoRoot,
  gitListFiles,
  requireRepoRoot,
} from "../common/repo-tree.util";

/**
 * Every code path that inserts a row into `transactions` either runs the
 * user's transaction rules or is a reviewed exemption (INV-RULE-002,
 * docs/future-plans/transaction-rules.md section 6.3 and invariant I2).
 *
 * The mistake this holds is the one a new creation path makes by default: the
 * rules are applied on the paths that existed when the feature landed, and a
 * path added later inserts rows the rules never see, with nothing failing. The
 * guard lists the files that hold an insert site and requires each one to be
 * in exactly one of two reviewed lists:
 *
 *   APPLYING_SITES       the file inserts and a file that calls the applier
 *                        (`applyToNew`, `applyToNewTransfer` or
 *                        `applyImportRules`) runs the rules in the same
 *                        transaction. The spec asserts that file still calls it.
 *   EXEMPT_INSERT_SITES  the file inserts and the rules are deliberately not
 *                        run, with the reason. `GAP:` marks a path that should
 *                        apply them and does not yet.
 *
 * Both lists are shrink-only in spirit: an entry whose file no longer has an
 * insert site fails, so a list cannot outlive the code it describes, and an
 * exemption is never added to make a new path pass (docs/guard-tests.md).
 *
 * The unit of the check is the file, not the statement. A file in
 * APPLYING_SITES may still hold an insert the applier does not evaluate (the
 * regular import processor creates transfer legs, which section 6.3 leaves to
 * Q2); the comment on that entry says so. The applier being called is checked
 * with comments stripped, so commenting the call out fails the guard.
 */

const SRC_PREFIX = "backend/src/";

/** Calls that run the rules: the applier's two entry points and the MNY pass. */
const APPLIER_CALL = /\b(applyToNew|applyToNewTransfer|applyImportRules)\(/;

/**
 * Files that insert into `transactions` and whose rows the rules see. The value
 * is the file that calls the applier for them: the same file, or the caller
 * that owns the transaction when the insert lives in a helper.
 */
export const APPLYING_SITES: Readonly<Record<string, string>> = {
  // REST create, joint register, scheduled posting, AI, MCP, createBulk.
  "transactions/transactions.service.ts":
    "transactions/transactions.service.ts",
  // writeTransferLegs: applyToNewTransfer inside the leg transaction.
  "transactions/transaction-transfer.service.ts":
    "transactions/transaction-transfer.service.ts",
  // processTransaction applies the import rules inside the row savepoint. The
  // two transfer-leg creations in this file (a split transfer's counterpart and
  // a plain transfer's mirror leg) are not evaluated: design 6.3, Q2.
  "import/import-regular-processor.service.ts":
    "import/import-regular-processor.service.ts",
  // writeTransactions inserts; MnyImportService runs one applyImportRules pass
  // over the regular rows it wrote, on the import's own manager.
  "import/mny/writers/write-transactions.ts":
    "import/mny/mny-import.service.ts",
};

/**
 * Files that insert into `transactions` and are exempt from the rules, each
 * with the reason. Shrink-only: delete an entry when the code moves or starts
 * applying the rules; never add one to make a new path pass.
 */
export const EXEMPT_INSERT_SITES: Readonly<Record<string, string>> = {
  "backup/backup-restore-database.service.ts":
    "backup restore replays the rows of a backup file verbatim; a rule must not re-edit restored data",
  "action-history/action-history.service.ts":
    "undo and redo put a deleted or edited row back exactly as it was; a rule must not re-edit it",
  "database/seed.service.ts":
    "seed data for a fresh install, written before any user rule can exist",
  "database/demo-seed.service.ts":
    "demo-account seed data, written before any user rule can exist",
  "database/demo-reset.service.ts":
    "demo-account reset replays the fixed demo data",
  "securities/investment-transactions.service.ts":
    "the cash leg of an investment transaction is derived from the trade; its category, payee and tags follow the trade (design 6.3, out of scope)",
  "import/import-investment-processor.service.ts":
    "QIF investment import: the cash leg of a trade and its transfer counterpart are derived rows (design 6.3, out of scope; transfer legs wait on Q2)",
  "import/mny/writers/write-investments.ts":
    "MNY investment import: the cash rows of a trade are derived from it (design 6.3, out of scope)",
  "transactions/transaction-split.service.ts":
    "the counterpart leg of a split transfer, created by createSplits and addSplit; not evaluated until Q2 of the design is decided",
  "transactions/convert-to-transfer.ts":
    "the counterpart leg of a rule's own convert_to_transfer action, written by the applier as that rule's effect (spec transaction-rules-structural-actions.md section 5); rules never re-evaluate a row a rule created, and a structural action is refused on any transfer leg",
};

type SiteKind =
  | "create(Transaction, ...)"
  | "new Transaction()"
  | "INSERT INTO transactions"
  | "INSERT INTO a dynamic table name"
  | "insert().into(transactions)"
  | "repository insert/save/create of Transaction";

export interface InsertSite {
  line: number;
  kind: SiteKind;
}

/**
 * Blank every comment while keeping line numbers, so prose that names a
 * pattern cannot trip the scan and a commented-out call cannot satisfy it.
 * A `//` inside a string literal (a URL) is left alone by requiring the
 * comment to start a line or follow whitespace after code.
 */
export function stripComments(text: string): string {
  const blank = (m: string): string => m.replace(/[^\n]/g, " ");
  return text
    .replace(/\/\*[\s\S]*?\*\//g, blank)
    .replace(
      /(^|[ \t])\/\/[^\n]*/gm,
      (m, lead: string) => lead + blank(m.slice(lead.length)),
    );
}

const lineOf = (text: string, index: number): number =>
  text.slice(0, index).split("\n").length;

/** Every insert into `transactions` in one file's source, comments ignored. */
export function findInsertSites(source: string): InsertSite[] {
  const text = stripComments(source);
  const sites: InsertSite[] = [];
  const add = (re: RegExp, kind: SiteKind): void => {
    for (const m of text.matchAll(re)) {
      sites.push({ line: lineOf(text, m.index ?? 0), kind });
    }
  };

  add(/\bcreate\(\s*Transaction\s*,/g, "create(Transaction, ...)");
  add(/\bnew Transaction\(\s*\)/g, "new Transaction()");
  add(/INSERT\s+INTO\s+"?transactions\b"?/gi, "INSERT INTO transactions");
  add(/INSERT\s+INTO\s+"\$\{/gi, "INSERT INTO a dynamic table name");
  add(
    /\.into\(\s*(Transaction\b|["'`]transactions["'`])/g,
    "insert().into(transactions)",
  );
  add(
    /getRepository\(\s*Transaction\s*\)\s*\.(insert|save|upsert|create)\(/g,
    "repository insert/save/create of Transaction",
  );
  add(
    /\.(insert|upsert)\(\s*Transaction\s*,/g,
    "repository insert/save/create of Transaction",
  );

  // A repository held in a variable: `const repo = m.getRepository(Transaction)`
  // followed by `repo.insert(...)`. The variable is followed only to the end of
  // the block that declares it (the first later line that closes at a shallower
  // indent), because `repo` is also a callback parameter name elsewhere in a
  // file, for an unrelated entity.
  const lines = text.split("\n");
  const held =
    /(?:const|let)\s+(\w+)\s*=\s*[\w.]+\.getRepository\(\s*Transaction\s*\)/g;
  for (const decl of text.matchAll(held)) {
    const declLine = lineOf(text, decl.index ?? 0);
    const indent = lines[declLine - 1].search(/\S/);
    const use = new RegExp(`\\b${decl[1]}\\.(insert|save|upsert|create)\\(`);
    for (let i = declLine; i < lines.length; i += 1) {
      const at = lines[i].search(/\S/);
      if (at >= 0 && at < indent && lines[i].trimStart().startsWith("}")) break;
      if (use.test(lines[i])) {
        sites.push({
          line: i + 1,
          kind: "repository insert/save/create of Transaction",
        });
      }
    }
  }

  return sites.sort((a, b) => a.line - b.line);
}

interface SourceFile {
  path: string;
  source: string;
}

function sourceFiles(): SourceFile[] {
  const root = requireRepoRoot(findRepoRoot(__dirname));
  // `--others --exclude-standard` as well as `--cached`: a brand-new file is
  // otherwise invisible until it is staged, which is how a scan goes green
  // locally and red in CI on the same content.
  return gitListFiles(root, "--cached --others --exclude-standard")
    .filter(
      (f) =>
        f.startsWith(SRC_PREFIX) &&
        f.endsWith(".ts") &&
        !f.endsWith(".spec.ts"),
    )
    .map((f) => ({
      path: f.slice(SRC_PREFIX.length),
      source: readFileSync(join(root, f), "utf8"),
    }));
}

describe("the insert-site scanner", () => {
  it("finds each shape of an insert into transactions", () => {
    const samples: [string, SiteKind][] = [
      ["m.create(Transaction, { userId });", "create(Transaction, ...)"],
      ["const t = new Transaction();", "new Transaction()"],
      [
        "await m.query(`INSERT INTO transactions (id) VALUES ($1)`);",
        "INSERT INTO transactions",
      ],
      [
        'await m.query(`insert into "transactions" (id)`);',
        "INSERT INTO transactions",
      ],
      [
        "q.insert().into(Transaction).values(v);",
        "insert().into(transactions)",
      ],
      ['q.insert().into("transactions");', "insert().into(transactions)"],
      [
        "await m.getRepository(Transaction).insert(rows);",
        "repository insert/save/create of Transaction",
      ],
      [
        "const repo = m.getRepository(Transaction);\nawait repo.save(row);",
        "repository insert/save/create of Transaction",
      ],
      [
        'await m.query(`INSERT INTO "${table}" (a) VALUES ($1)`);',
        "INSERT INTO a dynamic table name",
      ],
    ];
    for (const [source, kind] of samples) {
      expect(findInsertSites(source).map((s) => s.kind)).toContain(kind);
    }
  });

  it("does not report reads, other tables or prose", () => {
    const clean = [
      "const rows = await m.getRepository(Transaction).find({ where });",
      "const repo = m.getRepository(Transaction);\nawait repo.find();",
      "await m.query(`INSERT INTO transaction_splits (id) VALUES ($1)`);",
      "await m.query(`INSERT INTO transaction_tags (id) VALUES ($1)`);",
      "m.create(TransactionSplit, { amount });",
      "// m.create(Transaction, { x }) is described here\nconst a = 1;",
      "/* INSERT INTO transactions */ const a = 1;",
      "/*\n * INSERT INTO transactions (in a doc block)\n */",
    ];
    for (const source of clean) {
      expect(findInsertSites(source)).toEqual([]);
    }
  });

  it("keeps line numbers when it blanks comments", () => {
    const source = "/*\n * x\n */\nconst a = 1;\nm.create(Transaction, {});";
    expect(findInsertSites(source)).toEqual([
      { line: 5, kind: "create(Transaction, ...)" },
    ]);
  });
});

describe("every insert into transactions applies the rules or is exempt", () => {
  const files = sourceFiles();
  const byPath = new Map(files.map((f) => [f.path, f]));
  const sitesByFile = new Map<string, InsertSite[]>();
  for (const file of files) {
    const sites = findInsertSites(file.source);
    if (sites.length > 0) sitesByFile.set(file.path, sites);
  }

  it("finds the sources and the insert sites it is meant to scan", () => {
    // An empty match set is indistinguishable from a clean one, and a guard
    // that lists the tree with `git ls-files` is blind to an untracked file.
    expect(files.length).toBeGreaterThan(400);
    for (const known of [
      "transactions/transactions.service.ts",
      "transactions/transaction-transfer.service.ts",
      "import/import-regular-processor.service.ts",
      "import/mny/writers/write-transactions.ts",
      "action-history/action-history.service.ts",
    ]) {
      expect([...sitesByFile.keys()]).toContain(known);
    }
  });

  it("has no file that inserts into transactions outside the two lists", () => {
    const listed = new Set([
      ...Object.keys(APPLYING_SITES),
      ...Object.keys(EXEMPT_INSERT_SITES),
    ]);
    const offenders = [...sitesByFile.entries()]
      .filter(([path]) => !listed.has(path))
      .map(
        ([path, sites]) =>
          `  ${path}: ${sites.map((s) => `line ${s.line} (${s.kind})`).join(", ")}`,
      );
    if (offenders.length > 0) {
      throw new Error(
        [
          "A file inserts into `transactions` and neither applies the transaction rules nor is a reviewed exemption (INV-RULE-002):",
          ...offenders,
          "",
          "Fix the code: call TransactionRulesApplierService.applyToNew (or applyToNewTransfer for a transfer, applyImportRules for the MNY pass) inside the transaction that inserts the row, then list the file in APPLYING_SITES.",
          "Only if the path genuinely must not run rules (restore, seed, undo, a derived leg), add it to EXEMPT_INSERT_SITES with a one-line reason and have the exemption reviewed. Do not add one to make the guard pass.",
          "See docs/system-invariants.md INV-RULE-002 and docs/future-plans/transaction-rules.md section 6.3.",
        ].join("\n"),
      );
    }
  });

  it("lists a file in only one of the two lists", () => {
    const both = Object.keys(APPLYING_SITES).filter(
      (p) => p in EXEMPT_INSERT_SITES,
    );
    expect(both).toEqual([]);
  });

  it("requires every applying site's owner to still call the applier", () => {
    const missing = Object.entries(APPLYING_SITES)
      .filter(([, applierFile]) => {
        const file = byPath.get(applierFile);
        return !file || !APPLIER_CALL.test(stripComments(file.source));
      })
      .map(
        ([insertFile, applierFile]) =>
          `  ${insertFile} (rules run by ${applierFile})`,
      );
    if (missing.length > 0) {
      throw new Error(
        [
          "These files insert into `transactions` and are listed as applying the rules, but the file that should call the applier does not (INV-RULE-002):",
          ...missing,
          "",
          "Restore the call to applyToNew / applyToNewTransfer / applyImportRules inside the inserting transaction. If the path no longer applies rules on purpose, move it to EXEMPT_INSERT_SITES with a reason and have that reviewed.",
        ].join("\n"),
      );
    }
  });

  it("keeps both lists to files that still hold an insert site", () => {
    const stale = [
      ...Object.keys(APPLYING_SITES),
      ...Object.keys(EXEMPT_INSERT_SITES),
    ].filter((path) => !sitesByFile.has(path));
    if (stale.length > 0) {
      throw new Error(
        [
          "These entries no longer have an insert into `transactions`; delete them so the lists shrink with the code:",
          ...stale.map((p) => `  ${p}`),
        ].join("\n"),
      );
    }
  });

  it("gives every exemption a reason, and every GAP a description", () => {
    for (const [path, reason] of Object.entries(EXEMPT_INSERT_SITES)) {
      expect({ path, ok: reason.trim().length >= 20 }).toEqual({
        path,
        ok: true,
      });
      if (reason.startsWith("GAP:")) {
        expect(reason.slice(4).trim().length).toBeGreaterThan(20);
      }
    }
  });
});
