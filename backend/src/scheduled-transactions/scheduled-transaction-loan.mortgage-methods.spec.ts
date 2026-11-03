import { LoanFee } from "../loan-fees/entities/loan-fee.entity";
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
 * `ScheduledTransactionLoanService` on the LINEAR and INTEREST_ONLY methods
 * (docs/specs/mortgage-types.md, sections 5.2, 5.6, 8 and 9): what the service
 * WRITES from the installment the pricing tail resolves -- the deactivation at
 * payoff, the posting's booking, the method-change reprice, the missing-term
 * decline. The spec's section 7 pricing tables themselves are asserted
 * against the pure tail in `backend/src/loan-installments/price-installment.spec.ts`.
 * The fixture is the spec's: EUR 300,000 over 360 monthly payments from
 * 2024-01-01, 2.00% until 4.00% from 2027-01-01; the debt each case prices is
 * the spec's "debt as posted", the figure `datedLoanDebt` returns.
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
      [LoanFee, { find: jest.fn().mockResolvedValue([]) }],
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

  describe("the final installment (spec table 7.1)", () => {
    it("deactivates the schedule once the debt is retired, and writes no split", async () => {
      // The 2050-07-01 advancement finds the debt retired: no 0.0106 payment.
      await advance(
        makeMortgage(),
        makeTemplate(833.3439, 2.7778, "2050-07-01"),
        0,
      );
      expect(scheduledTransactionsRepository.update).toHaveBeenCalledWith(
        scheduledTransactionId,
        { isActive: false },
      );
      expect(splitsRepository.save).not.toHaveBeenCalled();
    });
  });

  describe("INTEREST_ONLY (spec table 7.4 and section 9)", () => {
    const interestOnly = () =>
      makeMortgage({ mortgageType: "INTEREST_ONLY", prepaymentMode: null });

    it("posts the interest alone and moves the loan balance by zero", async () => {
      const template = makeTemplate(0, 883.3333, "2027-02-01");
      const decision = await post(
        interestOnly(),
        template,
        265000,
        "2027-02-01",
      );
      // Priced at 883.3333, booked in cents (issue #1581).
      expect(decision).toEqual({
        kind: "allocation",
        amountsBySplitId: new Map([
          ["split-principal", -0],
          ["split-interest", -883.33],
        ]),
        parentAmount: -883.33,
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
      // Re-divided at 4dp (783.3333 interest, 443.0556 principal) and booked
      // in cents: the 1,226.39 bill, 783.33 interest, principal the rest.
      expect(decision).toEqual({
        kind: "allocation",
        amountsBySplitId: new Map([
          ["split-principal", -443.06],
          ["split-interest", -783.33],
        ]),
        parentAmount: -1226.39,
      });

      // The advancement after that posting prices 2027-02-01 at the method
      // installment again: c on the debt the short posting left
      // (235,000.0012 - 443.06).
      const healed = await advance(
        account,
        makeTemplate(443.06, 783.33, "2027-02-01"),
        234556.9412,
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
