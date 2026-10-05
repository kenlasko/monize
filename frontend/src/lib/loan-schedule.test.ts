import { describe, it, expect } from 'vitest';
import {
  DEFAULT_MAX_PROJECTION_YEARS,
  ScheduleFrequency,
  advanceDate,
  buildRateTimeline,
  resolveEffectiveLoanTerms,
  calculateMortgagePaymentAmount,
  calculatePaymentForTerm,
  compareSchedules,
  effectiveAnnualRate,
  effectiveAnnualRateOn,
  generateLoanSchedule,
  getPeriodicRate,
  getPeriodsPerYear,
  maxPaymentsForHorizon,
  recurringOccurrencesDue,
  LoanScheduleInput,
  RecurringOverpaymentFrequency,
} from './loan-schedule';
import { MORTGAGE_TYPES } from '@/types/account';

function baseInput(overrides: Partial<LoanScheduleInput> = {}): LoanScheduleInput {
  return {
    startingBalance: 10000,
    annualRate: 6,
    paymentAmount: 500,
    frequency: 'MONTHLY',
    firstPaymentDate: new Date(2026, 0, 15),
    ...overrides,
  };
}

describe('getPeriodsPerYear', () => {
  it('maps every frequency to its period count', () => {
    expect(getPeriodsPerYear('WEEKLY')).toBe(52);
    expect(getPeriodsPerYear('ACCELERATED_WEEKLY')).toBe(52);
    expect(getPeriodsPerYear('BIWEEKLY')).toBe(26);
    expect(getPeriodsPerYear('ACCELERATED_BIWEEKLY')).toBe(26);
    expect(getPeriodsPerYear('SEMI_MONTHLY')).toBe(24);
    expect(getPeriodsPerYear('MONTHLY')).toBe(12);
    expect(getPeriodsPerYear('QUARTERLY')).toBe(4);
    expect(getPeriodsPerYear('YEARLY')).toBe(1);
  });

  it('defaults to monthly for unknown frequencies', () => {
    expect(getPeriodsPerYear('UNKNOWN' as ScheduleFrequency)).toBe(12);
  });
});

describe('getPeriodicRate', () => {
  // Parity fixtures with backend mortgage-amortization.util.spec.ts
  it('uses semi-annual compounding for Canadian fixed-rate mortgages', () => {
    const expected = Math.pow(1 + 0.05 / 2, 2 / 12) - 1;
    expect(getPeriodicRate(5, 12, 'CANADIAN_FIXED')).toBeCloseTo(expected, 10);
  });

  it('uses semi-annual compounding for Canadian fixed biweekly payments', () => {
    const expected = Math.pow(1 + 0.05 / 2, 2 / 26) - 1;
    expect(getPeriodicRate(5, 26, 'CANADIAN_FIXED')).toBeCloseTo(expected, 10);
  });

  it('uses simple division for non-Canadian loans', () => {
    expect(getPeriodicRate(6, 12, 'ANNUITY')).toBeCloseTo(0.005, 10);
    expect(getPeriodicRate(6, 26, 'ANNUITY')).toBeCloseTo(6 / 100 / 26, 10);
  });

  it('is the nominal convention, not monthly compounding converted', () => {
    // The convention is named in docs/financial-semantics.md section 9: the
    // quoted rate is nominal, compounded at the payment frequency. Backend
    // parity cannot prove this (both layers mirror one formula), so the
    // alternative contract is spelled out here and asserted to be a DIFFERENT
    // number -- otherwise a future change to either convention would look like
    // agreement.
    const monthlyEquivalentBiweekly = Math.pow(1 + 0.06 / 12, 12 / 26) - 1;
    expect(getPeriodicRate(6, 26, 'ANNUITY')).not.toBeCloseTo(
      monthlyEquivalentBiweekly,
      9,
    );
    expect(getPeriodicRate(6, 52, 'ANNUITY')).not.toBeCloseTo(
      Math.pow(1 + 0.06 / 12, 12 / 52) - 1,
      9,
    );
    // Monthly is the one frequency where the two conventions coincide.
    expect(getPeriodicRate(6, 12, 'ANNUITY')).toBeCloseTo(
      Math.pow(1 + 0.06 / 12, 12 / 12) - 1,
      12,
    );
  });

  // One row per type: each prices a biweekly period by its own compounding
  // trait, derived here from the quoted rate rather than read back from
  // `MORTGAGE_TYPE_TRAITS`. Only the semi-annual type departs from the nominal
  // convention; none of them is monthly compounding converted.
  const BIWEEKLY_6_PERCENT: Record<(typeof MORTGAGE_TYPES)[number], number> = {
    ANNUITY: 0.06 / 26,
    CANADIAN_FIXED: Math.pow(1 + 0.06 / 2, 2 / 26) - 1,
    LINEAR: 0.06 / 26,
    INTEREST_ONLY: 0.06 / 26,
  };
  it.each(MORTGAGE_TYPES)('prices a %s period by its own compounding', (type) => {
    expect(getPeriodicRate(6, 26, type)).toBeCloseTo(BIWEEKLY_6_PERCENT[type], 12);
    expect(getPeriodicRate(6, 26, type)).not.toBeCloseTo(
      Math.pow(1 + 0.06 / 12, 12 / 26) - 1,
      9,
    );
  });

  it('uses simple division for an ANNUITY mortgage', () => {
    expect(getPeriodicRate(6, 12, 'ANNUITY')).toBeCloseTo(0.005, 10);
  });

  it('yields a lower rate than simple division for Canadian fixed', () => {
    expect(getPeriodicRate(5, 12, 'CANADIAN_FIXED')).toBeLessThan(getPeriodicRate(5, 12, 'ANNUITY'));
  });

  it('returns 0 for a 0% annual rate', () => {
    expect(getPeriodicRate(0, 12, 'CANADIAN_FIXED')).toBe(0);
    expect(getPeriodicRate(0, 12, 'ANNUITY')).toBe(0);
  });
});

describe('effectiveAnnualRate', () => {
  // Parity with backend calculateEffectiveAnnualRate (which rounds to 2dp for
  // its API contract; this returns the raw percentage). Fixtures derived here,
  // not read back from either implementation.
  it('compounds at the payment frequency outside the Canadian fixed branch', () => {
    for (const periodsPerYear of [12, 24, 26, 52]) {
      expect(effectiveAnnualRate(6, periodsPerYear, 'ANNUITY')).toBeCloseTo(
        (Math.pow(1 + 0.06 / periodsPerYear, periodsPerYear) - 1) * 100,
        10,
      );
    }
    // More compounding periods cost more.
    expect(effectiveAnnualRate(6, 12, 'ANNUITY')).toBeLessThan(
      effectiveAnnualRate(6, 52, 'ANNUITY'),
    );
  });

  it('compounds semi-annually for Canadian fixed, whatever the frequency', () => {
    const expected = (Math.pow(1 + 0.05 / 2, 2) - 1) * 100;
    expect(effectiveAnnualRate(5, 12, 'CANADIAN_FIXED')).toBeCloseTo(expected, 10);
    expect(effectiveAnnualRate(5, 26, 'CANADIAN_FIXED')).toBeCloseTo(expected, 10);
    // ANNUITY is on the nominal convention, compounded at the payment frequency.
    expect(effectiveAnnualRate(5, 26, 'ANNUITY')).toBeCloseTo(
      (Math.pow(1 + 0.05 / 26, 26) - 1) * 100,
      10,
    );
  });

  it('is 0 for a 0% rate on either branch', () => {
    expect(effectiveAnnualRate(0, 12, 'CANADIAN_FIXED')).toBe(0);
    expect(effectiveAnnualRate(0, 26, 'ANNUITY')).toBe(0);
  });
});

describe('advanceDate', () => {
  it('advances weekly and biweekly by days', () => {
    expect(advanceDate(new Date(2026, 0, 1), 'WEEKLY')).toEqual(new Date(2026, 0, 8));
    expect(advanceDate(new Date(2026, 0, 1), 'BIWEEKLY')).toEqual(new Date(2026, 0, 15));
  });

  it('advances semi-monthly between the 15th and the last day of the month', () => {
    // The recurrence engine's convention, because it is the engine that posts
    // these payments -- projecting the 1st and the 15th showed a semi-monthly
    // borrower dates their register never has. Both stored spellings step alike;
    // loan-frequency.guard.test.ts asserts the agreement over two years.
    expect(advanceDate(new Date(2026, 0, 1), 'SEMI_MONTHLY')).toEqual(new Date(2026, 0, 31));
    expect(advanceDate(new Date(2026, 0, 31), 'SEMI_MONTHLY')).toEqual(new Date(2026, 1, 15));
    expect(advanceDate(new Date(2026, 1, 15), 'SEMI_MONTHLY')).toEqual(new Date(2026, 1, 28));
    expect(advanceDate(new Date(2026, 0, 1), 'SEMIMONTHLY')).toEqual(new Date(2026, 0, 31));
  });

  it('advances monthly, quarterly, and yearly by calendar units', () => {
    // Clamped, not overflowed. This assertion used to read `.toBe(2)` with the
    // comment "Jan 31 -> Mar 3 (JS overflow)" -- a test pinning the defect: the
    // projection skipped February outright while the backend's own end date,
    // stepped by the recurrence engine, clamped to 28 February. `advanceDate`
    // delegates to that engine now, so the two calendars are one.
    expect(advanceDate(new Date(2026, 0, 31), 'MONTHLY')).toEqual(new Date(2026, 1, 28));
    expect(advanceDate(new Date(2028, 0, 31), 'MONTHLY')).toEqual(new Date(2028, 1, 29));
    expect(advanceDate(new Date(2026, 0, 15), 'QUARTERLY')).toEqual(new Date(2026, 3, 15));
    expect(advanceDate(new Date(2026, 0, 15), 'YEARLY')).toEqual(new Date(2027, 0, 15));
    // A leap-day anniversary clamps rather than rolling into March.
    expect(advanceDate(new Date(2028, 1, 29), 'YEARLY')).toEqual(new Date(2029, 1, 28));
  });
});

