import { BadRequestException } from "@nestjs/common";
import { EntityManager } from "typeorm";
import { LoanRateChangesService } from "./loan-rate-changes.service";
import { LoanRateChange } from "./entities/loan-rate-change.entity";
import { Account, AccountType } from "../accounts/entities/account.entity";
import { ScheduledTransaction } from "../scheduled-transactions/entities/scheduled-transaction.entity";
import { ScheduledTransactionSplit } from "../scheduled-transactions/entities/scheduled-transaction-split.entity";
import { ACCOUNT_BALANCE_AS_OF_SQL } from "../common/ledger-balance.sql";
import {
  createScopedDbMocks,
  DataSourceMock,
  ManagerMock,
} from "../test-helpers/scoped-db-testing";

jest.mock("../common/db/scoped-db", () =>
  jest.requireActual("../test-helpers/scoped-db-testing").scopedDbMockModule(),
);

/**
 * The rate-change paths for LINEAR and INTEREST_ONLY mortgages
 * (docs/specs/mortgage-types.md, section 5.3): the template is repriced by the
 * method at its own due date -- principal from table 4.3, interest at the
 * rate in force on that date -- through the loan core, and no payment is ever
 * recorded on the rate row, because the method states every installment.
 * Figures are the spec's section 7 worked example.
 */
