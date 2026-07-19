import { describe, it, expect } from 'vitest';
import {
  ScheduleFrequency,
  advanceDate,
  buildRateTimeline,
  calculateMortgagePaymentAmount,
  calculatePaymentForTerm,
  compareSchedules,
  effectiveAnnualRateOn,
  generateLoanSchedule,
  getPeriodicRate,
  getPeriodsPerYear,
  LoanScheduleInput,
} from './loan-schedule';

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
    expect(getPeriodicRate(5, 12, true, false)).toBeCloseTo(expected, 10);
  });

  it('uses semi-annual compounding for Canadian fixed biweekly payments', () => {
    const expected = Math.pow(1 + 0.05 / 2, 2 / 26) - 1;
    expect(getPeriodicRate(5, 26, true, false)).toBeCloseTo(expected, 10);
  });

  it('uses simple division for non-Canadian loans', () => {
    expect(getPeriodicRate(6, 12, false, false)).toBeCloseTo(0.005, 10);
    expect(getPeriodicRate(6, 26, false, false)).toBeCloseTo(6 / 100 / 26, 10);
  });

  it('uses simple division for Canadian variable-rate mortgages', () => {
    expect(getPeriodicRate(6, 12, true, true)).toBeCloseTo(0.005, 10);
  });

  it('yields a lower rate than simple division for Canadian fixed', () => {
    expect(getPeriodicRate(5, 12, true, false)).toBeLessThan(getPeriodicRate(5, 12, false, false));
  });

  it('returns 0 for a 0% annual rate', () => {
    expect(getPeriodicRate(0, 12, true, false)).toBe(0);
    expect(getPeriodicRate(0, 12, false, false)).toBe(0);
  });
});

describe('advanceDate', () => {
  it('advances weekly and biweekly by days', () => {
    expect(advanceDate(new Date(2026, 0, 1), 'WEEKLY')).toEqual(new Date(2026, 0, 8));
    expect(advanceDate(new Date(2026, 0, 1), 'BIWEEKLY')).toEqual(new Date(2026, 0, 15));
  });

  it('advances semi-monthly between the 1st and 15th', () => {
    expect(advanceDate(new Date(2026, 0, 1), 'SEMI_MONTHLY')).toEqual(new Date(2026, 0, 15));
    expect(advanceDate(new Date(2026, 0, 15), 'SEMI_MONTHLY')).toEqual(new Date(2026, 1, 1));
  });

  it('advances monthly, quarterly, and yearly by calendar units', () => {
    expect(advanceDate(new Date(2026, 0, 31), 'MONTHLY').getMonth()).toBe(2); // Jan 31 -> Mar 3 (JS overflow)
    expect(advanceDate(new Date(2026, 0, 15), 'QUARTERLY')).toEqual(new Date(2026, 3, 15));
    expect(advanceDate(new Date(2026, 0, 15), 'YEARLY')).toEqual(new Date(2027, 0, 15));
  });
});

