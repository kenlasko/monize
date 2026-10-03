import { Test, TestingModule } from "@nestjs/testing";
import { DataSource } from "typeorm";
import { ScheduledTransactionLoanService } from "./scheduled-transaction-loan.service";
import { ScheduledTransaction } from "./entities/scheduled-transaction.entity";
import { ScheduledTransactionSplit } from "./entities/scheduled-transaction-split.entity";
import { Account } from "../accounts/entities/account.entity";
import { LoanRateChange } from "../loan-rate-changes/entities/loan-rate-change.entity";
import { createScopedDbMocks } from "../test-helpers/scoped-db-testing";

jest.mock("../common/db/scoped-db", () =>
  jest.requireActual("../test-helpers/scoped-db-testing").scopedDbMockModule(),
);

/**
 * `resolveInstallment` for the LINEAR and INTEREST_ONLY methods
 * (docs/specs/mortgage-types.md, sections 5.2 and 9, table 4.3). Every figure
 * is copied from the spec's section 7 tables, which were produced by an
 * independent period-by-period loop: EUR 300,000 over 360 monthly payments from
 * 2024-01-01, 2.00% until 4.00% from 2027-01-01, repayments of 20,000 on
 * 2025-07-01 and 15,000 on 2026-01-01. The debt each case prices is the spec's
 * "debt as posted", the figure `datedLoanDebt` returns.
 */
