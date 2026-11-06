import { readdirSync, readFileSync } from "fs";
import { join, relative } from "path";
import * as ts from "typescript";

/**
 * An amount in an account's currency is rounded and summed at that currency's
 * money precision (INV-MONEY-001, `docs/specs/money-precision.md`): four places
 * for fiat, a coin's own places (up to eight) for a cryptocurrency. The
 * helpers default to four, so a call that passes no precision is exactly the
 * defect on these paths: it rounds a 2,500-sat fee (`0.00002500` BTC) to zero.
 *
 * The files below are class (a) of the money-precision inventory: they handle
 * amounts in the account's currency. In them, `roundMoney`, `sumMoney` and
 * `toMoneyNumber` take a second argument, `moneyDecimalsFor(...)` of the
 * currency the amount is in (or `FIAT_MONEY_DECIMALS` for a figure that is
 * fiat by construction), and no literal 10000 / 1e4 scales an amount, nor a
 * `toFixed(4)` or a SQL `ROUND(..., 4)` rounds one. Elsewhere (reporting-currency figures,
 * loans, securities, shared expenses) the four-place default is the rule.
 *
 * The scan reads the TypeScript syntax tree, so a comment or a string naming a
 * call never trips it; the SQL check reads string and template literals only.
 */

const SRC_ROOT = join(__dirname, "..");

/** The account-currency paths (class (a) of the inventory). */
const ACCOUNT_CURRENCY_FILES = [
  "transactions/transactions.service.ts",
  "transactions/transaction-transfer.service.ts",
  "transactions/transaction-split.service.ts",
  "transactions/transaction-bulk-update.service.ts",
  "transactions/convert-to-transfer.ts",
  "transactions/split-received-amount.util.ts",
  "common/split-amount.util.ts",
  "common/deletion-balance.util.ts",
  "common/currency-minor-unit.util.ts",
  "action-history/action-history.service.ts",
  "scheduled-transactions/scheduled-transactions.service.ts",
  "scheduled-transactions/scheduled-effective-amount.service.ts",
  "accounts/accounts.service.ts",
  "accounts/balance-forecast.service.ts",
  "accounts/balance-forecast.util.ts",
  "accounts/account-balances-report.service.ts",
  "delegation/joint-accounts.service.ts",
  "transactions/transaction-reconciliation.service.ts",
  "categories/category-detail.service.ts",
  "payees/payee-detail.service.ts",
  "transactions/transaction-analytics.service.ts",
  "accounts/account-export.service.ts",
  "bank-sync/bank-sync.service.ts",
  "bank-sync/bank-transaction-planner.ts",
  "bank-sync/bank-sync-views.ts",
  "bank-sync/bank-sync-preview.service.ts",
  "bank-sync/bank-sync-plan-fingerprint.ts",
  "import/ofx-parser.ts",
  "import/import-context.ts",
  "import/import-post-processing.service.ts",
  "import/import-transfer-dedupe.ts",
  "import/import.service.ts",
  "ai-review/ai-review-work.service.ts",
];

/**
 * Files that still round or sum an account-currency amount at the fiat
 * default, on the day the guard landed (phase 1A of
 * `docs/future-plans/money-precision.md`). Shrink-only: phases 1B to 1D delete
 * a file's line when they convert it, and the list ends empty. Never add one;
 * a new call in a listed file passes a precision too.
 */
const BASELINE = new Set<string>([]);

/** The helpers whose second argument is the precision. */
const PRECISION_HELPERS = new Set(["roundMoney", "sumMoney", "toMoneyNumber"]);

/** A SQL `ROUND(<expr>, 4)`: the database rounding money at the fiat scale. */
const SQL_ROUND_AT_FOUR = /\bROUND\s*\((?:[^()]|\([^()]*\))*,\s*4\s*\)/i;

const MULTIPLICATIVE = new Set<ts.SyntaxKind>([
  ts.SyntaxKind.AsteriskToken,
  ts.SyntaxKind.SlashToken,
  ts.SyntaxKind.AsteriskEqualsToken,
  ts.SyntaxKind.SlashEqualsToken,
]);