describe('calculateMortgagePaymentAmount', () => {
  it('matches the backend fixture for a standard mortgage', () => {
    // $300,000 at 5% over 25 years, monthly, non-Canadian: ~1753.77
    const payment = calculateMortgagePaymentAmount(300000, 5, 300, 'MONTHLY', 'ANNUITY');
    expect(payment).toBeCloseTo(1753.77, 0);
  });

  it('handles 0% interest as principal / payments', () => {
    expect(calculateMortgagePaymentAmount(120000, 0, 300, 'MONTHLY', 'ANNUITY')).toBe(400);
  });

  it('computes Canadian fixed-rate payments with semi-annual compounding', () => {
    const canadian = calculateMortgagePaymentAmount(300000, 5, 300, 'MONTHLY', 'CANADIAN_FIXED');
    const standard = calculateMortgagePaymentAmount(300000, 5, 300, 'MONTHLY', 'ANNUITY');
    expect(canadian).toBeLessThan(standard);
    expect(canadian).toBeCloseTo(1744.81, 0);
  });

  it('derives accelerated payments from the monthly payment', () => {
    const monthly = calculateMortgagePaymentAmount(300000, 5, 300, 'MONTHLY', 'ANNUITY');
    const acceleratedBiweekly = calculateMortgagePaymentAmount(
      300000, 5, 300, 'ACCELERATED_BIWEEKLY', 'ANNUITY',
    );
    const acceleratedWeekly = calculateMortgagePaymentAmount(
      300000, 5, 300, 'ACCELERATED_WEEKLY', 'ANNUITY',
    );
    expect(acceleratedBiweekly).toBeCloseTo(monthly / 2, 2);
    expect(acceleratedWeekly).toBeCloseTo(monthly / 4, 2);
  });

  it('returns 0 for non-positive principal or term', () => {
    expect(calculateMortgagePaymentAmount(0, 5, 300, 'MONTHLY', 'ANNUITY')).toBe(0);
    expect(calculateMortgagePaymentAmount(100000, 5, 0, 'MONTHLY', 'ANNUITY')).toBe(0);
  });
});

describe('generateLoanSchedule', () => {
  it('amortizes a simple loan to zero', () => {
    const result = generateLoanSchedule(baseInput());
    expect(result.paidOff).toBe(true);
    expect(result.payoffDate).not.toBeNull();
    expect(result.rows[result.rows.length - 1].balance).toBe(0);
    // 10k at 6%/yr with $500/mo pays off in ~21 payments
    expect(result.numPayments).toBeGreaterThan(19);
    expect(result.numPayments).toBeLessThan(23);
    expect(result.totalInterest).toBeGreaterThan(0);
  });

  it('reproduces the reports\' per-row arithmetic', () => {
    const result = generateLoanSchedule(baseInput());
    const first = result.rows[0];
    // interest = balance * rate/12; principal = payment - interest
    expect(first.interest).toBeCloseTo(10000 * 0.005, 2);
    expect(first.principal).toBeCloseTo(500 - 50, 2);
    expect(first.balance).toBeCloseTo(10000 - 450, 2);
    expect(first.date).toBe('2026-01-15');
    expect(result.rows[1].date).toBe('2026-02-15');
  });

  it('handles a 0% rate loan', () => {
    const result = generateLoanSchedule(baseInput({ annualRate: 0 }));
    expect(result.paidOff).toBe(true);
    expect(result.numPayments).toBe(20);
    expect(result.totalInterest).toBe(0);
  });

  it('reports paidOff false when the payment does not cover interest', () => {
    const result = generateLoanSchedule(baseInput({ paymentAmount: 40 }));
    expect(result.paidOff).toBe(false);
    expect(result.payoffDate).toBeNull();
    expect(result.rows).toHaveLength(0);
  });

  it('caps the final payment at the remaining balance', () => {
    const result = generateLoanSchedule(baseInput());
    const last = result.rows[result.rows.length - 1];
    expect(last.principal).toBeLessThanOrEqual(500);
    expect(last.balance).toBe(0);
    expect(last.payment).toBeLessThan(500);
  });

  it('stops at maxPayments when the loan outlives the cap', () => {
    const result = generateLoanSchedule(
      baseInput({ startingBalance: 500000, paymentAmount: 2600, maxPayments: 100 }),
    );
    expect(result.numPayments).toBe(100);
    expect(result.paidOff).toBe(false);
    expect(result.payoffDate).toBeNull();
  });

  it('defaults the cap to 600 payments', () => {
    const result = generateLoanSchedule(
      // Barely amortizing: takes far longer than 600 periods
      baseInput({ startingBalance: 500000, annualRate: 6, paymentAmount: 2510 }),
    );
    expect(result.numPayments).toBe(600);
    expect(result.paidOff).toBe(false);
  });

  it('produces less interest for Canadian fixed than standard compounding', () => {
    const canadian = generateLoanSchedule(
      baseInput({ startingBalance: 300000, paymentAmount: 2000, mortgageType: 'CANADIAN_FIXED' }),
    );
    const standard = generateLoanSchedule(
      baseInput({ startingBalance: 300000, paymentAmount: 2000 }),
    );
    expect(canadian.totalInterest).toBeLessThan(standard.totalInterest);
    expect(canadian.numPayments).toBeLessThanOrEqual(standard.numPayments);
  });

  it('seeds cumulative totals from prior history', () => {
    const result = generateLoanSchedule(
      baseInput({ initialCumulativePrincipal: 5000, initialCumulativeInterest: 1200 }),
    );
    const first = result.rows[0];
    expect(first.cumulativePrincipal).toBeCloseTo(5000 + first.principal, 2);
    expect(first.cumulativeInterest).toBeCloseTo(1200 + first.interest, 2);
    // Aggregates cover only this run, not the seeded history
    expect(result.totalInterest).toBeLessThan(1200);
  });

  describe('recurring extra payments', () => {
    it('shortens the schedule and reduces interest', () => {
      const baseline = generateLoanSchedule(baseInput());
      const scenario = generateLoanSchedule(
        baseInput({ overpayments: { recurringExtra: { amount: 200 } } }),
      );
      expect(scenario.numPayments).toBeLessThan(baseline.numPayments);
      expect(scenario.totalInterest).toBeLessThan(baseline.totalInterest);
      expect(scenario.rows[0].extraPrincipal).toBe(200);
      expect(scenario.totalExtraPrincipal).toBeGreaterThan(0);
    });

    it('respects the start and end date window', () => {
      const scenario = generateLoanSchedule(
        baseInput({
          overpayments: {
            recurringExtra: {
              amount: 200,
              startDate: '2026-03-01',
              endDate: '2026-05-31',
            },
          },
        }),
      );
      // Payments on the 15th: Jan/Feb outside, Mar/Apr/May inside, Jun+ outside
      expect(scenario.rows[0].extraPrincipal).toBe(0);
      expect(scenario.rows[1].extraPrincipal).toBe(0);
      expect(scenario.rows[2].extraPrincipal).toBe(200);
      expect(scenario.rows[4].extraPrincipal).toBe(200);
      expect(scenario.rows[5].extraPrincipal).toBe(0);
    });

    it('ignores non-positive recurring amounts', () => {
      const scenario = generateLoanSchedule(
        baseInput({ overpayments: { recurringExtra: { amount: 0 } } }),
      );
      expect(scenario.rows[0].extraPrincipal).toBe(0);
    });

    it('includes extra principal in cumulative principal', () => {
      const scenario = generateLoanSchedule(
        baseInput({ overpayments: { recurringExtra: { amount: 200 } } }),
      );
      const first = scenario.rows[0];
      expect(first.cumulativePrincipal).toBeCloseTo(first.principal + 200, 2);
    });
  });

  describe('lump sums', () => {
    it('applies a lump sum on the first payment on or after its date', () => {
      const scenario = generateLoanSchedule(
        baseInput({ overpayments: { lumpSums: [{ date: '2026-03-01', amount: 1000 }] } }),
      );
      // Payments land on the 15th; Mar 1 lump attaches to Mar 15 (row 3)
      expect(scenario.rows[1].extraPrincipal).toBe(0);
      expect(scenario.rows[2].extraPrincipal).toBe(1000);
    });

    it('attaches lump sums dated before the first payment to row 1', () => {
      const scenario = generateLoanSchedule(
        baseInput({ overpayments: { lumpSums: [{ date: '2025-06-01', amount: 1000 }] } }),
      );
      expect(scenario.rows[0].extraPrincipal).toBe(1000);
    });

    it('combines multiple lump sums landing in the same period', () => {
      const scenario = generateLoanSchedule(
        baseInput({
          overpayments: {
            lumpSums: [
              { date: '2026-03-01', amount: 500 },
              { date: '2026-03-10', amount: 250 },
            ],
          },
        }),
      );
      expect(scenario.rows[2].extraPrincipal).toBe(750);
    });

    it('ignores lump sums dated after payoff', () => {
      const withLateLump = generateLoanSchedule(
        baseInput({ overpayments: { lumpSums: [{ date: '2099-01-01', amount: 5000 }] } }),
      );
      const baseline = generateLoanSchedule(baseInput());
      expect(withLateLump.numPayments).toBe(baseline.numPayments);
      expect(withLateLump.totalExtraPrincipal).toBe(0);
    });

    it('caps extra principal at the remaining balance', () => {
      const scenario = generateLoanSchedule(
        baseInput({ overpayments: { lumpSums: [{ date: '2026-01-01', amount: 999999 }] } }),
      );
      expect(scenario.numPayments).toBe(1);
      expect(scenario.paidOff).toBe(true);
      const only = scenario.rows[0];
      expect(only.balance).toBe(0);
      expect(only.extraPrincipal).toBeCloseTo(10000 - only.principal, 2);
    });
  });
});

