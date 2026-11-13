import { describe, it, expect } from 'vitest';
import {
  estimateAmountOn,
  estimateEntryOn,
  estimatedOccurrenceAmount,
  nextOccurrenceEffectiveAmount,
  occurrenceFollowsEstimate,
  occurrenceAccountIds,
  occurrencePin,
  occurrenceSettlementAccountId,
  occurrenceTouchesAccounts,
  overrideEffectiveAmount,
  scheduleEffectiveAmount,
  sumEffectiveOccurrences,
} from './scheduled-effective-amount';
import { isComplete } from './currency-total';
import type {
  ScheduledTransaction,
  ScheduledTransactionOverride,
} from '@/types/scheduled-transaction';

/**
 * The client half of the effective-amount contract (issue #1247). The numbers are
 * the issue's worked example: 10 shares at 100, pinned at 1.50 while the security
 * was priced in EUR (so the persisted amount implies 1,500 CAD), re-priced to
 * 1,350 CAD once the security became USD at 1.35.
 *
 * Every case also asserts what must NOT come back, because the defect is a
 * plausible number rather than an error.
 */
describe('scheduled effective amounts', () => {
  const plain = (overrides: Partial<ScheduledTransaction> = {}) =>
    ({
      id: 'st-plain',
      amount: -1200,
      currencyCode: 'CAD',
      isInvestment: false,
      isSplit: false,
      isTransfer: false,
      ...overrides,
    }) as ScheduledTransaction;

  const investment = (overrides: Partial<ScheduledTransaction> = {}) =>
    ({
      id: 'st-inv',
      // The security-currency cash impact, at the account's own currency code.
      amount: -1000,
      currencyCode: 'CAD',
      isInvestment: true,
      isSplit: false,
      isTransfer: false,
      ...overrides,
    }) as ScheduledTransaction;

  const override = (
    overrides: Partial<ScheduledTransactionOverride> = {},
  ) =>
    ({
      id: 'ovr-1',
      scheduledTransactionId: 'st-plain',
      originalDate: '2026-09-01',
      overrideDate: '2026-09-03',
      amount: null,
      ...overrides,
    }) as ScheduledTransactionOverride;

  describe('scheduleEffectiveAmount', () => {
    it('reads the server figure and its settlement currency', () => {
      expect(
        scheduleEffectiveAmount(
          investment({
            effectiveAmount: -1350,
            effectiveAmountComplete: true,
            effectiveCurrencyCode: 'CAD',
          }),
        ),
      ).toEqual({ amount: -1350, currencyCode: 'CAD', complete: true });
    });

    it('reports an explicit null as unknown, never as the persisted amount', () => {
      const result = scheduleEffectiveAmount(
        investment({
          effectiveAmount: null,
          effectiveAmountComplete: false,
          effectiveCurrencyCode: 'CAD',
        }),
      );

      expect(result.amount).toBeNull();
      expect(result.complete).toBe(false);
      expect(result.amount).not.toBe(-1000);
    });

    it('keeps a plain schedule on its stored amount', () => {
      expect(scheduleEffectiveAmount(plain({ effectiveAmount: -1200 }))).toEqual(
        { amount: -1200, currencyCode: 'CAD', complete: true },
      );
    });

    // A rolling deploy serves some responses from a backend that predates the
    // field. Absent is "no information", so it is read as unknown for anything
    // an exchange rate re-prices and as the stored amount for everything else --
    // the same split `lib/forecast.ts` makes.
    describe('when the server did not send the field (older backend)', () => {
      it('treats a top-level investment schedule as unknown', () => {
        const result = scheduleEffectiveAmount(investment());

        expect(result.amount).toBeNull();
        expect(result.complete).toBe(false);
      });

      it('treats a split parent with an investment line as unknown', () => {
        const result = scheduleEffectiveAmount(
          plain({
            isSplit: true,
            splits: [
              { kind: 'investment', investmentAction: 'BUY' },
            ] as never,
          }),
        );

        expect(result.amount).toBeNull();
        expect(result.complete).toBe(false);
      });

      it('keeps a plain schedule known', () => {
        expect(scheduleEffectiveAmount(plain())).toEqual({
          amount: -1200,
          currencyCode: 'CAD',
          complete: true,
        });
      });

      it('keeps a split parent with no investment line known', () => {
        const result = scheduleEffectiveAmount(
          plain({
            isSplit: true,
            splits: [{ kind: 'category', amount: -1200 }] as never,
          }),
        );

        expect(result).toEqual({
          amount: -1200,
          currencyCode: 'CAD',
          complete: true,
        });
      });
    });
  });

  describe('overrideEffectiveAmount', () => {
    it('reads the override figure the server resolved', () => {
      const result = overrideEffectiveAmount(
        investment({
          effectiveAmount: -1350,
          effectiveAmountComplete: true,
          effectiveCurrencyCode: 'CAD',
        }),
        override({ effectiveAmount: -675, effectiveAmountComplete: true }),
      );

      expect(result).toEqual({
        amount: -675,
        currencyCode: 'CAD',
        complete: true,
      });
    });

    it('reports an unknown override as unknown', () => {
      const result = overrideEffectiveAmount(
        investment({ effectiveAmount: null, effectiveAmountComplete: false }),
        override({ effectiveAmount: null, effectiveAmountComplete: false }),
      );

      expect(result.amount).toBeNull();
      expect(result.complete).toBe(false);
    });

    it('falls through to the base occurrence for a date-only override', () => {
      const schedule = plain({ effectiveAmount: -1200 });

      expect(
        overrideEffectiveAmount(schedule, override({ amount: null })),
      ).toEqual(scheduleEffectiveAmount(schedule));
    });

    it('uses a non-investment override stored amount on an older backend', () => {
      expect(
        overrideEffectiveAmount(plain(), override({ amount: -1350 })),
      ).toEqual({ amount: -1350, currencyCode: 'CAD', complete: true });
    });
  });

  describe('nextOccurrenceEffectiveAmount', () => {
    it('prefers the next override over the base occurrence', () => {
      const result = nextOccurrenceEffectiveAmount(
        plain({
          effectiveAmount: -1200,
          nextOverride: override({ effectiveAmount: -1350 }),
        }),
      );

      expect(result.amount).toBe(-1350);
    });

    it('uses the base occurrence when there is no override', () => {
      expect(
        nextOccurrenceEffectiveAmount(plain({ effectiveAmount: -1200 })).amount,
      ).toBe(-1200);
    });
  });

  describe('occurrencePin', () => {
    it('is the slot and no override when none governs the occurrence', () => {
      expect(
        occurrencePin(plain({ nextDueDate: '2026-09-01T00:00:00.000Z' })),
      ).toEqual({ expectedOccurrenceDate: '2026-09-01', expectedOverrideId: null });
    });

    it('is the override date and the override id when an override moved the occurrence', () => {
      expect(
        occurrencePin(
          plain({
            nextDueDate: '2026-09-01',
            nextOverride: override({ id: 'ovr-7', overrideDate: '2026-09-03' }),
          }),
        ),
      ).toEqual({ expectedOccurrenceDate: '2026-09-03', expectedOverrideId: 'ovr-7' });
    });

    it('carries the override id when the override kept the slot date', () => {
      expect(
        occurrencePin(
          plain({
            nextDueDate: '2026-09-01',
            nextOverride: override({ id: 'ovr-8', overrideDate: '2026-09-01' }),
          }),
        ),
      ).toEqual({ expectedOccurrenceDate: '2026-09-01', expectedOverrideId: 'ovr-8' });
    });

    it('treats an absent nextOverride as no override', () => {
      expect(
        occurrencePin(plain({ nextDueDate: '2026-09-01', nextOverride: undefined })),
      ).toEqual({ expectedOccurrenceDate: '2026-09-01', expectedOverrideId: null });
    });
  });

  describe('sumEffectiveOccurrences', () => {
    const at = (amount: number, currencyCode = 'CAD') => ({
      amount,
      currencyCode,
      complete: true,
    });
    const unknown = { amount: null, currencyCode: 'CAD', complete: false };
    /** A converter that knows exactly one pair, so a second currency is a gap. */
    const cadOnly = (amount: number, from: string) =>
      from === 'CAD' ? amount : null;
    const identity = (amount: number) => amount;

    it('totals a complete single-currency set', () => {
      const result = sumEffectiveOccurrences(
        [at(-1200), at(-1350)],
        (x) => x,
        cadOnly,
        Math.abs,
      );

      expect(result.value).toBe(2550);
      expect(isComplete(result)).toBe(true);
    });

    it('converts before summing, so currencies cannot be added as numbers', () => {
      // 1,350 CAD at 0.74 is 999 USD; beside a 500 USD bill the answer is 1,499
      // USD, not the 1,850 an adder that ignored the currency produced.
      const toUsd = (amount: number, from: string) =>
        from === 'USD' ? amount : amount * 0.74;
      const result = sumEffectiveOccurrences(
        [at(-1350, 'CAD'), at(-500, 'USD')],
        (x) => x,
        toUsd,
        Math.abs,
      );

      expect(result.value).toBe(1499);
      expect(result.value).not.toBe(1850);
      expect(isComplete(result)).toBe(true);
    });

    it('withholds the total when a rate is missing, and names the currency', () => {
      const result = sumEffectiveOccurrences(
        [at(-1200, 'CAD'), at(-500, 'USD')],
        (x) => x,
        cadOnly,
        Math.abs,
      );

      expect(isComplete(result)).toBe(false);
      expect(result.value).toBe(1200);
      expect(result.missingCurrencies).toEqual(['USD']);
      expect(result.excludedCount).toBe(1);
    });

    it('excludes an unpriceable occurrence by count, with no currency to blame', () => {
      // Its own settlement rate is what is missing, so it is unknown in every
      // currency -- naming CAD would send the reader to fix the wrong rate.
      const result = sumEffectiveOccurrences(
        [at(-1200), unknown],
        (x) => x,
        cadOnly,
        Math.abs,
      );

      expect(isComplete(result)).toBe(false);
      expect(result.value).toBe(1200);
      expect(result.missingCurrencies).toEqual([]);
      expect(result.excludedCount).toBe(1);
    });

    it('totals an empty set as a known zero, not as unknown', () => {
      // Nothing upcoming is a settled answer; reporting it as unknown would take
      // a question the user can act on away from them.
      const result = sumEffectiveOccurrences([], (x: never) => x, cadOnly);

      expect(result.value).toBe(0);
      expect(isComplete(result)).toBe(true);
    });

    it('accumulates in integer ten-thousandths, so cents do not drift', () => {
      const result = sumEffectiveOccurrences(
        [at(0.1), at(0.2)],
        (x) => x,
        cadOnly,
        identity,
      );

      expect(result.value).toBe(0.3);
    });
  });
});

