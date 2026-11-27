import { describe, it, expect } from 'vitest';

/**
 * INV-CATEGORY-004 (READ), client side: "expense" is `type = 'expense'`, never
 * "not income" (`docs/specs/transfer-categories.md` sections 2 and 9).
 *
 * A category's type is `categoryType`; the API no longer sends the old
 * `isIncome` flag (#2478). Reading "not income" as "is it spending?" counts a
 * Transfer category as spending, so every read of a category's type goes through
 * `@/lib/category-type` (`categoryTypeOf`, `isIncomeCategory`,
 * `isExpenseCategory`, `isTransferCategory`, `signByCategoryType`). This scan
 * fails a new raw read, with no file allowlist.
 *
 * What it reads, outside tests and the helper:
 *   - a property read of `isIncome` on a receiver named like a category
 *     (`category`, `categories`, `cat`, `c`, `parent`, `child`);
 *   - a negated read, `!x.isIncome` or `x.isIncome === false`, on any receiver
 *     that is not a budget line.
 *
 * A budget line's `isIncome` is its own column with its own meaning (the line's
 * direction), and the budget screens speak of lines throughout, so the
 * receiver rules are off under `budgets/`. A line the rules do not fit carries
 * `income-flag-ok: <reason>` in a comment on it or the line above; the next
 * offender in the same file is still found. The scan reads names, not types:
 * it stops the slips the codebase has made, and the helper's tests hold the
 * behaviour.
 */
const sources = import.meta.glob(['/src/**/*.ts', '/src/**/*.tsx', '!/src/**/*.test.ts', '!/src/**/*.test.tsx'], {
  query: '?raw',
  eager: true,
  import: 'default',
}) as Record<string, string>;

const MARKER = 'income-flag-ok:';
const HELPER = '/src/lib/category-type.ts';
const BUDGET_LINE_RECEIVERS = new Set(['bc', 'bcEntry', 'line', 'budgetCategory']);

export interface Finding {
  file: string;
  line: number;
  rule: string;
  text: string;
}

function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:"'`\\])\/\/.*$/gm, '$1');
}

export function findRawIncomeReads(file: string, source: string): Finding[] {
  const budgetCode = /\/(budgets|budget)[/.-]|\/types\/budget\.ts$|\/lib\/budget/.test(file);
  const raw = source.split('\n');
  const code = stripComments(source).split('\n');
  const out: Finding[] = [];
  const add = (index: number, rule: string, text: string) => {
    const marked = raw[index].includes(MARKER) || (index > 0 && raw[index - 1].includes(MARKER));
    if (!marked) out.push({ file, line: index + 1, rule, text: text.trim() });
  };
  for (const [index, line] of code.entries()) {
    for (const m of line.matchAll(/\b(\w+)\??\.isIncome\b(\s*=(?!=))?/g)) {
      const receiver = m[1];
      // An assignment writes the flag; it does not read it.
      if (m[2]) continue;
      if (budgetCode || BUDGET_LINE_RECEIVERS.has(receiver)) continue;
      const before = line.slice(0, m.index);
      const after = line.slice((m.index ?? 0) + m[0].length);
      const negated = /!\s*[\w.?]*$/.test(before) || /^\s*(===\s*false|!==\s*true)/.test(after);
      if (negated || /^(category|categories|cat|c|parent|child|cc)$/.test(receiver)) {
        add(index, negated ? 'negated-read' : 'category-read', m[0]);
      }
    }
  }
  return out;
}

describe('a category type is read through the helper (INV-CATEGORY-004)', () => {
  it('finds no raw read of the legacy income flag outside the helper', () => {
    const findings = Object.entries(sources)
      .filter(([file]) => file !== HELPER && !file.startsWith('/src/test/'))
      .flatMap(([file, source]) => findRawIncomeReads(file, source));
    // A failure names `@/lib/category-type`; the baseline is empty and stays so.
    expect(findings.map((f) => `${f.file}:${f.line} [${f.rule}] ${f.text}`)).toEqual([]);
  });

  describe('the scan', () => {
    const scan = (code: string) => findRawIncomeReads('/src/x.ts', code);

    it.each([
      ['a negated category read', 'const spending = rows.filter((r) => !category.isIncome);'],
      ['a negated read of another shape', 'if (!row.isIncome) spend();'],
      ['a comparison with false', 'if (agg.isIncome === false) spend();'],
      ['a category read', 'const income = cat?.isIncome;'],
    ])('fails %s', (_name, code) => {
      expect(scan(code)).not.toEqual([]);
    });

    it.each([
      ['a budget line', 'if (!bc.isIncome) skip();'],
      ['a line named line', 'const income = line.isIncome;'],
      ['the helper', 'const income = isIncomeCategory(cat);'],
      ['an assignment', 'category.isIncome = true;'],
      ['a comment', '// the old flag, and !cat.isIncome, are gone'],
      ['a marked line', "// income-flag-ok: the report's own two sections\nconst x = !g.section.isIncome;"],
    ])('passes %s', (_name, code) => {
      expect(scan(code)).toEqual([]);
    });

    it('does not read under budgets/, where every receiver is a line', () => {
      expect(findRawIncomeReads('/src/components/budgets/X.tsx', 'const e = !c.isIncome;')).toEqual([]);
    });
  });
});
