import { describe, it, expect } from 'vitest';
import { blankComments } from './blank-comments';

/**
 * Guard: an amount in an account's currency is rounded and summed at that
 * currency's money precision (`docs/specs/money-precision.md`, INV-MONEY-001).
 *
 * Money is stored at eight places and rounded per currency: four for every
 * fiat currency, a coin's own places (eight for Bitcoin) for a coin. The
 * helpers in `lib/format.ts` take the precision as an argument and default to
 * the fiat four, so a call that passes nothing is correct for a fiat-only
 * figure and silently wrong for a coin wallet: a 2,500-satoshi network fee
 * (0.00002500 BTC) rounds to zero, a split editor reads a set as balanced
 * that the server refuses, and a running balance drops the fee.
 *
 * In the files listed below, every one of which handles an amount in an
 * account's currency, the following fail:
 *
 * - a `roundMoney` or `sumMoney` call with one argument: pass
 *   `moneyDecimalsForCurrency(code)` (or `moneyDecimalsFor(places)`) for an
 *   account-currency amount, or `FIAT_MONEY_DECIMALS` where the figure is
 *   fiat by construction (a reporting-currency total, an investment figure);
 * - a reference to `MONEY_DECIMALS`, the deprecated name of the fiat four;
 * - a literal ten thousand, the old integer scale of `decimal(20,4)`: sum with
 *   `sumMoney(values, decimals)` or accumulate in `toMoneyUnits` /
 *   `fromMoneyUnits` units.
 *
 * The baseline is shrink-only (`docs/guard-tests.md`): converting a file means
 * deleting its entry, never adding one.
 */
const sources = import.meta.glob('/src/**/*.{ts,tsx}', {
  query: '?raw',
  eager: true,
  import: 'default',
}) as Record<string, string>;

/** The account-currency paths (`docs/future-plans/money-precision.md` Phase 2A). */
const ACCOUNT_CURRENCY_FILES = [
  '/src/components/transactions/SplitEditor.tsx',
  '/src/components/transactions/SplitAmountFields.tsx',
  '/src/components/transactions/TransactionForm.tsx',
  '/src/components/transactions/split-rows.ts',
  '/src/components/scheduled-transactions/PostTransactionDialog.tsx',
  '/src/components/scheduled-transactions/ScheduledTransactionForm.tsx',
  '/src/components/scheduled-transactions/OverrideEditorDialog.tsx',
  '/src/components/dashboard/UpcomingBills.tsx',
  '/src/lib/forecast.ts',
  '/src/lib/minor-unit-booking.ts',
  '/src/lib/balance-history.ts',
  '/src/lib/running-balance.ts',
  '/src/lib/tagged-balance.ts',
  '/src/lib/fx-fees.ts',
  '/src/lib/fx-fees-csv.ts',
  '/src/components/reconcile/reconcile-rows.ts',
  '/src/app/reconcile/page.tsx',
  '/src/components/transactions/TransactionList.tsx',
  '/src/app/transactions/page.tsx',
  '/src/components/accounts/AccountForm.tsx',
  '/src/components/settings/bank-sync/BankSyncAccountRow.tsx',
  '/src/components/reports/ForeignCurrencyFeesReport.tsx',
  '/src/components/accounts/shared/ForeignCurrencyFeesSection.tsx',
  '/src/components/accounts/AccountRow.tsx',
  '/src/components/transactions/AccountBalancesBarChart.tsx',
] as const;

/**
 * Offenders recorded when the guard landed, per file. Shrink-only: a file
 * leaves this list when it is converted, and nothing is ever added to it.
 */
const BASELINE: Readonly<Record<string, number>> = {};

const CALL = /\b(roundMoney|sumMoney)\s*\(/g;
const DEPRECATED_NAME = /\bMONEY_DECIMALS\b/g;
const OLD_SCALE = /(?<![\w.])10_?000(?![\w.])/g;

/** 1-indexed line number of a character offset, for an offender report. */
function lineOf(source: string, index: number): number {
  return source.slice(0, index).split('\n').length;
}

/**
 * The number of top-level arguments of the call whose `(` is at `open`:
 * commas at depth one, ignoring strings and a trailing comma.
 */
function argumentCount(source: string, open: number): number {
  let depth = 0;
  let commas = 0;
  let quote: string | null = null;
  let lastSignificant = '';
  let sawArgument = false;
  for (let i = open; i < source.length; i++) {
    const ch = source[i];
    if (quote) {
      if (ch === '\\') i++;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      quote = ch;
      sawArgument = true;
      lastSignificant = ch;
      continue;
    }
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' || ch === ']' || ch === '}') {
      depth--;
      if (depth === 0) {
        const trailing = lastSignificant === ',' ? 1 : 0;
        return sawArgument ? commas + 1 - trailing : 0;
      }
    } else if (ch === ',' && depth === 1) commas++;
    if (depth >= 1 && !/\s/.test(ch) && i !== open) {
      sawArgument = true;
      lastSignificant = ch;
    }
  }
  return Number.NaN;
}

