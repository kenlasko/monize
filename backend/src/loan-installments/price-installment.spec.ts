import { EntityManager } from "typeorm";
import {
  datedAnnualRate,
  datedAnnuityPayment,
  DatedAnnuityPayment,
  datedPaymentAmount,
  identifyLoanTemplate,
  declineReason,
  InstallmentPurpose,
  paymentNewlyApplies,
  priceInstallment,
  resolveInstallmentCore,
} from "./price-installment";
import { ScheduledTransaction } from "../scheduled-transactions/entities/scheduled-transaction.entity";
import { ScheduledTransactionSplit } from "../scheduled-transactions/entities/scheduled-transaction-split.entity";
import { Account, AccountType } from "../accounts/entities/account.entity";
import { LoanRateChange } from "../loan-rate-changes/entities/loan-rate-change.entity";
import { bookLoanAllocation } from "../accounts/loan-payment-waterfall.util";
import { createScopedDbMocks } from "../test-helpers/scoped-db-testing";

/**
 * The pure pricing tail for the LINEAR and INTEREST_ONLY methods
 * (docs/specs/mortgage-types.md, sections 5.2 and 9, table 4.3). Every figure
 * is copied from the spec's section 7 tables, which were produced by an
 * independent period-by-period loop: EUR 300,000 over 360 monthly payments from
 * 2024-01-01, 2.00% until 4.00% from 2027-01-01, repayments of 20,000 on
 * 2025-07-01 and 15,000 on 2026-01-01. The debt each case prices is the spec's
 * "debt as posted", the figure `datedLoanDebt` returns; the rate is the one
 * the timeline resolves for the date, passed in directly because the tail is
 * pure. The service's own spec keeps the cases about what the service WRITES
 * (deactivation, the posting's booking, the method-change reprice, the
 * missing-term decline); these are the ones about the numbers.
 */
