import { readdirSync, readFileSync } from "fs";
import { join, relative } from "path";
import * as ts from "typescript";

/**
 * A part folds into the figure above it as its aggregate, never as its
 * rounded reading (`docs/specs/report-rounding-and-aggregation.md` rule 2,
 * INV-REPORT-005). Reading a part at four places and adding the reading made a
 * total move with the grouping: two 124.752474 cells summed to 249.5050 where
 * one cell of both read 249.5049, and the Cash Flow Sankey answered a 500 when a
 * parent and its children were read on their own (issue #2384).
 *
 * Flagged, where the argument or right-hand side reads an `FxAggregate`'s
 * `knownSubtotal` or `unroundedSubtotal` (a double past about nine thousand
 * holds fewer places than the accumulator):
 * - `agg.addConverted(...)` / `agg.add(...)`: fold the part with `merge` or
 *   `mergeNegated`;
 * - `sumMoney(...)`: fold the parts' aggregates instead;
 * - `x += ...` / `x -= ...`: accumulate in an `FxAggregate`;
 * - `isNetSpending(...)` over a reading or a `roundMoney(...)`: judge the
 *   direction on `agg.sign`, before rounding (rule 5).
 * The scan reads the syntax tree, so a comment naming the pattern never trips
 * it.
 */

const SRC_ROOT = join(__dirname, "..");

const READINGS = new Set(["knownSubtotal", "unroundedSubtotal"]);

/** `true` when `node` reads an aggregate's subtotal anywhere inside it. */
const readsSubtotal = (node: ts.Node): boolean =>
  (ts.isPropertyAccessExpression(node) && READINGS.has(node.name.text)) ||
  ts.forEachChild(node, (child) => readsSubtotal(child) || undefined) === true;

/** `true` when `node` calls `roundMoney` anywhere inside it. */
const callsRoundMoney = (node: ts.Node): boolean =>
  (ts.isCallExpression(node) &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === "roundMoney") ||
  ts.forEachChild(node, (child) => callsRoundMoney(child) || undefined) ===
    true;

const calleeName = (call: ts.CallExpression): string | null => {
  const callee = call.expression;
  if (ts.isIdentifier(callee)) return callee.text;
  if (ts.isPropertyAccessExpression(callee)) return callee.name.text;
  return null;
};

/** Every rounded reading folded into another figure in `source`. */
export function roundedFoldFindings(
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
  const flag = (node: ts.Node) => {
    const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line;
    findings.push(`${line + 1}: ${node.getText(sf)}`);
  };
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const name = calleeName(node);
      const folded =
        (name === "addConverted" &&
          ts.isPropertyAccessExpression(node.expression)) ||
        (name === "add" &&
          ts.isPropertyAccessExpression(node.expression) &&
          node.arguments.length === 3) ||
        name === "sumMoney";
      if (folded && node.arguments.some((arg) => readsSubtotal(arg))) {
        flag(node);
      } else if (
        name === "isNetSpending" &&
        node.arguments.some((arg) => readsSubtotal(arg) || callsRoundMoney(arg))
      ) {
        flag(node);
      }
    }
    if (
      ts.isBinaryExpression(node) &&
      (node.operatorToken.kind === ts.SyntaxKind.PlusEqualsToken ||
        node.operatorToken.kind === ts.SyntaxKind.MinusEqualsToken) &&
      readsSubtotal(node.right)
    ) {
      flag(node);
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

describe("a part folds into a total as its aggregate (INV-REPORT-005)", () => {
  it("never adds an aggregate's rounded reading into another figure", () => {
    const offenders = productionFiles().flatMap((rel) =>
      roundedFoldFindings(rel, readFileSync(join(SRC_ROOT, rel), "utf8")).map(
        (finding) => `${rel}:${finding}`,
      ),
    );
    if (offenders.length > 0) {
      throw new Error(
        "Fold a part into the figure above it with FxAggregate.merge / " +
          "mergeNegated (or FxAggregate.difference for a net) and read the " +
          "total once; judge a direction on agg.sign, never on a rounded " +
          "value (docs/specs/report-rounding-and-aggregation.md rules 2 and " +
          "5):\n  " +
          offenders.join("\n  "),
      );
    }
  });

  it("sees what it is meant to see, and not prose or a fold", () => {
    const flagged = roundedFoldFindings(
      "sample.ts",
      [
        "group.addConverted(cell.knownSubtotal);",
        "total.addConverted(-net.knownSubtotal);",
        "total.add(part.knownSubtotal, from, to);",
        "const t = sumMoney(rows.map((r) => r.agg.knownSubtotal));",
        "overall += agg.knownSubtotal;",
        "overall -= agg.unroundedSubtotal;",
        "if (!isNetSpending(roundMoney(overall))) continue;",
        "if (isNetSpending(agg.knownSubtotal)) keep();",
      ].join("\n"),
    );
    expect(flagged).toEqual([
      "1: group.addConverted(cell.knownSubtotal)",
      "2: total.addConverted(-net.knownSubtotal)",
      "3: total.add(part.knownSubtotal, from, to)",
      "4: sumMoney(rows.map((r) => r.agg.knownSubtotal))",
      "5: overall += agg.knownSubtotal",
      "6: overall -= agg.unroundedSubtotal",
      "7: isNetSpending(roundMoney(overall))",
      "8: isNetSpending(agg.knownSubtotal)",
    ]);

    const clean = roundedFoldFindings(
      "sample.ts",
      [
        "// group.addConverted(cell.knownSubtotal) in a comment",
        "/* overall += agg.knownSubtotal */",
        'const msg = "never sumMoney(rows.map((r) => r.knownSubtotal))";',
        "group.merge(cell);",
        "group.mergeNegated(cell);",
        "const net = FxAggregate.difference(income, expenses);",
        "if (isNetSpending(agg.sign)) keep();",
        "agg.addConverted(convert(row.total, row));",
        "const value = agg.knownSubtotal;",
        "const mean = roundMoney(agg.unroundedSubtotal / count);",
        "missing.add(pair);",
        "const t = sumMoney(values, MONEY_SCALE);",
      ].join("\n"),
    );
    expect(clean).toEqual([]);
  });
});