/** Every offence in `source`, as `line: reason` strings. */
function offences(source: string): string[] {
  const code = blankComments(source);
  const found: string[] = [];
  for (const match of code.matchAll(CALL)) {
    const index = match.index ?? 0;
    const before = code.slice(Math.max(0, index - 9), index);
    if (before.endsWith('function ')) continue;
    const open = index + match[0].length - 1;
    if (argumentCount(code, open) === 1) {
      found.push(`${lineOf(code, index)}: ${match[1]}() without a precision`);
    }
  }
  for (const match of code.matchAll(DEPRECATED_NAME)) {
    found.push(`${lineOf(code, match.index ?? 0)}: MONEY_DECIMALS`);
  }
  for (const match of code.matchAll(OLD_SCALE)) {
    found.push(`${lineOf(code, match.index ?? 0)}: literal ${match[0]} used as a money scale`);
  }
  return found;
}

describe('the money precision scan', () => {
  it('fails a one-argument call and passes one that states its precision', () => {
    expect(offences('const a = roundMoney(x);')).toHaveLength(1);
    expect(offences('const a = sumMoney(rows.map((r) => Number(r.amount)));')).toHaveLength(1);
    expect(offences('const a = roundMoney(roundMoney(x, d) - y);')).toHaveLength(1);
    expect(offences('const a = roundMoney(x, decimals);')).toEqual([]);
    expect(offences('const a = sumMoney([a, -b], moneyDecimalsForCurrency(code));')).toEqual([]);
    expect(offences('const a = roundMoney(\n  f(x, y),\n  d,\n);')).toEqual([]);
    expect(offences("const a = roundMoney(f('a,b'));")).toHaveLength(1);
  });

  it('fails the deprecated name and the old integer scale', () => {
    expect(offences('const d = MONEY_DECIMALS;')).toHaveLength(1);
    expect(offences('const c = Math.round(x * 10000) / 10000;')).toHaveLength(2);
    expect(offences('const SCALE = 10_000;')).toHaveLength(1);
    expect(offences('const t = 100000; const u = 1.10000;')).toEqual([]);
  });

  it('reads code, not the prose that explains it', () => {
    expect(offences('// roundMoney(x) and MONEY_DECIMALS and 10000\nconst a = 1;')).toEqual([]);
    expect(offences('/* sumMoney(values) */ const a = 1;')).toEqual([]);
    // A definition is not a call.
    expect(offences('export function roundMoney(value: number): number {}')).toEqual([]);
  });

  it('reports the line an offence is on', () => {
    expect(offences('const a = 1;\n// note\nconst b = roundMoney(a);')).toEqual([
      '3: roundMoney() without a precision',
    ]);
  });
});

describe('money precision on the account-currency paths', () => {
  it('scans every listed file', () => {
    const missing = ACCOUNT_CURRENCY_FILES.filter((path) => sources[path] === undefined);
    expect(missing).toEqual([]);
  });

  it('rounds and sums every account-currency amount at its currency\'s precision', () => {
    const failures: string[] = [];
    for (const path of ACCOUNT_CURRENCY_FILES) {
      const found = offences(sources[path] ?? '');
      const allowed = BASELINE[path] ?? 0;
      if (found.length > allowed) {
        failures.push(...found.map((offence) => `${path}:${offence}`));
      }
    }
    expect(
      failures,
      'Pass the currency\'s money precision: roundMoney(x, moneyDecimalsForCurrency(code)) / ' +
        'sumMoney(xs, decimals), or FIAT_MONEY_DECIMALS for a figure that is fiat by construction; ' +
        'never MONEY_DECIMALS or a literal ten-thousand scale (docs/specs/money-precision.md).',
    ).toEqual([]);
  });

  it('keeps the baseline shrink-only: no entry outlives its offences', () => {
    const stale = Object.entries(BASELINE).filter(
      ([path, count]) => offences(sources[path] ?? '').length < count,
    );
    expect(stale).toEqual([]);
  });
});
