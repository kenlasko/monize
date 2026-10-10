import { describe, it, expect } from 'vitest';

/**
 * A scheduled occurrence's money comes from the effective-amount contract, never
 * from the persisted scalar.
 *
 * Issue #1247 was one line copied into seven places:
 *
 *   const amount = st.nextOverride?.amount ?? st.amount;
 *
 * Each site read as obviously right, and every one of them disagreed with the
 * cash-flow forecast (and with the posting) by however much the exchange rate had
 * moved since the schedule was written. Prose in a `CLAUDE.md` would be read,
 * agreed with, and copied again, so the rule is a scan: any new occurrence of the
 * fingerprint fails here, and the fix is `nextOccurrenceEffectiveAmount(st)` from
 * `lib/scheduled-effective-amount.ts`.
 *
 * The scan covers `src/` rather than a single component, because the mistake is
 * mechanical and its next appearance will be in a file nobody thought to test.
 * Modelled on `src/test/ui-conventions.test.ts`, which walks the tree the same way.
 */
const sources = import.meta.glob('/src/**/*.{ts,tsx}', {
  query: '?raw',
  eager: true,
  import: 'default',
}) as Record<string, string>;

/** A line that is only a comment, wherever it sits in a block. */
function isComment(line: string): boolean {
  const trimmed = line.trimStart();
  return (
    trimmed.startsWith('//') ||
    trimmed.startsWith('*') ||
    trimmed.startsWith('/*')
  );
}

/** Source files only: tests legitimately contain the shape they assert on. */
function productionSources(): [string, string][] {
  return Object.entries(sources).filter(
    ([path]) => !/\.test\.tsx?$/.test(path),
  );
}

/**
 * The fallback shape, in the spacings people actually write: an `?? …amount`
 * whose left side reads an override's amount -- `nextOverride?.amount ?? x.amount`,
 * `override.amount ?? amount`, and so on.
 */
const PERSISTED_FALLBACK =
  /\b(?:next)?[Oo]verride\??\.amount\s*\?\?\s*[A-Za-z_$][\w$]*(?:\.[\w$]+)*\b/;

/**
 * Files allowed to compose an override amount with a base amount.
 *
 * `PostTransactionDialog` seeds the editable field of the POST form, which is the
 * write path: the number the user confirms is the number that gets stored, and a
 * plain schedule's `amount` is not re-priced by any exchange rate. Issue #1247
 * scopes itself to read models and says the posting path is unaffected.
 */
const ALLOWED = new Set([
  '/src/components/scheduled-transactions/PostTransactionDialog.tsx',
]);

/** The surfaces issue #1247 lists as affected, plus the shared helper's own users. */
const MIGRATED_SURFACES = [
  '/src/lib/scheduled-utils.ts',
  '/src/components/dashboard/UpcomingBills.tsx',
  '/src/components/budgets/BudgetUpcomingBills.tsx',
  '/src/components/reports/UpcomingBillsReport.tsx',
  '/src/components/accounts/shared/RecurringChargesPanel.tsx',
  '/src/components/scheduled-transactions/ScheduledTransactionList.tsx',
  '/src/app/bills/page.tsx',
];

/**
 * Files allowed to expand a recurrence in the browser, each with the reason it
 * cannot ask the server instead.
 *
 * Expansion belongs on the server (`GET /scheduled-transactions/occurrences`):
 * a client can derive dates but never per-occurrence amounts, which is how the
 * Upcoming Bills report came to print, total and export ONE schedule-level
 * figure against every occurrence it drew (issue #1247).
 */
