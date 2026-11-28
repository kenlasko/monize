import { readFileSync } from "fs";
import { join } from "path";
import { gitListFiles } from "./repo-tree.util";
import {
  ACCOUNT_BALANCE_AS_OF_SQL,
  ACCOUNT_BALANCES_AS_OF_DATES_SQL,
  LEDGER_EXCLUDES_VOID,
  LEDGER_MOVEMENT_PREDICATE,
  LEDGER_BALANCE_EXPRESSION,
  LEDGER_TOP_LEVEL_ONLY,
  PROVISIONAL_COUNTS_AS_OF_DATES_SQL,
  ledgerBalanceAsOfExpression,
  ledgerBalanceJoin,
  ledgerMovementPredicate,
  ledgerProvisionalPredicate,
} from "./ledger-balance.sql";

/**
 * The as-of ledger balance means one thing, so it is spelled once.
 *
 * Four services wrote the same join out by hand and the copies had already
 * drifted. The scheduled loan bill (INV-LOAN-006) claims the debt it prices is
 * the same measurement the balances-as-of report shows, which holds only while
 * the predicates agree -- so a fifth hand-written copy is a defect, not a
 * style preference.
 *
 * The scan reads code, not prose: comments are blanked first (line numbers
 * preserved), or the paragraph above explaining the banned pattern would fail
 * the guard that bans it.
 */
const SOURCE_ROOT = join(__dirname, "..");

/**
 * The BALANCE family: every module that answers "what is this account worth",
 * and therefore has to agree with every other one. All of their copies are
 * converted, so this scan runs over them with nothing exempted.
 *
 * Reports are deliberately NOT in scope. A report asking which rows to count
 * is asking a different question with a different answer -- several read split
 * *children* on purpose, because a parent's amount is not the cash meaning of
 * its lines (INV-REPORT-001 in docs/system-invariants.md, "A report that reads only the parent row cannot
 * exclude a line, so it excludes an amount"). That family has its own single
 * source in `common/investment-filter.util.ts` and its own guard; folding the
 * two together would make one of them wrong.
 */
const BALANCE_FAMILY = [
  "accounts/",
  "action-history/",
  "delegation/",
  "import/",
  "net-worth/",
  "scheduled-transactions/",
];

/**
 * The balance readers that report a provisional count. They read it through
 * `loadProvisionalCounts` and never name the column, so what counts (non-VOID,
 * top level, flagged, dated on or before the balance's day) is one predicate
 * (`docs/specs/provisional-amounts.md` section 6, P5). The importer and
 * the action history WRITE the flag, which is why they are not in this list.
 */
const PROVISIONAL_COUNT_READERS = [
  "accounts/",
  "delegation/",
  "net-worth/",
  "scheduled-transactions/",
];

function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (match) => match.replace(/[^\n]/g, " "))
    .replace(/\/\/[^\n]*/g, (match) => " ".repeat(match.length));
}