describe('occurrenceSettlementAccountId', () => {
  const accounts = new Map([
    ['acc-brokerage', { linkedAccountId: 'acc-cash' }],
    ['acc-lonely-brokerage', { linkedAccountId: null }],
    ['acc-cash', { linkedAccountId: null }],
    ['acc-chequing', { linkedAccountId: null }],
  ]);

  const schedule = (overrides: Partial<ScheduledTransaction>) =>
    ({
      id: 'st-1',
      amount: -5000,
      currencyCode: 'CAD',
      accountId: 'acc-brokerage',
      isInvestment: true,
      ...overrides,
    }) as unknown as ScheduledTransaction;

  it('takes the server answer, which is the decision the posting makes', () => {
    expect(
      occurrenceSettlementAccountId(
        schedule({
          settlementAccountId: 'acc-chequing',
          investmentFundingAccountId: 'acc-cash',
        }),
        accounts,
      ),
    ).toBe('acc-chequing');
  });

  it('never charges the brokerage a trade only files against it', () => {
    // The defect in one line: `accountId` is where the schedule LIVES, not where
    // its cash comes from.
    const st = schedule({ settlementAccountId: 'acc-cash' });

    expect(occurrenceSettlementAccountId(st, accounts)).not.toBe(st.accountId);
    expect(occurrenceSettlementAccountId(st, accounts)).toBe('acc-cash');
  });

  it('falls back to the named funding account when the server did not say', () => {
    expect(
      occurrenceSettlementAccountId(
        schedule({ investmentFundingAccountId: 'acc-chequing' }),
        accounts,
      ),
    ).toBe('acc-chequing');
  });

  it("falls back to the brokerage's linked cash account after that", () => {
    expect(occurrenceSettlementAccountId(schedule({}), accounts)).toBe(
      'acc-cash',
    );
  });

  it('answers undefined rather than naming the brokerage it cannot resolve', () => {
    // Undefined means "not identifiable from what the client holds", and a
    // caller projects nothing. Returning `accountId` here would be the defect
    // wearing the helper's name.
    expect(
      occurrenceSettlementAccountId(
        schedule({ accountId: 'acc-lonely-brokerage' }),
        accounts,
      ),
    ).toBeUndefined();
  });

  it('leaves a non-investment schedule on its own account', () => {
    expect(
      occurrenceSettlementAccountId(
        schedule({ accountId: 'acc-chequing', isInvestment: false }),
        accounts,
      ),
    ).toBe('acc-chequing');
  });
});

