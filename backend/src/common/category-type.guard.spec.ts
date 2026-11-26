import { readdirSync, readFileSync, statSync } from "fs";
import { join, relative } from "path";

/**
 * INV-CATEGORY-004 (READ): "expense" is `type = 'expense'`, never "not income".
 *
 * A category is Income, Expense or Transfer. `categories.is_income` is the
 * previous release's flag, kept in step by a trigger for one release; reading
 * it as "is it spending?" counts a Transfer category as spending
 * (`docs/specs/transfer-categories.md` sections 2 and 9). Every read of a
 * category's type goes through `src/categories/category-type.util.ts`
 * (`categoryTypeOf`, `isIncomeCategory`, `isExpenseCategory`, `categoryTypeIs`
 * for SQL), and this scan fails a new raw read.
 *
 * What it reads, outside specs and the helper:
 *   - the SQL column `is_income`, anywhere;
 *   - the entity column spelled in a query: `"isIncome"` in a select list, a
 *     `Pick<Category, ...>`, an alias such as `cat.isIncome` in a string;
 *   - a property read of `isIncome` on a receiver named like a category
 *     (`category`, `categories`, `cat`, `c`, `parent`, `child`);
 *   - a negated read, `!x.isIncome`, `x.isIncome === false`, on any receiver
 *     that is not a budget line.
 *
 * `budget_categories.is_income` is a different column with its own meaning (a
 * line's direction). Under `src/budgets/` every receiver is a line, so the
 * receiver rules are off there; the column rule is not, and a budget line's own
 * column carries the marker below. Elsewhere a line is named `bc`, `line`,
 * `budgetCategory` or `bcEntry`. A line the rules do not fit carries
 * `income-flag-ok: <reason>` in a comment on it or the line above; the scan
 * has no file allowlist, so the next offender in the same file is still found.
 *
 * The scan reads names, not types: it stops the slips the codebase has made, a
 * variable named something else gets past it, and the helper's own tests are
 * what hold the behaviour.
 */

const SRC_ROOT = join(__dirname, "..");
const MARKER = "income-flag-ok:";

/** The helper owns the one spelling that reads the flag. */
const HELPER = "categories/category-type.util.ts";

const BUDGET_LINE_RECEIVERS = new Set([
  "bc",
  "bcEntry",
  "line",
  "budgetCategory",
]);

interface Finding {
  file: string;
  line: number;
  rule: string;
  text: string;
}

/** Blank `//` and block comments, keeping line numbers. Strings are left. */
export function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");
}

export function findRawIncomeReads(file: string, source: string): Finding[] {
  const budgetCode = /^(budgets)[\\/]/.test(file);
  const raw = source.split("\n");
  const code = stripComments(source).split("\n");
  const out: Finding[] = [];
  const add = (index: number, rule: string, text: string) => {
    const marked =
      raw[index].includes(MARKER) ||
      (index > 0 && raw[index - 1].includes(MARKER));
    if (!marked) out.push({ file, line: index + 1, rule, text: text.trim() });
  };
  for (const [index, line] of code.entries()) {
    if (/\bis_income\b/.test(line)) add(index, "sql-column", line);
    if (
      !line.includes("BudgetCategory") &&
      (/["'`]isIncome["'`]/.test(line) ||
        /["'`][^"'`\n]*\b(?:c|cat|category|categories|p|parent)\.isIncome\b/.test(
          line,
        ))
    ) {
      add(index, "query-string", line);
    }
    for (const m of line.matchAll(/\b(\w+)\??\.isIncome\b(\s*=(?!=))?/g)) {
      const receiver = m[1];
      // An assignment writes the flag; it does not read it.
      if (m[2]) continue;
      if (budgetCode || BUDGET_LINE_RECEIVERS.has(receiver)) continue;
      const before = line.slice(0, m.index);
      const after = line.slice((m.index ?? 0) + m[0].length);
      const negated =
        /!\s*[\w.?]*$/.test(before) ||
        /^\s*(===\s*false|!==\s*true)/.test(after);
      if (
        negated ||
        /^(category|categories|cat|c|parent|child|cc)$/.test(receiver)
      ) {
        add(index, negated ? "negated-read" : "category-read", m[0]);
      }
    }
    if (!budgetCode && /\bisIncome\s*===?\s*false\b/.test(line)) {
      add(index, "negated-read", line);
    }
  }
  return out;
}

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (
        [
          "node_modules",
          "dist",
          "__fixtures__",
          "i18n",
          "test-helpers",
        ].includes(entry)
      ) {
        continue;
      }
      out.push(...sourceFiles(full));
      continue;
    }
    if (!entry.endsWith(".ts") || entry.endsWith(".spec.ts")) continue;
    out.push(full);
  }
  return out;
}

describe("a category's type is read through the helper (INV-CATEGORY-004)", () => {
  it("finds no raw read of the legacy income flag outside the helper", () => {
    const findings = sourceFiles(SRC_ROOT)
      .filter((file) => relative(SRC_ROOT, file) !== HELPER)
      .flatMap((file) =>
        findRawIncomeReads(
          relative(SRC_ROOT, file),
          readFileSync(file, "utf8"),
        ),
      );

    // A failure names the helper to use; the baseline is empty and stays so.
    expect(
      findings.map((f) => `${f.file}:${f.line} [${f.rule}] ${f.text}`),
    ).toEqual([]);
  });

  describe("the scan", () => {
    const scan = (code: string) => findRawIncomeReads("x.ts", code);

    it.each([
      [
        "a negated read",
        "const expense = rows.filter((r) => !category.isIncome);",
      ],
      ["a negated read of a derived shape", "if (!row.isIncome) spend();"],
      ["a comparison with false", "if (agg.isIncome === false) spend();"],
      ["a category read", "const income = cat?.isIncome;"],
      ["the SQL column", "WHERE c.is_income = false"],
      ["a quoted select", 'select: ["id", "isIncome"]'],
      ["a query alias in a string", '.addSelect("cat.isIncome", "x")'],
    ])("fails %s", (_name, code) => {
      expect(scan(code)).not.toEqual([]);
    });

    it.each([
      ["a budget line's direction", "if (!bc.isIncome) skip();"],
      ["a budget line named line", "const income = line.isIncome;"],
      ["an assignment, which writes the flag", "category.isIncome = true;"],
      ["the helper", "const income = isIncomeCategory(cat);"],
      ["the type in SQL", "WHERE c.category_type = 'expense'"],
      ["a comment", "// the old is_income flag, and !cat.isIncome, are gone"],
      [
        "a marked line",
        "// income-flag-ok: the file's own flag\nconst x = def.isIncome === false;",
      ],
    ])("passes %s", (_name, code) => {
      expect(scan(code)).toEqual([]);
    });

    it("names the rule and the line it found", () => {
      expect(scan("a\nb\nconst e = !cat.isIncome;")).toEqual([
        expect.objectContaining({ line: 3, rule: "negated-read" }),
      ]);
    });
  });
});