/** Every precision finding in `source`, as `line: what`. */
export function moneyPrecisionFindings(
  fileName: string,
  source: string,
): string[] {
  const sf = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.ES2021,
    true,
  );
  const findings: string[] = [];
  const at = (node: ts.Node, what: string) =>
    findings.push(
      `${sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1}: ${what}`,
    );

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const callee = ts.isIdentifier(node.expression)
        ? node.expression.text
        : ts.isPropertyAccessExpression(node.expression)
          ? node.expression.name.text
          : null;
      if (
        callee !== null &&
        PRECISION_HELPERS.has(callee) &&
        node.arguments.length === 1
      ) {
        at(node, `${callee}(...) without a precision`);
      }
      const [places] = node.arguments;
      if (
        callee === "toFixed" &&
        node.arguments.length === 1 &&
        ts.isNumericLiteral(places) &&
        Number(places.text) === 4
      ) {
        at(node, "toFixed(4) on an amount");
      }
    }
    if (
      ts.isNumericLiteral(node) &&
      Number(node.text) === 10000 &&
      ts.isBinaryExpression(node.parent) &&
      MULTIPLICATIVE.has(node.parent.operatorToken.kind)
    ) {
      at(node, `${node.getText(sf)} used as a money scale`);
    }
    if (
      (ts.isStringLiteral(node) ||
        ts.isNoSubstitutionTemplateLiteral(node) ||
        ts.isTemplateHead(node) ||
        ts.isTemplateMiddle(node) ||
        ts.isTemplateTail(node)) &&
      SQL_ROUND_AT_FOUR.test(node.text)
    ) {
      at(node, "SQL ROUND(..., 4) on an amount");
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return findings;
}

function read(rel: string): string {
  return readFileSync(join(SRC_ROOT, rel), "utf8");
}

/** Every `.ts` file under `dir`, as a path relative to `SRC_ROOT`. */
function sourceFiles(dir: string = SRC_ROOT): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return entry.name.endsWith(".ts") ? [relative(SRC_ROOT, full)] : [];
  });
}

/**
 * The one place a one-argument `toMoneyNumber(` is the subject: the helper's
 * own spec, which pins what its default does.
 */
const TO_MONEY_NUMBER_DEFAULT_SPEC = "common/round.util.spec.ts";