describe('the accounts an occurrence touches', () => {
  const accountsById = new Map([
    ['brokerage-1', { linkedAccountId: 'sleeve-1' }],
    ['sleeve-1', { linkedAccountId: null }],
    ['chequing-1', { linkedAccountId: null }],
    ['savings-1', { linkedAccountId: null }],
  ]);

  const bill = (overrides: Partial<ScheduledTransaction> = {}) =>
    ({
      id: 'st-bill',
      amount: -1200,
      currencyCode: 'CAD',
      accountId: 'chequing-1',
      isInvestment: false,
      isSplit: false,
      isTransfer: false,
      ...overrides,
    }) as ScheduledTransaction;

  const occurrence = (transferAccountId: string | null = null) => ({
    transferAccountId,
  });

  it('names the account a plain bill settles in', () => {
    expect(occurrenceAccountIds(occurrence(), bill(), accountsById)).toEqual([
      'chequing-1',
    ]);
  });

  it('names both legs of a transfer', () => {
    expect(
      occurrenceAccountIds(occurrence('savings-1'), bill({ isTransfer: true }), accountsById),
    ).toEqual(['chequing-1', 'savings-1']);
  });

  it('names the settlement account of an investment schedule, never the brokerage', () => {
    // INV-OCCURRENCE-003: the brokerage is where the security lands; the cash
    // leaves the funding account. A calendar filtered to the funding account
    // that read accountId would leave out a purchase draining it.
    const schedule = bill({
      accountId: 'brokerage-1',
      isInvestment: true,
      investmentFundingAccountId: 'chequing-1',
    });

    const ids = occurrenceAccountIds(occurrence(), schedule, accountsById);

    expect(ids).toEqual(['chequing-1']);
    expect(ids).not.toContain('brokerage-1');
  });

  it('falls to the brokerage linked cash sleeve when no funding account is named', () => {
    const schedule = bill({ accountId: 'brokerage-1', isInvestment: true });
    expect(occurrenceAccountIds(occurrence(), schedule, accountsById)).toEqual(['sleeve-1']);
  });

  it("prefers the server's settlement account over anything derived", () => {
    const schedule = bill({
      accountId: 'brokerage-1',
      isInvestment: true,
      investmentFundingAccountId: 'chequing-1',
      settlementAccountId: 'savings-1',
    });
    expect(occurrenceAccountIds(occurrence(), schedule, accountsById)).toEqual(['savings-1']);
  });

  it('names no account when an investment settlement cannot be identified', () => {
    // Naming the brokerage here would charge an account whose cash never moves.
    const schedule = bill({ accountId: 'unknown-brokerage', isInvestment: true });
    expect(occurrenceAccountIds(occurrence(), schedule, accountsById)).toEqual([]);
  });

  it('is in scope when any account it touches is', () => {
    const transfer = bill({ isTransfer: true });

    expect(
      occurrenceTouchesAccounts(occurrence('savings-1'), transfer, accountsById, new Set(['savings-1'])),
    ).toBe(true);
    expect(
      occurrenceTouchesAccounts(occurrence('savings-1'), transfer, accountsById, new Set(['chequing-1'])),
    ).toBe(true);
    expect(
      occurrenceTouchesAccounts(occurrence('savings-1'), transfer, accountsById, new Set(['other-1'])),
    ).toBe(false);
  });

  it('is in no scope when it touches no account this client can name', () => {
    const schedule = bill({ accountId: 'unknown-brokerage', isInvestment: true });
    expect(
      occurrenceTouchesAccounts(occurrence(), schedule, accountsById, new Set(['chequing-1'])),
    ).toBe(false);
  });
});