describe("priceInstallment", () => {
  const loanAccountId = "acc-mortgage";
  const userId = "user-1";

  const makeMortgage = (overrides: Partial<Account> = {}): Account =>
    ({
      id: loanAccountId,
      userId,
      accountType: "MORTGAGE",
      name: "Hypotheek",
      mortgageType: "LINEAR",
      prepaymentMode: null,
      isCanadianMortgage: false,
      isVariableRate: false,
      interestRate: 2,
      paymentAmount: null,
      extraPaymentAmount: null,
      paymentFrequency: "MONTHLY",
      paymentStartDate: "2024-01-01",
      amortizationMonths: 360,
      originalPrincipal: 300000,
      openingBalance: -300000,
      currentBalance: -300000,
      interestCategoryId: "cat-interest",
      ...overrides,
    }) as unknown as Account;

  const makeTemplate = (
    principal: number,
    interest: number,
    nextDueDate: string,
    extra?: number,
  ): ScheduledTransaction =>
    ({
      id: "st-mortgage",
      userId,
      accountId: "acc-chequing",
      name: "Mortgage Payment",
      amount: -(principal + interest + (extra ?? 0)),
      frequency: "MONTHLY",
      nextDueDate,
      isActive: true,
      splits: [
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
        ...(extra
          ? [
              {
                id: "split-extra",
                transferAccountId: loanAccountId,
                categoryId: null,
                amount: -extra,
                memo: "Extra Principal",
              },
            ]
          : []),
      ],
    }) as unknown as ScheduledTransaction;

  /**
   * Price the template at its own due date, with the rate the timeline gives.
   * With no timeline the dated payment is `accounts.payment_amount` (spec
   * 7.1), which is what these fixtures state; a case about a stated payment
   * passes its own.
   */
  const price = (
    account: Account,
    template: ScheduledTransaction,
    debt: number,
    annualRate: number,
    purpose: InstallmentPurpose = "template",
    dated: {
      datedPayment?: DatedAnnuityPayment | null;
      paymentNewlyApplies?: boolean;
    } = {},
  ) => {
    const identified = identifyLoanTemplate(
      template.splits as ScheduledTransactionSplit[],
      account,
    );
    if (!identified.managed) {
      throw new Error("fixture is not a managed template");
    }
    return priceInstallment({
      debt,
      annualRate,
      loanAccount: account,
      template: identified,
      templateAmount: Math.abs(Number(template.amount)),
      datedPayment:
        dated.datedPayment === undefined
          ? datedAnnuityPayment([], template.nextDueDate, account.paymentAmount)
          : dated.datedPayment,
      paymentNewlyApplies: dated.paymentNewlyApplies ?? false,
      frequency: account.paymentFrequency || template.frequency,
      asOfDate: template.nextDueDate,
      purpose,
    });
  };

  /** The allocation of a priced installment: principal, interest, extra, parent. */
  const priced = (...args: Parameters<typeof price>) => {
    const result = price(...args);
    if (result.kind !== "ok") {
      throw new Error(`expected a priced installment, got ${result.kind}`);
    }
    return {
      principal: result.allocation.principal,
      interest: result.allocation.interest,
      extra: result.allocation.extraPrincipal,
      parent: result.allocation.total,
    };
  };

  describe("LINEAR, SHORTEN_TERM (spec table 7.1)", () => {
    it("keeps the principal constant through a rate change; only the interest moves", () => {
      const account = makeMortgage();

      const december = priced(
        account,
        makeTemplate(833.3333, 393.6111, "2026-12-01"),
        235833.3345,
        2,
      );
      expect(december).toEqual({
        principal: 833.3333,
        interest: 393.0556,
        extra: 0,
        parent: 1226.3889,
      });

      const january = priced(
        account,
        makeTemplate(833.3333, 393.0556, "2027-01-01"),
        235000.0012,
        4,
      );
      expect(january).toEqual({
        principal: 833.3333,
        interest: 783.3333,
        extra: 0,
        parent: 1616.6666,
      });
    });

    it("prices 2027-01-01 on a ledger posted at cents: 833.33 and 783.33", () => {
      // 36 installments of 833.33 and 35,000 of repayments leave 235,000.12.
      const result = priced(
        makeMortgage(),
        makeTemplate(833.3333, 393.0556, "2027-01-01"),
        235000.12,
        4,
      );
      expect(result.principal).toBe(833.3333);
      expect(result.interest).toBe(783.3337);
      expect(Math.round(result.interest * 100) / 100).toBe(783.33);
    });

    it("prices a ledger recorded at statement cents from what it holds (table 7.2)", () => {
      const result = priced(
        makeMortgage(),
        makeTemplate(833.3333, 443.0556, "2025-07-01"),
        265000.06,
        2,
      );
      expect(result).toMatchObject({
        principal: 833.3333,
        interest: 441.6668,
        parent: 1275.0001,
      });
    });

    it("lets the final installment absorb the leftover", () => {
      const final = priced(
        makeMortgage(),
        makeTemplate(833.3333, 5.5555, "2050-06-01"),
        833.3439,
        4,
      );
      expect(final).toEqual({
        principal: 833.3439,
        interest: 2.7778,
        extra: 0,
        parent: 836.1217,
      });
    });

    it("grows the template to the method installment, unbounded by payment_amount", () => {
      // payment_amount is null for LINEAR (spec decision 11); the template
      // still advances to c + interest + the standing extra.
      const result = priced(
        makeMortgage({ extraPaymentAmount: 100 }),
        makeTemplate(833.3333, 393.0556, "2027-01-01", 100),
        235000.0012,
        4,
      );
      expect(result).toEqual({
        principal: 833.3333,
        interest: 783.3333,
        extra: 100,
        parent: 1716.6666,
      });
    });

    it("reads a mortgage whose original_principal is null from its opening balance", () => {
      const result = priced(
        makeMortgage({ originalPrincipal: null }),
        makeTemplate(833.3333, 500, "2024-02-01"),
        299166.6667,
        2,
      );
      expect(result).toMatchObject({ principal: 833.3333, interest: 498.6111 });
    });
  });

  describe("LINEAR, LOWER_INSTALLMENT (spec table 7.3)", () => {
    it("re-derives the principal from the next due date after a prepayment", () => {
      const account = makeMortgage({ prepaymentMode: "LOWER_INSTALLMENT" });
      const template = makeTemplate(833.3333, 474.7222, "2025-07-01");

      // Before the 20,000 repayment reaches the ledger: 285,000.0006 over 342.
      const before = priced(account, template, 285000.0006, 2);
      expect(before.principal).toBe(833.3333);

      // After it: the same due date re-derives 265,000.0006 / 342.
      const after = priced(account, template, 265000.0006, 2);
      expect(after).toEqual({
        principal: 774.8538,
        interest: 441.6667,
        extra: 0,
        parent: 1216.5205,
      });
    });

    it("keeps the principal through a rate change", () => {
      const result = priced(
        makeMortgage({ prepaymentMode: "LOWER_INSTALLMENT" }),
        makeTemplate(730.2109, 395.0, "2027-01-01"),
        236588.347,
        4,
      );
      expect(result).toEqual({
        principal: 730.2109,
        interest: 788.6278,
        extra: 0,
        parent: 1518.8387,
      });
    });

    it("counts remaining payments from the calendar for a due date moved off it", () => {
      // 2025-07-10 is k = 19, the same as 2025-07-01: remaining 342.
      const result = priced(
        makeMortgage({ prepaymentMode: "LOWER_INSTALLMENT" }),
        makeTemplate(833.3333, 474.7222, "2025-07-10"),
        265000.0006,
        2,
      );
      expect(result.principal).toBe(774.8538);
    });

    it("pays the whole debt on payment N", () => {
      const result = priced(
        makeMortgage({ prepaymentMode: "LOWER_INSTALLMENT" }),
        makeTemplate(730.2109, 4.8679, "2053-12-01"),
        730.2109,
        4,
      );
      expect(result).toEqual({
        principal: 730.2109,
        interest: 2.434,
        extra: 0,
        parent: 732.6449,
      });
    });
  });

  describe("INTEREST_ONLY (spec table 7.4 and section 9)", () => {
    const interestOnly = () =>
      makeMortgage({ mortgageType: "INTEREST_ONLY", prepaymentMode: null });

    it("keeps the principal line at zero and prices the interest", () => {
      const result = priced(
        interestOnly(),
        makeTemplate(0, 441.6667, "2027-01-01"),
        265000,
        4,
      );
      expect(result.principal).toBe(0);
      expect(result.interest).toBe(883.3333);
      expect(result.parent).toBe(883.3333);
    });

    it("writes the bullet into the principal line before payment N", () => {
      const result = priced(
        interestOnly(),
        makeTemplate(0, 883.3333, "2053-12-01"),
        265000,
        4,
      );
      expect(result).toEqual({
        principal: 265000,
        interest: 883.3333,
        extra: 0,
        parent: 265883.3333,
      });
    });
  });

  describe("missing terms (spec section 8)", () => {
    it("declines a LINEAR mortgage without its calendar, naming the term", () => {
      const result = price(
        makeMortgage({ paymentStartDate: null }),
        makeTemplate(833.3333, 500, "2024-02-01"),
        299166.6667,
        2,
      );
      expect(result).toEqual({
        kind: "declined",
        reason: `the LINEAR mortgage ${loanAccountId} has no paymentStartDate`,
      });
    });
  });

  /**
   * The settlement purpose (`docs/specs/loan-installment-settlement.md`
   * section 7, the spec's 9.2 annuity: 200,000 at 6 % monthly, payment 1,500).
   * The template may hold a clamp written for one installment; the settlement
   * prices the configured payment, and takes the extra line as it stands.
   */
  describe('purpose "settlement"', () => {
    const annuityLoan = (overrides: Partial<Account> = {}): Account =>
      makeMortgage({
        accountType: AccountType.LOAN,
        mortgageType: null,
        interestRate: 6,
        paymentAmount: 1500,
        paymentStartDate: null,
        amortizationMonths: null,
        originalPrincipal: null,
        ...overrides,
      });

    it("prices an annuity at the dated payment, not the template's clamped amount", () => {
      const result = priced(
        annuityLoan(),
        makeTemplate(480, 1000, "2024-02-01"),
        200000,
        6,
        "settlement",
      );
      expect(result).toEqual({
        principal: 500,
        interest: 1000,
        extra: 0,
        parent: 1500,
      });
    });

    it("takes a stated payment exactly, down as well as up, with the template's extra on top of a stated base", () => {
      const stated: DatedAnnuityPayment = {
        amount: 1400,
        statesBase: true,
        effectiveDate: "2024-01-15",
        source: "manual",
      };
      expect(
        priced(
          annuityLoan(),
          makeTemplate(480, 1000, "2024-02-01", 100),
          200000,
          6,
          "settlement",
          { datedPayment: stated },
        ),
      ).toEqual({ principal: 400, interest: 1000, extra: 100, parent: 1500 });
      // The account column and an `initial` row hold the extra already.
      expect(
        priced(
          annuityLoan(),
          makeTemplate(480, 1000, "2024-02-01", 100),
          200000,
          6,
          "settlement",
          { datedPayment: { ...stated, statesBase: false, source: "initial" } },
        ),
      ).toEqual({ principal: 300, interest: 1000, extra: 100, parent: 1400 });
    });

    it("falls back to the template's amount when nothing dates a payment", () => {
      // The planner refuses before pricing (`missing: ["payment"]`); the
      // tail itself keeps the bill as it stands.
      const result = priced(
        annuityLoan({ paymentAmount: null }),
        makeTemplate(500, 1000, "2024-02-01"),
        200000,
        6,
        "settlement",
      );
      expect(result).toEqual({
        principal: 500,
        interest: 1000,
        extra: 0,
        parent: 1500,
      });
    });

    it("takes the template's standing extra line where a reconfigure grows it toward the account's", () => {
      const account = annuityLoan({ extraPaymentAmount: 300 });
      const template = makeTemplate(400, 1000, "2024-02-01", 100);

      const settlement = priced(account, template, 200000, 6, "settlement");
      expect(settlement).toEqual({
        principal: 400,
        interest: 1000,
        extra: 100,
        parent: 1500,
      });

      const reconfigure = priced(account, template, 200000, 6, "reconfigure");
      expect(reconfigure).toEqual({
        principal: 200,
        interest: 1000,
        extra: 300,
        parent: 1500,
      });
    });

    it("prices LINEAR through the method installment as the template purpose does", () => {
      const template = makeTemplate(833.3333, 393.0556, "2027-01-01");
      const settlement = priced(
        makeMortgage(),
        template,
        235000.0012,
        4,
        "settlement",
      );
      expect(settlement).toEqual(
        priced(makeMortgage(), template, 235000.0012, 4),
      );
      expect(settlement.principal).toBe(833.3333);
      expect(settlement.interest).toBe(783.3333);
    });
  });

  describe('purpose "sync" (the rate-change sync, spec 7.5)', () => {
    const annuityLoan = (overrides: Partial<Account> = {}): Account =>
      makeMortgage({
        accountType: AccountType.LOAN,
        mortgageType: null,
        interestRate: 6,
        paymentAmount: 1500,
        paymentStartDate: null,
        amortizationMonths: null,
        originalPrincipal: null,
        ...overrides,
      });

    it("takes the dated payment exactly, replacing a raised template, where the advancement keeps the max", () => {
      const raised = makeTemplate(600, 1000, "2024-02-01");
      expect(priced(annuityLoan(), raised, 200000, 6, "sync")).toEqual({
        principal: 500,
        interest: 1000,
        extra: 0,
        parent: 1500,
      });
      expect(priced(annuityLoan(), raised, 200000, 6, "template").parent).toBe(
        1600,
      );
    });

    it("takes a stated payment exactly, down as well as up, with the standing extra on top of a stated base", () => {
      const stated: DatedAnnuityPayment = {
        amount: 1400,
        statesBase: true,
        effectiveDate: "2024-01-15",
        source: "manual",
      };
      expect(
        priced(
          annuityLoan(),
          makeTemplate(480, 1000, "2024-02-01", 100),
          200000,
          6,
          "sync",
          { datedPayment: stated },
        ),
      ).toEqual({ principal: 400, interest: 1000, extra: 100, parent: 1500 });
    });

    it("grows the extra line back toward the account's configured extra, as every template rewrite does", () => {
      expect(
        priced(
          annuityLoan({ extraPaymentAmount: 300 }),
          makeTemplate(400, 1000, "2024-02-01", 100),
          200000,
          6,
          "sync",
        ),
      ).toEqual({ principal: 200, interest: 1000, extra: 300, parent: 1500 });
    });

    it("keeps the template's amount when nothing dates a payment", () => {
      expect(
        priced(
          annuityLoan({ paymentAmount: null }),
          makeTemplate(500, 1000, "2024-02-01"),
          200000,
          6,
          "sync",
        ),
      ).toEqual({ principal: 500, interest: 1000, extra: 0, parent: 1500 });
    });

    it("prices LINEAR through the method installment as the template purpose does", () => {
      const template = makeTemplate(833.3333, 393.0556, "2027-01-01");
      expect(priced(makeMortgage(), template, 235000.0012, 4, "sync")).toEqual(
        priced(makeMortgage(), template, 235000.0012, 4),
      );
    });
  });

  describe("identifyLoanTemplate", () => {
    it("names the principal, interest and extra lines of a managed template", () => {
      const template = makeTemplate(800, 500, "2024-02-01", 100);
      const identified = identifyLoanTemplate(
        template.splits as ScheduledTransactionSplit[],
        makeMortgage(),
      );
      expect(identified.managed).toBe(true);
      expect(identified.principalSplit?.id).toBe("split-principal");
      expect(identified.interestSplit?.id).toBe("split-interest");
      expect(identified.extraPrincipalSplit?.id).toBe("split-extra");
      expect(identified.unmanagedLines).toEqual([]);
    });

    it("reports a line it cannot account for, with the reason a caller logs", () => {
      const template = makeTemplate(800, 500, "2024-02-01");
      const splits = [
        ...(template.splits as ScheduledTransactionSplit[]),
        {
          id: "split-escrow",
          transferAccountId: null,
          categoryId: "cat-escrow",
          amount: -200,
          memo: "Escrow",
        } as unknown as ScheduledTransactionSplit,
      ];
      const account = makeMortgage();
      const identified = identifyLoanTemplate(splits, account);
      expect(identified.managed).toBe(false);
      if (identified.managed) throw new Error("unreachable");
      expect(identified.unmanagedLines.map((s) => s.id)).toEqual([
        "split-escrow",
      ]);
      expect(declineReason(identified, account)).toBe(
        "1 line(s) beyond principal/interest/extra",
      );
    });

    it("cannot pick the interest line from several categorized lines without a configured category", () => {
      const template = makeTemplate(800, 500, "2024-02-01");
      const splits = [
        ...(template.splits as ScheduledTransactionSplit[]),
        {
          id: "split-escrow",
          transferAccountId: null,
          categoryId: "cat-escrow",
          amount: -200,
          memo: "Escrow",
        } as unknown as ScheduledTransactionSplit,
      ];
      const account = makeMortgage({ interestCategoryId: null });
      const identified = identifyLoanTemplate(splits, account);
      expect(identified.managed).toBe(false);
      if (identified.managed) throw new Error("unreachable");
      expect(declineReason(identified, account)).toBe(
        `2 categorized lines and no interest category configured on account ${loanAccountId}`,
      );
    });
  });

  /**
   * The I/O half: the rate comes from the timeline dated at the boundary, and
   * a rate nothing records is `null` -- which the template and posting
   * purposes read as 0 % (the posting path's historical default, spec section
   * 15 item 5) and the settlement refuses (decision 16).
   */
  describe("datedAnnualRate and the core's missing-rate rule", () => {
    let manager: Record<string, jest.Mock>;
    let rateChangesRepository: Record<string, jest.Mock>;
    let ledgerDebt: number;

    const m = () => manager as unknown as EntityManager;

    beforeEach(() => {
      rateChangesRepository = { find: jest.fn().mockResolvedValue([]) };
      manager = createScopedDbMocks([
        [LoanRateChange, rateChangesRepository],
      ]).manager;
      ledgerDebt = 235000.0012;
      manager.query.mockImplementation(async (sql: unknown) =>
        String(sql).includes("opening_balance")
          ? [{ balance: String(-ledgerDebt) }]
          : [],
      );
    });

    it("resolves the timeline's rate for the date, not the account's scalar", async () => {
      rateChangesRepository.find.mockResolvedValue([
        { effectiveDate: "2024-01-01", annualRate: "2.0000" },
        { effectiveDate: "2027-01-01", annualRate: "4.0000" },
      ]);
      const account = makeMortgage({ interestRate: 9 });
      await expect(datedAnnualRate(m(), account, "2026-12-01")).resolves.toBe(
        2,
      );
      await expect(datedAnnualRate(m(), account, "2027-01-01")).resolves.toBe(
        4,
      );
      expect(rateChangesRepository.find).toHaveBeenCalledWith({
        where: { accountId: loanAccountId },
        order: { effectiveDate: "ASC" },
      });
    });

    it("falls back to the account's scalar when no row applies", async () => {
      await expect(
        datedAnnualRate(
          m(),
          // A raw read hands a decimal back as a string; the rule reads both.
          makeMortgage({ interestRate: "3.5" } as unknown as Partial<Account>),
          "2024-02-01",
        ),
      ).resolves.toBe(3.5);
    });

    it.each([[null], [undefined], ["not a number"]])(
      "answers null, not 0, when nothing records a rate (scalar %p)",
      async (interestRate) => {
        await expect(
          datedAnnualRate(
            m(),
            makeMortgage({ interestRate } as unknown as Partial<Account>),
            "2024-02-01",
          ),
        ).resolves.toBeNull();
      },
    );

    it("prices the template purpose at 0 % when no rate is recorded, the posting path's default", async () => {
      const template = makeTemplate(833.3333, 393.0556, "2027-01-01");
      const result = await resolveInstallmentCore(m(), {
        scheduledTransaction: template,
        splits: template.splits as ScheduledTransactionSplit[],
        loanAccount: makeMortgage({ interestRate: null }),
        asOfDate: "2027-01-01",
        purpose: "template",
      });
      expect(result.kind).toBe("ok");
      if (result.kind !== "ok") throw new Error("unreachable");
      expect(result.annualRate).toBe(0);
      expect(result.allocation).toMatchObject({
        principal: 833.3333,
        interest: 0,
      });
    });

    it("declines the sync purpose when no rate is recorded: an offer never prices 0 %", async () => {
      const template = makeTemplate(833.3333, 393.0556, "2027-01-01");
      const result = await resolveInstallmentCore(m(), {
        scheduledTransaction: template,
        splits: template.splits as ScheduledTransactionSplit[],
        loanAccount: makeMortgage({ interestRate: null }),
        asOfDate: "2027-01-01",
        purpose: "sync",
      });
      expect(result).toEqual({
        kind: "declined",
        reason: `no interest rate is recorded for loan account ${loanAccountId} on 2027-01-01`,
      });
    });

    it("declines the settlement purpose when no rate is recorded, naming the rate and the date", async () => {
      const template = makeTemplate(833.3333, 393.0556, "2027-01-01");
      const result = await resolveInstallmentCore(m(), {
        scheduledTransaction: template,
        splits: template.splits as ScheduledTransactionSplit[],
        loanAccount: makeMortgage({ interestRate: null }),
        asOfDate: "2027-01-01",
        purpose: "settlement",
      });
      expect(result).toEqual({
        kind: "declined",
        reason: `no interest rate is recorded for loan account ${loanAccountId} on 2027-01-01`,
      });
    });

    it("reports a retired debt before asking for a rate: zero needs none", async () => {
      ledgerDebt = 0;
      const template = makeTemplate(833.3333, 393.0556, "2027-01-01");
      const result = await resolveInstallmentCore(m(), {
        scheduledTransaction: template,
        splits: template.splits as ScheduledTransactionSplit[],
        loanAccount: makeMortgage({ interestRate: null }),
        asOfDate: "2027-01-01",
        purpose: "settlement",
      });
      expect(result).toEqual({ kind: "paid-off", debt: 0, managed: true });
    });

    it("prices the settlement at the timeline's rate once one applies", async () => {
      rateChangesRepository.find.mockResolvedValue([
        { effectiveDate: "2027-01-01", annualRate: "4.0000" },
      ]);
      const template = makeTemplate(833.3333, 393.0556, "2027-01-01");
      const result = await resolveInstallmentCore(m(), {
        scheduledTransaction: template,
        splits: template.splits as ScheduledTransactionSplit[],
        loanAccount: makeMortgage({ interestRate: null }),
        asOfDate: "2027-01-01",
        purpose: "settlement",
      });
      expect(result.kind).toBe("ok");
      if (result.kind !== "ok") throw new Error("unreachable");
      expect(result.annualRate).toBe(4);
      expect(result.allocation).toMatchObject({
        principal: 833.3333,
        interest: 783.3333,
      });
    });

    it("declines an annuity settlement nothing states a payment for, naming the payment and the date", async () => {
      rateChangesRepository.find.mockResolvedValue([
        { effectiveDate: "2024-01-01", annualRate: "6.0000" },
      ]);
      const template = makeTemplate(500, 1000, "2024-02-01");
      const result = await resolveInstallmentCore(m(), {
        scheduledTransaction: template,
        splits: template.splits as ScheduledTransactionSplit[],
        loanAccount: makeMortgage({
          accountType: AccountType.LOAN,
          mortgageType: null,
          paymentAmount: null,
        }),
        asOfDate: "2024-02-01",
        purpose: "settlement",
      });
      expect(result).toEqual({
        kind: "declined",
        reason: `no payment is recorded for loan account ${loanAccountId} on 2024-02-01`,
      });
    });

    it("reads the dated payment through the same read as the rate", async () => {
      rateChangesRepository.find.mockResolvedValue([
        {
          effectiveDate: "2024-01-01",
          annualRate: "6.0000",
          newPaymentAmount: "1500.0000",
          source: "manual",
        },
      ]);
      const account = makeMortgage({ paymentAmount: 1000 });
      await expect(
        datedPaymentAmount(m(), account, "2023-12-31"),
      ).resolves.toEqual({
        amount: 1000,
        statesBase: false,
        effectiveDate: null,
        source: null,
      });
      await expect(
        datedPaymentAmount(m(), account, "2024-01-01"),
      ).resolves.toEqual({
        amount: 1500,
        statesBase: true,
        effectiveDate: "2024-01-01",
        source: "manual",
      });
      expect(rateChangesRepository.find).toHaveBeenCalledWith({
        where: { accountId: loanAccountId },
        order: { effectiveDate: "ASC" },
      });
    });
  });

  /**
   * The one rule for the annuity payment at a date (INV-LOAN-009, spec 7.1;
   * the settlement spec's decision 12), asserted once for every caller: the
   * advancement, the settlement, the sync and the projection.
   */
  describe("datedAnnuityPayment (spec 7.1, settlement decision 12)", () => {
    const rows = [
      { effectiveDate: "2024-01-01", newPaymentAmount: 1500, source: "manual" },
      { effectiveDate: "2024-03-01", newPaymentAmount: null, source: "manual" },
      {
        effectiveDate: "2024-06-01",
        newPaymentAmount: "1600.0000",
        source: "inferred",
      },
    ] as unknown as LoanRateChange[];

    it("is the latest row on or before the date that carries one, stating the base", () => {
      expect(datedAnnuityPayment(rows, "2024-04-01", 1000)).toEqual({
        amount: 1500,
        statesBase: true,
        effectiveDate: "2024-01-01",
        source: "manual",
      });
      expect(datedAnnuityPayment(rows, "2024-06-01", 1000)).toEqual({
        amount: 1600,
        statesBase: true,
        effectiveDate: "2024-06-01",
        source: "inferred",
      });
      expect(datedAnnuityPayment(rows, "2024-07-15", 1000)).toMatchObject({
        amount: 1600,
        effectiveDate: "2024-06-01",
      });
    });

    it("an initial row is a copy of accounts.payment_amount and holds the extra", () => {
      const initial = [
        {
          effectiveDate: "2024-01-01",
          newPaymentAmount: 1600,
          source: "initial",
        },
      ] as unknown as LoanRateChange[];
      expect(datedAnnuityPayment(initial, "2024-02-01", null)).toEqual({
        amount: 1600,
        statesBase: false,
        effectiveDate: "2024-01-01",
        source: "initial",
      });
    });

    it("falls back to the account's payment before any row applies, and to null without one", () => {
      expect(datedAnnuityPayment(rows, "2023-12-31", 1000)).toEqual({
        amount: 1000,
        statesBase: false,
        effectiveDate: null,
        source: null,
      });
      expect(datedAnnuityPayment(rows, "2023-12-31", "1200.5")).toMatchObject({
        amount: 1200.5,
        statesBase: false,
      });
      expect(datedAnnuityPayment(rows, "2023-12-31", null)).toBeNull();
      expect(datedAnnuityPayment(rows, "2023-12-31", 0)).toBeNull();
      expect(datedAnnuityPayment([], "2024-01-01", undefined)).toBeNull();
    });

    it("a tie on the date goes to the row read last", () => {
      const tied = [
        {
          effectiveDate: "2024-01-01",
          newPaymentAmount: 1500,
          source: "manual",
        },
        {
          effectiveDate: "2024-01-01",
          newPaymentAmount: 1550,
          source: "manual",
        },
      ] as unknown as LoanRateChange[];
      expect(datedAnnuityPayment(tied, "2024-01-01", null)?.amount).toBe(1550);
    });
  });

  describe("paymentNewlyApplies (spec 7.3)", () => {
    const stated = (
      overrides: Partial<DatedAnnuityPayment> = {},
    ): DatedAnnuityPayment => ({
      amount: 560,
      statesBase: true,
      effectiveDate: "2023-04-15",
      source: "manual",
      ...overrides,
    });

    it("holds when a manual or inferred row is dated after the slot before the installment", () => {
      expect(paymentNewlyApplies(stated(), "2023-04-03")).toBe(true);
      expect(
        paymentNewlyApplies(stated({ source: "inferred" }), "2023-04-03"),
      ).toBe(true);
      // Dated on the preceding slot: it applied to that installment already.
      expect(paymentNewlyApplies(stated(), "2023-04-15")).toBe(false);
      expect(paymentNewlyApplies(stated(), "2023-05-03")).toBe(false);
    });

    it("never holds for an initial row, the account column, no payment or no preceding slot", () => {
      expect(
        paymentNewlyApplies(
          stated({ source: "initial", statesBase: false }),
          "2023-04-03",
        ),
      ).toBe(false);
      expect(
        paymentNewlyApplies(
          stated({ effectiveDate: null, source: null, statesBase: false }),
          "2023-04-03",
        ),
      ).toBe(false);
      expect(paymentNewlyApplies(null, "2023-04-03")).toBe(false);
      expect(paymentNewlyApplies(stated(), null)).toBe(false);
    });
  });

  /**
   * Fixture 5.1 of `docs/specs/scheduled-loan-installment-pricing.md`: ANNUITY,
   * 100,000.00 over 300 monthly payments from 2023-02-03, 584.59 at 5.0 %,
   * the `initial` row 5.0 % / 584.59 effective 2023-02-03. Every row of
   * table 7.4 (the advancement) and of table 5.3 (Timeline B, successive
   * advancements), the figures copied from the spec and compared in cents
   * (`bookLoanAllocation`, the booking the posting applies). The debt each
   * case prices is the spec's "debt before", the figure `datedLoanDebt`
   * returns; the calendar is the schedule's (`start_date` 2023-02-03,
   * monthly), from which the core reads the slot before `D`.
   */
  describe("the dated payment: the advancement (spec tables 7.4 and 5.3)", () => {
    let manager: Record<string, jest.Mock>;
    let rateChangesRepository: Record<string, jest.Mock>;
    let ledgerDebt: number;

    const m = () => manager as unknown as EntityManager;

    const annuity = (overrides: Partial<Account> = {}): Account =>
      makeMortgage({
        mortgageType: "ANNUITY",
        prepaymentMode: null,
        interestRate: 5,
        paymentAmount: 584.59,
        extraPaymentAmount: null,
        paymentStartDate: "2023-02-03" as unknown as Date,
        amortizationMonths: 300,
        originalPrincipal: 100000,
        openingBalance: -100000,
        currentBalance: -100000,
        ...overrides,
      });

    const rateRow = (
      effectiveDate: string,
      annualRate: number,
      newPaymentAmount: number | null,
      source: "initial" | "manual" | "inferred" = "manual",
    ) =>
      ({
        effectiveDate,
        annualRate: annualRate.toFixed(4),
        newPaymentAmount:
          newPaymentAmount === null ? null : newPaymentAmount.toFixed(4),
        source,
      }) as unknown as LoanRateChange;
    const initial = rateRow("2023-02-03", 5, 584.59, "initial");
    const timelineA = [initial, rateRow("2023-04-15", 4.5, 560)];
    const timelineB = [
      initial,
      rateRow("2024-05-15", 4.5, 557),
      rateRow("2025-06-15", 4.0, 531.1),
    ];

    /** A template holding `amount` (its lines do not price; the extra line does). */
    const templateOf = (amount: number, extra = 0) =>
      makeTemplate(amount - extra, 0, "2023-02-03", extra);

    beforeEach(() => {
      rateChangesRepository = { find: jest.fn().mockResolvedValue([]) };
      manager = createScopedDbMocks([
        [LoanRateChange, rateChangesRepository],
      ]).manager;
      manager.query.mockImplementation(async (sql: unknown) =>
        String(sql).includes("opening_balance")
          ? [{ balance: String(-ledgerDebt) }]
          : [],
      );
    });

    interface AdvanceCase {
      timeline: LoanRateChange[];
      template: ScheduledTransaction;
      /** The new `next_due_date`. */
      D: string;
      debt: number;
      account?: Account;
      startDate?: string;
      purpose?: InstallmentPurpose;
    }

    /** What `rewriteLoanTemplate` writes for `D`, booked in cents. */
    const advance = async ({
      timeline,
      template,
      D,
      debt,
      account = annuity(),
      startDate = "2023-02-03",
      purpose = "template",
    }: AdvanceCase) => {
      rateChangesRepository.find.mockResolvedValue(timeline);
      ledgerDebt = debt;
      const result = await resolveInstallmentCore(m(), {
        scheduledTransaction: {
          amount: template.amount,
          frequency: "MONTHLY",
          startDate,
          nextDueDate: D,
          endDate: null,
          occurrencesRemaining: null,
        },
        splits: template.splits as ScheduledTransactionSplit[],
        loanAccount: account,
        asOfDate: D,
        purpose,
      });
      if (result.kind !== "ok") {
        throw new Error(`expected a priced installment, got ${result.kind}`);
      }
      const booked = bookLoanAllocation(result.allocation, 2, debt);
      return {
        payment: booked.total,
        interest: booked.interest,
        principal: booked.principal,
        extra: booked.extraPrincipal,
        debt: result.debt,
      };
    };

    it.each([
      [
        "A1 stated down, newly applies",
        {
          timeline: timelineA,
          template: templateOf(584.59),
          D: "2023-05-03",
          debt: 99494.13,
        },
        { payment: 560, interest: 373.1, principal: 186.9 },
      ],
      [
        "A2 one installment later: max(560.00, 560.00)",
        {
          timeline: timelineA,
          template: templateOf(560),
          D: "2023-06-03",
          debt: 99307.23,
        },
        { payment: 560, interest: 372.4, principal: 187.6 },
      ],
      [
        "A3 stated up, newly applies",
        {
          timeline: [initial, rateRow("2023-04-15", 5.5, 610)],
          template: templateOf(584.59),
          D: "2023-05-03",
          debt: 99494.13,
        },
        { payment: 610, interest: 456.01, principal: 153.99 },
      ],
      [
        "A4 rate only: the initial row's payment, max(584.59, 584.59)",
        {
          timeline: [initial, rateRow("2023-04-15", 4.5, null)],
          template: templateOf(584.59),
          D: "2023-05-03",
          debt: 99494.13,
        },
        { payment: 584.59, interest: 373.1, principal: 211.49 },
      ],
      [
        "A5 two stated changes between postings: the later one",
        {
          timeline: [
            initial,
            rateRow("2023-04-10", 4.75, 572),
            rateRow("2023-04-20", 4.5, 560),
          ],
          template: templateOf(584.59),
          D: "2023-05-03",
          debt: 99494.13,
        },
        { payment: 560, interest: 373.1, principal: 186.9 },
      ],
      [
        "A6 two changes, the later rate only: the earlier payment at the later rate",
        {
          timeline: [
            initial,
            rateRow("2023-04-10", 4.75, 572),
            rateRow("2023-04-20", 4.5, null),
          ],
          template: templateOf(584.59),
          D: "2023-05-03",
          debt: 99494.13,
        },
        { payment: 572, interest: 373.1, principal: 198.9 },
      ],
      [
        "A7 a user-raised template with no change: max(600.00, 584.59)",
        {
          timeline: [initial],
          template: templateOf(600),
          D: "2023-04-03",
          debt: 99648.05,
        },
        { payment: 600, interest: 415.2, principal: 184.8 },
      ],
      [
        "A8 the raise is replaced when a stated payment newly applies (decision 2)",
        {
          timeline: timelineA,
          template: templateOf(600),
          D: "2023-05-03",
          debt: 99463.25,
        },
        { payment: 560, interest: 372.99, principal: 187.01 },
      ],
      [
        "A9 the final-installment clamp",
        {
          timeline: [initial],
          template: templateOf(584.59),
          D: "2043-01-03",
          debt: 300,
        },
        { payment: 301.25, interest: 1.25, principal: 300 },
      ],
      [
        "A10 the grow-back after a void restored the debt",
        {
          timeline: [initial],
          template: templateOf(301.25),
          D: "2043-02-03",
          debt: 10000,
        },
        { payment: 584.59, interest: 41.67, principal: 542.92 },
      ],
      [
        "A11 the grow-back steps into a stated payment dated after the clamped slot",
        {
          timeline: [initial, rateRow("2043-01-10", 4.5, 560)],
          template: templateOf(301.25),
          D: "2043-02-03",
          debt: 10000,
        },
        { payment: 560, interest: 37.5, principal: 522.5 },
      ],
      [
        "A12 no rate-change row: max(584.59, accounts.payment_amount)",
        {
          timeline: [],
          template: templateOf(584.59),
          D: "2023-03-03",
          debt: 99832.08,
        },
        { payment: 584.59, interest: 415.97, principal: 168.62 },
      ],
      [
        "A13 Scenario 2 data before a resync heals one installment late",
        {
          timeline: [initial],
          template: templateOf(560),
          D: "2023-03-03",
          debt: 99856.67,
        },
        { payment: 584.59, interest: 416.07, principal: 168.52 },
      ],
      [
        "A14 a stated base takes the standing extra on top",
        {
          timeline: [
            rateRow("2023-02-03", 5, 634.59, "initial"),
            rateRow("2023-04-15", 4.5, 560),
          ],
          template: templateOf(634.59, 50),
          D: "2023-05-03",
          debt: 99343.51,
          account: annuity({ paymentAmount: 634.59, extraPaymentAmount: 50 }),
        },
        { payment: 610, interest: 372.54, principal: 187.46, extra: 50 },
      ],
      [
        "A15 no row: the account's payment holds the extra already",
        {
          timeline: [],
          template: templateOf(634.59, 50),
          D: "2023-03-03",
          debt: 99782.08,
          account: annuity({ paymentAmount: 634.59, extraPaymentAmount: 50 }),
        },
        { payment: 634.59, interest: 415.76, principal: 168.83, extra: 50 },
      ],
      [
        "A16 an initial row dated the day before the first change never newly applies",
        {
          timeline: [
            rateRow("2023-04-14", 5, 584.59, "initial"),
            rateRow("2023-04-15", 4.5, null),
          ],
          template: templateOf(600),
          D: "2023-05-03",
          debt: 99463.25,
          account: annuity({ paymentStartDate: null }),
        },
        { payment: 600, interest: 372.99, principal: 227.01 },
      ],
    ] as Array<[string, AdvanceCase, Record<string, number>]>)(
      "%s",
      async (_name, advanceCase, expected) => {
        await expect(advance(advanceCase)).resolves.toMatchObject({
          extra: 0,
          ...expected,
          debt: advanceCase.debt,
        });
      },
    );

    it("Timeline B, installments 16, 17, 29 and 30 through successive advancements (table 5.3)", async () => {
      // 16: 2024-05-15 is after the due date, not yet in effect.
      await expect(
        advance({
          timeline: timelineB,
          template: templateOf(584.59),
          D: "2024-05-03",
          debt: 97406.35,
        }),
      ).resolves.toMatchObject({
        payment: 584.59,
        interest: 405.86,
        principal: 178.73,
      });
      // 17: newly applies, the preceding slot 2024-05-03 < 2024-05-15.
      await expect(
        advance({
          timeline: timelineB,
          template: templateOf(584.59),
          D: "2024-06-03",
          debt: 97227.62,
        }),
      ).resolves.toMatchObject({
        payment: 557,
        interest: 364.6,
        principal: 192.4,
      });
      // 29: 2025-06-15 is after the due date.
      await expect(
        advance({
          timeline: timelineB,
          template: templateOf(557),
          D: "2025-06-03",
          debt: 94870.65,
        }),
      ).resolves.toMatchObject({
        payment: 557,
        interest: 355.76,
        principal: 201.24,
      });
      // 30: newly applies, the preceding slot 2025-06-03 < 2025-06-15.
      await expect(
        advance({
          timeline: timelineB,
          template: templateOf(557),
          D: "2025-07-03",
          debt: 94669.41,
        }),
      ).resolves.toMatchObject({
        payment: 531.1,
        interest: 315.56,
        principal: 215.54,
      });
    });

    it("a posting re-divides the bill shown and never steps into the dated payment", async () => {
      // The template advanced to 557.00 is what installment 17 posts.
      await expect(
        advance({
          timeline: timelineB,
          template: templateOf(557),
          D: "2024-06-03",
          debt: 97227.62,
          purpose: "posting",
        }),
      ).resolves.toMatchObject({
        payment: 557,
        interest: 364.6,
        principal: 192.4,
      });
      // A template not yet advanced posts what it was shown, re-divided.
      await expect(
        advance({
          timeline: timelineB,
          template: templateOf(584.59),
          D: "2024-06-03",
          debt: 97227.62,
          purpose: "posting",
        }),
      ).resolves.toMatchObject({
        payment: 584.59,
        interest: 364.6,
        principal: 219.99,
      });
    });

    it("a reconfigure targets accounts.payment_amount, not the dated payment (7.6 item 3)", async () => {
      await expect(
        advance({
          timeline: timelineA,
          template: templateOf(584.59),
          D: "2023-05-03",
          debt: 99494.13,
          purpose: "reconfigure",
        }),
      ).resolves.toMatchObject({
        payment: 584.59,
        interest: 373.1,
        principal: 211.49,
      });
    });

    it("a stated payment dated on the preceding slot applied to that installment already: the max stands", async () => {
      // Effective 2023-04-03 exactly: row(2023-04-03) is the stated row and
      // prev(2023-05-03) = 2023-04-03 is not before it, so 2023-05-03 keeps
      // max(template, 560.00); a template still at 584.59 stays.
      await expect(
        advance({
          timeline: [initial, rateRow("2023-04-03", 4.5, 560)],
          template: templateOf(584.59),
          D: "2023-05-03",
          debt: 99494.13,
        }),
      ).resolves.toMatchObject({ payment: 584.59 });
    });

    it("a schedule whose calendar cannot be read keeps the max rule", async () => {
      await expect(
        advance({
          timeline: timelineA,
          template: templateOf(584.59),
          D: "2023-05-03",
          debt: 99494.13,
          startDate: null as unknown as string,
        }),
      ).resolves.toMatchObject({ payment: 584.59 });
    });
  });
});
