import { EntityManager } from "typeorm";
import { Account } from "../accounts/entities/account.entity";
import { ScheduledTransaction } from "../scheduled-transactions/entities/scheduled-transaction.entity";
import { ScheduledTransactionSplit } from "../scheduled-transactions/entities/scheduled-transaction-split.entity";
import { createScopedDbMocks } from "../test-helpers/scoped-db-testing";
import { LoanFeeTerms, originalPrincipalOf, priceLoanFee } from "./loan-fees";
import {
  datedAnnuityPayment,
  identifyLoanTemplate,
  InstallmentPurpose,
  priceInstallment,
} from "./price-installment";
import {
  loanProjectionOccurrences,
  projectLoanOccurrences,
} from "./project-loan-occurrences";
import { applyLoanTemplateRewrite } from "./reprice-template";

/**
 * Mortgage fees (`docs/specs/mortgage-fees.md`, INV-LOAN-011): the pure
 * pricing of one fee (section 3, table 3.1), the fee lines of a template
 * (section 4), and what each pricing purpose, the projection and the
 * template rewrite do with them (sections 5 and 6). The loan portion is
 * fixture 5.1 of the pricing spec: 100,000.00 at 5.0 % monthly, payment
 * 584.59 = 167.92 principal + 416.67 interest.
 */
