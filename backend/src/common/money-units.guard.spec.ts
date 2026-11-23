import { readdirSync, readFileSync } from "fs";
import { join, relative } from "path";
import * as ts from "typescript";

/**
 * Money and share counts are scaled to integer units on their decimal digits,
 * never by a float multiply (Discussion #2343). `Math.round(x * 10000)`
 * misreads a large amount: `300000000000.03 * 10000` is `3000000000000300.5`
 * in doubles, so the positive amount becomes `...301`, its negation `...300`,
 * and a pair that should cancel leaves a unit. The same holds at 1e8 for a
 * share count or a coin.
 *
 * Flagged: a `Math.round(...)` whose argument multiplies by ten thousand or a
 * hundred million (in any spelling), or by a constant named like a scale
 * (`MONEY_UNITS`, `SCALE`, `UNITS_PER_MONEY`). Not flagged: a percentage, which
 * the same multiply builds and then divides by 100 (`Math.round(r * 10000) /
 * 100`): it is a ratio, not money. The scan reads the syntax tree, so a comment
 * naming the pattern never trips it.
 */

const SRC_ROOT = join(__dirname, "..");

/** Ten-thousandths (fiat money) and hundred-millionths (shares, a coin). */
const SCALES = new Set([10_000, 100_000_000]);
const SCALE_NAME = /UNITS|SCALE/;

const unwrap = (node: ts.Expression): ts.Expression =>
  ts.isParenthesizedExpression(node) ? unwrap(node.expression) : node;

const isScale = (node: ts.Expression): boolean => {
  const inner = unwrap(node);
  return (
    (ts.isNumericLiteral(inner) && SCALES.has(Number(inner.text))) ||
    (ts.isIdentifier(inner) && SCALE_NAME.test(inner.text))
  );
};

/** `true` when `node` (and any multiply nested in it) scales by a scale. */
const multipliesByScale = (node: ts.Expression): boolean => {
  const inner = unwrap(node);
  return (
    ts.isBinaryExpression(inner) &&
    inner.operatorToken.kind === ts.SyntaxKind.AsteriskToken &&
    (isScale(inner.left) ||
      isScale(inner.right) ||
      multipliesByScale(inner.left) ||
      multipliesByScale(inner.right))
  );
};

/** `Math.round(...)` read straight back as a percentage: `... / 100`. */
const isPercentage = (call: ts.CallExpression): boolean => {
  let parent: ts.Node = call.parent;
  while (ts.isParenthesizedExpression(parent)) parent = parent.parent;
  return (
    ts.isBinaryExpression(parent) &&
    parent.operatorToken.kind === ts.SyntaxKind.SlashToken &&
    ts.isNumericLiteral(unwrap(parent.right)) &&
    Number((unwrap(parent.right) as ts.NumericLiteral).text) === 100
  );
};

/** Every float-scaled rounding in `source`, as `line: text`. */
export function floatScaleFindings(fileName: string, source: string): string[] {
  const sf = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.ES2021,
    true,
  );
  const findings: string[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      node.expression.getText(sf) === "Math.round" &&
      node.arguments.length === 1 &&
      multipliesByScale(node.arguments[0]) &&
      !isPercentage(node)
    ) {
      const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line;
      findings.push(`${line + 1}: ${node.getText(sf)}`);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return findings;
}

/** Every production `.ts` file under `dir`, relative to `SRC_ROOT`. */
function productionFiles(dir: string = SRC_ROOT): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return productionFiles(full);
    return entry.name.endsWith(".ts") &&
      !/\.(spec|e2e-spec)\.ts$/.test(entry.name)
      ? [relative(SRC_ROOT, full)]
      : [];
  });
}

describe("money is scaled to integer units on its decimal digits", () => {
  it("never rounds a float product of a money or share scale", () => {
    const offenders = productionFiles().flatMap((rel) =>
      floatScaleFindings(rel, readFileSync(join(SRC_ROOT, rel), "utf8")).map(
        (finding) => `${rel}:${finding}`,
      ),
    );
    if (offenders.length > 0) {
      throw new Error(
        "Scale money to integer units with moneyUnits(x, decimals), sum it " +
          "with sumMoney(values, decimals), round one value with " +
          "roundMoney / roundToDecimals, and shift a share count with " +
          "toScaledUnits (common/round.util.ts). Math.round(x * 10000) misreads " +
          "a large amount (Discussion #2343):\n  " +
          offenders.join("\n  "),
      );
    }
  });

  it("sees what it is meant to see, and not prose or a percentage", () => {
    const flagged = floatScaleFindings(
      "sample.ts",
      [
        "const a = Math.round(x * 10000);",
        "const b = Math.round(x * 10_000) / 10_000;",
        "const c = Math.round((x - y) * 1e4);",
        "const d = Math.round(amount * rate * MONEY_UNITS);",
        "const e = Math.round(q * 1e8) / 1e8;",
        "const f = Math.round(Number(v) * SCALE);",
        "const g = Math.round(10000 * x);",
      ].join("\n"),
    );
    expect(flagged).toEqual([
      "1: Math.round(x * 10000)",
      "2: Math.round(x * 10_000)",
      "3: Math.round((x - y) * 1e4)",
      "4: Math.round(amount * rate * MONEY_UNITS)",
      "5: Math.round(q * 1e8)",
      "6: Math.round(Number(v) * SCALE)",
      "7: Math.round(10000 * x)",
    ]);

    const clean = floatScaleFindings(
      "sample.ts",
      [
        "// Math.round(x * 10000) in a comment",
        "/* Math.round(x * 1e8) */",
        'const msg = "never Math.round(x * 10000)";',
        "const pct = Math.round((spent / budgeted) * 10000) / 100;",
        "const ear = Math.round(rate * 10000) / 100;",
        "const price = Math.round(p * 1000000) / 1000000;",
        "const cents = Math.round(x * 100) / 100;",
        "const units = moneyUnits(x, FIAT_MONEY_DECIMALS);",
        "const limit = 10000;",
      ].join("\n"),
    );
    expect(clean).toEqual([]);
  });
});