describe('calculateMortgagePaymentAmount', () => {
  it('matches the backend fixture for a standard mortgage', () => {
    // $300,000 at 5% over 25 years, monthly, non-Canadian: ~1753.77
    const payment = calculateMortgagePaymentAmount(300000, 5, 300, 'MONTHLY', false, false);
    expect(payment).toBeCloseTo(1753.77, 0);
  });

  it('handles 0% interest as principal / payments', () => {
    expect(calculateMortgagePaymentAmount(120000, 0, 300, 'MONTHLY', false, false)).toBe(400);
  });

  it('computes Canadian fixed-rate payments with semi-annual compounding', () => {
    const canadian = calculateMortgagePaymentAmount(300000, 5, 300, 'MONTHLY', true, false);
    const standard = calculateMortgagePaymentAmount(300000, 5, 300, 'MONTHLY', false, false);
    expect(canadian).toBeLessThan(standard);
    expect(canadian).toBeCloseTo(1744.81, 0);
  });

  it('derives accelerated payments from the monthly payment', () => {
    const monthly = calculateMortgagePaymentAmount(300000, 5, 300, 'MONTHLY', false, false);
    const acceleratedBiweekly = calculateMortgagePaymentAmount(
      300000, 5, 300, 'ACCELERATED_BIWEEKLY', false, false,
    );
    const acceleratedWeekly = calculateMortgagePaymentAmount(
      300000, 5, 300, 'ACCELERATED_WEEKLY', false, false,
    );
    expect(acceleratedBiweekly).toBeCloseTo(monthly / 2, 2);
    expect(acceleratedWeekly).toBeCloseTo(monthly / 4, 2);
  });

  it('returns 0 for non-positive principal or term', () => {
    expect(calculateMortgagePaymentAmount(0, 5, 300, 'MONTHLY', false, false)).toBe(0);
    expect(calculateMortgagePaymentAmount(100000, 5, 0, 'MONTHLY', false, false)).toBe(0);
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
      baseInput({ startingBalance: 300000, paymentAmount: 2000, isCanadian: true }),
    );
    const standard = generateLoanSchedule(
      baseInput({ startingBalance: 300000, paymentAmount: 2000 }),
    );
    expect(canadian.totalInterest).toBeLessThan(standard.totalInterest);
    expect(canadian.numPayments).toBeLessThanOrEqual(standard.numPayments);
  });

  it('treats Canadian variable-rate as standard compounding', () => {
    const variable = generateLoanSchedule(
      baseInput({ isCanadian: true, isVariableRate: true }),
    );
    const standard = generateLoanSchedule(baseInput());
    expect(variable.totalInterest).toBe(standard.totalInterest);
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
        isCanadian: true,
        rateChanges: [{ effectiveDate: '2026-03-01', annualRate: 12 }],
      }),
    );
    const firstSegmentRate = getPeriodicRate(6, 12, true, false);
    const secondSegmentRate = getPeriodicRate(12, 12, true, false);
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

  it('returns zero months saved when either schedule never pays off', () => {
    const baseline = generateLoanSchedule(baseInput({ paymentAmount: 40 }));
    const scenario = generateLoanSchedule(
      baseInput({ paymentAmount: 40, overpayments: { recurringExtra: { amount: 200 } } }),
    );
    const comparison = compareSchedules(baseline, scenario);
    expect(comparison.monthsSaved).toBe(0);
  });
});

describe('calculatePaymentForTerm', () => {
  it('solves the annuity payment for a balance over a fixed term', () => {
    // 225400 over 300 monthly periods at 5% -> ~1317 (WMP worked example)
    const payment = calculatePaymentForTerm(225400, 5, 300, 'MONTHLY');
    expect(payment).toBeGreaterThan(1300);
    expect(payment).toBeLessThan(1335);
  });

  it('splits the balance evenly at 0% interest', () => {
    expect(calculatePaymentForTerm(12000, 0, 24, 'MONTHLY')).toBe(500);
  });

  it('returns 0 for a non-positive balance or term', () => {
    expect(calculatePaymentForTerm(0, 5, 300, 'MONTHLY')).toBe(0);
    expect(calculatePaymentForTerm(1000, 5, 0, 'MONTHLY')).toBe(0);
  });

  it('recovers the contractual payment that generateLoanSchedule amortizes', () => {
    // The payment that clears 10000 over the baseline term should reproduce
    // roughly the same number of periods.
    const baseline = generateLoanSchedule(baseInput());
    const payment = calculatePaymentForTerm(10000, 6, baseline.numPayments, 'MONTHLY');
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
    const installment = calculateMortgagePaymentAmount(200000, 4, 300, 'MONTHLY', false, false);
    return baseInput({
      startingBalance: 200000,
      annualRate: 4,
      paymentAmount: installment, // contractual installment -> ~300-month term
      frequency: 'MONTHLY',
      firstPaymentDate: new Date('2025-01-15'),
    });
  };

  it('spends the whole budget each period, splitting into a shrinking installment and a growing overpayment', () => {
    const budget = 4000;
    const result = generateLoanSchedule({
      ...budgetInput(),
      overpayments: { targetMonthlyPayment: budget },
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

  it('levels a cadence denser than the loan payments across every payment', () => {
    const base = baseInput({ startingBalance: 100000, paymentAmount: 600 });
    // Weekly on a monthly loan is approximated: ~100 * 52/12 each month.
    const weekly = generateLoanSchedule({
      ...base,
      overpayments: { recurringExtra: { amount: 100, frequency: 'WEEKLY' } },
    });
    expect(weekly.rows[0].extraPrincipal).toBeCloseTo((100 * 52) / 12, 2);
    expect(weekly.rows[1].extraPrincipal).toBeCloseTo((100 * 52) / 12, 2);
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
