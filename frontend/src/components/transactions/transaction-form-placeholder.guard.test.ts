import { describe, it, expect } from 'vitest';

/**
 * Guard for `docs/frontend/screens-and-dialogs.md`'s rule that a form dialog
 * opens at its full size. `TransactionForm` is loaded with `next/dynamic`, and a
 * host that passed no `loading` drew its Modal as a bare title bar until the
 * chunk arrived, then grew to the form's height. Every `dynamic()` import of
 * `TransactionForm` passes `loading: TransactionFormPlaceholder`.
 */
const sources = import.meta.glob('/src/**/*.tsx', {
  query: '?raw',
  eager: true,
  import: 'default',
}) as Record<string, string>;

/** The `dynamic(...)` call that starts at `start`, parentheses balanced. */
function dynamicCall(source: string, start: number): string {
  let depth = 0;
  for (let i = start; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === '(') depth += 1;
    else if (ch === ')') {
      depth -= 1;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  return source.slice(start);
}

describe('a lazily loaded TransactionForm reserves its height', () => {
  it('every dynamic() import of TransactionForm passes loading: TransactionFormPlaceholder', () => {
    const offenders: string[] = [];
    let hosts = 0;
    for (const [path, content] of Object.entries(sources)) {
      if (/\.test\.tsx$/.test(path)) continue;
      for (const match of content.matchAll(/\bdynamic\(/g)) {
        const call = dynamicCall(content, match.index + 'dynamic'.length);
        if (!call.includes("'@/components/transactions/TransactionForm'")) continue;
        hosts += 1;
        if (!/loading:\s*TransactionFormPlaceholder\b/.test(call)) {
          const line = content.slice(0, match.index).split('\n').length;
          offenders.push(`${path}:${line}`);
        }
      }
    }
    expect(hosts).toBeGreaterThan(0);
    expect(offenders).toEqual([]);
  });

  it('every dynamic() import of QuickAddDialog passes loading: QuickAddDialogPlaceholder', () => {
    const offenders: string[] = [];
    let hosts = 0;
    for (const [path, content] of Object.entries(sources)) {
      if (/\.test\.tsx$/.test(path)) continue;
      for (const match of content.matchAll(/\bdynamic\(/g)) {
        const call = dynamicCall(content, match.index + 'dynamic'.length);
        if (!call.includes("'@/components/transactions/quick-add/QuickAddDialog'")) continue;
        hosts += 1;
        if (!/loading:\s*QuickAddDialogPlaceholder\b/.test(call)) {
          const line = content.slice(0, match.index).split('\n').length;
          offenders.push(`${path}:${line}`);
        }
      }
    }
    expect(hosts).toBeGreaterThan(0);
    expect(offenders).toEqual([]);
  });
});