describe('generateLoanSchedule with rate changes', () => {
  it('is identical to the plain schedule when rateChanges is empty', () => {
    const plain = generateLoanSchedule(baseInput());
    const withEmpty = generateLoanSchedule(baseInput({ rateChanges: [] }));
    expect(withEmpty).toEqual(plain);
  });

  it('applies a mid-schedule rate step from the first payment on/after its date', () => {
    const result = generateLoanSchedule(
      baseInput({
        rateChanges: [{ effectiveDate: '2026-03-01', annualRate: 12 }],
      }),
    );

    // Rows 1-2 (Jan 15, Feb 15) at 6%; row 3 (Mar 15) onwards at 12%
    expect(result.rows[0].annualRate).toBe(6);
    expect(result.rows[1].annualRate).toBe(6);
    expect(result.rows[2].annualRate).toBe(12);

    // Row 2 still accrues at 6%/12 on row 1's closing balance
    expect(result.rows[1].interest).toBeCloseTo(result.rows[0].balance * 0.005, 2);
    // Row 3 accrues at the doubled periodic rate on row 2's closing balance
    expect(result.rows[2].interest).toBeCloseTo(result.rows[1].balance * 0.01, 2);
  });

  it('keeps the payment unchanged when the step has no payment amount', () => {
    const result = generateLoanSchedule(
      baseInput({
        rateChanges: [{ effectiveDate: '2026-03-01', annualRate: 12 }],
      }),
    );
    for (const row of result.rows.slice(0, -1)) {
      expect(row.payment).toBeCloseTo(500, 2);
    }
  });

  it('changes the payment when the step carries one', () => {
    const result = generateLoanSchedule(
      baseInput({
        rateChanges: [{ effectiveDate: '2026-03-01', annualRate: 12, paymentAmount: 600 }],
      }),
    );
    expect(result.rows[1].payment).toBeCloseTo(500, 2);
    expect(result.rows[2].payment).toBeCloseTo(600, 2);
  });

  it('extends the payoff when the rate rises with a fixed payment', () => {
    const baseline = generateLoanSchedule(baseInput());
    const stepped = generateLoanSchedule(
      baseInput({
        rateChanges: [{ effectiveDate: '2026-03-01', annualRate: 12 }],
      }),
    );
    expect(stepped.numPayments).toBeGreaterThan(baseline.numPayments);
    expect(stepped.totalInterest).toBeGreaterThan(baseline.totalInterest);
  });

  it('applies a step dated before the first payment to row 1', () => {
    const result = generateLoanSchedule(
      baseInput({
        rateChanges: [{ effectiveDate: '2020-01-01', annualRate: 12 }],
      }),
    );
    expect(result.rows[0].annualRate).toBe(12);
    expect(result.rows[0].interest).toBeCloseTo(10000 * 0.01, 2);
  });

  it('recomputes the periodic rate per segment with Canadian semi-annual compounding', () => {
    const result = generateLoanSchedule(
      baseInput({
        mortgageType: 'CANADIAN_FIXED',
        rateChanges: [{ effectiveDate: '2026-03-01', annualRate: 12 }],
      }),
    );
    const firstSegmentRate = getPeriodicRate(6, 12, 'CANADIAN_FIXED');
    const secondSegmentRate = getPeriodicRate(12, 12, 'CANADIAN_FIXED');
    expect(result.rows[0].interest).toBeCloseTo(10000 * firstSegmentRate, 2);
    expect(result.rows[2].interest).toBeCloseTo(result.rows[1].balance * secondSegmentRate, 2);
  });

  it('composes with overpayments: extra principal still applies after the step', () => {
    const result = generateLoanSchedule(
      baseInput({
        rateChanges: [{ effectiveDate: '2026-03-01', annualRate: 12 }],
        overpayments: { recurringExtra: { amount: 100 } },
      }),
    );
    expect(result.rows[2].annualRate).toBe(12);
    expect(result.rows[2].extraPrincipal).toBe(100);
  });

  it('applies multiple steps in date order regardless of input order', () => {
    const result = generateLoanSchedule(
      baseInput({
        rateChanges: [
          { effectiveDate: '2026-05-01', annualRate: 9 },
          { effectiveDate: '2026-03-01', annualRate: 12 },
        ],
      }),
    );
    expect(result.rows[1].annualRate).toBe(6);
    expect(result.rows[2].annualRate).toBe(12);
    expect(result.rows[3].annualRate).toBe(12);
    expect(result.rows[4].annualRate).toBe(9);
  });
});

describe('generateLoanSchedule rescueEndPeriod', () => {
  it('re-levels toward the rescue term when a rate rise would stall the payment, instead of stopping', () => {
    // A low fixed payment sized at 2% cannot cover the interest once the rate
    // jumps to 12% mid-schedule. Without a rescue the schedule stalls (never
    // paid off); rescueEndPeriod re-levels the payment to amortize the rest.
    const stalling = baseInput({
      startingBalance: 100000,
      annualRate: 2,
      paymentAmount: 500,
      rateChanges: [{ effectiveDate: '2026-06-01', annualRate: 12 }],
      maxPayments: 600,
    });

    expect(generateLoanSchedule(stalling).paidOff).toBe(false);

    const rescued = generateLoanSchedule({ ...stalling, rescueEndPeriod: 360 });
    expect(rescued.paidOff).toBe(true);
    expect(rescued.payoffDate).not.toBeNull();
  });

  it('does not force payoff at the rescue term when the payment amortizes early', () => {
    // Unlike fixedEndPeriod, rescueEndPeriod never re-levels a healthy payment:
    // a payment that clears the loan well before the term keeps its early
    // payoff.
    const early = generateLoanSchedule(
      baseInput({ startingBalance: 10000, annualRate: 6, paymentAmount: 2000, rescueEndPeriod: 360 }),
    );
    expect(early.paidOff).toBe(true);
    expect(early.numPayments).toBeLessThan(12);

    // fixedEndPeriod, by contrast, re-levels every period and stretches the
    // same payment across the whole term.
    const forced = generateLoanSchedule(
      baseInput({
        startingBalance: 10000,
        annualRate: 6,
        paymentAmount: 2000,
        fixedEndPeriod: 360,
        maxPayments: 600,
      }),
    );
    expect(forced.numPayments).toBeGreaterThan(300);
  });
});

describe('resolveEffectiveLoanTerms', () => {
  const rows = [
    { effectiveDate: '2022-01-01', annualRate: 5.5, newPaymentAmount: 2500, source: 'manual' as const },
    { effectiveDate: '2023-06-01', annualRate: 6.2, newPaymentAmount: null, source: 'manual' as const },
  ];

  it('takes the latest row at or before the date', () => {
    expect(resolveEffectiveLoanTerms(rows, '2024-01-01', 4)).toEqual({
      annualRate: 6.2,
      paymentAmount: 2500,
      paymentEffectiveDate: '2022-01-01',
      snapshotPaymentAmount: null,
    });
  });

  it('falls back to the account scalar before the earliest row, unlike buildRateTimeline', () => {
    // This is the whole reason it exists. buildRateTimeline deliberately applies
    // the EARLIEST row when the schedule starts before it -- right for a
    // schedule anchored at origination (loan-past-impact), wrong for one
    // anchored today, where it would make a change dated next year today's rate
    // AND emit it again as a future step.
    expect(resolveEffectiveLoanTerms(rows, '2021-01-01', 4)).toEqual({
      annualRate: 4,
      paymentAmount: null,
      paymentEffectiveDate: null,
      snapshotPaymentAmount: null,
    });
    expect(buildRateTimeline(rows, '2021-01-01', 4).startingAnnualRate).toBe(5.5);
  });

  it('reports an initial row\'s payment separately, not as the stated one', () => {
    // `initial` is written both by detection (a real observed installment) and
    // by the first-rate-change hook (a verbatim copy of account.paymentAmount),
    // with nothing on the row to tell them apart -- so it is neither
    // authoritative nor worthless, and the caller ranks it. Its RATE is the
    // origination rate either way, which is a fact about the loan.
    const initialOnly = [
      { effectiveDate: '2022-01-01', annualRate: 3.9, newPaymentAmount: 450, source: 'initial' as const },
    ];
    expect(resolveEffectiveLoanTerms(initialOnly, '2024-01-01', 4)).toEqual({
      annualRate: 3.9,
      paymentAmount: null,
      paymentEffectiveDate: null,
      snapshotPaymentAmount: 450,
    });
  });

  it('takes the latest stating row when a later one leaves the payment unchanged', () => {
    const withInitial = [
      { effectiveDate: '2021-01-01', annualRate: 3, newPaymentAmount: 100, source: 'initial' as const },
      { effectiveDate: '2022-01-01', annualRate: 5, newPaymentAmount: 2500, source: 'manual' as const },
      { effectiveDate: '2023-01-01', annualRate: 6, newPaymentAmount: null, source: 'inferred' as const },
    ];
    expect(resolveEffectiveLoanTerms(withInitial, '2024-01-01', 4)).toEqual({
      annualRate: 6,
      paymentAmount: 2500,
      paymentEffectiveDate: '2022-01-01',
      snapshotPaymentAmount: 100,
    });
  });

  it('treats a row with no source as stating its payment', () => {
    // The field is optional so existing callers and fixtures keep working; only
    // an explicit 'initial' is demoted.
    expect(
      resolveEffectiveLoanTerms(
        [{ effectiveDate: '2022-01-01', annualRate: 5, newPaymentAmount: 800 }],
        '2024-01-01',
        4,
      ).paymentAmount,
    ).toBe(800);
  });

  it('returns the fallback for an empty timeline', () => {
    expect(resolveEffectiveLoanTerms([], '2024-01-01', 4.25)).toEqual({
      annualRate: 4.25,
      paymentAmount: null,
      paymentEffectiveDate: null,
      snapshotPaymentAmount: null,
    });
  });
});

