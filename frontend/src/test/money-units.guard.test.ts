import { describe, it, expect } from 'vitest';
import ts from 'typescript';

/**
 * Guard: money is scaled to integer units on its decimal digits, never by a
 * float multiply (Discussion #2343). `Math.round(x * 10000)` misreads a large
 * amount: `300000000000.03 * 10000` is `3000000000000300.5` in doubles, so the
 * positive amount becomes `...301`, its negation `...300`, and two months that
 * cancel chart as 0.0001. Use `sumMoney(values, decimals)`, `roundMoney` /
 * `roundToDecimals`, or `toMoneyUnits` / `fromMoneyUnits` (`lib/format.ts`).
 *
 * Flagged: a `Math.round(...)` whose argument multiplies by ten thousand, by a
 * power of ten (`10 ** decimals`, `Math.pow(10, decimals)`), or by a constant
 * named like a scale (`SCALE`, `MONEY_UNITS`). Not flagged: a
 * percentage, which the same multiply builds and then divides by 100
 * (`Math.round(r * 10000) / 100`). The share count's 8dp rounding is
 * `investmentFold.guard.test.ts`'s subject: it lives in one file by rule. The
 * backend twin is `backend/src/common/money-units.guard.spec.ts`.
 */
const sources = import.meta.glob('/src/**/*.{ts,tsx}', {
  query: '?raw',
  eager: true,
  import: 'default',
}) as Record<string, string>;

/**
 * A constant named like a scale (`SCALE`, `MONEY_UNITS`). Case-sensitive: a
 * lowercase `scale` in this layer is an image's or a chart's, not money's.
 */
const SCALE_NAME = /UNITS|SCALE/;

const unwrap = (node: ts.Expression): ts.Expression =>
  ts.isParenthesizedExpression(node) ? unwrap(node.expression) : node;

const isNumber = (node: ts.Expression, value: number): boolean => {
  const inner = unwrap(node);
  return ts.isNumericLiteral(inner) && Number(inner.text) === value;
};

const isScale = (node: ts.Expression): boolean => {
  const inner = unwrap(node);
  if (ts.isNumericLiteral(inner)) return Number(inner.text) === 10_000;
  if (ts.isIdentifier(inner)) return SCALE_NAME.test(inner.text);
  // `10 ** 4`, `10 ** decimals`
  if (
    ts.isBinaryExpression(inner) &&
    inner.operatorToken.kind === ts.SyntaxKind.AsteriskAsteriskToken
  ) {
    return isNumber(inner.left, 10);
  }
  if (ts.isCallExpression(inner)) {
    const callee = inner.expression;
    // `Math.pow(10, decimals)`
    return (
      ts.isPropertyAccessExpression(callee) &&
      callee.expression.getText() === 'Math' &&
      callee.name.text === 'pow' &&
      inner.arguments.length > 0 &&
      isNumber(inner.arguments[0], 10)
    );
  }
  return false;
};

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

const isPercentage = (call: ts.CallExpression): boolean => {
  let parent: ts.Node = call.parent;
  while (ts.isParenthesizedExpression(parent)) parent = parent.parent;
  if (!ts.isBinaryExpression(parent)) return false;
  const divisor = unwrap(parent.right);
  return (
    parent.operatorToken.kind === ts.SyntaxKind.SlashToken &&
    ts.isNumericLiteral(divisor) &&
    Number(divisor.text) === 100
  );
};

/** Every float-scaled rounding in `source`, as `line: text`. */
function floatScaleFindings(fileName: string, source: string): string[] {
  const sf = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.ES2021,
    true,
    fileName.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const findings: string[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      node.expression.getText(sf) === 'Math.round' &&
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

describe('money is scaled to integer units on its decimal digits', () => {
  it('never rounds a float product of the money scale', () => {
    const offenders = Object.entries(sources)
      .filter(([path]) => !/\.test\.tsx?$/.test(path))
      .flatMap(([path, source]) =>
        floatScaleFindings(path, source).map((finding) => `${path}:${finding}`),
      );
    expect(
      offenders,
      'Sum money with sumMoney(values, decimals), round one value with ' +
        'roundMoney / roundToDecimals, or accumulate toMoneyUnits / ' +
        'fromMoneyUnits (lib/format.ts). Math.round(x * 10000) misreads a ' +
        'large amount (Discussion #2343).',
    ).toEqual([]);
  });

  it('sees what it is meant to see, and not prose or a percentage', () => {
    expect(
      floatScaleFindings(
        'sample.ts',
        [
          'const a = Math.round(x * 10000);',
          'const b = Math.round(x * 10_000) / 10_000;',
          'const c = Math.round((x - y) * 1e4);',
          'const d = Math.round(amount * rate * SCALE);',
          'const e = Math.round(10000 * x);',
          'const f = Math.round(x * 10 ** decimals);',
          'const g = Math.round(x * Math.pow(10, decimals));',
        ].join('\n'),
      ),
    ).toEqual([
      '1: Math.round(x * 10000)',
      '2: Math.round(x * 10_000)',
      '3: Math.round((x - y) * 1e4)',
      '4: Math.round(amount * rate * SCALE)',
      '5: Math.round(10000 * x)',
      '6: Math.round(x * 10 ** decimals)',
      '7: Math.round(x * Math.pow(10, decimals))',
    ]);

    expect(
      floatScaleFindings(
        'sample.tsx',
        [
          '// Math.round(x * 10000) in a comment',
          '/* Math.round(x * 10000) */',
          "const msg = 'never Math.round(x * 10000)';",
          'const pct = Math.round((spent / budgeted) * 10000) / 100;',
          'const cents = Math.round(x * 100) / 100;',
          'const units = toMoneyUnits(x, FIAT_MONEY_DECIMALS);',
          'const el = <span>{Math.round(share * 100)}</span>;',
          'const px = Math.round(image.width * scale);',
        ].join('\n'),
      ),
    ).toEqual([]);
  });
});
