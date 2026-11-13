import { readdirSync, readFileSync } from "fs";
import { join, relative, sep } from "path";

/**
 * Which routes a personal access token can reach is a reviewed list, held here.
 *
 * `PatAccessGuard` is fail-closed, so forgetting `@AllowPat()` costs nothing.
 * The mistake this guard exists for is the opposite one: adding the decorator
 * to a controller that signs people in, manages credentials or sharing, or
 * exports the whole dataset, or marking a writing POST `@PatScope("read")` so a
 * read-only token can write. Each is one line in a diff and none fails a test
 * of its own. Opening a controller to PATs, or declaring a POST a pure read,
 * means editing a list below in the same PR, as a decision someone reviewed.
 */
const SRC = join(__dirname, "..", "..");

/** Controllers a PAT may reach. Add one only after reading every handler. */
const PAT_CONTROLLERS = [
  "accounts/accounts.controller.ts",
  "action-history/action-history.controller.ts",
  "ai-review/ai-review-requests.controller.ts",
  "ai/forecast/ai-forecast.controller.ts",
  "ai/insights/ai-insights.controller.ts",
  "ai/query/ai-query.controller.ts",
  "ai/trivia/dashboard-trivia.controller.ts",
  "attachments/attachments.controller.ts",
  "attachments/warranty-attachment-copy.controller.ts",
  "bonds/bonds.controller.ts",
  "budgets/budgets.controller.ts",
  "built-in-reports/built-in-reports.controller.ts",
  "calendar/calendar-day-notes.controller.ts",
  "categories/categories.controller.ts",
  "currencies/currencies.controller.ts",
  "email-receipts/parsers/email-receipt-parsers.controller.ts",
  "email-receipts/receipts/email-receipts.controller.ts",
  "import/import.controller.ts",
  "import/mny/mny-import.controller.ts",
  "institutions/institutions.controller.ts",
  "investment-reports/investment-reports.controller.ts",
  "investment-reports/investment-transaction-summary.controller.ts",
  "loan-fees/loan-fees.controller.ts",
  "loan-rate-changes/loan-rate-changes.controller.ts",
  "loan-scenarios/loan-scenarios.controller.ts",
  "monte-carlo/monte-carlo.controller.ts",
  "net-worth/net-worth.controller.ts",
  "notification-center/notification-preference.controller.ts",
  "notification-center/notification-reminder.controller.ts",
  "notification-center/notification.controller.ts",
  "payees/payees.controller.ts",
  "payroll-deductions/payroll-deductions.controller.ts",
  "reports/reports.controller.ts",
  "scheduled-transactions/scheduled-transactions.controller.ts",
  "securities/holdings.controller.ts",
  "securities/investment-transactions.controller.ts",
  "securities/performance-comparison.controller.ts",
  "securities/portfolio.controller.ts",
  "securities/quote-table-preview.controller.ts",
  "securities/securities.controller.ts",
  "strategies/gem-strategy.controller.ts",
  "tags/tags.controller.ts",
  "transaction-rules/transaction-rules.controller.ts",
  "transactions/transactions.controller.ts",
  "warranties/warranties.controller.ts",
  "warranties/warranty-claims.controller.ts",
];

/**
 * `@PatScope("read")` handlers per controller: non-GET routes that compute an
 * answer and write nothing. Raising a count means the new handler, and the
 * service method behind it, were read and found to write nothing (no row, no
 * email, no push, no provider call that costs money).
 */
const PAT_READ_OVERRIDES: Record<string, number> = {
  "accounts/accounts.controller.ts": 5,
  "budgets/budgets.controller.ts": 2,
  "email-receipts/parsers/email-receipt-parsers.controller.ts": 2,
  "email-receipts/receipts/email-receipts.controller.ts": 1,
  "import/import.controller.ts": 5,
  "investment-reports/investment-reports.controller.ts": 1,
  "reports/reports.controller.ts": 1,
  "transaction-rules/transaction-rules.controller.ts": 4,
};

/**
 * Never reachable with a PAT, whatever a later change intends: these are how an
 * account is taken over, shared or emptied.
 */
const SESSION_ONLY_DIRECTORIES = [
  "admin",
  "auth",
  "backup",
  "delegation",
  "emergency-access",
  "mcp",
  "oauth",
  "push",
  "users",
];

function controllerFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return controllerFiles(full);
    return entry.name.endsWith(".controller.ts") ? [full] : [];
  });
}

/** Blank comments so prose naming a decorator neither trips nor satisfies the scan. */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, " "))
    .replace(/^\s*\/\/.*$/gm, "");
}

const controllers = controllerFiles(SRC).map((file) => ({
  path: relative(SRC, file).split(sep).join("/"),
  code: stripComments(readFileSync(file, "utf8")),
}));

describe("personal access token route list", () => {
  it("finds the controllers", () => {
    expect(controllers.length).toBeGreaterThan(50);
  });

  it("strips a decorator named only in a comment", () => {
    expect(stripComments("// @AllowPat()\n/* @AllowPat() */\n")).not.toContain(
      "@AllowPat()",
    );
    expect(stripComments("@AllowPat()\n")).toContain("@AllowPat()");
  });

  it("opens exactly the reviewed controllers to PATs", () => {
    const annotated = controllers
      .filter((c) => /^@AllowPat\(\)/m.test(c.code))
      .map((c) => c.path)
      .sort();
    expect(annotated).toEqual([...PAT_CONTROLLERS].sort());
  });

  it("uses @AllowPat() only on a class, never to re-open one handler", () => {
    const offenders = controllers
      .filter((c) => /^[ \t]+@AllowPat\(/m.test(c.code))
      .map((c) => c.path);
    expect(offenders).toEqual([]);
  });

  it("keeps the session-only directories free of every PAT decorator", () => {
    const offenders = controllers
      .filter((c) => SESSION_ONLY_DIRECTORIES.includes(c.path.split("/")[0]))
      .filter((c) => /@(AllowPat|PatScope)\(/.test(c.code))
      .map((c) => c.path);
    expect(offenders).toEqual([]);
  });

  it("declares a non-GET route a pure read only where reviewed", () => {
    const found: Record<string, number> = {};
    for (const c of controllers) {
      const count = (c.code.match(/@PatScope\("read"\)/g) ?? []).length;
      if (count > 0) found[c.path] = count;
    }
    expect(found).toEqual(PAT_READ_OVERRIDES);
  });
});
