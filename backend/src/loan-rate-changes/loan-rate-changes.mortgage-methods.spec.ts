import { BadRequestException } from "@nestjs/common";
import { LoanRateChangesService } from "./loan-rate-changes.service";
import { LoanRateChange } from "./entities/loan-rate-change.entity";
import { Account, AccountType } from "../accounts/entities/account.entity";
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
 * method on the dated debt -- principal from table 4.3, interest at the rate
 * in force on the installment's date -- and no payment is ever recorded on the
 * rate row, because the method states every installment. Figures are the
 * spec's section 7 worked example.
 */
describe("LoanRateChangesService: LINEAR and INTEREST_ONLY", () => {
  let service: LoanRateChangesService;
  let rateChangesRepository: Record<string, jest.Mock>;
  let accountsRepository: Record<string, jest.Mock>;
  let scheduledTransactionsService: Record<string, jest.Mock>;
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

  const timeline = [
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
      effectiveDate: "2027-01-01",
      annualRate: 4,
      newPaymentAmount: null,
      source: "manual",
    },
  ];

  const template = (principal: number, interest: number) => ({
    id: "sched-1",
    name: "Mortgage Payment",
    currencyCode: "EUR",
    amount: -(principal + interest),
    nextDueDate: "2027-01-01",
    splits: [
      { transferAccountId: accountId, amount: -principal, memo: "Principal" },
      { categoryId: "cat-interest", amount: -interest, memo: "Interest" },
    ],
  });

  beforeEach(() => {
    // Recorded on 2026-12-15 for 2027-01-01: the change is in the future.
    jest.useFakeTimers({
      doNotFake: [
        "nextTick",
        "setImmediate",
        "setTimeout",
        "setInterval",
        "queueMicrotask",
      ],
    });
    jest.setSystemTime(new Date(2026, 11, 15, 12));

    rateChangesRepository = {
      find: jest.fn().mockResolvedValue([]),
      findOne: jest.fn().mockResolvedValue(null),
    };
    accountsRepository = {
      findOne: jest.fn().mockResolvedValue(makeMortgage()),
    };
    scheduledTransactionsService = {
      findOne: jest.fn().mockResolvedValue(template(833.3333, 393.0556)),
      update: jest.fn().mockResolvedValue({ id: "sched-1" }),
    };

    ({ manager, dataSource } = createScopedDbMocks([
      [LoanRateChange, rateChangesRepository],
      [Account, accountsRepository],
    ]));
    manager.count.mockResolvedValue(1);
    manager.find.mockResolvedValue(timeline);
    manager.findOne.mockResolvedValue(null);
    manager.create.mockImplementation((_entity, data) => ({ ...data }));
    manager.save.mockImplementation((data) =>
      Promise.resolve(data.id ? data : { ...data, id: "rc-new" }),
    );
    // The ledger debt through 2027-01-01, as posted (spec table 7.1).
    manager.query.mockResolvedValue([{ balance: "-235000.0012" }]);

    service = new LoanRateChangesService(
      dataSource as never,
      scheduledTransactionsService as never,
    );
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it("a future-dated change on a linear mortgage changes the template's interest line only", async () => {
    const result = await service.create(
      userId,
      accountId,
      { effectiveDate: "2027-01-01", annualRate: 4 },
      { deferScheduledSync: true },
    );

    // Priced on the ledger debt through the installment's own date.
    expect(manager.query).toHaveBeenCalledWith(ACCOUNT_BALANCE_AS_OF_SQL, [
      accountId,
      userId,
      "2027-01-01",
    ]);
    expect(result.scheduledPaymentPreview).toMatchObject({
      currentPrincipal: 833.3333,
      proposedPrincipal: 833.3333,
      currentInterest: 393.0556,
      proposedInterest: 783.3333,
      proposedPaymentAmount: 1616.6666,
    });
    // No payment is recorded on the rate row.
    expect(manager.create).toHaveBeenCalledWith(
      LoanRateChange,
      expect.objectContaining({ newPaymentAmount: null }),
    );
  });

  it("applies the confirmed sync with the method's split", async () => {
    await service.create(userId, accountId, {
      effectiveDate: "2027-01-01",
      annualRate: 4,
    });

    expect(scheduledTransactionsService.update).toHaveBeenCalledWith(
      userId,
      "sched-1",
      {
        amount: -1616.6666,
        splits: [
          {
            transferAccountId: accountId,
            amount: -833.3333,
            memo: "Principal",
          },
          { categoryId: "cat-interest", amount: -783.3333, memo: "Interest" },
        ],
      },
    );
  });

  it("re-derives a LOWER_INSTALLMENT principal from the remaining payments, not from the rate", async () => {
    accountsRepository.findOne.mockResolvedValue(
      makeMortgage({ prepaymentMode: "LOWER_INSTALLMENT" }),
    );
    manager.query.mockResolvedValue([{ balance: "-236588.347" }]);

    const result = await service.create(
      userId,
      accountId,
      { effectiveDate: "2027-01-01", annualRate: 4 },
      { deferScheduledSync: true },
    );

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
    scheduledTransactionsService.findOne.mockResolvedValue(
      template(0, 441.6667),
    );
    manager.query.mockResolvedValue([{ balance: "-265000" }]);

    const result = await service.create(
      userId,
      accountId,
      { effectiveDate: "2027-01-01", annualRate: 4 },
      { deferScheduledSync: true },
    );

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
    manager.find.mockResolvedValue([]);

    const plan = await service.buildScheduledUpdate(
      userId,
      makeMortgage({ interestRate: null }),
      { annualRate: 4, paymentAmount: null, effectiveDate: "2027-01-01" },
    );

    // The override's rate is today's; the installment is priced at the rate
    // dated to its due date, and there is none to read.
    expect(plan).toBeNull();
  });

  it("does not sync a linear mortgage missing its amortization", async () => {
    accountsRepository.findOne.mockResolvedValue(
      makeMortgage({ amortizationMonths: null }),
    );

    const result = await service.create(
      userId,
      accountId,
      { effectiveDate: "2027-01-01", annualRate: 4 },
      { deferScheduledSync: true },
    );

    expect(result.scheduledPaymentPreview).toBeNull();
  });
});