describe('estimated amounts (issue #2096)', () => {
  const estimated = (overrides: Partial<ScheduledTransaction> = {}) =>
    ({
      id: 'st-heat',
      amount: -999,
      currencyCode: 'CAD',
      isInvestment: false,
      isSplit: false,
      isTransfer: false,
      amountIsEstimated: true,
      amountEstimate: {
        status: 'estimated',
        currencyCode: 'CAD',
        months: { '2025-02': { amount: -220, basis: 'seasonal' } },
        paymentCount: 3,
        latestPaymentDate: '2025-01-10',
        growthRate: null,
        historyMonths: 24,
        missingPair: null,
      },
      ...overrides,
    }) as ScheduledTransaction;

  it("reads the month's estimate, never the snapshot", () => {
    expect(estimatedOccurrenceAmount(estimated(), '2025-02-10')).toBe(-220);
    // A month the estimate does not hold is unknown, not -999.
    expect(estimatedOccurrenceAmount(estimated(), '2025-09-10')).toBeNull();
    expect(
      estimatedOccurrenceAmount(estimated({ amountEstimate: null }), '2025-02-10'),
    ).toBeNull();
  });

  it('is undefined for a schedule that does not estimate', () => {
    expect(
      estimatedOccurrenceAmount(estimated({ amountIsEstimated: false }), '2025-02-10'),
    ).toBeUndefined();
    expect(occurrenceFollowsEstimate(estimated({ amountIsEstimated: undefined }))).toBe(false);
  });

  it('lets an override that states an amount or lines govern its occurrence', () => {
    const st = estimated();
    expect(occurrenceFollowsEstimate(st)).toBe(true);
    expect(occurrenceFollowsEstimate(st, { amount: null, isSplit: null })).toBe(true);
    expect(occurrenceFollowsEstimate(st, { amount: -250, isSplit: null })).toBe(false);
    expect(occurrenceFollowsEstimate(st, { amount: null, isSplit: true })).toBe(false);
  });

  it('reads a preview estimate by month', () => {
    expect(estimateAmountOn(estimated().amountEstimate, '2025-02-28')).toBe(-220);
    expect(estimateAmountOn(null, '2025-02-28')).toBeNull();
  });

  describe("a transfer's balance floors (issue #2164)", () => {
    // The card's statement closed on Feb 5 owing 2700; the open cycle owes 300.
    const transfer = () =>
      estimated({
        isTransfer: true,
        amountEstimate: {
          status: 'estimated',
          currencyCode: 'CAD',
          months: {
            '2025-02': { amount: -2000, basis: 'recent' },
            '2025-03': { amount: -2000, basis: 'recent' },
            '2025-04': { amount: -2000, basis: 'recent' },
          },
          paymentCount: 3,
          latestPaymentDate: '2025-01-26',
          growthRate: null,
          historyMonths: 24,
          missingPair: null,
          floors: [
            {
              after: '2025-02-05',
              through: '2025-03-05',
              months: {
                '2025-02': { amount: -2700, basis: 'balance' },
                '2025-03': { amount: -2700, basis: 'balance' },
              },
            },
            {
              after: '2025-03-05',
              through: '2025-04-05',
              months: {
                '2025-03': { amount: -2000, basis: 'recent' },
                '2025-04': { amount: -2000, basis: 'recent' },
              },
            },
          ],
        },
      });

    it('reads a date a floor governs from the floor, as the server prices it', () => {
      expect(estimatedOccurrenceAmount(transfer(), '2025-02-26')).toBe(-2700);
      expect(estimateEntryOn(transfer().amountEstimate, '2025-02-26')?.basis).toBe('balance');
      // The floor's bounds: after Feb 5, through Mar 5.
      expect(estimatedOccurrenceAmount(transfer(), '2025-02-05')).toBe(-2000);
      expect(estimatedOccurrenceAmount(transfer(), '2025-03-05')).toBe(-2700);
      expect(estimatedOccurrenceAmount(transfer(), '2025-03-26')).toBe(-2000);
    });

    it('reads the plain month past every floor', () => {
      expect(estimatedOccurrenceAmount(transfer(), '2025-04-26')).toBe(-2000);
      expect(estimateEntryOn(transfer().amountEstimate, '2025-04-26')?.basis).toBe('recent');
    });

    it('reads the months alone from a server that sends no floors', () => {
      const st = transfer();
      const { floors: _floors, ...older } = st.amountEstimate!;
      expect(estimateAmountOn(older, '2025-02-26')).toBe(-2000);
    });
  });
});