describe("ScheduledTransactionLoanService: LINEAR and INTEREST_ONLY", () => {
  let service: ScheduledTransactionLoanService;
  let scheduledTransactionsRepository: Record<string, jest.Mock>;
  let splitsRepository: Record<string, jest.Mock>;
  let accountsRepository: Record<string, jest.Mock>;
  let rateChangesRepository: Record<string, jest.Mock>;
  let manager: Record<string, jest.Mock>;
  /** The ledger debt `datedLoanDebt` reads, positive. */
  let ledgerDebt: number;

  const loanAccountId = "acc-mortgage";
  const scheduledTransactionId = "st-mortgage";
  const userId = "user-1";

  const makeMortgage = (overrides: Partial<Account> = {}): Account =>
    ({
      id: loanAccountId,
      userId,
      accountType: "MORTGAGE",
      name: "Hypotheek",
      mortgageType: "LINEAR",
      prepaymentMode: null,
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
      id: scheduledTransactionId,
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

  /** What the template advancement wrote: principal, interest, parent. */
  const written = () => {
    const amountOf = (id: string): number | undefined => {
      const call = splitsRepository.save.mock.calls
        .map((c: any[]) => c[0])
        .reverse()
        .find((s: any) => s.id === id);
      return call ? Math.abs(call.amount) : undefined;
    };
    const parentCall = scheduledTransactionsRepository.update.mock.calls
      .map((c: any[]) => c[1])
      .reverse()
      .find((u: any) => u.amount !== undefined);
    return {
      principal: amountOf("split-principal"),
      interest: amountOf("split-interest"),
      extra: amountOf("split-extra"),
      parent: parentCall ? Math.abs(parentCall.amount) : undefined,
    };
  };

  const advance = async (
    account: Account,
    template: ScheduledTransaction,
    debt: number,
  ) => {
    accountsRepository.findOne.mockResolvedValue(account);
    scheduledTransactionsRepository.findOne.mockResolvedValue(template);
    ledgerDebt = debt;
    splitsRepository.save.mockClear();
    scheduledTransactionsRepository.update.mockClear();
    await service.recalculateLoanPaymentSplits(scheduledTransactionId);
    return written();
  };

  const post = async (
    account: Account,
    template: ScheduledTransaction,
    debt: number,
    asOfDate: string,
  ) => {
    accountsRepository.findOne.mockResolvedValue(account);
    ledgerDebt = debt;
    return service.resolvePostingAllocation(
      template,
      template.splits as ScheduledTransactionSplit[],
      asOfDate,
    );
  };

  beforeEach(async () => {
    scheduledTransactionsRepository = {
      findOne: jest.fn().mockResolvedValue(null),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
    };
    splitsRepository = {
      save: jest
        .fn()
        .mockImplementation((entity: any) => Promise.resolve(entity)),
      find: jest.fn(async () => {
        const st = await scheduledTransactionsRepository.findOne();
        return (st && st.splits) || [];
      }),
    };
    accountsRepository = { findOne: jest.fn().mockResolvedValue(null) };
    rateChangesRepository = {
      find: jest.fn().mockResolvedValue([
        { effectiveDate: "2024-01-01", annualRate: "2.0000" },
        { effectiveDate: "2027-01-01", annualRate: "4.0000" },
      ]),
    };

    const scopedDb = createScopedDbMocks([
      [ScheduledTransaction, scheduledTransactionsRepository],
      [ScheduledTransactionSplit, splitsRepository],
      [Account, accountsRepository],
      [LoanRateChange, rateChangesRepository],
    ]);
    manager = scopedDb.manager;
    ledgerDebt = 300000;
    manager.query.mockImplementation(async (sql: unknown) =>
      String(sql).includes("opening_balance")
        ? [{ balance: String(-ledgerDebt) }]
        : [],
    );

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ScheduledTransactionLoanService,
        { provide: DataSource, useValue: scopedDb.dataSource },
      ],
    }).compile();
    service = module.get(ScheduledTransactionLoanService);
  });

  describe("LINEAR, SHORTEN_TERM (spec table 7.1)", () => {
    it("keeps the principal constant through a rate change; only the interest moves", async () => {
      const account = makeMortgage();

      const december = await advance(
        account,
        makeTemplate(833.3333, 393.6111, "2026-12-01"),
        235833.3345,
      );
      expect(december).toEqual({
        principal: 833.3333,
        interest: 393.0556,
        extra: undefined,
        parent: 1226.3889,
      });

      const january = await advance(
        account,
        makeTemplate(833.3333, 393.0556, "2027-01-01"),
        235000.0012,
      );
      expect(january).toEqual({
        principal: 833.3333,
        interest: 783.3333,
        extra: undefined,
        parent: 1616.6666,
      });
    });

    it("prices 2027-01-01 on a ledger posted at cents: 833.33 and 783.33", async () => {
      // 36 installments of 833.33 and 35,000 of repayments leave 235,000.12.
      const result = await advance(
        makeMortgage(),
        makeTemplate(833.3333, 393.0556, "2027-01-01"),
        235000.12,
      );
      expect(result.principal).toBe(833.3333);
      expect(result.interest).toBe(783.3337);
      expect(Math.round(result.interest! * 100) / 100).toBe(783.33);
    });

    it("prices a ledger recorded at statement cents from what it holds (table 7.2)", async () => {
      const result = await advance(
        makeMortgage(),
        makeTemplate(833.3333, 443.0556, "2025-07-01"),
        265000.06,
      );
      expect(result).toMatchObject({
        principal: 833.3333,
        interest: 441.6668,
        parent: 1275.0001,
      });
    });

    it("lets the final installment absorb the leftover, and posts nothing after it", async () => {
      const account = makeMortgage();
      const final = await advance(
        account,
        makeTemplate(833.3333, 5.5555, "2050-06-01"),
        833.3439,
      );
      expect(final).toEqual({
        principal: 833.3439,
        interest: 2.7778,
        extra: undefined,
        parent: 836.1217,
      });

      // The 2050-07-01 advancement finds the debt retired: no 0.0106 payment.
      scheduledTransactionsRepository.update.mockClear();
      await advance(account, makeTemplate(833.3439, 2.7778, "2050-07-01"), 0);
      expect(scheduledTransactionsRepository.update).toHaveBeenCalledWith(
        scheduledTransactionId,
        { isActive: false },
      );
      expect(splitsRepository.save).not.toHaveBeenCalled();
    });

    it("grows the template to the method installment, unbounded by payment_amount", async () => {
      // payment_amount is null for LINEAR (spec decision 11); the template
      // still advances to c + interest + the standing extra.
      const result = await advance(
        makeMortgage({ extraPaymentAmount: 100 }),
        makeTemplate(833.3333, 393.0556, "2027-01-01", 100),
        235000.0012,
      );
      expect(result).toEqual({
        principal: 833.3333,
        interest: 783.3333,
        extra: undefined,
        parent: 1716.6666,
      });
    });

    it("reads a mortgage whose original_principal is null from its opening balance", async () => {
      const result = await advance(
        makeMortgage({ originalPrincipal: null }),
        makeTemplate(833.3333, 500, "2024-02-01"),
        299166.6667,
      );
      expect(result).toMatchObject({ principal: 833.3333, interest: 498.6111 });
    });
  });

  describe("LINEAR, LOWER_INSTALLMENT (spec table 7.3)", () => {
    it("re-derives the principal from the next due date after a prepayment", async () => {
      const account = makeMortgage({ prepaymentMode: "LOWER_INSTALLMENT" });
      const template = makeTemplate(833.3333, 474.7222, "2025-07-01");

      // Before the 20,000 repayment reaches the ledger: 285,000.0006 over 342.
      const before = await advance(account, template, 285000.0006);
      expect(before.principal).toBe(833.3333);

      // After it: the same due date re-derives 265,000.0006 / 342.
      const after = await advance(account, template, 265000.0006);
      expect(after).toEqual({
        principal: 774.8538,
        interest: 441.6667,
        extra: undefined,
        parent: 1216.5205,
      });
    });

    it("keeps the principal through a rate change", async () => {
      const result = await advance(
        makeMortgage({ prepaymentMode: "LOWER_INSTALLMENT" }),
        makeTemplate(730.2109, 395.0, "2027-01-01"),
        236588.347,
      );
      expect(result).toEqual({
        principal: 730.2109,
        interest: 788.6278,
        extra: undefined,
        parent: 1518.8387,
      });
    });

    it("counts remaining payments from the calendar for a due date moved off it", async () => {
      // 2025-07-10 is k = 19, the same as 2025-07-01: remaining 342.
      const result = await advance(
        makeMortgage({ prepaymentMode: "LOWER_INSTALLMENT" }),
        makeTemplate(833.3333, 474.7222, "2025-07-10"),
        265000.0006,
      );
      expect(result.principal).toBe(774.8538);
    });

    it("pays the whole debt on payment N", async () => {
      const result = await advance(
        makeMortgage({ prepaymentMode: "LOWER_INSTALLMENT" }),
        makeTemplate(730.2109, 4.8679, "2053-12-01"),
        730.2109,
      );
      expect(result).toEqual({
        principal: 730.2109,
        interest: 2.434,
        extra: undefined,
        parent: 732.6449,
      });
    });
  });

  describe("INTEREST_ONLY (spec table 7.4 and section 9)", () => {
    const interestOnly = () =>
      makeMortgage({ mortgageType: "INTEREST_ONLY", prepaymentMode: null });

    it("keeps the principal line at zero and prices the interest", async () => {
      const result = await advance(
        interestOnly(),
        makeTemplate(0, 441.6667, "2027-01-01"),
        265000,
      );
      expect(result.principal).toBe(0);
      expect(result.interest).toBe(883.3333);
      expect(result.parent).toBe(883.3333);
    });

    it("writes the bullet into the principal line before payment N", async () => {
      const result = await advance(
        interestOnly(),
        makeTemplate(0, 883.3333, "2053-12-01"),
        265000,
      );
      expect(result).toEqual({
        principal: 265000,
        interest: 883.3333,
        extra: undefined,
        parent: 265883.3333,
      });
    });

    it("posts the interest alone and moves the loan balance by zero", async () => {
      const template = makeTemplate(0, 883.3333, "2027-02-01");
      const decision = await post(
        interestOnly(),
        template,
        265000,
        "2027-02-01",
      );
      expect(decision).toEqual({
        kind: "allocation",
        amountsBySplitId: new Map([
          ["split-principal", -0],
          ["split-interest", -883.3333],
        ]),
        parentAmount: -883.3333,
      });
    });
  });

  describe("a posting never grows the parent (spec section 5.2)", () => {
    it("re-divides a stale template after a rate rise, and the next advancement heals it", async () => {
      const account = makeMortgage();
      // The 2027-01-01 template still holds December's 2% installment: the
      // user declined the rate-change sync.
      const stale = makeTemplate(833.3333, 393.0556, "2027-01-01");

      const decision = await post(account, stale, 235000.0012, "2027-01-01");
      expect(decision).toEqual({
        kind: "allocation",
        amountsBySplitId: new Map([
          ["split-principal", -443.0556],
          ["split-interest", -783.3333],
        ]),
        parentAmount: -1226.3889,
      });

      // The advancement after that posting prices 2027-02-01 at the method
      // installment again: c on the debt the short posting left.
      const healed = await advance(
        account,
        makeTemplate(443.0556, 783.3333, "2027-02-01"),
        234556.9456,
      );
      expect(healed).toEqual({
        principal: 833.3333,
        interest: 781.8565,
        extra: undefined,
        parent: 1615.1898,
      });
    });

    it("posts nothing for a retired debt", async () => {
      const decision = await post(
        makeMortgage(),
        makeTemplate(833.3333, 2.7778, "2050-07-01"),
        0,
        "2050-07-01",
      );
      expect(decision).toEqual({ kind: "retired" });
    });
  });

  describe("a method change reprices the template (spec section 5.6)", () => {
    // 2026-01-01 of table 7.1: the LINEAR template holds 1,241.6666. The user
    // switches the mortgage to ANNUITY, and the account update stores the
    // re-levelled annuity payment (1,108.8584 here, for the example).
    const toAnnuity = () =>
      makeMortgage({ mortgageType: "ANNUITY", paymentAmount: 1108.8584 });
    const linearTemplate = () => makeTemplate(833.3333, 408.3333, "2026-01-01");

    const reprice = async (
      account: Account,
      template: ScheduledTransaction,
    ) => {
      accountsRepository.findOne.mockResolvedValue(account);
      scheduledTransactionsRepository.findOne.mockResolvedValue(template);
      ledgerDebt = 245000.0008;
      splitsRepository.save.mockClear();
      scheduledTransactionsRepository.update.mockClear();
      await service.repriceLoanTemplate(scheduledTransactionId);
      return written();
    };

    it("would leave a plain advancement billing the larger linear installment", async () => {
      // The defect the reprice exists for: annuity advancement only grows a
      // template toward payment_amount, never lowers it.
      const result = await advance(toAnnuity(), linearTemplate(), 245000.0008);
      expect(result.parent).toBeUndefined();
      expect(result.principal).toBe(833.3333);
    });

    it("lowers the template to the annuity payment, re-divided at this date's interest", async () => {
      const result = await reprice(toAnnuity(), linearTemplate());
      expect(result).toEqual({
        principal: 700.5251,
        interest: 408.3333,
        extra: undefined,
        parent: 1108.8584,
      });
    });

    it("moves a template the other way to the method installment", async () => {
      const result = await reprice(
        makeMortgage(),
        makeTemplate(700.5251, 408.3333, "2026-01-01"),
      );
      expect(result).toEqual({
        principal: 833.3333,
        interest: 408.3333,
        extra: undefined,
        parent: 1241.6666,
      });
    });
  });

  describe("missing terms (spec section 8)", () => {
    it.each([
      ["amortizationMonths", { amortizationMonths: null }],
      ["paymentStartDate", { paymentStartDate: null }],
      ["paymentFrequency", { paymentFrequency: null }],
    ] as const)(
      "declines without %s: the template is not rewritten and the persisted amounts post",
      async (_field, overrides) => {
        const account = makeMortgage(overrides as Partial<Account>);
        const template = makeTemplate(833.3333, 500, "2024-02-01");

        const result = await advance(account, template, 299166.6667);
        expect(result).toEqual({
          principal: undefined,
          interest: undefined,
          extra: undefined,
          parent: undefined,
        });

        const decision = await post(
          account,
          template,
          299166.6667,
          "2024-02-01",
        );
        expect(decision).toEqual({ kind: "not-applicable" });
      },
    );
  });
});