describe('buildRateTimeline', () => {
  const rows = [
    { effectiveDate: '2022-01-01', annualRate: 5.5, newPaymentAmount: 2500 },
    { effectiveDate: '2023-06-01', annualRate: 6.2, newPaymentAmount: null },
    { effectiveDate: '2024-03-01', annualRate: 4.9, newPaymentAmount: 2650 },
  ];

  it('falls back to the account rate when there is no history', () => {
    const timeline = buildRateTimeline([], '2022-01-01', 6);
    expect(timeline.startingAnnualRate).toBe(6);
    expect(timeline.startingPaymentAmount).toBeNull();
    expect(timeline.rateChanges).toEqual([]);
  });

  it('starts at the latest row on or before the schedule start', () => {
    const timeline = buildRateTimeline(rows, '2023-08-01', 99);
    expect(timeline.startingAnnualRate).toBe(6.2);
    // Latest non-null payment at/before the start is the initial snapshot
    expect(timeline.startingPaymentAmount).toBe(2500);
    expect(timeline.rateChanges).toEqual([
      { effectiveDate: '2024-03-01', annualRate: 4.9, paymentAmount: 2650 },
    ]);
  });

  it('uses the earliest row before the timeline begins', () => {
    // Both the rate AND the payment fall back to the earliest row: it is the
    // origination snapshot. Real case: payment_start_date (2022-04-25) precedes
    // the initial rate row, which detection dates at the first installment
    // (2022-05-13) -- the schedule must still start at that recorded payment.
    const timeline = buildRateTimeline(rows, '2020-01-01', 99);
    expect(timeline.startingAnnualRate).toBe(5.5);
    expect(timeline.startingPaymentAmount).toBe(2500);
    expect(timeline.rateChanges).toHaveLength(3);
  });

  it('keeps the pre-history payment null when the earliest row has none', () => {
    // Interest booked separately leaves every row's payment null (recording it
    // would capture a principal-only figure); the fallback must not invent one
    // from a later row, whose payment belongs to a later rate level.
    const nullFirst = [
      { effectiveDate: '2022-01-01', annualRate: 5.5, newPaymentAmount: null },
      { effectiveDate: '2024-03-01', annualRate: 4.9, newPaymentAmount: 2650 },
    ];
    const timeline = buildRateTimeline(nullFirst, '2020-01-01', 99);
    expect(timeline.startingPaymentAmount).toBeNull();
  });

  it('turns the full history into steps for a schedule starting at origination', () => {
    const timeline = buildRateTimeline(rows, '2022-01-01', 99);
    expect(timeline.startingAnnualRate).toBe(5.5);
    expect(timeline.startingPaymentAmount).toBe(2500);
    expect(timeline.rateChanges).toEqual([
      { effectiveDate: '2023-06-01', annualRate: 6.2, paymentAmount: null },
      { effectiveDate: '2024-03-01', annualRate: 4.9, paymentAmount: 2650 },
    ]);
  });
});

describe('compareSchedules', () => {
  it('computes payments, months, and interest saved', () => {
    const baseline = generateLoanSchedule(baseInput());
    const scenario = generateLoanSchedule(
      baseInput({ overpayments: { recurringExtra: { amount: 200 } } }),
    );
    const comparison = compareSchedules(baseline, scenario);
    expect(comparison.paymentsSaved).toBe(baseline.numPayments - scenario.numPayments);
    expect(comparison.monthsSaved).toBe(comparison.paymentsSaved);
    expect(comparison.interestSaved).toBeCloseTo(
      Math.round((baseline.totalInterest - scenario.totalInterest) * 100) / 100,
      2,
    );
    expect(comparison.interestSaved).toBeGreaterThan(0);
  });

  it('reports every saving as unknown when either schedule never pays off', () => {
    const baseline = generateLoanSchedule(baseInput({ paymentAmount: 40 }));
    const scenario = generateLoanSchedule(
      baseInput({ paymentAmount: 40, overpayments: { recurringExtra: { amount: 200 } } }),
    );
    const comparison = compareSchedules(baseline, scenario);
    // Not zero: zero is a claim that the overpayment bought nothing. All three
    // savings compare against a schedule that has no lifetime to compare with.
    expect(comparison.monthsSaved).toBeNull();
    expect(comparison.paymentsSaved).toBeNull();
    expect(comparison.interestSaved).toBeNull();
    // The ending installment is not a property of a truncated schedule either:
    // `finalPaymentAmount` is then the installment at the last PROJECTED row,
    // mid-schedule, so a drop measured from it is unknown too.
    expect(comparison.installmentReduction).toBeNull();
  });
});

describe('calculatePaymentForTerm', () => {
  it('solves the annuity payment for a balance over a fixed term', () => {
    // 225400 over 300 monthly periods at 5% -> ~1317 (WMP worked example)
    const payment = calculatePaymentForTerm(225400, 5, 300, 'MONTHLY', 'ANNUITY');
    expect(payment).toBeGreaterThan(1300);
    expect(payment).toBeLessThan(1335);
  });

  it('splits the balance evenly at 0% interest', () => {
    expect(calculatePaymentForTerm(12000, 0, 24, 'MONTHLY', 'ANNUITY')).toBe(500);
  });

  it('returns 0 for a non-positive balance or term', () => {
    expect(calculatePaymentForTerm(0, 5, 300, 'MONTHLY', 'ANNUITY')).toBe(0);
    expect(calculatePaymentForTerm(1000, 5, 0, 'MONTHLY', 'ANNUITY')).toBe(0);
  });

  it('recovers the contractual payment that generateLoanSchedule amortizes', () => {
    // The payment that clears 10000 over the baseline term should reproduce
    // roughly the same number of periods.
    const baseline = generateLoanSchedule(baseInput());
    const payment = calculatePaymentForTerm(10000, 6, baseline.numPayments, 'MONTHLY', 'ANNUITY');
    const rebuilt = generateLoanSchedule(baseInput({ paymentAmount: payment }));
    expect(Math.abs(rebuilt.numPayments - baseline.numPayments)).toBeLessThanOrEqual(1);
  });
});

describe('generateLoanSchedule LOWER_INSTALLMENT mode', () => {
  it('keeps the payoff date fixed and lowers the installment after a lump sum', () => {
    const base = baseInput({
      startingBalance: 275400,
      annualRate: 5,
      paymentAmount: 1610.46,
      maxPayments: 400,
    });
    const shorten = generateLoanSchedule({
      ...base,
      overpayments: { lumpSums: [{ date: '2026-01-15', amount: 50000, mode: 'SHORTEN_TERM' }] },
    });
    const lower = generateLoanSchedule({
      ...base,
      overpayments: { lumpSums: [{ date: '2026-01-15', amount: 50000, mode: 'LOWER_INSTALLMENT' }] },
    });
    const baseline = generateLoanSchedule(base);

    // SHORTEN keeps the installment but ends sooner.
    expect(shorten.numPayments).toBeLessThan(baseline.numPayments);
    // LOWER keeps the term (within a period) but drops the installment.
    expect(Math.abs(lower.numPayments - baseline.numPayments)).toBeLessThanOrEqual(1);
    expect(lower.finalPaymentAmount).toBeLessThan(baseline.finalPaymentAmount);
    // Both still save interest versus the baseline; SHORTEN saves more.
    expect(baseline.totalInterest - lower.totalInterest).toBeGreaterThan(0);
    expect(shorten.totalInterest).toBeLessThan(lower.totalInterest);
  });

  it('reports the installment reduction in the comparison', () => {
    const base = baseInput({ startingBalance: 200000, annualRate: 4, paymentAmount: 1200, maxPayments: 400 });
    const baseline = generateLoanSchedule(base);
    const lower = generateLoanSchedule({
      ...base,
      overpayments: { lumpSums: [{ date: '2026-01-15', amount: 30000, mode: 'LOWER_INSTALLMENT' }] },
    });
    const comparison = compareSchedules(baseline, lower);
    expect(comparison.installmentReduction).toBeGreaterThan(0);
    expect(comparison.monthsSaved).toBe(0);
  });
});