describe("account-currency amounts are rounded at their currency's precision", () => {
  const findingsByFile = new Map(
    ACCOUNT_CURRENCY_FILES.map((rel) => [
      rel,
      moneyPrecisionFindings(rel, read(rel)),
    ]),
  );

  it("passes a precision on every listed account-currency path", () => {
    const offenders = [...findingsByFile.entries()]
      .filter(([rel, found]) => found.length > 0 && !BASELINE.has(rel))
      .flatMap(([rel, found]) => found.map((f) => `${rel}:${f}`));
    if (offenders.length > 0) {
      throw new Error(
        "An amount in an account's currency is rounded and summed at that " +
          "currency's money precision: pass moneyDecimalsFor(currency." +
          "decimalPlaces) as the second argument of roundMoney / sumMoney / " +
          "toMoneyNumber (FIAT_MONEY_DECIMALS only for a figure that is fiat " +
          "by construction), and never scale, toFixed or ROUND an amount at 4 " +
          "(docs/specs/money-precision.md, INV-MONEY-001):\n  " +
          offenders.join("\n  "),
      );
    }
  });

  it("keeps the baseline shrink-only: a converted file leaves it", () => {
    const stale = [...BASELINE].filter(
      (rel) => (findingsByFile.get(rel) ?? []).length === 0,
    );
    if (stale.length > 0) {
      throw new Error(
        "These files no longer round at the fiat default; delete their " +
          `BASELINE line:\n  ${stale.join("\n  ")}`,
      );
    }
  });

  it("baselines only listed account-currency files", () => {
    const listed = new Set(ACCOUNT_CURRENCY_FILES);
    expect([...BASELINE].filter((rel) => !listed.has(rel))).toEqual([]);
  });

  it("sees what it is meant to see, and not prose", () => {
    const flagged = moneyPrecisionFindings(
      "sample.ts",
      [
        "const a = roundMoney(x);",
        "const b = sumMoney(values);",
        "const c = toMoneyNumber(row.total);",
        "const d = Math.round(x * 10000) / 10000;",
        "const e = Math.round(x * 1e4);",
        'const f = "UPDATE accounts SET b = ROUND(CAST(b AS numeric) + $1, 4)";',
        "const g = round.roundMoney(x);",
        "const h = amount.toFixed(4);",
      ].join("\n"),
    );
    expect(flagged).toEqual([
      "1: roundMoney(...) without a precision",
      "2: sumMoney(...) without a precision",
      "3: toMoneyNumber(...) without a precision",
      "4: 10000 used as a money scale",
      "4: 10000 used as a money scale",
      "5: 1e4 used as a money scale",
      "6: SQL ROUND(..., 4) on an amount",
      "7: roundMoney(...) without a precision",
      "8: toFixed(4) on an amount",
    ]);

    const clean = moneyPrecisionFindings(
      "sample.ts",
      [
        "// roundMoney(x) in a comment, and a 10000 * 2 in prose",
        "/* sumMoney(values) */",
        'const msg = "call roundMoney(x) with a precision";',
        "const a = roundMoney(x, moneyDecimalsFor(places));",
        "const b = sumMoney(values, decimals);",
        "const c = toMoneyNumber(row.total, FIAT_MONEY_DECIMALS);",
        "const limit = 10000;",
        'const sql = "SELECT ROUND(rate, 10)";',
        "const shown = amount.toFixed(places);",
      ].join("\n"),
    );
    expect(clean).toEqual([]);
  });
});

describe("toMoneyNumber always names the precision it reads at", () => {
  // `toMoneyNumber(row.total)` reads at four places, which rounds a coin's
  // 0.00002500 to zero before it is converted (INV-MONEY-001). Wherever it is
  // called it says which precision it means: `MONEY_SCALE` for an aggregate in
  // a row's own currency (lossless; the same for fiat), `moneyDecimalsFor(...)`
  // for an account's currency, `FIAT_MONEY_DECIMALS` for a reporting-currency
  // figure. Baseline is empty and stays so.
  const oneArgument = (rel: string): string[] => {
    const source = read(rel);
    if (!source.includes("toMoneyNumber(")) return [];
    return moneyPrecisionFindings(rel, source)
      .filter((finding) => finding.includes("toMoneyNumber(...)"))
      .map((finding) => `${rel}:${finding}`);
  };

  it("has no one-argument toMoneyNumber( anywhere under backend/src", () => {
    const offenders = sourceFiles()
      .filter((rel) => rel !== TO_MONEY_NUMBER_DEFAULT_SPEC)
      .flatMap(oneArgument);
    if (offenders.length > 0) {
      throw new Error(
        "toMoneyNumber(x) reads at the fiat four places and rounds a coin's " +
          "sum to zero before it converts: pass MONEY_SCALE for an aggregate " +
          "in the row's own currency, moneyDecimalsFor(...) for an account's " +
          "currency, or FIAT_MONEY_DECIMALS for a reporting-currency figure " +
          "(docs/specs/money-precision.md, INV-MONEY-001):\n  " +
          offenders.join("\n  "),
      );
    }
  });

  it("scans the source tree, and sees a bare call", () => {
    const files = sourceFiles();
    expect(files).toContain("built-in-reports/spending-reports.service.ts");
    expect(files).toContain(TO_MONEY_NUMBER_DEFAULT_SPEC);
    expect(oneArgument(TO_MONEY_NUMBER_DEFAULT_SPEC)).not.toEqual([]);
  });
});