const CLIENT_EXPANDERS = new Map([
  [
    '/src/lib/frequency.ts',
    'defines advanceByFrequency; steps a single date and knows nothing of occurrences',
  ],
  [
    '/src/components/scheduled-transactions/OccurrenceDatePicker.tsx',
    'offers the next N dates to attach an override to; the amount of each date of a loan bill comes from the server (getLoanOccurrences), never the template',
  ],
  [
    '/src/lib/forecast.ts',
    'the cash-flow forecast, which already resolves each occurrence against futureOverrides and the effective-amount contract; it is the surface the others were wrong against',
  ],
  [
    '/src/lib/scheduled-calendar.ts',
    'the shared month grid behind the bills calendar and the Upcoming Bills widget, which draws names on dates and prints no amount per occurrence',
  ],
  [
    '/src/lib/loan-overpayments.ts',
    'counts how many occurrences of a recurring OVERPAYMENT fall due by each amortization row. The cadence is one the user typed into the loan calculator, not a scheduled transaction, so there is no override to look up and no stored amount to re-price -- the amount is the one on screen',
  ],
]);

describe('scheduled occurrence expansion guard', () => {
  it('expands a recurrence only where a client has to', () => {
    const offenders: string[] = [];

    for (const [path, contents] of productionSources()) {
      if (CLIENT_EXPANDERS.has(path)) continue;
      const lines = contents.split('\n');
      lines.forEach((line, index) => {
        if (isComment(line)) return;
        if (!/advanceByFrequency\s*\(/.test(line)) return;
        const opensLoop = lines
          .slice(Math.max(0, index - 12), index)
          .some((prior) => /\b(while|for)\s*\(/.test(prior));
        if (opensLoop) offenders.push(`${path}:${index + 1}`);
      });
    }

    expect(offenders).toEqual([]);
  });

  it('every exemption still exists, so the list cannot go stale', () => {
    const paths = new Map(productionSources());
    for (const path of CLIENT_EXPANDERS.keys()) {
      expect(paths.has(path)).toBe(true);
    }
  });

  /**
   * An occurrence's kind is `occurrenceKind`, not a `scheduledKind({ amount: x ??
   * y })` composed at the call site. Two surfaces had written that expression out
   * with identical comments, and the shape hides a real trap: `Number(null)` is
   * 0, so an unpriceable bill classifies as a grey reminder.
   */
  it('composes an occurrence kind in exactly one place', () => {
    const KIND_COMPOSERS = new Set(['/src/lib/scheduled-kind.ts']);
    const offenders: string[] = [];

    for (const [path, contents] of productionSources()) {
      if (KIND_COMPOSERS.has(path)) continue;
      const lines = contents.split('\n');
      lines.forEach((line, index) => {
        if (isComment(line)) return;
        if (!/scheduledKind\s*\(\s*\{/.test(line)) return;
        // The amount argument may be on the following lines.
        const argument = lines.slice(index, index + 4).join(' ');
        if (/amount:[^,}]*\?\?/.test(argument)) {
          offenders.push(`${path}:${index + 1}`);
        }
      });
    }

    expect(offenders).toEqual([]);
  });

  /**
   * A standalone sign or colour helper that reads the SCHEDULE's amount is the
   * same defect wearing a function name.
   *
   * `RecurringChargesPanel` had `scheduledAmountClass(s)` and
   * `scheduledAmountSign(s)` keyed off `Number(s.amount) < 0` while printing
   * `nextOccurrenceEffectiveAmount(s)` beside them -- so an inflow of 20 rendered
   * as "-$20.00" in red. Importing the effective-amount helper is not proof of
   * migration; nothing may derive direction from the template in a file that
   * displays an occurrence's magnitude.
   */
  it('never derives a sign or colour from the schedule amount', () => {
    // The one place the fallback is allowed to live, and it takes the SERVER's
    // provable-sign answer rather than reaching for the template itself.
    const DIRECTION_DECIDERS = new Set(['/src/lib/scheduled-kind.ts']);
    const TEMPLATE_SIGN =
      /Number\(\s*\w+\??\.amount\s*\)[\s)]*[<>]|\w+\??\.amount\s*[<>]\s*0/;
    const offenders: string[] = [];

    for (const [path, contents] of productionSources()) {
      if (DIRECTION_DECIDERS.has(path)) continue;
      // Only the files that show an occurrence's own magnitude: elsewhere a
      // signed comparison is about a posted row, which is a different question.
      if (
        !/nextOccurrenceEffectiveAmount|scheduleEffectiveAmount|overrideEffectiveAmount|occurrenceKind/.test(
          contents,
        )
      ) {
        continue;
      }
      contents.split('\n').forEach((line, index) => {
        if (isComment(line)) return;
        if (TEMPLATE_SIGN.test(line)) offenders.push(`${path}:${index + 1}`);
      });
    }

    expect(offenders).toEqual([]);
  });

  it('bans a template-sign helper, and nothing correct', () => {
    const TEMPLATE_SIGN =
      /Number\(\s*\w+\??\.amount\s*\)[\s)]*[<>]|\w+\??\.amount\s*[<>]\s*0/;
    expect(TEMPLATE_SIGN.test("return Number(s.amount) < 0 ? '-' : '+';")).toBe(
      true,
    );
    expect(TEMPLATE_SIGN.test('if (st.amount < 0) return red;')).toBe(true);
    expect(
      TEMPLATE_SIGN.test('const kind = occurrenceKind(effective, st);'),
    ).toBe(false);
    expect(
      TEMPLATE_SIGN.test('formatCurrency(Math.abs(occurrence.amount))'),
    ).toBe(false);
  });

  it('bans the composed-kind shape, and nothing correct', () => {
    const composed = [
      'const kind = scheduledKind({',
      '  amount: getEffective(st).amount ?? Number(st.amount),',
      '  isTransfer: st.isTransfer,',
      '});',
    ].join(' ');
    const correct = 'const kind = scheduledKind({ amount: Number(st.amount) });';
    expect(/scheduledKind\s*\(\s*\{/.test(composed)).toBe(true);
    expect(/amount:[^,}]*\?\?/.test(composed)).toBe(true);
    expect(/amount:[^,}]*\?\?/.test(correct)).toBe(false);
  });

  /**
   * Import presence is not proof: the report imported the effective-amount helper
   * throughout the period it was applying one amount to every occurrence. What
   * makes it correct is that its dates AND amounts come from the same server
   * payload, so this asserts the call and the absence of a local expansion.
   */
  it('the Upcoming Bills report reads occurrences from the server', () => {
    const report = new Map(productionSources()).get(
      '/src/components/reports/UpcomingBillsReport.tsx',
    );
    expect(report).toBeDefined();
    expect(report).toContain('getOccurrences');
    expect(report).not.toContain('advanceByFrequency');
  });
});

describe('scheduled effective amount guard', () => {
  it('has files to scan', () => {
    // A scan whose subject list is empty passes for the wrong reason.
    expect(productionSources().length).toBeGreaterThan(200);
  });

  it('nothing falls back from an override amount to the persisted amount', () => {
    const offenders: string[] = [];

    for (const [path, contents] of productionSources()) {
      if (ALLOWED.has(path)) continue;
      contents.split('\n').forEach((line, index) => {
        // Comments quote the banned shape on purpose -- that is how the rule is
        // explained where it was broken. Only code counts.
        if (isComment(line)) return;
        if (PERSISTED_FALLBACK.test(line)) {
          offenders.push(`${path}:${index + 1}: ${line.trim()}`);
        }
      });
    }

    expect(offenders).toEqual([]);
  });

  it('bans the exact shape issue #1247 fixed, and nothing correct', () => {
    // Pinning the regex against the real strings, so a later tidy-up of it cannot
    // silently stop matching the shape it exists for.
    expect(
      PERSISTED_FALLBACK.test('const a = st.nextOverride?.amount ?? st.amount;'),
    ).toBe(true);
    expect(
      PERSISTED_FALLBACK.test('return override.amount ?? scheduled.amount;'),
    ).toBe(true);
    expect(
      PERSISTED_FALLBACK.test('return nextOverride?.amount ?? amount;'),
    ).toBe(true);
    expect(
      PERSISTED_FALLBACK.test(
        'const { amount } = nextOccurrenceEffectiveAmount(st);',
      ),
    ).toBe(false);
    // A comment quoting the shape is documentation, not a violation -- but the
    // same text in code still is.
    expect(isComment('  // never nextOverride?.amount ?? amount')).toBe(true);
    expect(isComment('  const a = nextOverride?.amount ?? amount;')).toBe(false);
  });

  it('every migrated surface still reads the shared resolver', () => {
    // A surface that stops importing it has either been deleted (update this
    // list, deliberately) or has gone back to deriving the amount itself.
    const paths = new Map(productionSources());
    const problems = MIGRATED_SURFACES.flatMap((path) => {
      const contents = paths.get(path);
      if (contents === undefined) return [`${path}: no such source file`];
      return contents.includes('scheduled-effective-amount')
        ? []
        : [`${path}: does not import lib/scheduled-effective-amount`];
    });

    expect(problems).toEqual([]);
  });

  it('the allowed exception still exists, so the exemption is not stale', () => {
    const paths = new Map(productionSources());
    for (const path of ALLOWED) {
      expect(paths.has(path)).toBe(true);
    }
  });

  /**
   * The amount is half the answer; the account is the other half.
   *
   * A scheduled investment's `accountId` is the BROKERAGE, and its cash settles
   * in the funding account or the brokerage's linked cash account. The dashboard
   * widget ran its below-zero projection on `accountMap.get(item.accountId)`, so
   * a purchase the funding account covers to the cent was reported as an
   * overdraft of the brokerage -- a balance the trade never moves -- while the
   * account that actually pays was left out of the projection entirely.
   *
   * The shape is `<map>.get(<x>.accountId)` in a file that resolves an
   * occurrence's amount, and it is the fingerprint rather than a variable name
   * because the alias is how it reappears. `occurrenceSettlementAccountId` is
   * the fix, and its two exemptions below each say why they address the
   * brokerage on purpose.
   */
  const ACCOUNT_ID_LOOKUP =
    /(?:\.(?:get|has)\(\s*|\[\s*)[A-Za-z_$][\w$]*\.accountId\b/;

  /** Files that address an account by `accountId` for a reason that is not a balance. */
  const ACCOUNT_ID_LOOKUP_ALLOWED = new Map([
    [
      '/src/lib/scheduled-effective-amount.ts',
      'defines occurrenceSettlementAccountId; the brokerage is where the linked cash account is read from',
    ],
    [
      '/src/lib/forecast.ts',
      "reads the brokerage's own currency for the settlement pair's `from` side; the account it charges comes from occurrenceSettlementAccountId",
    ],
  ]);

  it('no surface projects an occurrence onto the account it is filed under', () => {
    const offenders: string[] = [];

    for (const [path, contents] of productionSources()) {
      if (ACCOUNT_ID_LOOKUP_ALLOWED.has(path)) continue;
      if (!contents.includes('scheduled-effective-amount')) continue;
      contents.split('\n').forEach((line, index) => {
        if (isComment(line)) return;
        if (ACCOUNT_ID_LOOKUP.test(line)) {
          offenders.push(`${path}:${index + 1}: ${line.trim()}`);
        }
      });
    }

    expect(offenders).toEqual([]);
  });

  it('matches the shape the dashboard widget had, and not a settlement lookup', () => {
    expect(
      ACCOUNT_ID_LOOKUP.test('const account = accountMap.get(item.accountId);'),
    ).toBe(true);
    expect(
      ACCOUNT_ID_LOOKUP.test('if (!runningBalances.has(item.accountId)) {'),
    ).toBe(true);
    expect(ACCOUNT_ID_LOOKUP.test('const a = byId[tx.accountId];')).toBe(true);
    expect(
      ACCOUNT_ID_LOOKUP.test(
        'const account = accountMap.get(settlementAccountId);',
      ),
    ).toBe(false);
    expect(ACCOUNT_ID_LOOKUP.test('if (s.accountId === accountId) return;')).toBe(
      false,
    );
  });

  it('every allowed account lookup still exists, so no exemption is stale', () => {
    const paths = new Map(productionSources());
    for (const path of ACCOUNT_ID_LOOKUP_ALLOWED.keys()) {
      expect(paths.has(path)).toBe(true);
    }
  });
});