describe('generateLoanSchedule per-overpayment mode', () => {
  const base = () =>
    baseInput({ startingBalance: 275400, annualRate: 5, paymentAmount: 1610.46, maxPayments: 400 });

  it("applies each lump sum's own mode", () => {
    const baseline = generateLoanSchedule(base());
    const shorten = generateLoanSchedule({
      ...base(),
      overpayments: { lumpSums: [{ date: '2026-01-15', amount: 50000, mode: 'SHORTEN_TERM' }] },
    });
    const lower = generateLoanSchedule({
      ...base(),
      overpayments: { lumpSums: [{ date: '2026-01-15', amount: 50000, mode: 'LOWER_INSTALLMENT' }] },
    });

    // SHORTEN keeps the installment and ends sooner.
    expect(shorten.finalPaymentAmount).toBeCloseTo(baseline.finalPaymentAmount, 0);
    expect(shorten.numPayments).toBeLessThan(baseline.numPayments);
    // LOWER drops the installment and keeps ~the original term.
    expect(lower.finalPaymentAmount).toBeLessThan(baseline.finalPaymentAmount);
    expect(Math.abs(lower.numPayments - baseline.numPayments)).toBeLessThanOrEqual(1);
  });

  it('handles mixed modes in one plan', () => {
    const baseline = generateLoanSchedule(base());
    const mixed = generateLoanSchedule({
      ...base(),
      overpayments: {
        lumpSums: [
          { date: '2026-02-15', amount: 40000, mode: 'LOWER_INSTALLMENT' },
          { date: '2027-02-15', amount: 40000, mode: 'SHORTEN_TERM' },
        ],
      },
    });

    expect(mixed.paidOff).toBe(true);
    // The LOWER lump lowered the installment...
    expect(mixed.finalPaymentAmount).toBeLessThan(baseline.finalPaymentAmount);
    // ...and the later SHORTEN lump ended it before the original term.
    expect(mixed.numPayments).toBeLessThan(baseline.numPayments);
  });
});

describe('effectiveAnnualRateOn', () => {
  const rows = [
    { effectiveDate: '2021-07-05', annualRate: 1.95 },
    { effectiveDate: '2022-01-05', annualRate: 4.21 },
    { effectiveDate: '2022-04-05', annualRate: 5.5 },
  ];

  it('returns the latest rate on or before the date', () => {
    expect(effectiveAnnualRateOn(rows, '2022-04-05', 9)).toBe(5.5);
    expect(effectiveAnnualRateOn(rows, '2022-03-01', 9)).toBe(4.21);
    expect(effectiveAnnualRateOn(rows, '2025-06-05', 9)).toBe(5.5);
  });

  it('uses the earliest row for a date before the first change', () => {
    expect(effectiveAnnualRateOn(rows, '2020-01-01', 9)).toBe(1.95);
  });

  it('falls back to the account rate when there are no rows', () => {
    expect(effectiveAnnualRateOn([], '2024-01-01', 5.5)).toBe(5.5);
  });
});

describe('generateBudgetSchedule (fixed monthly budget)', () => {
  const budgetInput = () => {
    const installment = calculateMortgagePaymentAmount(200000, 4, 300, 'MONTHLY', 'ANNUITY');
    return baseInput({
      startingBalance: 200000,
      annualRate: 4,
      paymentAmount: installment, // contractual installment -> ~300-month term
      frequency: 'MONTHLY',
      firstPaymentDate: new Date('2025-01-15'),
    });
  };

  it('lower-installment: shrinking installment, growing overpayment, constant total', () => {
    const budget = 4000;
    const result = generateLoanSchedule({
      ...budgetInput(),
      overpayments: { targetMonthlyPayment: budget, targetMonthlyPaymentMode: 'LOWER_INSTALLMENT' },
    });

    expect(result.paidOff).toBe(true);
    // Paying 4000/mo on a 200k loan clears it in well under the 300-month term.
    expect(result.numPayments).toBeLessThan(70);

    // Every non-final period spends exactly the budget = installment + overpayment.
    for (const row of result.rows.slice(0, -1)) {
      expect(row.payment + row.extraPrincipal).toBeCloseTo(budget, 1);
      expect(row.extraPrincipal).toBeGreaterThan(0);
    }

    // The installment steps down and the overpayment grows to fill the budget.
    const first = result.rows[0];
    const later = result.rows[result.rows.length - 5];
    expect(later.payment).toBeLessThan(first.payment);
    expect(later.extraPrincipal).toBeGreaterThan(first.extraPrincipal);
  });

  it('shorten-term: fixed installment, constant overpayment, same payoff as lower-installment', () => {
    const budget = 4000;
    const base = budgetInput();
    const shorten = generateLoanSchedule({
      ...base,
      overpayments: { targetMonthlyPayment: budget, targetMonthlyPaymentMode: 'SHORTEN_TERM' },
    });
    const lower = generateLoanSchedule({
      ...base,
      overpayments: { targetMonthlyPayment: budget, targetMonthlyPaymentMode: 'LOWER_INSTALLMENT' },
    });

    // Both modes pay the same total each period, so the schedule is identical.
    expect(shorten.numPayments).toBe(lower.numPayments);
    expect(shorten.totalInterest).toBeCloseTo(lower.totalInterest, 2);

    // Shorten-term keeps the contractual installment fixed and the overpayment
    // constant (only the split differs from lower-installment).
    const nonFinal = shorten.rows.slice(0, -1);
    for (const row of nonFinal) {
      expect(row.payment).toBeCloseTo(base.paymentAmount, 1);
      expect(row.payment + row.extraPrincipal).toBeCloseTo(budget, 1);
    }
    expect(nonFinal[0].extraPrincipal).toBeCloseTo(nonFinal[nonFinal.length - 1].extraPrincipal, 1);
  });

  it('reports the level installment as finalPaymentAmount, never the payoff residual', () => {
    const budget = 4000;
    const base = budgetInput();
    const shorten = generateLoanSchedule({
      ...base,
      overpayments: { targetMonthlyPayment: budget, targetMonthlyPaymentMode: 'SHORTEN_TERM' },
    });
    // Shorten-term never re-amortizes: the comparison table must see the
    // contractual installment, not the final row's small catch-up total.
    expect(shorten.finalPaymentAmount).toBeCloseTo(base.paymentAmount, 2);

    const lower = generateLoanSchedule({
      ...base,
      overpayments: { targetMonthlyPayment: budget, targetMonthlyPaymentMode: 'LOWER_INSTALLMENT' },
    });
    // Lower-installment reports the last re-amortized installment -- the same
    // uncapped level the second-to-last row shows, not the payoff-capped split.
    const secondToLast = lower.rows[lower.rows.length - 2];
    expect(lower.finalPaymentAmount).toBeLessThanOrEqual(secondToLast.payment);
    expect(lower.finalPaymentAmount).toBeGreaterThan(0);
  });

  it('defaults the mode to lower-installment when the plan omits it', () => {
    const base = budgetInput();
    const omitted = generateLoanSchedule({
      ...base,
      overpayments: { targetMonthlyPayment: 4000 },
    });
    const lower = generateLoanSchedule({
      ...base,
      overpayments: { targetMonthlyPayment: 4000, targetMonthlyPaymentMode: 'LOWER_INSTALLMENT' },
    });
    // The omitted-mode split matches lower-installment (the product default),
    // not shorten-term's fixed contractual installment.
    expect(omitted.rows[5].payment).toBeCloseTo(lower.rows[5].payment, 2);
    expect(omitted.rows[5].payment).toBeLessThan(base.paymentAmount);
  });

  it('never lets the total exceed the budget and pays off on the last row', () => {
    const budget = 3000;
    const result = generateLoanSchedule({
      ...budgetInput(),
      overpayments: { targetMonthlyPayment: budget },
    });
    for (const row of result.rows) {
      expect(row.payment + row.extraPrincipal).toBeLessThanOrEqual(budget + 0.01);
    }
    expect(result.rows[result.rows.length - 1].balance).toBe(0);
  });

  it('applies the budget only within its date window', () => {
    const result = generateLoanSchedule({
      ...budgetInput(),
      overpayments: {
        targetMonthlyPayment: 4000,
        targetMonthlyPaymentMode: 'SHORTEN_TERM',
        targetMonthlyPaymentStart: '2025-04-01',
        targetMonthlyPaymentEnd: '2025-12-31',
      },
    });

    // Before the window (Jan-Mar): only the installment, no overpayment.
    const early = result.rows.filter((r) => r.date < '2025-04-01');
    expect(early.length).toBeGreaterThan(0);
    for (const r of early) expect(r.extraPrincipal).toBe(0);

    // Within the window: the budget tops up (overpayment > 0).
    const inWindow = result.rows.filter((r) => r.date >= '2025-04-01' && r.date <= '2025-12-31');
    expect(inWindow.length).toBeGreaterThan(0);
    for (const r of inWindow) expect(r.extraPrincipal).toBeGreaterThan(0);

    // After the window: back to just the installment.
    const after = result.rows.filter((r) => r.date > '2025-12-31');
    expect(after.length).toBeGreaterThan(0);
    for (const r of after) expect(r.extraPrincipal).toBe(0);
  });

  it('never counts unpaid interest as principal when the installment is below the interest', () => {
    // Contractual installment (100) deliberately below the period interest, as a
    // sharp rate rise on a fixed installment would cause; the budget still
    // covers the interest.
    const result = generateLoanSchedule({
      startingBalance: 200000,
      annualRate: 8,
      paymentAmount: 100,
      frequency: 'MONTHLY',
      firstPaymentDate: new Date('2025-01-15'),
      overpayments: { targetMonthlyPayment: 4000, targetMonthlyPaymentMode: 'SHORTEN_TERM' },
    });

    const first = result.rows[0];
    const interest0 = (200000 * 8) / 100 / 12; // 1333.33
    // Total paid is the budget, and the balance drops by exactly budget minus
    // interest -- not by more (which the old split would have done).
    expect(first.payment + first.extraPrincipal).toBeCloseTo(4000, 1);
    expect(200000 - first.balance).toBeCloseTo(4000 - interest0, 1);
    expect(first.interest).toBeCloseTo(interest0, 1);
  });

  it('does not amortize when the budget cannot cover the first period interest', () => {
    const result = generateLoanSchedule({
      ...budgetInput(),
      // 200k at 4% -> ~667/mo interest; a 500 budget never amortizes.
      overpayments: { targetMonthlyPayment: 500 },
    });
    expect(result.paidOff).toBe(false);
    expect(result.numPayments).toBe(0);
  });
});