describe("as-of ledger balance SQL", () => {
  it("blanks comments while preserving line numbers", () => {
    const stripped = stripComments("a\n// t.parent_transaction_id IS NULL\nb");
    expect(stripped.split("\n")).toHaveLength(3);
    expect(stripped).not.toContain("parent_transaction_id");
    expect(stripComments("keep t.parent_transaction_id IS NULL")).toContain(
      "parent_transaction_id",
    );
  });

  it("composes the documented predicates", () => {
    expect(ACCOUNT_BALANCE_AS_OF_SQL).toContain(LEDGER_EXCLUDES_VOID);
    expect(ACCOUNT_BALANCE_AS_OF_SQL).toContain(LEDGER_TOP_LEVEL_ONLY);
    expect(ACCOUNT_BALANCE_AS_OF_SQL).toContain("t.transaction_date <= $3");
    expect(ledgerBalanceJoin("$2", ["t.user_id = $1"])).toContain(
      "AND t.user_id = $1",
    );
  });

  it("has no hand-written copy of the movement predicate", () => {
    // The subject is the PREDICATE, not a whole query shape: most callers do
    // not sum a balance (some take MAX(date), some sum future rows only, some
    // sum a CASE) but every one of them asks this same question first, and it
    // is the answer drifting between them that costs money.
    const offenders: string[] = [];
    for (const relative of gitListFiles(SOURCE_ROOT)) {
      if (!relative.endsWith(".ts") || relative.endsWith(".spec.ts")) continue;
      if (relative === "common/ledger-balance.sql.ts") continue;
      if (!BALANCE_FAMILY.some((dir) => relative.startsWith(dir))) continue;
      const source = stripComments(
        readFileSync(join(SOURCE_ROOT, relative), "utf8"),
      );
      if (/parent_transaction_id IS NULL/.test(source)) {
        offenders.push(relative);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("counts provisional legs through one predicate, never a balance reader's own", () => {
    const offenders: string[] = [];
    for (const relative of gitListFiles(SOURCE_ROOT)) {
      if (!relative.endsWith(".ts") || relative.endsWith(".spec.ts")) continue;
      if (!PROVISIONAL_COUNT_READERS.some((dir) => relative.startsWith(dir))) {
        continue;
      }
      const source = stripComments(
        readFileSync(join(SOURCE_ROOT, relative), "utf8"),
      );
      if (/amount_is_provisional|amountIsProvisional/.test(source)) {
        offenders.push(relative);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("states a provisional leg as a ledger movement that carries the flag", () => {
    expect(ledgerProvisionalPredicate()).toBe(
      `(${LEDGER_MOVEMENT_PREDICATE} AND t.amount_is_provisional)`,
    );
    expect(ledgerProvisionalPredicate("")).toBe(
      `(${ledgerMovementPredicate("")} AND amount_is_provisional)`,
    );
  });

  it("bounds the provisional count at each as-of date, as the balance join is", () => {
    expect(PROVISIONAL_COUNTS_AS_OF_DATES_SQL).toContain(
      ledgerProvisionalPredicate(),
    );
    expect(PROVISIONAL_COUNTS_AS_OF_DATES_SQL).toContain(
      "legs.transaction_date <= d.as_of",
    );
    expect(PROVISIONAL_COUNTS_AS_OF_DATES_SQL).toContain(
      "t.account_id = ANY($1::uuid[])",
    );
    // The snapshot's bound, on request: the user's today, never CURRENT_DATE.
    expect(PROVISIONAL_COUNTS_AS_OF_DATES_SQL).toContain(
      "($3::date IS NULL OR t.transaction_date <= $3::date)",
    );
    expect(PROVISIONAL_COUNTS_AS_OF_DATES_SQL).not.toContain("CURRENT_DATE");
  });

  it("scans a family that actually exists", () => {
    // A directory renamed out from under this list would silently scan
    // nothing, which looks exactly like compliance.
    const files = gitListFiles(SOURCE_ROOT).filter((relative) =>
      relative.endsWith(".ts"),
    );
    for (const dir of BALANCE_FAMILY) {
      expect(files.some((relative) => relative.startsWith(dir))).toBe(true);
    }
  });

  it("covers the balance readers, including the ones that do not sum a balance", () => {
    // The predicate reaches queries taking MAX(date) and summing only future
    // rows; if the scan only recognised balance sums those would drift freely.
    const scanned = gitListFiles(SOURCE_ROOT).filter(
      (relative) =>
        relative.endsWith(".ts") &&
        !relative.endsWith(".spec.ts") &&
        BALANCE_FAMILY.some((dir) => relative.startsWith(dir)) &&
        stripComments(
          readFileSync(join(SOURCE_ROOT, relative), "utf8"),
        ).includes("LEDGER_MOVEMENT_PREDICATE"),
    );
    expect(scanned.length).toBeGreaterThanOrEqual(7);
  });

  it("states the predicate once, and the balance query composes it", () => {
    expect(LEDGER_MOVEMENT_PREDICATE).toContain(LEDGER_EXCLUDES_VOID);
    expect(LEDGER_MOVEMENT_PREDICATE).toContain(LEDGER_TOP_LEVEL_ONLY);
    expect(ACCOUNT_BALANCE_AS_OF_SQL).toContain(LEDGER_MOVEMENT_PREDICATE);
  });

  it("bounds the many-dates query by the same join at each unnested date", () => {
    expect(ACCOUNT_BALANCES_AS_OF_DATES_SQL).toContain(
      ledgerBalanceJoin("d.as_of"),
    );
    expect(ACCOUNT_BALANCES_AS_OF_DATES_SQL).toContain("unnest($3::date[])");
  });

  it("states a one-pass as-of balance as the balance expression filtered at its date", () => {
    // The same opening balance plus the same sum, keeping only the rows on or
    // before the date, so several balances of one account read in one pass
    // over a join bounded at the latest of them equal the per-date reads.
    expect(ledgerBalanceAsOfExpression("d.as_of")).toBe(
      LEDGER_BALANCE_EXPRESSION.replace(
        "SUM(t.amount)",
        "SUM(t.amount) FILTER (WHERE t.transaction_date <= d.as_of)",
      ),
    );
  });
});
