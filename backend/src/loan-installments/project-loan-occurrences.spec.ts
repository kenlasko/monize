import {
  LoanOccurrence,
  LoanOccurrenceOverride,
  loanProjectionOccurrences,
  projectLoanOccurrences,
} from "./project-loan-occurrences";
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
  ) => loanProjectionOccurrences(schedule, overrides, count, "2030-12-31");

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
    const count = options.count ?? 5;
    const occurrences = occurrencesOf(schedule, options.overrides ?? [], count);
    return projectLoanOccurrences({
      schedule,
      splits: options.splits ?? makeSplits(),
      loanAccount: options.account ?? makeMortgage(),
      rateChanges: options.rateChanges ?? timelineA,
      occurrences,
      count,
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
        missing: { kind: "override-lines", overrideId: "ovr-march" },
      });
      expect(april).toMatchObject({
        amount: null,
        principal: null,
        debtBefore: null,
        complete: false,
        missing: { kind: "earlier-occurrence", originalDate: "2023-03-03" },
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
        count: 2,
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
      count: 3,
      debtLedger,
    });
    // 99,000.00 - 167.92 - 168.62
    expect(result.occurrences[2].debtBefore).toBe(98663.46);
    expect(result.occurrences[2].interest).toBe(411.1);
  });

  describe("a settled debt (8.2)", () => {
    it("ends the projection at the slot the final payment settles, as the advancement after it deactivates the schedule", () => {
      const result = project({ debt: 100, count: 4 });
      expect(result.occurrences).toHaveLength(1);
      expect(result.occurrences[0]).toMatchObject({
        amount: 100.42,
        principal: 100,
        interest: 0.42,
        debtBefore: 100,
        complete: true,
      });
    });

    it("lists the cursor of a settled debt as the payoff at zero, and nothing after it", () => {
      const result = project({ debt: 0, count: 4 });
      expect(result.occurrences).toEqual([
        {
          originalDate: "2023-02-03",
          dueDate: "2023-02-03",
          overrideId: null,
          amount: 0,
          principal: 0,
          interest: 0,
          extraPrincipal: 0,
          annualRate: 5,
          debtBefore: 0,
          complete: true,
          missing: null,
        },
      ]);
    });

    it("lists a payoff with no rate at its date as incomplete, naming the rate, without withholding the zero figures", () => {
      const result = project({
        account: makeMortgage({ interestRate: null }),
        rateChanges: [],
        debt: 0,
        count: 2,
      });
      expect(result.occurrences).toEqual([
        expect.objectContaining({
          amount: 0,
          principal: 0,
          interest: 0,
          annualRate: null,
          complete: false,
          missing: { kind: "rate", date: "2023-02-03" },
        }),
      ]);
    });

    it("ends the projection where the debt at the slot is settled even when the debt at the moved date is not", () => {
      // The cursor's 100.42 settles the loan by 2023-03-03; a charge recorded
      // for 2023-03-05 makes the debt at the moved date 50.00. The
      // advancement at the slot reads 0.00 and deactivates the schedule, so
      // the moved occurrence never posts.
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
      const occurrences = occurrencesOf(schedule, overrides, 3);
      const result = projectLoanOccurrences({
        schedule,
        splits: makeSplits(),
        loanAccount: makeMortgage(),
        rateChanges: timelineA,
        occurrences,
        count: 3,
        debtLedger: new Map([
          ["2023-02-03", 100],
          ["2023-03-03", 100],
          ["2023-03-10", 150],
          ["2023-04-03", 150],
        ]),
      });
      expect(result.occurrences.map((o) => o.originalDate)).toEqual([
        "2023-02-03",
      ]);
    });

    it("posts an override's amount on a settled debt, as post() does, and names what cannot be priced of it", () => {
      const result = project({
        overrides: [
          {
            id: "ovr-feb",
            originalDate: "2023-02-03",
            overrideDate: "2023-02-03",
            amount: -610,
            splits: null,
          },
        ],
        debt: 0,
        count: 2,
      });
      expect(result.occurrences[0]).toEqual({
        originalDate: "2023-02-03",
        dueDate: "2023-02-03",
        overrideId: "ovr-feb",
        amount: 610,
        principal: null,
        interest: null,
        extraPrincipal: null,
        annualRate: 5,
        debtBefore: 0,
        complete: false,
        missing: { kind: "override-on-settled-debt", overrideId: "ovr-feb" },
      });
    });

    it("books an override's own lines on a settled debt as given", () => {
      const result = project({
        overrides: [
          {
            id: "ovr-feb",
            originalDate: "2023-02-03",
            overrideDate: "2023-02-03",
            amount: -50,
            splits: [
              {
                categoryId: null,
                transferAccountId: loanAccountId,
                amount: -50,
                memo: "Principal",
              },
              {
                categoryId: "cat-interest",
                transferAccountId: null,
                amount: 0,
                memo: "Interest",
              },
            ],
          },
        ],
        debt: 0,
        count: 2,
      });
      expect(result.occurrences).toHaveLength(1);
      expect(result.occurrences[0]).toMatchObject({
        amount: 50,
        principal: 50,
        interest: 0,
        complete: true,
        missing: null,
      });
    });

    it("keeps a line of credit's schedule running at a settled debt and prices it again once it is drawn on", () => {
      const lineOfCredit = makeMortgage({
        accountType: "LINE_OF_CREDIT",
        mortgageType: null,
        paymentAmount: 100,
      } as Partial<Account>);
      const schedule = makeSchedule({ amount: -100 });
      const occurrences = occurrencesOf(schedule, [], 4);
      // A 1,200.00 draw recorded for 2023-04-15.
      const result = projectLoanOccurrences({
        schedule,
        splits: makeSplits(95, 5),
        loanAccount: lineOfCredit,
        rateChanges: [],
        occurrences,
        count: 4,
        debtLedger: new Map([
          ["2023-02-03", 0],
          ["2023-03-03", 0],
          ["2023-04-03", 0],
          ["2023-05-03", 1200],
        ]),
      });
      expect(result.occurrences.map(figures)).toEqual([
        {
          dueDate: "2023-02-03",
          amount: 0,
          interest: 0,
          principal: 0,
          debtBefore: 0,
          annualRate: 5,
          complete: true,
        },
        {
          dueDate: "2023-03-03",
          amount: 0,
          interest: 0,
          principal: 0,
          debtBefore: 0,
          annualRate: 5,
          complete: true,
        },
        {
          dueDate: "2023-04-03",
          amount: 0,
          interest: 0,
          principal: 0,
          debtBefore: 0,
          annualRate: 5,
          complete: true,
        },
        // 1,200.00 x 5 % / 12 = 5.00; the template's 100.00 stands.
        {
          dueDate: "2023-05-03",
          amount: 100,
          interest: 5,
          principal: 95,
          debtBefore: 1200,
          annualRate: 5,
          complete: true,
        },
      ]);
    });
  });

  describe("slot order", () => {
    it("bills the cursor's stored template to the cursor even when an override moves it past the next slot", () => {
      // The Scenario 2 template (560.00) at the cursor 2023-02-03, moved to
      // 2023-03-10, after the 2023-03-03 slot. `post()` claims the cursor
      // first, so the cursor posts the stored 560.00 and the 2023-03-03 slot
      // the advancement, 584.59; neither books before the other's date, so
      // both are priced on 100,000.00.
      const result = project({
        schedule: makeSchedule({ amount: -560 }),
        splits: makeSplits(185, 375),
        overrides: [
          {
            id: "ovr-cursor",
            originalDate: "2023-02-03",
            overrideDate: "2023-03-10",
            amount: null,
            splits: null,
          },
        ],
        count: 2,
      });
      expect(
        result.occurrences.map((o) => ({
          originalDate: o.originalDate,
          ...figures(o),
        })),
      ).toEqual([
        {
          originalDate: "2023-03-03",
          dueDate: "2023-03-03",
          amount: 584.59,
          interest: 416.67,
          principal: 167.92,
          debtBefore: 100000,
          annualRate: 5,
          complete: true,
        },
        {
          originalDate: "2023-02-03",
          dueDate: "2023-03-10",
          amount: 560,
          interest: 416.67,
          principal: 143.33,
          debtBefore: 100000,
          annualRate: 5,
          complete: true,
        },
      ]);
    });

    it("advances the chain through a slot moved past the reported rows without reporting it", () => {
      // The cursor moved to 2023-06-10: the first two by date are the
      // 2023-03-03 and 2023-04-03 slots, and the cursor still bills the
      // stored 560.00 while they bill the advancement.
      const schedule = makeSchedule({ amount: -560 });
      const overrides: LoanOccurrenceOverride[] = [
        {
          id: "ovr-cursor",
          originalDate: "2023-02-03",
          overrideDate: "2023-06-10",
          amount: null,
          splits: null,
        },
      ];
      const occurrences = occurrencesOf(schedule, overrides, 2);
      expect(occurrences.map((o) => o.originalDate)).toEqual([
        "2023-03-03",
        "2023-04-03",
        "2023-02-03",
      ]);
      const result = projectLoanOccurrences({
        schedule,
        splits: makeSplits(185, 375),
        loanAccount: makeMortgage(),
        rateChanges: timelineA,
        occurrences,
        count: 2,
        debtLedger: flatLedger(occurrences, 100000),
      });
      expect(result.occurrences.map((o) => [o.originalDate, o.amount])).toEqual(
        [
          ["2023-03-03", 584.59],
          ["2023-04-03", 584.59],
        ],
      );
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
      expect(result.occurrences.map((o) => o.missing)).toEqual([
        { kind: "rate", date: "2023-02-03" },
        { kind: "earlier-occurrence", originalDate: "2023-02-03" },
        { kind: "earlier-occurrence", originalDate: "2023-02-03" },
        { kind: "earlier-occurrence", originalDate: "2023-02-03" },
      ]);
    });

    it("reports every occurrence as unknown on a cadence it cannot count, instead of the posting path's monthly default", () => {
      const result = project({
        account: makeMortgage({ paymentFrequency: "EVERY_SO_OFTEN" }),
        count: 2,
      });
      expect(result.occurrences.map((o) => o.complete)).toEqual([false, false]);
      expect(result.occurrences.map((o) => o.amount)).toEqual([null, null]);
      expect(result.occurrences.map((o) => o.missing)).toEqual([
        { kind: "cadence", frequency: "EVERY_SO_OFTEN" },
        { kind: "cadence", frequency: "EVERY_SO_OFTEN" },
      ]);
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
          count: 2,
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
        count: 12,
        debtLedger: new Map(),
      }),
    ).toEqual({ status: "priced", occurrences: [] });
  });
});