describe('recurring extra frequency', () => {
  it('lands a sparse cadence as a real overpayment every Nth payment', () => {
    const base = baseInput({ startingBalance: 100000, paymentAmount: 600 });
    // Quarterly on a monthly loan: the full 300 lands on payment 1, then every
    // 3rd payment -- not levelled to 100 per month.
    const quarterly = generateLoanSchedule({
      ...base,
      overpayments: { recurringExtra: { amount: 300, frequency: 'QUARTERLY' } },
    });
    expect(quarterly.rows[0].extraPrincipal).toBeCloseTo(300, 2);
    expect(quarterly.rows[1].extraPrincipal).toBe(0);
    expect(quarterly.rows[2].extraPrincipal).toBe(0);
    expect(quarterly.rows[3].extraPrincipal).toBeCloseTo(300, 2);
  });

  it('carries every due occurrence of a denser cadence at the next payment', () => {
    const base = baseInput({ startingBalance: 100000, paymentAmount: 600 });
    // Weekly on a monthly loan, first payment 2026-01-15. Only the Jan 15
    // occurrence is due at payment 1; Jan 22, 29, Feb 5 and Feb 12 arrive with
    // payment 2. Four or five per month, never a levelled 433.33 that falls on
    // no actual overpayment date.
    const weekly = generateLoanSchedule({
      ...base,
      overpayments: { recurringExtra: { amount: 100, frequency: 'WEEKLY' } },
    });
    expect(weekly.rows[0].extraPrincipal).toBeCloseTo(100, 2);
    expect(weekly.rows[1].extraPrincipal).toBeCloseTo(400, 2);
    expect(weekly.rows[2].extraPrincipal).toBeCloseTo(400, 2);
  });

  it('treats an omitted frequency as a per-payment amount (legacy behaviour)', () => {
    const base = baseInput({ startingBalance: 100000, paymentAmount: 600 });
    const legacy = generateLoanSchedule({
      ...base,
      overpayments: { recurringExtra: { amount: 100 } },
    });
    const monthly = generateLoanSchedule({
      ...base,
      overpayments: { recurringExtra: { amount: 100, frequency: 'MONTHLY' } },
    });
    // On a monthly loan, "monthly" and "per payment" coincide.
    expect(legacy.totalInterest).toBeCloseTo(monthly.totalInterest, 2);
  });
});

describe('recurringOccurrencesDue', () => {
  // The cadence in isolation: how many occurrences a payment on a given date
  // has to carry. Counted against the calendar by hand, independent of any loan.
  const first = new Date(2026, 0, 1);

  it('counts one MONTHLY occurrence per calendar month', () => {
    const counter = recurringOccurrencesDue(
      { amount: 100, frequency: 'MONTHLY' },
      first,
    );
    // Twelve payment dates, one occurrence each -- the count does not depend on
    // how often the loan itself is paid.
    const months = [
      '2026-01-01', '2026-02-01', '2026-03-01', '2026-04-01',
      '2026-05-01', '2026-06-01', '2026-07-01', '2026-08-01',
      '2026-09-01', '2026-10-01', '2026-11-01', '2026-12-01',
    ];
    expect(months.map((d) => counter.dueBy(d))).toEqual(Array(12).fill(1));
    // A thirteenth month is a new year's first occurrence, not a thirteenth one
    // for 2026.
    expect(counter.dueBy('2026-12-31')).toBe(0);
    expect(counter.dueBy('2027-01-01')).toBe(1);
  });

  it('counts 12 MONTHLY occurrences over a biweekly payment calendar', () => {
    const counter = recurringOccurrencesDue(
      { amount: 100, frequency: 'MONTHLY' },
      first,
    );
    // Every biweekly payment date in 2026, in order.
    let total = 0;
    const date = new Date(first);
    while (date.getFullYear() === 2026) {
      total += counter.dueBy(
        `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(
          date.getDate(),
        ).padStart(2, '0')}`,
      );
      date.setDate(date.getDate() + 14);
    }
    // round(26 / 12) = 2 gave 13 here.
    expect(total).toBe(12);
  });

  it('spaces occurrences exactly one cadence step apart', () => {
    // WEEKLY and BIWEEKLY are day cadences, so "52 a year" is nominal: a
    // 365-day year holds 53 seven-day steps, exactly as a weekly standing order
    // does. The invariant is the step, asserted here directly.
    for (const [frequency, stepDays] of [
      ['WEEKLY', 7],
      ['BIWEEKLY', 14],
    ] as [RecurringOverpaymentFrequency, number][]) {
      const counter = recurringOccurrencesDue({ amount: 1, frequency }, first);
      expect(counter.dueBy('2026-01-01')).toBe(1);
      const dayBefore = new Date(2026, 0, 1 + stepDays - 1);
      const onStep = new Date(2026, 0, 1 + stepDays);
      const iso = (d: Date) =>
        `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(
          d.getDate(),
        ).padStart(2, '0')}`;
      expect(counter.dueBy(iso(dayBefore))).toBe(0);
      expect(counter.dueBy(iso(onStep))).toBe(1);
    }
  });

  it('counts 4 QUARTERLY and 1 ANNUALLY occurrence per calendar year', () => {
    // Calendar cadences, so the annual count is exact.
    for (const [frequency, expected] of [
      ['QUARTERLY', 4],
      ['ANNUALLY', 1],
    ] as [RecurringOverpaymentFrequency, number][]) {
      const counter = recurringOccurrencesDue({ amount: 1, frequency }, first);
      expect(counter.dueBy('2026-12-31')).toBe(expected);
      expect(counter.dueBy('2027-12-31')).toBe(expected);
    }
  });

  it('steps a month-end anchor on the loan\'s own calendar', () => {
    // The cadence walks the recurrence engine, the same calendar the loan's
    // payment dates walk. Deriving each occurrence from the anchor instead
    // (2026-01-31, 02-28, 03-31, 04-30 ...) looked tidier in isolation and was
    // wrong where it mattered: a monthly loan first paid on the 31st has rows on
    // 01-31, 02-28, 03-28, 04-28, so the occurrence due 03-31 arrived AFTER the
    // March row, waited for 04-28, and the borrower paid eleven monthly extras
    // in the first calendar year and two on one row the next February.
    //
    // So a clamp is absorbed once and kept: after February the cadence settles
    // onto the 28th, exactly where the loan's payments have settled.
    const counter = recurringOccurrencesDue(
      { amount: 100, frequency: 'MONTHLY' },
      new Date(2026, 0, 31),
    );
    expect(counter.dueBy('2026-01-31')).toBe(1);
    expect(counter.dueBy('2026-02-27')).toBe(0);
    expect(counter.dueBy('2026-02-28')).toBe(1);
    expect(counter.dueBy('2026-03-27')).toBe(0);
    expect(counter.dueBy('2026-03-28')).toBe(1);
    expect(counter.dueBy('2026-04-27')).toBe(0);
    expect(counter.dueBy('2026-04-28')).toBe(1);
  });

  it('lands every occurrence on a payment of a month-end monthly loan', () => {
    // The whole reason the cadence follows the engine. Twelve rows in 2026,
    // twelve occurrences, one each -- no month with none and no row carrying
    // two. The anchor-derived cadence gave 11 and then a doubled February.
    const result = generateLoanSchedule(
      baseInput({
        startingBalance: 100000,
        annualRate: 5,
        paymentAmount: 1000,
        frequency: 'MONTHLY',
        firstPaymentDate: new Date(2026, 0, 31),
        overpayments: { recurringExtra: { amount: 200, frequency: 'MONTHLY' } },
      }),
    );
    const in2026 = result.rows.filter((r) => r.date.startsWith('2026'));
    expect(in2026).toHaveLength(12);
    for (const row of in2026) {
      expect(row.extraPrincipal).toBeCloseTo(200, 2);
    }
  });

  it('yields 12 monthly occurrences a year from any anchor day', () => {
    // The invariant INV-LOAN-001 states, checked across every anchor day a month
    // can start on -- the 29th to 31st are the ones that used to lose one.
    for (const day of [1, 5, 15, 28, 29, 30, 31]) {
      const counter = recurringOccurrencesDue(
        { amount: 100, frequency: 'MONTHLY' },
        new Date(2026, 0, day),
      );
      // Sweep every day of 2026 so the count cannot depend on payment dates.
      let total = 0;
      const cursor = new Date(2026, 0, day);
      while (cursor.getFullYear() === 2026) {
        total += counter.dueBy(
          `${cursor.getFullYear()}-${String(cursor.getMonth() + 1).padStart(2, '0')}-${String(
            cursor.getDate(),
          ).padStart(2, '0')}`,
        );
        cursor.setDate(cursor.getDate() + 1);
      }
      expect(total).toBe(12);
    }
  });

  it('pays a month-end monthly extra on a biweekly loan without skipping a month', () => {
    // The reproduction: a biweekly loan whose first payment is 2026-01-31. The
    // old accumulation put the second occurrence on Mar 3 and every later one on
    // the 3rd, so February was skipped outright and the year paid 1100 of a
    // declared 1200.
    const result = generateLoanSchedule(
      baseInput({
        startingBalance: 400000,
        annualRate: 6,
        paymentAmount: calculateMortgagePaymentAmount(
          400000,
          6,
          360,
          'BIWEEKLY',
          'ANNUITY',
        ),
        frequency: 'BIWEEKLY',
        firstPaymentDate: new Date(2026, 0, 31),
        overpayments: { recurringExtra: { amount: 100, frequency: 'MONTHLY' } },
      }),
    );
    const paidBy = (throughIso: string) =>
      Math.round(
        result.rows
          .filter((r) => r.date <= throughIso)
          .reduce((sum, r) => sum + r.extraPrincipal, 0) * 100,
      ) / 100;

    // February's occurrence (the 28th, clamped from the 31st) lands on the
    // 2026-02-28 payment. The old code paid nothing at all that month.
    const february = result.rows.find((r) => r.date === '2026-02-28');
    expect(february?.extraPrincipal).toBeCloseTo(100, 2);

    // Twelve occurrences fall in 2026 -- the cadence absorbed February's clamp
    // and settled onto the 28th, so the last of the twelve is due 2026-12-28 and
    // the thirteenth is 2027-01-28. Twelve to a calendar year from any anchor
    // day is the invariant; which day of the month they land on is not.
    //
    // The PAYMENT carrying the twelfth is 2027-01-02, because a biweekly row
    // does not exist on 2026-12-28: an occurrence is applied at the first
    // payment on or after its due date, so a year's worth of cadence can be
    // completed a few days into the next year. That is the cadence being a
    // calendar of its own, which is the point.
    expect(paidBy('2026-12-31')).toBeCloseTo(1100, 2);
    expect(paidBy('2027-01-02')).toBeCloseTo(1200, 2);
    expect(paidBy('2027-01-27')).toBeCloseTo(1200, 2);
  });

  it('refuses a rowDate that goes backwards', () => {
    // The counter consumes occurrences, so an out-of-order call would silently
    // swallow everything between the two dates. Prose could not make that
    // checkable; the throw can.
    const counter = recurringOccurrencesDue(
      { amount: 100, frequency: 'MONTHLY' },
      new Date(2026, 0, 1),
    );
    expect(counter.dueBy('2026-06-01')).toBe(6);
    expect(() => counter.dueBy('2026-03-01')).toThrow(/precedes/);
    // Asking again for the same row is allowed (nothing new is due).
    expect(counter.dueBy('2026-06-01')).toBe(0);
  });

  it('never counts an occurrence before the first projected payment', () => {
    // A start date already in the past means "from now", not a backlog.
    const counter = recurringOccurrencesDue(
      { amount: 100, frequency: 'MONTHLY', startDate: '2020-01-01' },
      first,
    );
    expect(counter.dueBy('2026-01-01')).toBe(1);
    expect(counter.dueBy('2026-02-01')).toBe(1);
  });

  it('delays the first occurrence to a future start date', () => {
    const counter = recurringOccurrencesDue(
      { amount: 100, frequency: 'MONTHLY', startDate: '2026-04-10' },
      first,
    );
    expect(counter.dueBy('2026-04-01')).toBe(0);
    // The April 10 occurrence is carried by the first payment on or after it.
    expect(counter.dueBy('2026-05-01')).toBe(1);
    expect(counter.dueBy('2026-06-01')).toBe(1);
  });

  it('stops counting past the end date, and stays stopped', () => {
    const counter = recurringOccurrencesDue(
      { amount: 100, frequency: 'MONTHLY', endDate: '2026-06-30' },
      first,
    );
    let total = 0;
    for (const month of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]) {
      total += counter.dueBy(`2026-${String(month).padStart(2, '0')}-01`);
    }
    expect(total).toBe(6);
    expect(counter.dueBy('2027-01-01')).toBe(0);
  });

  it('contributes nothing for a cadence it does not recognize', () => {
    // `loan_scenarios.recurring_extra_frequency` is an unconstrained VARCHAR, so
    // a legacy row or a restored backup can carry a value the map has no key
    // for. The undefined lookup used to land in the legacy branch and apply the
    // FULL amount on every payment -- the densest possible reading of an unknown
    // value. Nothing is the direction that cannot invent a saving.
    const counter = recurringOccurrencesDue(
      { amount: 5000, frequency: 'ONE_OFF' as unknown as never },
      new Date(2026, 0, 1),
    );
    expect(counter.dueBy('2026-01-01')).toBe(0);
    expect(counter.dueBy('2027-01-01')).toBe(0);

    // And an omitted frequency still means the legacy per-payment amount, which
    // is a different thing from an unrecognized one.
    const legacy = recurringOccurrencesDue({ amount: 5000 }, new Date(2026, 0, 1));
    expect(legacy.dueBy('2026-01-01')).toBe(1);
  });

  it('treats an omitted frequency as one occurrence per in-window payment', () => {
    const counter = recurringOccurrencesDue({ amount: 100 }, first);
    expect(counter.dueBy('2026-01-01')).toBe(1);
    expect(counter.dueBy('2026-01-15')).toBe(1);
    const windowed = recurringOccurrencesDue(
      { amount: 100, startDate: '2026-03-01', endDate: '2026-04-30' },
      first,
    );
    expect(windowed.dueBy('2026-02-01')).toBe(0);
    expect(windowed.dueBy('2026-03-15')).toBe(1);
    expect(windowed.dueBy('2026-05-01')).toBe(0);
  });
});

