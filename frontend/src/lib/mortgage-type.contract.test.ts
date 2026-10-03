import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { roundMoney } from '@/lib/format';
import {
  calculatePaymentForTerm,
  effectiveAnnualRate,
  generateLoanSchedule,
  getPeriodicRate,
  getPeriodsPerYear,
  type ScheduleFrequency,
} from '@/lib/loan-schedule';
import { methodPrincipal, methodScheduleTerms } from '@/lib/mortgage-installment';
import {
  MORTGAGE_TYPE_TRAITS,
  amortizationMethodFor,
  type MortgageAmortizationMethod,
  type MortgageTypeTraits,
} from '@/lib/mortgage-type';
import { MORTGAGE_TYPES, type MortgageType } from '@/types/account';

/**
 * Each mortgage type's compounding, method and annualization are decided once
 * per layer (`MORTGAGE_TYPE_TRAITS` here and in
 * `backend/src/accounts/mortgage-type.util.ts`), and the two layers must agree
 * (INV-LOAN-003, INV-LOAN-007). They cannot import each other, so the truth
 * table lives in the backend's `mortgage-type-cases.json` and BOTH suites
 * assert it, as `loan-rate-timeline.contract.test.ts` does for its twin. A row
 * changed on either side is a row both must satisfy.
 */
const CASES_PATH = join(
  __dirname,
  '..',
  '..',
  '..',
  'backend',
  'src',
  'accounts',
  'mortgage-type-cases.json',
);

interface MortgageTypeCase {
  type: MortgageType;
  traits: MortgageTypeTraits;
  example: {
    principal: number;
    annualRate: number;
    periodsPerYear: number;
    totalPayments: number;
    periodicRate: number;
    firstPrincipal: number;
    firstInterest: number;
    effectiveAnnualRate: number;
  };
}

interface MortgageTypeCases {
  comment: string;
  types: MortgageTypeCase[];
}

const cases: MortgageTypeCases = JSON.parse(readFileSync(CASES_PATH, 'utf8'));

/** The cadence a case's payments-per-year names; the cases use these two. */
const FREQUENCY_BY_PERIODS: Record<number, ScheduleFrequency> = {
  12: 'MONTHLY',
  26: 'BIWEEKLY',
};

/**
 * The first installment's principal by method, at the first due date, where
 * the debt is the principal: the annuity payment less its interest, and for
 * LINEAR and INTEREST_ONLY the first row of the engine's own projection, so
 * the method branch of `generateLoanSchedule` is what the backend's figures
 * are held against.
 */
const FIRST_PRINCIPAL: Record<
  MortgageAmortizationMethod,
  (args: {
    principal: number;
    annualRate: number;
    periodicRate: number;
    totalPayments: number;
    frequency: ScheduleFrequency;
    type: MortgageType;
  }) => number
> = {
  ANNUITY: ({ principal, annualRate, periodicRate, totalPayments, frequency, type }) =>
    roundMoney(
      calculatePaymentForTerm(principal, annualRate, totalPayments, frequency, type) -
        roundMoney(principal * periodicRate),
    ),
  LINEAR: (args) => firstMethodPrincipal(args),
  INTEREST_ONLY: (args) => firstMethodPrincipal(args),
};

function firstMethodPrincipal({
  principal,
  annualRate,
  totalPayments,
  frequency,
  type,
}: {
  principal: number;
  annualRate: number;
  totalPayments: number;
  frequency: ScheduleFrequency;
  type: MortgageType;
}): number {
  const method = amortizationMethodFor(type);
  if (method === 'ANNUITY') throw new Error(`${type} is priced as an annuity`);
  const resolved = methodScheduleTerms(
    type,
    {
      originalPrincipal: principal,
      amortizationMonths: (totalPayments * 12) / getPeriodsPerYear(frequency),
      paymentStartDate: '2024-01-01',
      paymentFrequency: frequency,
    },
    '2024-01-01',
  );
  const terms = resolved?.terms;
  if (!terms) throw new Error('the case terms are complete');
  expect(terms.scheduledPayments).toBe(totalPayments);
  expect(terms.constantPrincipal).not.toBeNull();
  // Table 4.3 at storage precision, the rule every projected row applies...
  const firstPrincipal = methodPrincipal({
    method,
    mode: terms.prepaymentMode,
    debt: principal,
    // The case states its principal, so `c` is known.
    constantPrincipal: terms.constantPrincipal as number,
    remaining: terms.remainingAtFirstRow,
    count: terms.scheduledPayments,
  });
  // ...and the engine's first row, which carries it at cents.
  const [first] = generateLoanSchedule({
    startingBalance: principal,
    annualRate,
    paymentAmount: 0,
    frequency,
    mortgageType: type,
    methodTerms: terms,
    firstPaymentDate: new Date(2024, 0, 1),
    maxPayments: 1,
  }).rows;
  expect(first.principal).toBe(Math.round(firstPrincipal * 100) / 100);
  return firstPrincipal;
}

describe('mortgage-type-cases.json, shared with the backend', () => {
  it('reads the backend truth table', () => {
    expect(cases.comment).toContain('INV-LOAN-007');
  });

  it('has exactly one case per type', () => {
    expect(cases.types.map((c) => c.type).sort()).toEqual([...MORTGAGE_TYPES].sort());
  });

  it.each(cases.types.map((c) => [c.type, c] as const))(
    '%s: traits match MORTGAGE_TYPE_TRAITS',
    (type, c) => {
      expect(MORTGAGE_TYPE_TRAITS[type]).toEqual(c.traits);
    },
  );

  it.each(cases.types.map((c) => [c.type, c.example] as const))(
    '%s: the example reproduces through the type-keyed functions',
    (type, example) => {
      const frequency = FREQUENCY_BY_PERIODS[example.periodsPerYear];
      expect(frequency).toBeDefined();
      const periodicRate = getPeriodicRate(example.annualRate, example.periodsPerYear, type);
      expect(periodicRate).toBeCloseTo(example.periodicRate, 15);
      expect(roundMoney(example.principal * periodicRate)).toBe(example.firstInterest);
      expect(
        FIRST_PRINCIPAL[amortizationMethodFor(type)]({
          principal: example.principal,
          annualRate: example.annualRate,
          periodicRate,
          totalPayments: example.totalPayments,
          frequency,
          type,
        }),
      ).toBe(example.firstPrincipal);
      // The backend rounds the EAR to 2dp for its API; this layer returns the
      // raw percentage and each surface picks its precision.
      expect(
        Math.round(effectiveAnnualRate(example.annualRate, example.periodsPerYear, type) * 100) /
          100,
      ).toBe(example.effectiveAnnualRate);
    },
  );
});
