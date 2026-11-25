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
 * holds fewer places than the accumulator), or a report figure's reading at
 * its currency's places, `knownSubtotalAt(places)` / `totalAt(places)`
 * (section 6, issue #2410):
 * - `agg.addConverted(...)` / `agg.add(...)`: fold the part with `merge` or
 *   `mergeNegated`;
 * - `sumMoney(...)`: fold the parts' aggregates instead;
 * - `x += ...` / `x -= ...`: accumulate in an `FxAggregate`;
 * - `a.knownSubtotal - b.knownSubtotal`, or a reading `+` / `-` anything: fold
 *   the two with `FxAggregate.difference` or `FxAggregate.sum` and read once (a
 *   sort comparator, which only orders rows, is exempt);
 * - `isNetSpending(...)` over a reading or a `roundMoney(...)`: judge the
 *   direction on `agg.sign`, before rounding (rule 5).
 * The scan reads the syntax tree, so a comment naming the pattern never trips
 * it.
 */

const SRC_ROOT = join(__dirname, "..");

const READINGS = new Set(["knownSubtotal", "unroundedSubtotal"]);

/** The readings that are method calls, taking the places to read at. */
const CALL_READINGS = new Set(["knownSubtotalAt", "totalAt"]);

/** `true` when `node` is `<x>.knownSubtotalAt(...)` or `<x>.totalAt(...)`. */
const isCallReading = (node: ts.Node): boolean =>
  ts.isCallExpression(node) &&
  ts.isPropertyAccessExpression(node.expression) &&
  CALL_READINGS.has(node.expression.name.text);

/** `true` when `node` reads an aggregate's subtotal anywhere inside it. */
const readsSubtotal = (node: ts.Node): boolean =>
  (ts.isPropertyAccessExpression(node) && READINGS.has(node.name.text)) ||
  isCallReading(node) ||
  ts.forEachChild(node, (child) => readsSubtotal(child) || undefined) === true;

/** `true` when `node` is itself a reading, under parentheses or a minus. */
const isReading = (node: ts.Expression): boolean => {
  if (ts.isParenthesizedExpression(node)) return isReading(node.expression);
  if (
    ts.isPrefixUnaryExpression(node) &&
    node.operator === ts.SyntaxKind.MinusToken
  ) {
    return isReading(node.operand);
  }
  return (
    (ts.isPropertyAccessExpression(node) && READINGS.has(node.name.text)) ||
    isCallReading(node)
  );
};

/** `true` when `node` sits in a function handed to a `.sort(...)` call. */
const inSortComparator = (node: ts.Node): boolean => {
  let fn: ts.Node | undefined = node.parent;
  while (fn && !ts.isFunctionLike(fn)) fn = fn.parent;
  const call = fn?.parent;
  return (
    !!call &&
    ts.isCallExpression(call) &&
    ts.isPropertyAccessExpression(call.expression) &&
    call.expression.name.text === "sort"
  );
};

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
    if (
      ts.isBinaryExpression(node) &&
      (node.operatorToken.kind === ts.SyntaxKind.PlusToken ||
        node.operatorToken.kind === ts.SyntaxKind.MinusToken) &&
      (isReading(node.left) || isReading(node.right)) &&
      !inSortComparator(node)
    ) {
      flag(node);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return findings;
}

/**
 * Every four-place reading (`.knownSubtotal`) in `source` outside a sort
 * comparator: in a report engine a figure is read at its currency's places,
 * `knownSubtotalAt(places)`, so a `knownSubtotal` there hands a reader a
 * figure the screen rounds a second time (section 6, issue #2410).
 */
export function fourPlaceReadingFindings(
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
  const visit = (node: ts.Node): void => {
    if (
      ts.isPropertyAccessExpression(node) &&
      node.name.text === "knownSubtotal" &&
      !inSortComparator(node)
    ) {
      const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line;
      findings.push(`${line + 1}: ${node.getText(sf)}`);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return findings;
}

/**
 * The report engines, whose every figure is a report figure: the built-in
 * reports (the Sankey among them) and the custom report. A surface elsewhere
 * that hands out a report figure (the budget reports, the monthly net worth,
 * the assistant's tools) reads at its places too, beside readings that are not
 * report figures, so it is held by its specs rather than by this scan.
 */
const REPORT_ENGINE_DIRS = ["built-in-reports", "reports"];

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

  it("reads every figure of a report engine at its currency's places (issue #2410)", () => {
    const offenders = REPORT_ENGINE_DIRS.flatMap((dir) =>
      productionFiles(join(SRC_ROOT, dir)).flatMap((rel) =>
        fourPlaceReadingFindings(
          rel,
          readFileSync(join(SRC_ROOT, rel), "utf8"),
        ).map((finding) => `${rel}:${finding}`),
      ),
    );
    if (offenders.length > 0) {
      throw new Error(
        "A report figure is read once at its currency's places: " +
          "agg.knownSubtotalAt(places) / agg.totalAt(places), or " +
          "reportFigure(value, places) for a figure that is not an " +
          "aggregate, with places from ReportCurrencyService.getReportPlaces " +
          "(docs/specs/report-rounding-and-aggregation.md section 6):\n  " +
          offenders.join("\n  "),
      );
    }
  });

  it("flags a four-place reading, and not a sort or a reading at places", () => {
    expect(
      fourPlaceReadingFindings(
        "sample.ts",
        [
          "const total = agg.knownSubtotal;",
          "rows.sort((a, b) => b.agg.knownSubtotal - a.agg.knownSubtotal);",
          "const shown = agg.knownSubtotalAt(places);",
          "// agg.knownSubtotal in a comment",
          "return { total: group.agg.knownSubtotal };",
        ].join("\n"),
      ),
    ).toEqual(["1: agg.knownSubtotal", "5: group.agg.knownSubtotal"]);
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
        "const net = roundMoney(a.knownSubtotal - b.knownSubtotal);",
        "const gain = value.knownSubtotal - cost;",
        "const both = (x.unroundedSubtotal) + -(y.knownSubtotal);",
        "group.addConverted(cell.knownSubtotalAt(places));",
        "overall += agg.totalAt(2) ?? 0;",
        "const t = sumMoney(rows.map((r) => r.agg.knownSubtotalAt(2)), 2);",
        "const net = a.knownSubtotalAt(places) - b.knownSubtotalAt(places);",
        "if (isNetSpending(agg.knownSubtotalAt(places))) keep();",
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
      "9: a.knownSubtotal - b.knownSubtotal",
      "10: value.knownSubtotal - cost",
      "11: (x.unroundedSubtotal) + -(y.knownSubtotal)",
      "12: group.addConverted(cell.knownSubtotalAt(places))",
      "13: overall += agg.totalAt(2) ?? 0",
      "14: sumMoney(rows.map((r) => r.agg.knownSubtotalAt(2)), 2)",
      "15: a.knownSubtotalAt(places) - b.knownSubtotalAt(places)",
      "16: isNetSpending(agg.knownSubtotalAt(places))",
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
        "rows.sort((a, b) => b.agg.knownSubtotal - a.agg.knownSubtotal);",
        "rows.sort(function (a, b) { return b.knownSubtotal - a.knownSubtotal; });",
        "const share = (part.unroundedSubtotal / whole.unroundedSubtotal) * 100;",
        "const total = readSubtotal(units) + this.nonFiniteSum;",
        "const value = agg.knownSubtotalAt(places);",
        "const total = agg.totalAt(places);",
        "rows.sort((a, b) => b.agg.knownSubtotalAt(2) - a.agg.knownSubtotalAt(2));",
      ].join("\n"),
    );
    expect(clean).toEqual([]);
  });
});