describe('recurring overpayment cadence in a schedule', () => {
  /** Extra principal carried by rows dated within `year`. */
  const extraInYear = (
    rows: { date: string; extraPrincipal: number }[],
    year: number,
  ): number =>
    Math.round(
      rows
        .filter((r) => r.date.startsWith(String(year)))
        .reduce((sum, r) => sum + r.extraPrincipal, 0) * 100,
    ) / 100;

  /** Rows in `year` that carried any extra principal. */
  const hitsInYear = (
    rows: { date: string; extraPrincipal: number }[],
    year: number,
  ): number =>
    rows.filter((r) => r.date.startsWith(String(year)) && r.extraPrincipal > 0)
      .length;

  // A real 30-year contractual schedule from 2026-01-01, so the first calendar
  // years are complete whatever the overpayment does to the tail.
  const longLoan = (frequency: ScheduleFrequency): LoanScheduleInput =>
    baseInput({
      startingBalance: 400000,
      annualRate: 6,
      paymentAmount: calculateMortgagePaymentAmount(
        400000,
        6,
        360,
        frequency,
        'ANNUITY',
      ),
      frequency,
      firstPaymentDate: new Date(2026, 0, 1),
    });

  it('pays a MONTHLY extra 12 times a year on a BIWEEKLY loan, not 13', () => {
    // round(26 / 12) = 2 landed the extra every second biweekly payment: 13
    // hits a year and 8.3% more cash than the borrower asked to pay.
    const result = generateLoanSchedule({
      ...longLoan('BIWEEKLY'),
      overpayments: { recurringExtra: { amount: 100, frequency: 'MONTHLY' } },
    });
    expect(hitsInYear(result.rows, 2026)).toBe(12);
    expect(hitsInYear(result.rows, 2027)).toBe(12);
    expect(extraInYear(result.rows, 2026)).toBeCloseTo(1200, 2);
    expect(extraInYear(result.rows, 2027)).toBeCloseTo(1200, 2);
  });

  it('pays a MONTHLY extra 12 times a year on a WEEKLY loan', () => {
    // round(52 / 12) = 4 also produced 13 hits a year.
    const result = generateLoanSchedule({
      ...longLoan('WEEKLY'),
      overpayments: { recurringExtra: { amount: 100, frequency: 'MONTHLY' } },
    });
    expect(hitsInYear(result.rows, 2026)).toBe(12);
    expect(extraInYear(result.rows, 2026)).toBeCloseTo(1200, 2);
  });

  it('pays a QUARTERLY extra 4 times a year on a BIWEEKLY loan', () => {
    const result = generateLoanSchedule({
      ...longLoan('BIWEEKLY'),
      overpayments: { recurringExtra: { amount: 300, frequency: 'QUARTERLY' } },
    });
    expect(hitsInYear(result.rows, 2026)).toBe(4);
    expect(extraInYear(result.rows, 2026)).toBeCloseTo(1200, 2);
  });

  it('pays an ANNUALLY extra once a year, whatever the loan frequency', () => {
    for (const frequency of [
      'MONTHLY',
      'BIWEEKLY',
      'WEEKLY',
    ] as ScheduleFrequency[]) {
      const result = generateLoanSchedule({
        ...longLoan(frequency),
        overpayments: { recurringExtra: { amount: 5000, frequency: 'ANNUALLY' } },
      });
      expect(hitsInYear(result.rows, 2026)).toBe(1);
      expect(extraInYear(result.rows, 2026)).toBeCloseTo(5000, 2);
    }
  });

  it('carries a cadence denser than the payments as batched occurrences', () => {
    // Weekly occurrences on a monthly loan: payments on the 1st carry 4 or 5
    // occurrences each. 48 of the year's 52 land on a 2026 payment -- the four
    // due after 2026-12-01 are carried by the January 2027 payment, because an
    // occurrence is applied at the first payment on or after its due date.
    const result = generateLoanSchedule({
      ...longLoan('MONTHLY'),
      overpayments: { recurringExtra: { amount: 100, frequency: 'WEEKLY' } },
    });
    expect(hitsInYear(result.rows, 2026)).toBe(12);
    expect(extraInYear(result.rows, 2026)).toBeCloseTo(4800, 2);
    // Payment 1 carries only the occurrence due on its own date; every later
    // 2026 payment carries the four or five that fell since the previous one.
    expect(result.rows[0].extraPrincipal).toBeCloseTo(100, 2);
    for (const row of result.rows.filter(
      (r) => r.date.startsWith('2026') && r.date !== result.rows[0].date,
    )) {
      expect([400, 500]).toContain(Math.round(row.extraPrincipal));
    }
  });

  it('pays every occurrence exactly once across the whole schedule', () => {
    // The cumulative invariant: total extra principal is the amount times the
    // occurrences the schedule's own dates carried -- no double-counting and
    // nothing dropped, before the final payoff cap.
    const input = {
      ...longLoan('BIWEEKLY'),
      overpayments: {
        recurringExtra: { amount: 100, frequency: 'MONTHLY' as const },
      },
    };
    const result = generateLoanSchedule(input);
    const counter = recurringOccurrencesDue(
      input.overpayments.recurringExtra,
      input.firstPaymentDate,
    );
    const occurrences = result.rows.reduce(
      (sum, row) => sum + counter.dueBy(row.date),
      0,
    );
    // The last row's extra is capped at the remaining balance, so the total can
    // only fall short by less than one occurrence.
    expect(result.totalExtraPrincipal).toBeGreaterThan(occurrences * 100 - 100);
    expect(result.totalExtraPrincipal).toBeLessThanOrEqual(occurrences * 100);
  });

  it('starts the cadence at the window start, without a backlog', () => {
    const past = generateLoanSchedule({
      ...longLoan('MONTHLY'),
      overpayments: {
        recurringExtra: {
          amount: 100,
          frequency: 'MONTHLY',
          startDate: '2020-01-01',
        },
      },
    });
    expect(past.rows[0].extraPrincipal).toBeCloseTo(100, 2);
    expect(extraInYear(past.rows, 2026)).toBeCloseTo(1200, 2);

    const future = generateLoanSchedule({
      ...longLoan('MONTHLY'),
      overpayments: {
        recurringExtra: {
          amount: 100,
          frequency: 'MONTHLY',
          startDate: '2026-04-01',
        },
      },
    });
    expect(future.rows[0].extraPrincipal).toBe(0);
    expect(future.rows[3].date).toBe('2026-04-01');
    expect(future.rows[3].extraPrincipal).toBeCloseTo(100, 2);
    expect(extraInYear(future.rows, 2026)).toBeCloseTo(900, 2);
  });

  it('stops at the window end and never pays past it', () => {
    const result = generateLoanSchedule({
      ...longLoan('BIWEEKLY'),
      overpayments: {
        recurringExtra: {
          amount: 100,
          frequency: 'MONTHLY',
          endDate: '2026-06-30',
        },
      },
    });
    expect(hitsInYear(result.rows, 2026)).toBe(6);
    expect(extraInYear(result.rows, 2026)).toBeCloseTo(600, 2);
    expect(extraInYear(result.rows, 2027)).toBe(0);
  });
});