describe("LoanRateChangesService: LINEAR and INTEREST_ONLY", () => {
  let service: LoanRateChangesService;
  let rateChangesRepository: Record<string, jest.Mock>;
  let accountsRepository: Record<string, jest.Mock>;
  let scheduledTransactionsRepository: Record<string, jest.Mock>;
  let splitsRepository: Record<string, jest.Mock>;
  let manager: ManagerMock;
  let dataSource: DataSourceMock;

  const userId = "user-1";
  const accountId = "account-1";

  const makeMortgage = (overrides: Partial<Account> = {}): Account =>
    ({
      id: accountId,
      userId,
      accountType: AccountType.MORTGAGE,
      mortgageType: "LINEAR",
      prepaymentMode: null,
      isCanadianMortgage: false,
      isVariableRate: false,
      currentBalance: -235833.3345,
      openingBalance: -300000,
      originalPrincipal: 300000,
      interestRate: 2,
      paymentAmount: null,
      paymentFrequency: "MONTHLY",
      paymentStartDate: "2024-01-01",
      amortizationMonths: 360,
      isClosed: false,
      scheduledTransactionId: "sched-1",
      interestCategoryId: "cat-interest",
      currencyCode: "EUR",
      ...overrides,
    }) as unknown as Account;

  const timeline = (changeDate = "2027-01-01") => [
    {
      id: "rc-initial",
      accountId,
      effectiveDate: "2024-01-01",
      annualRate: 2,
      newPaymentAmount: null,
      source: "initial",
    },
    {
      id: "rc-new",
      accountId,
      effectiveDate: changeDate,
      annualRate: 4,
      newPaymentAmount: null,
      source: "manual",
    },
  ];

  /** The linked bill as the schedule holds it, due 2027-01-01. */
  const template = (principal: number, interest: number) => {
    scheduledTransactionsRepository.findOne.mockResolvedValue({
      id: "sched-1",
      userId,
      accountId: "acc-chequing",
      name: "Mortgage Payment",
      currencyCode: "EUR",
      amount: -(principal + interest),
      frequency: "MONTHLY",
      startDate: "2024-01-01",
      nextDueDate: "2027-01-01",
      endDate: null,
      occurrencesRemaining: null,
      isActive: true,
    });
    splitsRepository.find.mockResolvedValue([
      {
        id: "split-principal",
        transferAccountId: accountId,
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
    ]);
  };

  beforeEach(() => {
    rateChangesRepository = {
      find: jest.fn().mockResolvedValue(timeline()),
      findOne: jest.fn().mockResolvedValue(null),
    };
    accountsRepository = {
      findOne: jest.fn().mockResolvedValue(makeMortgage()),
      save: jest.fn(),
      update: jest.fn(),
    };
    scheduledTransactionsRepository = {
      findOne: jest.fn().mockResolvedValue(null),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
    };
    splitsRepository = {
      find: jest.fn().mockResolvedValue([]),
      save: jest.fn().mockImplementation((split) => Promise.resolve(split)),
    };
    template(833.3333, 393.0556);

    ({ manager, dataSource } = createScopedDbMocks([
      [LoanRateChange, rateChangesRepository],
      [Account, accountsRepository],
      [ScheduledTransaction, scheduledTransactionsRepository],
      [ScheduledTransactionSplit, splitsRepository],
    ]));
    manager.count.mockResolvedValue(1);
    manager.findOne.mockResolvedValue(null);
    manager.create.mockImplementation((_entity, data) => ({ ...data }));
    manager.save.mockImplementation((data) =>
      Promise.resolve(data.id ? data : { ...data, id: "rc-new" }),
    );
    // The ledger debt through 2027-01-01, as posted (spec table 7.1).
    manager.query.mockResolvedValue([{ balance: "-235000.0012" }]);

    service = new LoanRateChangesService(dataSource as never);
  });

  it("a change dated on the template's due date on a linear mortgage changes the template's interest line only", async () => {
    const result = await service.create(userId, accountId, {
      effectiveDate: "2027-01-01",
      annualRate: 4,
    });

    // Priced on the ledger debt through the installment's own date.
    expect(manager.query).toHaveBeenCalledWith(ACCOUNT_BALANCE_AS_OF_SQL, [
      accountId,
      userId,
      "2027-01-01",
    ]);
    expect(result.scheduledPaymentPreview).toMatchObject({
      dueDate: "2027-01-01",
      currentPrincipal: 833.3333,
      proposedPrincipal: 833.3333,
      currentInterest: 393.0556,
      proposedInterest: 783.3333,
      proposedPaymentAmount: 1616.6666,
      // A derived installment states no payment on its rows.
      nextPaymentChange: null,
    });
    // No payment is recorded on the rate row, and nothing is written yet.
    expect(manager.create).toHaveBeenCalledWith(
      LoanRateChange,
      expect.objectContaining({ newPaymentAmount: null }),
    );
    expect(splitsRepository.save).not.toHaveBeenCalled();
    expect(scheduledTransactionsRepository.update).not.toHaveBeenCalled();
  });

  it("a change dated after the template's due date leaves the next installment's interest at the old rate", async () => {
    rateChangesRepository.find.mockResolvedValue(timeline("2027-01-15"));

    const result = await service.create(userId, accountId, {
      effectiveDate: "2027-01-15",
      annualRate: 4,
    });

    // 2027-01-01 is still priced at 2.00 %: 235,000.0012 x 2 % / 12.
    expect(result.scheduledPaymentPreview).toMatchObject({
      dueDate: "2027-01-01",
      proposedPrincipal: 833.3333,
      proposedInterest: 391.6667,
      proposedPaymentAmount: 1225,
    });
  });

  it("applies the confirmed sync with the method's split, through the template rewrite", async () => {
    await service.applyScheduledPaymentSync(userId, accountId);

    expect(splitsRepository.save).toHaveBeenCalledWith(
      expect.objectContaining({ id: "split-principal", amount: -833.3333 }),
    );
    expect(splitsRepository.save).toHaveBeenCalledWith(
      expect.objectContaining({ id: "split-interest", amount: -783.3333 }),
    );
    expect(scheduledTransactionsRepository.update).toHaveBeenCalledWith(
      "sched-1",
      { amount: -1616.6666 },
    );
    // The account row is not written (spec 5.6).
    expect(accountsRepository.save).not.toHaveBeenCalled();
    expect(accountsRepository.update).not.toHaveBeenCalled();
  });

  it("re-derives a LOWER_INSTALLMENT principal from the remaining payments, not from the rate", async () => {
    accountsRepository.findOne.mockResolvedValue(
      makeMortgage({ prepaymentMode: "LOWER_INSTALLMENT" }),
    );
    manager.query.mockResolvedValue([{ balance: "-236588.347" }]);

    const result = await service.create(userId, accountId, {
      effectiveDate: "2027-01-01",
      annualRate: 4,
    });

    expect(result.scheduledPaymentPreview).toMatchObject({
      proposedPrincipal: 730.2109,
      proposedInterest: 788.6278,
      proposedPaymentAmount: 1518.8387,
    });
  });

  it("prices an interest-only template at the new rate with a zero principal line", async () => {
    accountsRepository.findOne.mockResolvedValue(
      makeMortgage({ mortgageType: "INTEREST_ONLY" }),
    );
    template(0, 441.6667);
    manager.query.mockResolvedValue([{ balance: "-265000" }]);

    const result = await service.create(userId, accountId, {
      effectiveDate: "2027-01-01",
      annualRate: 4,
    });

    expect(result.scheduledPaymentPreview).toMatchObject({
      proposedPrincipal: 0,
      proposedInterest: 883.3333,
      proposedPaymentAmount: 883.3333,
    });
  });

  it("records no payment when asked to recalculate one", async () => {
    await service.create(userId, accountId, {
      effectiveDate: "2027-01-01",
      annualRate: 4,
      recalculatePayment: true,
    });

    expect(manager.create).toHaveBeenCalledWith(
      LoanRateChange,
      expect.objectContaining({ annualRate: 4, newPaymentAmount: null }),
    );
  });

  it.each(["LINEAR", "INTEREST_ONLY"] as const)(
    "refuses a stated payment on a %s mortgage before writing anything",
    async (mortgageType) => {
      accountsRepository.findOne.mockResolvedValue(
        makeMortgage({ mortgageType }),
      );

      await expect(
        service.create(userId, accountId, {
          effectiveDate: "2027-01-01",
          annualRate: 4,
          newPaymentAmount: 1500,
        }),
      ).rejects.toThrow(BadRequestException);
      await expect(
        service.update(userId, accountId, "rc-new", {
          newPaymentAmount: 1500,
        }),
      ).rejects.toThrow(/cannot state a payment amount/);
      expect(manager.save).not.toHaveBeenCalled();
    },
  );

  it("still accepts a stated payment on an annuity mortgage", async () => {
    accountsRepository.findOne.mockResolvedValue(
      makeMortgage({ mortgageType: "ANNUITY", paymentAmount: 1108.8584 }),
    );

    await service.create(userId, accountId, {
      effectiveDate: "2027-01-01",
      annualRate: 4,
      newPaymentAmount: 1500,
    });

    expect(manager.create).toHaveBeenCalledWith(
      LoanRateChange,
      expect.objectContaining({ newPaymentAmount: 1500 }),
    );
  });

  it("does not price a linear template at a defaulted 0% when no rate is known", async () => {
    rateChangesRepository.find.mockResolvedValue([]);
    // The plan prices the loan row the template's lines pay, as read in its
    // own transaction.
    accountsRepository.findOne.mockResolvedValue(
      makeMortgage({ interestRate: null }),
    );

    const plan = await service.buildScheduledUpdate(
      manager as unknown as EntityManager,
      makeMortgage({ interestRate: null }),
    );

    // The installment is priced at the rate dated to its due date, and there
    // is none to read: the sync declines rather than offering 0 %.
    expect(plan).toBeNull();
  });

  it("does not sync a linear mortgage missing its amortization", async () => {
    accountsRepository.findOne.mockResolvedValue(
      makeMortgage({ amortizationMonths: null }),
    );

    const result = await service.create(userId, accountId, {
      effectiveDate: "2027-01-01",
      annualRate: 4,
    });

    expect(result.scheduledPaymentPreview).toBeNull();
  });
});