describe("mortgage fees", () => {
  const facts = {
    debt: 400000,
    originalPrincipal: 400000,
    periodsPerYear: 12,
    decimals: 2,
  };
  const fee = (overrides: Partial<LoanFeeTerms>): LoanFeeTerms => ({
    categoryId: "cat-fee",
    name: "Fee",
    calculation: "FIXED",
    basis: "PER_PAYMENT",
    amount: null,
    rate: null,
    ...overrides,
  });

  describe("priceLoanFee (table 3.1)", () => {
    it.each([
      ["a fixed fee per payment", fee({ amount: 50 }), facts, 50],
      [
        "a fixed annual fee over 12 payments",
        fee({ amount: 3600, basis: "ANNUAL" }),
        facts,
        300,
      ],
      [
        "an annual percentage of the current balance",
        fee({
          calculation: "PERCENT_CURRENT_BALANCE",
          basis: "ANNUAL",
          rate: 0.5,
        }),
        facts,
        166.67,
      ],
      [
        "a per-payment percentage of the original balance",
        fee({ calculation: "PERCENT_ORIGINAL_BALANCE", rate: 0.02 }),
        facts,
        80,
      ],
      [
        "a fixed annual fee over 26 biweekly payments",
        fee({ amount: 1000, basis: "ANNUAL" }),
        { ...facts, periodsPerYear: 26 },
        38.46,
      ],
      [
        "a stored decimal string, as the column reads",
        fee({ amount: "50.0000" }),
        facts,
        50,
      ],
    ])("%s", (_label, terms, at, expected) => {
      expect(priceLoanFee(terms, at)).toEqual({
        kind: "ok",
        amount: expected,
      });
    });

    it("falls with the balance it is a percentage of", () => {
      const terms = fee({
        calculation: "PERCENT_CURRENT_BALANCE",
        basis: "ANNUAL",
        rate: 0.5,
      });
      expect(priceLoanFee(terms, { ...facts, debt: 390000 })).toEqual({
        kind: "ok",
        amount: 162.5,
      });
    });

    it("books in the currency's minor unit: whole yen", () => {
      expect(
        priceLoanFee(fee({ amount: 1000, basis: "ANNUAL" }), {
          ...facts,
          decimals: 0,
        }),
      ).toEqual({ kind: "ok", amount: 83 });
    });

    it("is unknown, not zero, when the original principal is unknown", () => {
      const priced = priceLoanFee(
        fee({ calculation: "PERCENT_ORIGINAL_BALANCE", rate: 0.02 }),
        { ...facts, originalPrincipal: null },
      );
      expect(priced.kind).toBe("unknown");
    });

    it("is unknown when the value its calculation reads is missing", () => {
      expect(priceLoanFee(fee({ amount: null }), facts).kind).toBe("unknown");
      expect(
        priceLoanFee(
          fee({ calculation: "PERCENT_CURRENT_BALANCE", amount: 50 }),
          facts,
        ).kind,
      ).toBe("unknown");
    });

    it("reads the original principal, else the opening debt", () => {
      expect(
        originalPrincipalOf({ originalPrincipal: 300000, openingBalance: -1 }),
      ).toBe(300000);
      expect(
        originalPrincipalOf({ originalPrincipal: null, openingBalance: -2500 }),
      ).toBe(2500);
      expect(
        originalPrincipalOf({ originalPrincipal: null, openingBalance: 0 }),
      ).toBeNull();
    });
  });

  const loanAccountId = "acc-mortgage";
  const makeMortgage = (overrides: Partial<Account> = {}): Account =>
    ({
      id: loanAccountId,
      userId: "user-1",
      accountType: "MORTGAGE",
      mortgageType: "ANNUITY",
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

  const insurance = fee({
    categoryId: "cat-insurance",
    name: "Mortgage insurance",
    amount: 50,
  });
  const defaultInsurance = fee({
    categoryId: "cat-default",
    name: "Default insurance",
    calculation: "PERCENT_CURRENT_BALANCE",
    basis: "ANNUAL",
    rate: 0.5,
  });
  const fees = [insurance, defaultInsurance];

  const line = (
    id: string,
    amount: number,
    rest: Partial<ScheduledTransactionSplit>,
  ): ScheduledTransactionSplit =>
    ({
      id,
      transferAccountId: null,
      categoryId: null,
      memo: null,
      amount: -amount,
      ...rest,
    }) as unknown as ScheduledTransactionSplit;

  /** 584.59 of loan, 50.00 insurance and 41.67 (100,000 x 0.5 % / 12). */
  const makeSplits = (): ScheduledTransactionSplit[] => [
    line("split-principal", 167.92, {
      transferAccountId: loanAccountId,
      memo: "Principal",
    }),
    line("split-interest", 416.67, {
      categoryId: "cat-interest",
      memo: "Interest",
    }),
    line("split-insurance", 50, {
      categoryId: "cat-insurance",
      memo: "Mortgage insurance",
    }),
    line("split-default", 41.67, {
      categoryId: "cat-default",
      memo: "Default insurance",
    }),
  ];
  const BILL = 676.26;

  describe("identifyLoanTemplate with fees (section 4)", () => {
    it("manages a template whose other lines are the configured fees", () => {
      const identified = identifyLoanTemplate(
        makeSplits(),
        makeMortgage(),
        fees,
      );
      expect(identified.managed).toBe(true);
      expect(identified.feeLines.map((l) => l.split.id)).toEqual([
        "split-insurance",
        "split-default",
      ]);
      expect(identified.feeLines.map((l) => l.fee)).toEqual(fees);
    });

    it("reads the fee lines as unaccounted for when no fee is configured", () => {
      expect(identifyLoanTemplate(makeSplits(), makeMortgage()).managed).toBe(
        false,
      );
    });

    it("leaves a second line on one fee's category unaccounted for", () => {
      const splits = [
        ...makeSplits(),
        line("split-insurance-2", 10, { categoryId: "cat-insurance" }),
      ];
      const identified = identifyLoanTemplate(splits, makeMortgage(), fees);
      expect(identified.managed).toBe(false);
      expect(identified.unmanagedLines.map((s) => s.id)).toEqual([
        "split-insurance-2",
      ]);
    });

    it("never reads the interest line as a fee's", () => {
      const onInterest = fee({ categoryId: "cat-interest", amount: 5 });
      const identified = identifyLoanTemplate(
        makeSplits().slice(0, 2),
        makeMortgage(),
        [onInterest],
      );
      expect(identified.managed).toBe(true);
      expect(identified.feeLines).toEqual([]);
      if (identified.managed) {
        expect(identified.interestSplit.id).toBe("split-interest");
      }
    });
  });

  const price = (
    purpose: InstallmentPurpose,
    options: {
      debt?: number;
      templateAmount?: number;
      account?: Account;
      splits?: ScheduledTransactionSplit[];
      fees?: LoanFeeTerms[];
    } = {},
  ) => {
    const account = options.account ?? makeMortgage();
    const identified = identifyLoanTemplate(
      options.splits ?? makeSplits(),
      account,
      options.fees ?? fees,
    );
    if (!identified.managed) throw new Error("fixture is not managed");
    return priceInstallment({
      debt: options.debt ?? 99832.08,
      annualRate: 5,
      loanAccount: account,
      template: identified,
      templateAmount: options.templateAmount ?? BILL,
      datedPayment: datedAnnuityPayment([], "2023-03-03", 584.59),
      paymentNewlyApplies: false,
      frequency: "MONTHLY",
      asOfDate: "2023-03-03",
      purpose,
    });
  };

  /** The same installment priced without fees: the loan portion alone. */
  const priceLoanOnly = (purpose: InstallmentPurpose, debt = 99832.08) => {
    const account = makeMortgage();
    const identified = identifyLoanTemplate(makeSplits().slice(0, 2), account);
    if (!identified.managed) throw new Error("fixture is not managed");
    return priceInstallment({
      debt,
      annualRate: 5,
      loanAccount: account,
      template: identified,
      templateAmount: 584.59,
      datedPayment: datedAnnuityPayment([], "2023-03-03", 584.59),
      paymentNewlyApplies: false,
      frequency: "MONTHLY",
      asOfDate: "2023-03-03",
      purpose,
    });
  };

  describe("priceInstallment with fee lines (section 5)", () => {
    it("reprices a template's balance fee at its date and bills loan + fees", () => {
      const priced = price("template");
      const loanOnly = priceLoanOnly("template");
      if (priced.kind !== "ok" || loanOnly.kind !== "ok") {
        throw new Error("declined");
      }
      // 99,832.08 x 0.5 % / 12 = 41.5967, booked 41.60; the fixed fee stands.
      expect(priced.fees.map((l) => l.amount)).toEqual([50, 41.6]);
      expect(priced.feeTotal).toBe(91.6);
      // The loan portion is priced exactly as it is without fees.
      expect(priced.allocation).toEqual(loanOnly.allocation);
      expect(priced.billTotal).toBe(584.59 + 91.6);
    });

    it("keeps the posting's fee lines as the bill showed them and re-divides only the rest", () => {
      const priced = price("posting");
      const loanOnly = priceLoanOnly("posting");
      if (priced.kind !== "ok" || loanOnly.kind !== "ok") {
        throw new Error("declined");
      }
      expect(priced.fees.map((l) => l.amount)).toEqual([50, 41.67]);
      expect(priced.allocation).toEqual(loanOnly.allocation);
      expect(priced.billTotal).toBe(BILL);
    });

    it("declines a bill smaller than its fee lines", () => {
      const priced = price("posting", { templateAmount: 80 });
      expect(priced.kind).toBe("declined");
    });

    it("declines a fee it cannot price rather than pricing it at zero", () => {
      const priced = price("template", {
        account: makeMortgage({
          originalPrincipal: null,
          openingBalance: 0,
        } as Partial<Account>),
        fees: [
          insurance,
          fee({
            categoryId: "cat-default",
            name: "Admin",
            calculation: "PERCENT_ORIGINAL_BALANCE",
            rate: 0.02,
          }),
        ],
      });
      expect(priced).toEqual({
        kind: "declined",
        reason: expect.stringContaining("Admin"),
      });
    });
  });

  describe("projectLoanOccurrences with fees (section 6)", () => {
    const schedule = {
      id: "st-mortgage",
      amount: -BILL,
      frequency: "MONTHLY",
      startDate: "2023-02-03",
      nextDueDate: "2023-02-03",
      endDate: null,
      occurrencesRemaining: null,
      currencyCode: "CAD",
      isActive: true,
    } as unknown as ScheduledTransaction;

    it("bills each occurrence its loan portion plus fees repriced on the folded debt", () => {
      const occurrences = loanProjectionOccurrences(
        schedule,
        [],
        2,
        "2030-12-31",
      );
      const debtLedger = new Map(
        occurrences.flatMap((o) => [
          [o.originalDate, 100000] as const,
          [o.dueDate, 100000] as const,
        ]),
      );
      const withFees = projectLoanOccurrences({
        schedule,
        splits: makeSplits(),
        loanAccount: makeMortgage(),
        rateChanges: [],
        occurrences,
        count: 2,
        debtLedger,
        fees,
      });
      const loanOnly = projectLoanOccurrences({
        schedule: { ...schedule, amount: -584.59 } as ScheduledTransaction,
        splits: makeSplits().slice(0, 2),
        loanAccount: makeMortgage(),
        rateChanges: [],
        occurrences,
        count: 2,
        debtLedger,
      });
      expect(withFees.status).toBe("priced");
      const [first, second] = withFees.occurrences;
      const [loanFirst, loanSecond] = loanOnly.occurrences;

      // The cursor carries the stored lines.
      expect(first.fees).toEqual([
        { categoryId: "cat-insurance", amount: 50 },
        { categoryId: "cat-default", amount: 41.67 },
      ]);
      expect(first.principal).toBe(loanFirst.principal);
      expect(first.interest).toBe(loanFirst.interest);
      expect(first.amount).toBe(BILL);

      // The next slot prices the balance fee on the debt the first leaves:
      // 100,000 - 167.92 = 99,832.08, x 0.5 % / 12 = 41.60.
      expect(second.fees).toEqual([
        { categoryId: "cat-insurance", amount: 50 },
        { categoryId: "cat-default", amount: 41.6 },
      ]);
      expect(second.principal).toBe(loanSecond.principal);
      expect(second.amount).toBe(
        Math.round(((loanSecond.amount as number) + 91.6) * 10000) / 10000,
      );
    });
  });

  describe("applyLoanTemplateRewrite with fees", () => {
    it("writes a changed fee line and a parent equal to loan + fees", async () => {
      const splits = makeSplits();
      const saved: Array<{ id: string; amount: number }> = [];
      const splitRepo = {
        save: jest.fn(async (s: ScheduledTransactionSplit) => {
          saved.push({ id: s.id, amount: Number(s.amount) });
          return s;
        }),
      };
      const scheduleRepo = { update: jest.fn() };
      const { manager } = createScopedDbMocks([
        [ScheduledTransactionSplit, splitRepo],
        [ScheduledTransaction, scheduleRepo],
      ]);
      const identified = identifyLoanTemplate(splits, makeMortgage(), fees);
      if (!identified.managed) throw new Error("fixture is not managed");
      const installment = priceInstallment({
        debt: 99832.08,
        annualRate: 5,
        loanAccount: makeMortgage(),
        template: identified,
        templateAmount: BILL,
        datedPayment: datedAnnuityPayment([], "2023-03-03", 584.59),
        paymentNewlyApplies: false,
        frequency: "MONTHLY",
        asOfDate: "2023-03-03",
        purpose: "template",
      });
      if (installment.kind !== "ok") throw new Error("declined");

      await applyLoanTemplateRewrite(manager as unknown as EntityManager, {
        scheduledTransaction: {
          id: "st-mortgage",
          nextDueDate: "2023-03-03",
        } as ScheduledTransaction,
        splits,
        loanAccount: makeMortgage(),
        installment,
      });

      // Only the balance fee moved; the fixed fee line is not rewritten.
      expect(saved.filter((s) => s.id.startsWith("split-d"))).toEqual([
        { id: "split-default", amount: -41.6 },
      ]);
      expect(saved.some((s) => s.id === "split-insurance")).toBe(false);
      expect(scheduleRepo.update).toHaveBeenCalledWith("st-mortgage", {
        amount: -installment.billTotal,
      });
      expect(installment.billTotal).toBe(
        Math.round((installment.allocation.total + 91.6) * 10000) / 10000,
      );
    });
  });
});
