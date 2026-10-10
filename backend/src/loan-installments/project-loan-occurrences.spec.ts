import {
  LoanOccurrence,
  LoanOccurrenceOverride,
  projectLoanOccurrences,
} from "./project-loan-occurrences";
import { expandOccurrenceSlots } from "../common/scheduled-occurrences";
import { Account } from "../accounts/entities/account.entity";
import { ScheduledTransaction } from "../scheduled-transactions/entities/scheduled-transaction.entity";
import { ScheduledTransactionSplit } from "../scheduled-transactions/entities/scheduled-transaction-split.entity";
import { RateTimelineRow } from "./price-installment";

/**
 * The occurrence projection (`docs/specs/scheduled-loan-installment-pricing.md`
 * section 8). Every figure is copied from the spec's tables 5.2 and 8.6, which
 * were produced by an independent period-by-period loop over fixture 5.1:
 * 100,000.00 over 300 monthly payments from 2023-02-03 at 5.0 %, payment
 * 584.59, and Timeline A (4.5 %, a stated 560.00, effective 2023-04-15).
 * The fold's inputs are handed in directly: the occurrences from the one
 * expander, the ledger debt per date as `datedLoanDebts` would answer it.
 */
describe("projectLoanOccurrences", () => {
  const loanAccountId = "acc-mortgage";
  const userId = "user-1";

  const makeMortgage = (overrides: Partial<Account> = {}): Account =>
    ({
      id: loanAccountId,
      userId,
      accountType: "MORTGAGE",
      name: "Mortgage",
      mortgageType: "ANNUITY",
      prepaymentMode: null,
      isCanadianMortgage: false,
      isVariableRate: false,
      interestRate: 5,
      paymentAmount: 584.59,
      extraPaymentAmount: null,
      paymentFrequency: "MONTHLY",
      paymentStartDate: "2023-02-03",
      amortizationMonths: 300,
      originalPrincipal: 100000,
      openingBalance: -100000,
      currentBalance: -100000,
      currencyCode: "CAD",
      interestCategoryId: "cat-interest",
      ...overrides,
    }) as unknown as Account;

  const makeSchedule = (
    overrides: Partial<ScheduledTransaction> = {},
  ): ScheduledTransaction =>
    ({
      id: "st-mortgage",
      userId,
      accountId: "acc-chequing",
      amount: -584.59,
      frequency: "MONTHLY",
      startDate: "2023-02-03",
      nextDueDate: "2023-02-03",
      endDate: null,
      occurrencesRemaining: null,
      currencyCode: "CAD",
      isActive: true,
      ...overrides,
    }) as unknown as ScheduledTransaction;

  const makeSplits = (
    principal = 167.92,
    interest = 416.67,
  ): ScheduledTransactionSplit[] =>
    [
      {
        id: "split-principal",
        transferAccountId: loanAccountId,
        categoryId: null,
        amount: -principal,
        memo: "Principal",
      },
      {
        id: "split-interest",
        transferAccountId: null,
        categoryId: "cat-interest",
        amount: -interest,
        memo: "Interest",
      },
    ] as unknown as ScheduledTransactionSplit[];

  /** The `initial` row plus Timeline A's stated change. */
  const timelineA: RateTimelineRow[] = [
    {
      effectiveDate: "2023-02-03",
      annualRate: 5,
      newPaymentAmount: 584.59,
      source: "initial",
    },
    {
      effectiveDate: "2023-04-15",
      annualRate: 4.5,
      newPaymentAmount: 560,
      source: "manual",
    },
  ];

  const occurrencesOf = (
    schedule: ScheduledTransaction,
    overrides: LoanOccurrenceOverride[],
    count: number,
  ) =>
    expandOccurrenceSlots(schedule, overrides, {
      through: "2030-12-31",
      maxOccurrences: count,
    });

  /** The ledger with nothing posted: the same debt at every date asked for. */
  const flatLedger = (
    occurrences: ReturnType<typeof occurrencesOf>,
    debt: number,
  ): Map<string, number> =>
    new Map(
      occurrences.flatMap((o) => [
        [o.originalDate, debt] as const,
        [o.dueDate, debt] as const,
      ]),
    );

  const project = (options: {
    account?: Account;
    schedule?: ScheduledTransaction;
    splits?: ScheduledTransactionSplit[];
    rateChanges?: RateTimelineRow[];
    overrides?: LoanOccurrenceOverride[];
    count?: number;
    debt?: number;
  }) => {
    const schedule = options.schedule ?? makeSchedule();
    const occurrences = occurrencesOf(
      schedule,
      options.overrides ?? [],
      options.count ?? 5,
    );
    return projectLoanOccurrences({
      schedule,
      splits: options.splits ?? makeSplits(),
      loanAccount: options.account ?? makeMortgage(),
      rateChanges: options.rateChanges ?? timelineA,
      occurrences,
      debtLedger: flatLedger(occurrences, options.debt ?? 100000),
    });
  };

  const figures = (row: LoanOccurrence) => ({
    dueDate: row.dueDate,
    amount: row.amount,
    interest: row.interest,
    principal: row.principal,
    debtBefore: row.debtBefore,
    annualRate: row.annualRate,
    complete: row.complete,
  });

  it("prices Timeline A with nothing posted as the five rows of table 5.2 (spec 8.6)", () => {
    const result = project({ count: 5 });
    expect(result.status).toBe("priced");
    expect(result.occurrences.map(figures)).toEqual([
      {
        dueDate: "2023-02-03",
        amount: 584.59,
        interest: 416.67,
        principal: 167.92,
        debtBefore: 100000,
        annualRate: 5,
        complete: true,
      },
      {
        dueDate: "2023-03-03",
        amount: 584.59,
        interest: 415.97,
        principal: 168.62,
        debtBefore: 99832.08,
        annualRate: 5,
        complete: true,
      },
      {
        dueDate: "2023-04-03",
        amount: 584.59,
        interest: 415.26,
        principal: 169.33,
        debtBefore: 99663.46,
        annualRate: 5,
        complete: true,
      },
      {
        dueDate: "2023-05-03",
        amount: 560,
        interest: 373.1,
        principal: 186.9,
        debtBefore: 99494.13,
        annualRate: 4.5,
        complete: true,
      },
      {
        dueDate: "2023-06-03",
        amount: 560,
        interest: 372.4,
        principal: 187.6,
        debtBefore: 99307.23,
        annualRate: 4.5,
        complete: true,
      },
    ]);
    expect(result.occurrences.map((o) => o.originalDate)).toEqual(
      result.occurrences.map((o) => o.dueDate),
    );
    expect(result.occurrences.every((o) => o.overrideId === null)).toBe(true);
    expect(result.occurrences.every((o) => o.extraPrincipal === 0)).toBe(true);
  });

  it("answers the first occurrence as the stored template, which is what posting it books (8.6)", () => {
    const [first] = project({ count: 1 }).occurrences;
    expect(first.amount).toBe(584.59);
    expect(Number(first.principal) + Number(first.interest)).toBe(first.amount);
  });

  it("shows the Scenario 2 template as posting would book it, and the chain healing after it (8.6, A13)", () => {
    const result = project({
      schedule: makeSchedule({ amount: -560 }),
      splits: makeSplits(185, 375),
      count: 2,
    });
    expect(result.occurrences.map(figures)).toEqual([
      {
        dueDate: "2023-02-03",
        amount: 560,
        interest: 416.67,
        principal: 143.33,
        debtBefore: 100000,
        annualRate: 5,
        complete: true,
      },
      {
        dueDate: "2023-03-03",
        amount: 584.59,
        interest: 416.07,
        principal: 168.52,
        debtBefore: 99856.67,
        annualRate: 5,
        complete: true,
      },
    ]);
  });

  describe("an override", () => {
    it("with an amount and no lines is the bill for that occurrence, divided at its date, and never the template (8.6)", () => {
      const result = project({
        overrides: [
          {
            id: "ovr-march",
            originalDate: "2023-03-03",
            overrideDate: "2023-03-03",
            amount: -610,
            splits: null,
          },
        ],
        count: 4,
      });
      expect(result.occurrences.map(figures)).toEqual([
        {
          dueDate: "2023-02-03",
          amount: 584.59,
          interest: 416.67,
          principal: 167.92,
          debtBefore: 100000,
          annualRate: 5,
          complete: true,
        },
        {
          dueDate: "2023-03-03",
          amount: 610,
          interest: 415.97,
          principal: 194.03,
          debtBefore: 99832.08,
          annualRate: 5,
          complete: true,
        },
        {
          dueDate: "2023-04-03",
          amount: 584.59,
          interest: 415.16,
          principal: 169.43,
          debtBefore: 99638.05,
          annualRate: 5,
          complete: true,
        },
        {
          dueDate: "2023-05-03",
          amount: 560,
          interest: 373.01,
          principal: 186.99,
          debtBefore: 99468.62,
          annualRate: 4.5,
          complete: true,
        },
      ]);
      expect(result.occurrences.map((o) => o.overrideId)).toEqual([
        null,
        "ovr-march",
        null,
        null,
      ]);
    });

    it("with an amount and its own lines keeps the lines as given and folds their principal and extra into the next debt", () => {
      const result = project({
        overrides: [
          {
            id: "ovr-march",
            originalDate: "2023-03-03",
            overrideDate: "2023-03-03",
            amount: -700,
            splits: [
              {
                categoryId: null,
                transferAccountId: loanAccountId,
                amount: -168.62,
                memo: "Principal",
              },
              {
                categoryId: "cat-interest",
                transferAccountId: null,
                amount: -415.97,
                memo: "Interest",
              },
              {
                categoryId: null,
                transferAccountId: loanAccountId,
                amount: -115.41,
                memo: "Extra Principal",
              },
            ],
          },
        ],
        count: 4,
      });
      const [, march, april, may] = result.occurrences;
      expect(march).toMatchObject({
        overrideId: "ovr-march",
        amount: 700,
        principal: 168.62,
        interest: 415.97,
        extraPrincipal: 115.41,
        debtBefore: 99832.08,
        complete: true,
      });
      // 99,832.08 - 168.62 - 115.41
      expect(figures(april)).toEqual({
        dueDate: "2023-04-03",
        amount: 584.59,
        interest: 414.78,
        principal: 169.81,
        debtBefore: 99548.05,
        annualRate: 5,
        complete: true,
      });
      expect(figures(may)).toEqual({
        dueDate: "2023-05-03",
        amount: 560,
        interest: 372.67,
        principal: 187.33,
        debtBefore: 99378.24,
        annualRate: 4.5,
        complete: true,
      });
    });

    it("whose lines the template identification does not recognise leaves its lines and every later debt unknown (8.3)", () => {
      const result = project({
        overrides: [
          {
            id: "ovr-march",
            originalDate: "2023-03-03",
            overrideDate: "2023-03-03",
            amount: -700,
            // A property-tax line and no interest line: not a shape the
            // core accounts for.
            splits: [
              {
                categoryId: "cat-tax",
                transferAccountId: null,
                amount: -700,
                memo: null,
              },
            ],
          },
        ],
        count: 3,
      });
      const [, march, april] = result.occurrences;
      expect(march).toEqual({
        originalDate: "2023-03-03",
        dueDate: "2023-03-03",
        overrideId: "ovr-march",
        amount: 700,
        principal: null,
        interest: null,
        extraPrincipal: null,
        annualRate: 5,
        debtBefore: 99832.08,
        complete: false,
      });
      expect(april).toMatchObject({
        amount: null,
        principal: null,
        debtBefore: null,
        complete: false,
      });
    });

    it("that only moves the date divides the chain's bill at the date it falls on, on the debt there", () => {
      const schedule = makeSchedule();
      const overrides: LoanOccurrenceOverride[] = [
        {
          id: "ovr-moved",
          originalDate: "2023-03-03",
          overrideDate: "2023-03-10",
          amount: null,
          splits: null,
        },
      ];
      const occurrences = occurrencesOf(schedule, overrides, 2);
      const result = projectLoanOccurrences({
        schedule,
        splits: makeSplits(),
        loanAccount: makeMortgage(),
        rateChanges: timelineA,
        occurrences,
        debtLedger: flatLedger(occurrences, 100000),
      });
      expect(result.occurrences[1]).toMatchObject({
        originalDate: "2023-03-03",
        dueDate: "2023-03-10",
        overrideId: "ovr-moved",
        amount: 584.59,
        interest: 415.97,
        principal: 168.62,
        debtBefore: 99832.08,
      });
    });
  });

  it("uses the ledger at each date, so a payment already recorded for a later date is counted at its date and not twice", () => {
    const schedule = makeSchedule();
    const occurrences = occurrencesOf(schedule, [], 3);
    // A 1,000.00 prepayment recorded for 2023-03-20: the ledger debt from
    // 2023-04-03 on is 1,000.00 lower, on top of what the projection books.
    const debtLedger = new Map<string, number>([
      ["2023-02-03", 100000],
      ["2023-03-03", 100000],
      ["2023-04-03", 99000],
    ]);
    const result = projectLoanOccurrences({
      schedule,
      splits: makeSplits(),
      loanAccount: makeMortgage(),
      rateChanges: timelineA,
      occurrences,
      debtLedger,
    });
    // 99,000.00 - 167.92 - 168.62
    expect(result.occurrences[2].debtBefore).toBe(98663.46);
    expect(result.occurrences[2].interest).toBe(411.1);
  });

  it("lists a retired debt as the payoff at zero and ends the projection after it (8.2)", () => {
    const result = project({ debt: 100, count: 4 });
    expect(result.occurrences).toHaveLength(2);
    expect(result.occurrences[0]).toMatchObject({
      amount: 100.42,
      principal: 100,
      interest: 0.42,
      debtBefore: 100,
      complete: true,
    });
    expect(result.occurrences[1]).toMatchObject({
      dueDate: "2023-03-03",
      amount: 0,
      principal: 0,
      interest: 0,
      extraPrincipal: 0,
      debtBefore: 0,
      complete: true,
    });
  });

  describe("missing data (8.4)", () => {
    it("reports an occurrence with no rate, and every later one, as unknown; the first keeps its debt", () => {
      const result = project({
        account: makeMortgage({ interestRate: null }),
        // Nothing dates a rate before 2023-04-15.
        rateChanges: [timelineA[1]],
        count: 4,
      });
      expect(result.status).toBe("priced");
      expect(result.occurrences.map(figures)).toEqual([
        {
          dueDate: "2023-02-03",
          amount: null,
          interest: null,
          principal: null,
          debtBefore: 100000,
          annualRate: null,
          complete: false,
        },
        {
          dueDate: "2023-03-03",
          amount: null,
          interest: null,
          principal: null,
          debtBefore: null,
          annualRate: null,
          complete: false,
        },
        {
          dueDate: "2023-04-03",
          amount: null,
          interest: null,
          principal: null,
          debtBefore: null,
          annualRate: null,
          complete: false,
        },
        {
          dueDate: "2023-05-03",
          amount: null,
          interest: null,
          principal: null,
          debtBefore: null,
          annualRate: 4.5,
          complete: false,
        },
      ]);
    });

    it("reports every occurrence as unknown on a cadence it cannot count, instead of the posting path's monthly default", () => {
      const result = project({
        account: makeMortgage({ paymentFrequency: "EVERY_SO_OFTEN" }),
        count: 2,
      });
      expect(result.occurrences.map((o) => o.complete)).toEqual([false, false]);
      expect(result.occurrences.map((o) => o.amount)).toEqual([null, null]);
    });

    it("keeps the template's amount when nothing dates a payment (the advancement's rule)", () => {
      const result = project({
        account: makeMortgage({ paymentAmount: null }),
        rateChanges: [
          {
            effectiveDate: "2023-02-03",
            annualRate: 5,
            newPaymentAmount: null,
            source: "initial",
          },
        ],
        count: 2,
      });
      expect(result.occurrences.map((o) => o.amount)).toEqual([584.59, 584.59]);
    });

    it("names a date the caller supplied no ledger debt for", () => {
      const schedule = makeSchedule();
      const occurrences = occurrencesOf(schedule, [], 2);
      expect(() =>
        projectLoanOccurrences({
          schedule,
          splits: makeSplits(),
          loanAccount: makeMortgage(),
          rateChanges: timelineA,
          occurrences,
          debtLedger: new Map([["2023-02-03", 100000]]),
        }),
      ).toThrow("2023-03-03");
    });
  });

  describe("declines", () => {
    it("a template whose lines it cannot account for", () => {
      const result = project({
        splits: [
          ...makeSplits(),
          {
            id: "split-escrow",
            transferAccountId: null,
            categoryId: "cat-escrow",
            amount: -50,
            memo: "Escrow",
          },
        ] as unknown as ScheduledTransactionSplit[],
      });
      expect(result).toEqual({
        status: "declined",
        reason: "1 line(s) beyond principal/interest/extra",
        occurrences: [],
      });
    });

    it("a LINEAR mortgage missing a method term, before any date is priced", () => {
      const result = project({
        account: makeMortgage({
          mortgageType: "LINEAR",
          paymentAmount: null,
          amortizationMonths: null,
        }),
      });
      expect(result).toEqual({
        status: "declined",
        reason: `the LINEAR mortgage ${loanAccountId} has no amortizationMonths`,
        occurrences: [],
      });
    });
  });

  it("answers no rows for no occurrences", () => {
    expect(
      projectLoanOccurrences({
        schedule: makeSchedule(),
        splits: makeSplits(),
        loanAccount: makeMortgage(),
        rateChanges: timelineA,
        occurrences: [],
        debtLedger: new Map(),
      }),
    ).toEqual({ status: "priced", occurrences: [] });
  });
});