describe('projection horizon', () => {
  it('derives the default cap from the frequency, not a flat row count', () => {
    expect(DEFAULT_MAX_PROJECTION_YEARS).toBe(50);
    // 50 years of monthly payments is the 600 the flat default used to be.
    expect(maxPaymentsForHorizon('MONTHLY')).toBe(600);
    expect(maxPaymentsForHorizon('BIWEEKLY')).toBe(1300);
    expect(maxPaymentsForHorizon('WEEKLY')).toBe(2600);
    expect(maxPaymentsForHorizon('SEMI_MONTHLY')).toBe(1200);
    expect(maxPaymentsForHorizon('QUARTERLY')).toBe(200);
    expect(maxPaymentsForHorizon('YEARLY')).toBe(50);
  });

  it('clamps the derived cap to the hard maximum', () => {
    expect(maxPaymentsForHorizon('WEEKLY', 1000)).toBe(10000);
  });

  // Ordinary contractual terms that the flat 600-payment default cut short.
  const longTerms: [ScheduleFrequency, number, number][] = [
    ['BIWEEKLY', 300, 650],
    ['BIWEEKLY', 360, 780],
    ['WEEKLY', 300, 1300],
    ['WEEKLY', 360, 1560],
  ];

  it.each(longTerms)(
    'pays off an ordinary %s mortgage over %i months (%i payments)',
    (frequency, amortizationMonths, expectedPayments) => {
      const payment = calculateMortgagePaymentAmount(
        300000,
        5,
        amortizationMonths,
        frequency,
        'ANNUITY',
      );
      const result = generateLoanSchedule(
        baseInput({
          startingBalance: 300000,
          annualRate: 5,
          paymentAmount: payment,
          frequency,
        }),
      );
      expect(result.paidOff).toBe(true);
      expect(result.payoffDate).not.toBeNull();
      // The contractual count, give or take the rounding of the installment.
      expect(result.numPayments).toBeGreaterThan(expectedPayments - 3);
      expect(result.numPayments).toBeLessThanOrEqual(expectedPayments + 1);
      expect(result.numPayments).toBeGreaterThan(600);
    },
  );

  it('still stops a genuinely non-amortizing schedule at the horizon', () => {
    const result = generateLoanSchedule(
      // Barely amortizing: far longer than 50 years of monthly payments.
      baseInput({ startingBalance: 500000, annualRate: 6, paymentAmount: 2510 }),
    );
    expect(result.numPayments).toBe(600);
    expect(result.paidOff).toBe(false);
    expect(result.payoffDate).toBeNull();
  });
});

describe('a truncated schedule is not a lifetime total', () => {
  // 500k at 6% paying 2510/month runs well past the 50-year horizon.
  const truncating = () =>
    baseInput({ startingBalance: 500000, annualRate: 6, paymentAmount: 2510 });

  it('reports no interest saved when the baseline never pays off', () => {
    const baseline = generateLoanSchedule(truncating());
    const scenario = generateLoanSchedule({
      ...truncating(),
      overpayments: { recurringExtra: { amount: 100, frequency: 'MONTHLY' } },
    });
    expect(baseline.paidOff).toBe(false);
    // Both stop at the horizon, so both accumulated a horizon's interest. Their
    // difference is not a saving -- and it would even come out NEGATIVE here,
    // since the scenario's larger principal payments accrue less interest over
    // the same 600 rows while still not paying the loan off.
    expect(compareSchedules(baseline, scenario).interestSaved).toBeNull();
  });

  it('reports no interest saved when only the scenario pays off', () => {
    const baseline = generateLoanSchedule(truncating());
    const scenario = generateLoanSchedule({
      ...truncating(),
      overpayments: { recurringExtra: { amount: 4000, frequency: 'MONTHLY' } },
    });
    expect(baseline.paidOff).toBe(false);
    expect(scenario.paidOff).toBe(true);
    expect(compareSchedules(baseline, scenario).interestSaved).toBeNull();
  });

  it('reports a saving when both schedules pay off', () => {
    const baseline = generateLoanSchedule(baseInput());
    const scenario = generateLoanSchedule(
      baseInput({ overpayments: { recurringExtra: { amount: 200 } } }),
    );
    expect(baseline.paidOff).toBe(true);
    expect(compareSchedules(baseline, scenario).interestSaved).toBeGreaterThan(0);
  });
});

describe('lowerEndPeriod', () => {
  const input = {
    startingBalance: 250000,
    annualRate: 5.5,
    paymentAmount: 1600,
    frequency: 'MONTHLY' as const,
    firstPaymentDate: new Date(2026, 0, 15),
    overpayments: {
      recurringExtra: {
        amount: 300,
        frequency: 'MONTHLY' as const,
        mode: 'LOWER_INSTALLMENT' as const,
      },
    },
  };
  const baselineTerm = generateLoanSchedule({
    ...input,
    overpayments: undefined,
  }).numPayments;

  it('reproduces the schedule the engine derives for itself', () => {
    // The field is a performance shortcut for a value the engine would compute
    // by generating a second schedule -- so the only thing that makes it safe is
    // that supplying the right value changes nothing. A goal-seek runs ~30
    // candidates and every one of them used to pay for that second schedule.
    const derived = generateLoanSchedule(input);
    const supplied = generateLoanSchedule({
      ...input,
      lowerEndPeriod: baselineTerm,
    });
    expect(supplied.rows).toEqual(derived.rows);
    expect(supplied.payoffDate).toBe(derived.payoffDate);
    expect(supplied.totalInterest).toBe(derived.totalInterest);
    expect(supplied.finalPaymentAmount).toBe(derived.finalPaymentAmount);
  });

  it('is load-bearing, so the equality above is not vacuous', () => {
    // A wrong term re-levels the installment toward a schedule the loan does not
    // have. If this passed, the field would be ignored and the test above would
    // prove nothing.
    const wrong = generateLoanSchedule({
      ...input,
      lowerEndPeriod: Math.round(baselineTerm / 2),
    });
    expect(wrong.finalPaymentAmount).not.toBe(
      generateLoanSchedule(input).finalPaymentAmount,
    );
  });

  it('is ignored where the engine has no use for it', () => {
    // SHORTEN_TERM keeps the installment, so there is no term to re-level
    // toward; fixedEndPeriod supersedes it outright. Neither may be perturbed by
    // a value a caller threads through generically.
    const shorten = {
      ...input,
      overpayments: {
        recurringExtra: { amount: 300, frequency: 'MONTHLY' as const },
      },
    };
    expect(
      generateLoanSchedule({ ...shorten, lowerEndPeriod: 7 }).rows,
    ).toEqual(generateLoanSchedule(shorten).rows);
    expect(
      generateLoanSchedule({ ...input, fixedEndPeriod: 240, lowerEndPeriod: 7 }).rows,
    ).toEqual(generateLoanSchedule({ ...input, fixedEndPeriod: 240 }).rows);
  });
});
