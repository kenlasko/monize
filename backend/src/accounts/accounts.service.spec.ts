import { Test, TestingModule } from "@nestjs/testing";
import { I18nContext } from "nestjs-i18n";
import { getRepositoryToken } from "@nestjs/typeorm";
import { NotFoundException, BadRequestException } from "@nestjs/common";
import { AccountsService } from "./accounts.service";
import {
  Account,
  AccountType,
  AccountSubType,
} from "./entities/account.entity";
import { Transaction } from "../transactions/entities/transaction.entity";
import { InvestmentTransaction } from "../securities/entities/investment-transaction.entity";
import { Holding } from "../securities/entities/holding.entity";
import { Institution } from "../institutions/entities/institution.entity";
import { CategoriesService } from "../categories/categories.service";
import { ScheduledTransactionsService } from "../scheduled-transactions/scheduled-transactions.service";
import { NetWorthService } from "../net-worth/net-worth.service";
import { PortfolioService } from "../securities/portfolio.service";
import { ExchangeRateService } from "../currencies/exchange-rate.service";
import { UserPreference } from "../users/entities/user-preference.entity";
import { LoanMortgageAccountService } from "./loan-mortgage-account.service";
import { LoanRateChangesService } from "../loan-rate-changes/loan-rate-changes.service";
import { LoanPaymentDetectorService } from "./loan-payment-detector.service";
import { DataSource } from "typeorm";
import { ActionHistoryService } from "../action-history/action-history.service";
import { ScheduledOccurrenceService } from "../scheduled-transactions/scheduled-occurrence.service";
import { ScheduledTransaction } from "../scheduled-transactions/entities/scheduled-transaction.entity";
import { LoanRateChange } from "../loan-rate-changes/entities/loan-rate-change.entity";
import {
  createScopedDbMocks,
  DataSourceMock,
} from "../test-helpers/scoped-db-testing";

jest.mock("../common/db/scoped-db", () =>
  jest.requireActual("../test-helpers/scoped-db-testing").scopedDbMockModule(),
);

describe("AccountsService", () => {
  let service: AccountsService;
  let accountsRepository: Record<string, jest.Mock>;
  let transactionRepository: Record<string, jest.Mock>;
  let investmentTxRepository: Record<string, jest.Mock>;
  let institutionsRepository: Record<string, jest.Mock>;
  let scheduledTransactionsService: Record<string, jest.Mock>;
  let categoriesService: Record<string, jest.Mock>;
  let netWorthService: Record<string, jest.Mock>;
  let mockQueryRunner: Record<string, any>;
  let mockDataSource: DataSourceMock;
  let userPreferenceRepository: Record<string, jest.Mock>;
  let exchangeRateService: Record<string, jest.Mock>;
  let mockActionHistoryService: Record<string, jest.Mock>;
  let scheduledOccurrenceService: { expand: jest.Mock };
  let scheduleRepository: { find: jest.Mock };
  let rateChangeRepository: { find: jest.Mock };
  let loanRateChangesService: Record<string, jest.Mock>;
  // loanMortgageService uses the real class with mocked repositories

  const mockAccount = {
    id: "account-1",
    userId: "user-1",
    name: "Checking",
    accountType: "CHEQUING",
    currencyCode: "USD",
    openingBalance: 1000,
    currentBalance: 1500,
    isClosed: false,
    linkedAccountId: null,
    accountSubType: null,
    scheduledTransactionId: null,
    excludeFromNetWorth: false,
    // The column default every row carries; a mortgage case overrides it.
    mortgageType: "ANNUITY",
  };

  beforeEach(async () => {
    accountsRepository = {
      create: jest
        .fn()
        .mockImplementation((data) => ({ ...data, id: "new-account" })),
      save: jest.fn().mockImplementation((data) => data),
      findOne: jest.fn(),
      findOneOrFail: jest.fn(),
      find: jest.fn(),
      remove: jest.fn(),
      update: jest.fn(),
      count: jest.fn(),
      query: jest.fn(),
      createQueryBuilder: jest.fn(() => ({
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        getMany: jest.fn().mockResolvedValue([]),
      })),
    };

    transactionRepository = {
      count: jest.fn().mockResolvedValue(0),
      createQueryBuilder: jest.fn(() => ({
        select: jest.fn().mockReturnThis(),
        addSelect: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        groupBy: jest.fn().mockReturnThis(),
        getRawMany: jest.fn().mockResolvedValue([]),
      })),
    };

    investmentTxRepository = {
      count: jest.fn().mockResolvedValue(0),
      createQueryBuilder: jest.fn(() => ({
        select: jest.fn().mockReturnThis(),
        addSelect: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        groupBy: jest.fn().mockReturnThis(),
        getRawMany: jest.fn().mockResolvedValue([]),
      })),
    };

    scheduledTransactionsService = {
      create: jest.fn().mockResolvedValue({ id: "sched-tx-1" }),
      update: jest.fn().mockResolvedValue({}),
      remove: jest.fn(),
      repriceLoanTemplate: jest.fn().mockResolvedValue(undefined),
    };

    loanRateChangesService = {
      create: jest.fn().mockImplementation((_userId, _accountId, dto) =>
        Promise.resolve({
          id: "rate-change-1",
          effectiveDate: dto.effectiveDate,
          annualRate: dto.annualRate,
          newPaymentAmount:
            dto.newPaymentAmount ?? (dto.recalculatePayment ? 1450.25 : null),
          source: "manual",
        }),
      ),
    };

    categoriesService = {
      findLoanCategories: jest.fn().mockResolvedValue({
        interestCategory: { id: "interest-cat-1" },
      }),
    };

    netWorthService = {
      recalculateAccount: jest.fn().mockResolvedValue(undefined),
      getMonthlyNetWorth: jest.fn().mockResolvedValue([]),
      getLatestNetWorth: jest.fn().mockResolvedValue(null),
    };

    mockActionHistoryService = {
      record: jest.fn().mockResolvedValue(null),
    };
    scheduledOccurrenceService = { expand: jest.fn().mockResolvedValue([]) };

    institutionsRepository = {
      findOne: jest.fn().mockResolvedValue({ id: "inst-1" }),
      find: jest.fn().mockResolvedValue([]),
    };

    userPreferenceRepository = {
      findOne: jest.fn().mockResolvedValue({ defaultCurrency: "USD" }),
    };
    exchangeRateService = {
      getRateForDate: jest.fn().mockResolvedValue(null),
      getLatestRate: jest.fn().mockResolvedValue(null),
    };

    scheduleRepository = { find: jest.fn().mockResolvedValue([]) };
    rateChangeRepository = { find: jest.fn().mockResolvedValue([]) };
    const { manager: txManager, dataSource } = createScopedDbMocks([
      [Account, accountsRepository],
      [Transaction, transactionRepository],
      [InvestmentTransaction, investmentTxRepository],
      [Institution, institutionsRepository],
      [UserPreference, userPreferenceRepository],
      [ScheduledTransaction, scheduleRepository],
      [LoanRateChange, rateChangeRepository],
    ]);
    mockDataSource = dataSource;
    txManager.save.mockImplementation((data) => data);
    txManager.remove.mockImplementation((data) => data);
    txManager.count.mockResolvedValue(0);
    txManager.query.mockResolvedValue([]);
    // Transaction-block tests address the manager through this legacy alias.
    mockQueryRunner = { manager: txManager, query: txManager.query };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AccountsService,
        LoanMortgageAccountService,
        { provide: getRepositoryToken(Account), useValue: accountsRepository },
        {
          provide: getRepositoryToken(Transaction),
          useValue: transactionRepository,
        },
        {
          provide: getRepositoryToken(InvestmentTransaction),
          useValue: investmentTxRepository,
        },
        {
          provide: getRepositoryToken(Institution),
          useValue: institutionsRepository,
        },
        { provide: CategoriesService, useValue: categoriesService },
        {
          provide: ScheduledTransactionsService,
          useValue: scheduledTransactionsService,
        },
        { provide: NetWorthService, useValue: netWorthService },
        {
          provide: PortfolioService,
          useValue: {
            getAccountMarketValues: jest.fn().mockResolvedValue(new Map()),
          },
        },
        {
          provide: ActionHistoryService,
          useValue: mockActionHistoryService,
        },
        { provide: ExchangeRateService, useValue: exchangeRateService },
        LoanMortgageAccountService,
        {
          provide: LoanRateChangesService,
          useValue: loanRateChangesService,
        },
        { provide: LoanPaymentDetectorService, useValue: {} },
        {
          provide: DataSource,
          useValue: mockDataSource,
        },
        {
          provide: ScheduledOccurrenceService,
          useValue: scheduledOccurrenceService,
        },
      ],
    }).compile();

    service = module.get<AccountsService>(AccountsService);
  });

  describe("findOne", () => {
    it("returns account when found and belongs to user", async () => {
      accountsRepository.findOne.mockResolvedValue(mockAccount);

      const result = await service.findOne("user-1", "account-1");
      expect(result).toEqual(mockAccount);
    });

    it("throws NotFoundException when account not found", async () => {
      accountsRepository.findOne.mockResolvedValue(null);

      await expect(service.findOne("user-1", "nonexistent")).rejects.toThrow(
        NotFoundException,
      );
    });

    it("throws NotFoundException when account belongs to different user", async () => {
      accountsRepository.findOne.mockResolvedValue(null);

      await expect(service.findOne("user-1", "account-1")).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe("create", () => {
    it("creates a basic account with opening balance", async () => {
      await service.create("user-1", {
        name: "New Account",
        accountType: AccountType.CHEQUING,
        currencyCode: "USD",
        openingBalance: 500,
      } as any);

      const createCall = accountsRepository.create.mock.calls[0][0];
      expect(createCall.openingBalance).toBe(500);
      expect(createCall.currentBalance).toBe(500);
      expect(createCall.userId).toBe("user-1");
      expect(accountsRepository.save).toHaveBeenCalled();
    });

    it("assigns a valid owned institution", async () => {
      await service.create("user-1", {
        name: "Bank Account",
        accountType: AccountType.CHEQUING,
        currencyCode: "USD",
        institutionId: "inst-1",
      } as any);

      expect(institutionsRepository.findOne).toHaveBeenCalledWith({
        where: { id: "inst-1", userId: "user-1" },
        select: { id: true },
      });
      const createCall = accountsRepository.create.mock.calls[0][0];
      expect(createCall.institutionId).toBe("inst-1");
    });

    it("rejects an institution that does not belong to the user", async () => {
      institutionsRepository.findOne.mockResolvedValue(null);

      await expect(
        service.create("user-1", {
          name: "Bank Account",
          accountType: AccountType.CHEQUING,
          currencyCode: "USD",
          institutionId: "someone-elses",
        } as any),
      ).rejects.toThrow(BadRequestException);
      expect(accountsRepository.save).not.toHaveBeenCalled();
    });

    it("defaults opening balance to 0", async () => {
      await service.create("user-1", {
        name: "Zero Balance",
        accountType: AccountType.SAVINGS,
        currencyCode: "USD",
      } as any);

      const createCall = accountsRepository.create.mock.calls[0][0];
      expect(createCall.openingBalance).toBe(0);
      expect(createCall.currentBalance).toBe(0);
    });

    it("creates an account with a foreign-transaction fee percentage", async () => {
      await service.create("user-1", {
        name: "Travel Card",
        accountType: AccountType.CREDIT_CARD,
        currencyCode: "USD",
        fxFeePercent: 2.5,
      } as any);

      const createCall = accountsRepository.create.mock.calls[0][0];
      expect(createCall.fxFeePercent).toBe(2.5);
    });

    it("writes a bare mortgage's type, and no type elsewhere", async () => {
      await service.create("user-1", {
        name: "Mortgage without a schedule",
        accountType: AccountType.MORTGAGE,
        currencyCode: "CAD",
        mortgageType: "CANADIAN_FIXED",
      } as any);
      await service.create("user-1", {
        name: "Savings",
        accountType: AccountType.SAVINGS,
        currencyCode: "CAD",
        mortgageType: "CANADIAN_FIXED",
      } as any);
      await service.create("user-1", {
        name: "Mortgage naming no type",
        accountType: AccountType.MORTGAGE,
        currencyCode: "CAD",
      } as any);

      const [mortgage, savings, untyped] =
        accountsRepository.create.mock.calls.map(([row]) => row);
      expect(mortgage).toMatchObject({ mortgageType: "CANADIAN_FIXED" });
      // Any other account takes the column default.
      expect(savings).not.toHaveProperty("mortgageType");
      expect(untyped).toMatchObject({ mortgageType: "ANNUITY" });
    });

    it("refuses a bare LINEAR mortgage without the terms its method prices from", async () => {
      // docs/specs/mortgage-types.md section 8: no N, no calendar, no cadence.
      await expect(
        service.create("user-1", {
          name: "Hypotheek",
          accountType: AccountType.MORTGAGE,
          currencyCode: "EUR",
          openingBalance: 300000,
          mortgageType: "LINEAR",
        } as any),
      ).rejects.toThrow(
        /requires amortizationMonths, paymentStartDate, paymentFrequency/,
      );
      expect(accountsRepository.create).not.toHaveBeenCalled();
    });

    it("stores the mortgage form's cadence for a bare LINEAR mortgage that sent only that", async () => {
      // No source account, so the full mortgage path is skipped; the request
      // named its cadence as mortgagePaymentFrequency, and the refusal must
      // not ask for a paymentFrequency it never used.
      await service.create("user-1", {
        name: "Hypotheek",
        accountType: AccountType.MORTGAGE,
        currencyCode: "EUR",
        openingBalance: 300000,
        mortgageType: "LINEAR",
        mortgagePaymentFrequency: "SEMI_MONTHLY",
        paymentStartDate: "2024-01-01",
        amortizationMonths: 360,
      } as any);
      expect(accountsRepository.create.mock.calls[0][0]).toMatchObject({
        mortgageType: "LINEAR",
        paymentFrequency: "SEMI_MONTHLY",
      });

      await expect(
        service.create("user-1", {
          name: "Hypotheek",
          accountType: AccountType.MORTGAGE,
          currencyCode: "EUR",
          openingBalance: 300000,
          mortgageType: "LINEAR",
          mortgagePaymentFrequency: "ACCELERATED_BIWEEKLY",
          paymentStartDate: "2024-01-01",
          amortizationMonths: 360,
        } as any),
      ).rejects.toThrow(/cannot be paid ACCELERATED_BIWEEKLY/);
    });

    it("stores no payment for a bare LINEAR mortgage, and its mode", async () => {
      await service.create("user-1", {
        name: "Hypotheek",
        accountType: AccountType.MORTGAGE,
        currencyCode: "EUR",
        openingBalance: 300000,
        mortgageType: "LINEAR",
        prepaymentMode: "LOWER_INSTALLMENT",
        // A form resends the payment field; the method has no constant one.
        paymentAmount: 1333.33,
        paymentFrequency: "MONTHLY",
        paymentStartDate: "2024-01-01",
        amortizationMonths: 360,
      } as any);
      await service.create("user-1", {
        name: "Savings",
        accountType: AccountType.SAVINGS,
        currencyCode: "EUR",
        prepaymentMode: "LOWER_INSTALLMENT",
      } as any);

      const [mortgage, savings] = accountsRepository.create.mock.calls.map(
        ([row]) => row,
      );
      expect(mortgage).toMatchObject({
        mortgageType: "LINEAR",
        prepaymentMode: "LOWER_INSTALLMENT",
      });
      expect(mortgage).not.toHaveProperty("paymentAmount");
      expect(savings).not.toHaveProperty("prepaymentMode");
    });

    it("creates a credit card account with statement date fields", async () => {
      await service.create("user-1", {
        name: "Visa Card",
        accountType: AccountType.CREDIT_CARD,
        currencyCode: "USD",
        creditLimit: 5000,
        statementDueDay: 15,
        statementSettlementDay: 25,
      } as any);

      const createCall = accountsRepository.create.mock.calls[0][0];
      expect(createCall.statementDueDay).toBe(15);
      expect(createCall.statementSettlementDay).toBe(25);
      expect(createCall.accountType).toBe(AccountType.CREDIT_CARD);
    });

    it("creates a credit card account without statement date fields", async () => {
      await service.create("user-1", {
        name: "Mastercard",
        accountType: AccountType.CREDIT_CARD,
        currencyCode: "USD",
        creditLimit: 10000,
      } as any);

      const createCall = accountsRepository.create.mock.calls[0][0];
      expect(createCall.statementDueDay).toBeUndefined();
      expect(createCall.statementSettlementDay).toBeUndefined();
    });

    it("strips statement date fields from non-credit-card accounts", async () => {
      await service.create("user-1", {
        name: "My Savings",
        accountType: AccountType.SAVINGS,
        currencyCode: "USD",
        statementDueDay: 15,
        statementSettlementDay: 25,
      } as any);

      const createCall = accountsRepository.create.mock.calls[0][0];
      expect(createCall.statementDueDay).toBeUndefined();
      expect(createCall.statementSettlementDay).toBeUndefined();
    });

    it("records action history on create", async () => {
      await service.create("user-1", {
        name: "New Account",
        accountType: AccountType.CHEQUING,
        currencyCode: "USD",
      } as any);

      expect(mockActionHistoryService.record).toHaveBeenCalledWith(
        "user-1",
        expect.objectContaining({
          entityType: "account",
          action: "create",
          description: expect.stringContaining("New Account"),
        }),
      );
    });
  });

  describe("updateBalance", () => {
    /**
     * The guarded UPDATE reports whether it matched a row.
     *
     * `is_closed = false` is a predicate of the write, not of a read that came
     * before it: a separate check let a mutation of an existing transaction read
     * the account as open, wait behind `close()`, and then add its delta to a row
     * that had since been closed at zero (audit P4-008). So the double has to
     * answer the way the statement does -- a row, or nothing.
     */
    function stageBalanceUpdate(matched: boolean): void {
      mockQueryRunner.query.mockImplementation(async (sql: string) =>
        String(sql).includes("UPDATE accounts") && matched
          ? [[{ id: "account-1" }], 1]
          : [[], 0],
      );
    }

    it("adds positive amount to balance", async () => {
      stageBalanceUpdate(true);
      accountsRepository.findOneOrFail.mockResolvedValue({
        ...mockAccount,
        currentBalance: 1500,
      });

      const result = await service.updateBalance("account-1", 500);

      const [sql, params] = mockQueryRunner.query.mock.calls[0];
      expect(sql).toContain("current_balance AS numeric) + $1");
      expect(sql).toContain("is_closed = false");
      expect(sql).toContain("RETURNING");
      expect(params).toEqual([500, "account-1"]);
      expect(result.currentBalance).toBe(1500);
    });

    it("subtracts negative amount from balance", async () => {
      stageBalanceUpdate(true);
      accountsRepository.findOneOrFail.mockResolvedValue({
        ...mockAccount,
        currentBalance: 700,
      });

      const result = await service.updateBalance("account-1", -300);

      expect(mockQueryRunner.query.mock.calls[0][1]).toEqual([
        -300,
        "account-1",
      ]);
      expect(result.currentBalance).toBe(700);
    });

    it("throws NotFoundException when account not found", async () => {
      stageBalanceUpdate(false);
      accountsRepository.findOne.mockResolvedValue(null);

      await expect(service.updateBalance("nonexistent", 100)).rejects.toThrow(
        NotFoundException,
      );
    });

    it("throws BadRequestException for closed accounts", async () => {
      // No row matched and the account exists: it is closed. Told apart so the
      // caller gets 400 rather than one ambiguous error.
      stageBalanceUpdate(false);
      accountsRepository.findOne.mockResolvedValue({
        ...mockAccount,
        isClosed: true,
      });

      await expect(service.updateBalance("account-1", 100)).rejects.toThrow(
        "Cannot modify balance of a closed account",
      );
    });

    it("refuses the delta when close() committed while the ledger write waited", async () => {
      // The regression guard for P4-008: an unvoid read the account as open, the
      // close committed at zero, and the delta then landed on the closed row --
      // a closed account holding -10.00. Re-evaluating the predicate after the
      // row lock refuses instead, and the throw rolls the ledger mutation back
      // with it.
      stageBalanceUpdate(false);
      accountsRepository.findOne.mockResolvedValue({
        ...mockAccount,
        isClosed: true,
      });

      await expect(
        service.updateBalance("account-1", -10),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(accountsRepository.findOneOrFail).not.toHaveBeenCalled();
    });

    it("rounds to 4 decimal places to match DB schema precision", async () => {
      stageBalanceUpdate(true);
      accountsRepository.findOneOrFail.mockResolvedValue({
        ...mockAccount,
        currentBalance: 20.3,
      });

      const result = await service.updateBalance("account-1", 10.2);

      expect(mockQueryRunner.query.mock.calls[0][0]).toContain("ROUND(");
      expect(result.currentBalance).toBe(20.3);
    });

    it("uses atomic SQL arithmetic to prevent race conditions", async () => {
      stageBalanceUpdate(true);
      accountsRepository.findOneOrFail.mockResolvedValue({
        ...mockAccount,
        currentBalance: 1100,
      });

      await service.updateBalance("account-1", 100);

      expect(mockQueryRunner.query).toHaveBeenCalledWith(
        expect.stringContaining("UPDATE accounts"),
        [100, "account-1"],
      );
    });
  });

  describe("touchAccount", () => {
    it("advances updated_at with an owner-scoped UPDATE and no balance change", async () => {
      // The crash-recovery backstop for net-worth snapshots: a snapshot-only
      // change (a past-dated row moved to another past month) leaves
      // current_balance untouched, so nothing would bump accounts.updated_at and
      // sweepStaleSnapshots could never find the stale snapshot. touchAccount
      // advances the timestamp -- owner-scoped, and it must not write the balance.
      mockQueryRunner.query.mockResolvedValue(undefined);

      await service.touchAccount("user-1", "account-1");

      const [sql, params] = mockQueryRunner.query.mock.calls[0];
      expect(sql).toContain("UPDATE accounts SET updated_at = now()");
      expect(sql).toContain("WHERE id = $1 AND user_id = $2");
      expect(sql).not.toContain("current_balance");
      expect(params).toEqual(["account-1", "user-1"]);
    });
  });

  describe("getTransactionCount", () => {
    it("returns counts and canDelete=true when no transactions", async () => {
      accountsRepository.findOne.mockResolvedValue(mockAccount);
      transactionRepository.count.mockResolvedValue(0);
      investmentTxRepository.count.mockResolvedValue(0);

      const result = await service.getTransactionCount("user-1", "account-1");

      expect(result.transactionCount).toBe(0);
      expect(result.investmentTransactionCount).toBe(0);
      expect(result.canDelete).toBe(true);
    });

    it("returns canDelete=false when transactions exist", async () => {
      accountsRepository.findOne.mockResolvedValue(mockAccount);
      transactionRepository.count.mockResolvedValue(5);
      investmentTxRepository.count.mockResolvedValue(0);

      const result = await service.getTransactionCount("user-1", "account-1");

      expect(result.canDelete).toBe(false);
    });

    it("returns canDelete=false when investment transactions exist", async () => {
      accountsRepository.findOne.mockResolvedValue(mockAccount);
      transactionRepository.count.mockResolvedValue(0);
      investmentTxRepository.count.mockResolvedValue(3);

      const result = await service.getTransactionCount("user-1", "account-1");

      expect(result.canDelete).toBe(false);
    });
  });

  describe("update", () => {
    it("updates account name", async () => {
      mockQueryRunner.manager.findOne.mockResolvedValue({ ...mockAccount });

      const result = await service.update("user-1", "account-1", {
        name: "Updated Name",
      });

      expect(result.name).toBe("Updated Name");
      expect(mockDataSource.transaction).toHaveBeenCalled();
    });

    it("assigns an owned institution on update", async () => {
      mockQueryRunner.manager.findOne.mockResolvedValue({ ...mockAccount });

      await service.update("user-1", "account-1", { institutionId: "inst-1" });

      const saved = mockQueryRunner.manager.save.mock.calls[0][0];
      expect(saved.institutionId).toBe("inst-1");
      expect(institutionsRepository.findOne).toHaveBeenCalled();
    });

    it("rejects an unowned institution on update", async () => {
      mockQueryRunner.manager.findOne.mockResolvedValue({ ...mockAccount });
      institutionsRepository.findOne.mockResolvedValue(null);

      await expect(
        service.update("user-1", "account-1", { institutionId: "x" }),
      ).rejects.toThrow(BadRequestException);
      expect(mockDataSource.transaction).toHaveBeenCalled();
    });

    it("links and unlinks a loan account for the equity view", async () => {
      mockQueryRunner.manager.findOne.mockResolvedValue({ ...mockAccount });
      await service.update("user-1", "account-1", {
        linkedLoanAccountId: "loan-1",
      });
      expect(
        mockQueryRunner.manager.save.mock.calls[0][0].linkedLoanAccountId,
      ).toBe("loan-1");

      mockQueryRunner.manager.save.mockClear();
      mockQueryRunner.manager.findOne.mockResolvedValue({
        ...mockAccount,
        linkedLoanAccountId: "loan-1",
      });
      await service.update("user-1", "account-1", {
        linkedLoanAccountId: null,
      });
      expect(
        mockQueryRunner.manager.save.mock.calls[0][0].linkedLoanAccountId,
      ).toBeNull();
    });

    it("throws BadRequestException for closed account", async () => {
      mockQueryRunner.manager.findOne.mockResolvedValue({
        ...mockAccount,
        isClosed: true,
      });

      await expect(
        service.update("user-1", "account-1", { name: "New" }),
      ).rejects.toThrow(BadRequestException);
      expect(mockDataSource.transaction).toHaveBeenCalled();
    });

    it("adjusts currentBalance when openingBalance changes", async () => {
      mockQueryRunner.manager.findOne.mockResolvedValue({
        ...mockAccount,
        openingBalance: 1000,
        currentBalance: 1500,
      });

      await service.update("user-1", "account-1", { openingBalance: 1200 });

      const saved = mockQueryRunner.manager.save.mock.calls[0][0];
      expect(saved.currentBalance).toBe(1700);
      expect(mockDataSource.transaction).toHaveBeenCalled();
    });

    it("recalculates termEndDate when termMonths changes to a positive value", async () => {
      const startDate = new Date("2025-01-15T12:00:00Z");
      mockQueryRunner.manager.findOne.mockResolvedValue({
        ...mockAccount,
        accountType: "MORTGAGE",
        paymentStartDate: startDate,
        termMonths: 60,
        termEndDate: new Date("2030-01-15"),
      });

      await service.update("user-1", "account-1", { termMonths: 36 });

      const saved = mockQueryRunner.manager.save.mock.calls[0][0];
      expect(saved.termMonths).toBe(36);
      expect(saved.termEndDate).toBeInstanceOf(Date);
      expect(saved.termEndDate.getTime()).toBeGreaterThan(startDate.getTime());
    });

    it("sets termEndDate to null when termMonths is set to 0", async () => {
      mockQueryRunner.manager.findOne.mockResolvedValue({
        ...mockAccount,
        accountType: "MORTGAGE",
        paymentStartDate: new Date("2025-01-01"),
        termMonths: 60,
        termEndDate: new Date("2030-01-01"),
      });

      await service.update("user-1", "account-1", { termMonths: 0 });

      const saved = mockQueryRunner.manager.save.mock.calls[0][0];
      expect(saved.termMonths).toBeNull();
      expect(saved.termEndDate).toBeNull();
    });

    it("writes the requested type and keeps it when a form resends it", async () => {
      const storedFixed = {
        ...mockAccount,
        accountType: "MORTGAGE",
        mortgageType: "CANADIAN_FIXED",
      };

      mockQueryRunner.manager.findOne.mockResolvedValue({ ...storedFixed });
      await service.update("user-1", "account-1", { mortgageType: "ANNUITY" });
      expect(mockQueryRunner.manager.save.mock.calls[0][0]).toMatchObject({
        mortgageType: "ANNUITY",
      });

      // A form resends every field: the same value keeps the same type.
      mockQueryRunner.manager.save.mockClear();
      mockQueryRunner.manager.findOne.mockResolvedValue({ ...storedFixed });
      await service.update("user-1", "account-1", {
        mortgageType: "CANADIAN_FIXED",
      });
      expect(mockQueryRunner.manager.save.mock.calls[0][0]).toMatchObject({
        mortgageType: "CANADIAN_FIXED",
      });
    });

    it("nulls the stored payment when a mortgage moves to LINEAR, keeping its mode", async () => {
      // docs/specs/mortgage-types.md decision 11: the column's CHECK refuses a
      // payment on a LINEAR row, and forms resend every field.
      mockQueryRunner.manager.findOne.mockResolvedValue({
        ...mockAccount,
        accountType: "MORTGAGE",
        mortgageType: "ANNUITY",
        paymentAmount: 1108.8584,
        paymentFrequency: "MONTHLY",
        paymentStartDate: "2024-01-01",
        amortizationMonths: 360,
        originalPrincipal: 300000,
      });

      await service.update("user-1", "account-1", {
        mortgageType: "LINEAR",
        prepaymentMode: "LOWER_INSTALLMENT",
        paymentAmount: 1108.8584,
      });

      expect(mockQueryRunner.manager.save.mock.calls[0][0]).toMatchObject({
        mortgageType: "LINEAR",
        prepaymentMode: "LOWER_INSTALLMENT",
        paymentAmount: null,
      });
    });

    it("reprices the linked template in the same transaction when the method changes", async () => {
      // docs/specs/mortgage-types.md section 5.6: the template still holds the
      // previous method's installment, and annuity advancement never lowers it.
      mockQueryRunner.manager.findOne.mockResolvedValue({
        ...mockAccount,
        accountType: "MORTGAGE",
        mortgageType: "ANNUITY",
        paymentAmount: 1108.8584,
        paymentFrequency: "MONTHLY",
        paymentStartDate: "2024-01-01",
        amortizationMonths: 360,
        originalPrincipal: 300000,
        scheduledTransactionId: "sched-1",
      });

      await service.update("user-1", "account-1", { mortgageType: "LINEAR" });
      expect(
        scheduledTransactionsService.repriceLoanTemplate,
      ).toHaveBeenCalledWith("sched-1");
      // After the account row it reads is written.
      expect(
        mockQueryRunner.manager.save.mock.invocationCallOrder[0],
      ).toBeLessThan(
        scheduledTransactionsService.repriceLoanTemplate.mock
          .invocationCallOrder[0],
      );

      // A save that keeps the method leaves the template alone.
      scheduledTransactionsService.repriceLoanTemplate.mockClear();
      mockQueryRunner.manager.findOne.mockResolvedValue({
        ...mockAccount,
        accountType: "MORTGAGE",
        mortgageType: "ANNUITY",
        scheduledTransactionId: "sched-1",
      });
      await service.update("user-1", "account-1", {
        mortgageType: "CANADIAN_FIXED",
      });
      expect(
        scheduledTransactionsService.repriceLoanTemplate,
      ).not.toHaveBeenCalled();
    });

    it("refuses to move a mortgage to INTEREST_ONLY without an amortization, writing nothing", async () => {
      mockQueryRunner.manager.findOne.mockResolvedValue({
        ...mockAccount,
        accountType: "MORTGAGE",
        mortgageType: "ANNUITY",
        paymentFrequency: "MONTHLY",
        paymentStartDate: "2024-01-01",
        amortizationMonths: null,
      });

      await expect(
        service.update("user-1", "account-1", {
          mortgageType: "INTEREST_ONLY",
        }),
      ).rejects.toThrow(/requires amortizationMonths/);
      expect(mockQueryRunner.manager.save).not.toHaveBeenCalled();
    });

    it("leaves the stored type alone when the request names none", async () => {
      mockQueryRunner.manager.findOne.mockResolvedValue({
        ...mockAccount,
        accountType: "MORTGAGE",
        mortgageType: "CANADIAN_FIXED",
      });
      await service.update("user-1", "account-1", { name: "Renamed" });
      expect(mockQueryRunner.manager.save.mock.calls[0][0]).toMatchObject({
        mortgageType: "CANADIAN_FIXED",
      });
    });

    it("reads a null type as naming none, never writing null to the NOT NULL column", async () => {
      // `@IsOptional()` lets a null through validation; an API or MCP caller
      // sending one must not reach the column or the traits lookup with it.
      mockQueryRunner.manager.findOne.mockResolvedValue({
        ...mockAccount,
        accountType: "MORTGAGE",
        mortgageType: "CANADIAN_FIXED",
      });
      await service.update("user-1", "account-1", {
        mortgageType: null,
      } as never);
      expect(mockQueryRunner.manager.save.mock.calls[0][0]).toMatchObject({
        mortgageType: "CANADIAN_FIXED",
      });
    });

    it("resets the type to the default when an edit moves a mortgage to another type", async () => {
      // Every non-mortgage row carries the column default; a stale
      // CANADIAN_FIXED left on a LOAN would describe a mortgage it is not.
      mockQueryRunner.manager.findOne.mockResolvedValue({
        ...mockAccount,
        accountType: "MORTGAGE",
        mortgageType: "CANADIAN_FIXED",
      });
      await service.update("user-1", "account-1", {
        accountType: AccountType.LOAN,
      });
      expect(mockQueryRunner.manager.save.mock.calls[0][0]).toMatchObject({
        accountType: AccountType.LOAN,
        mortgageType: "ANNUITY",
      });
    });

    it("writes no requested type on an account that is not a mortgage", async () => {
      mockQueryRunner.manager.findOne.mockResolvedValue({
        ...mockAccount,
        accountType: "LOAN",
        mortgageType: "ANNUITY",
      });
      await service.update("user-1", "account-1", {
        mortgageType: "CANADIAN_FIXED",
      });
      expect(mockQueryRunner.manager.save.mock.calls[0][0]).toMatchObject({
        mortgageType: "ANNUITY",
      });
    });

    it("updates amortizationMonths when provided", async () => {
      mockQueryRunner.manager.findOne.mockResolvedValue({
        ...mockAccount,
        accountType: "MORTGAGE",
        amortizationMonths: 300,
      });

      await service.update("user-1", "account-1", { amortizationMonths: 360 });

      const saved = mockQueryRunner.manager.save.mock.calls[0][0];
      expect(saved.amortizationMonths).toBe(360);
    });

    it("updates overpaymentCategoryId when provided", async () => {
      mockQueryRunner.manager.findOne.mockResolvedValue({
        ...mockAccount,
        accountType: "LOAN",
        overpaymentCategoryId: null,
      });

      await service.update("user-1", "account-1", {
        overpaymentCategoryId: "cat-overpay",
      });

      const saved = mockQueryRunner.manager.save.mock.calls[0][0];
      expect(saved.overpaymentCategoryId).toBe("cat-overpay");
    });

    it("clears overpaymentCategoryId when set to null", async () => {
      mockQueryRunner.manager.findOne.mockResolvedValue({
        ...mockAccount,
        accountType: "LOAN",
        overpaymentCategoryId: "cat-overpay",
      });

      await service.update("user-1", "account-1", {
        overpaymentCategoryId: null,
      });

      const saved = mockQueryRunner.manager.save.mock.calls[0][0];
      expect(saved.overpaymentCategoryId).toBeNull();
    });

    it("updates overpaymentMemo when provided, trimming whitespace", async () => {
      mockQueryRunner.manager.findOne.mockResolvedValue({
        ...mockAccount,
        accountType: "LOAN",
        overpaymentMemo: null,
      });

      await service.update("user-1", "account-1", {
        overpaymentMemo: "  Extra principal  ",
      });

      const saved = mockQueryRunner.manager.save.mock.calls[0][0];
      expect(saved.overpaymentMemo).toBe("Extra principal");
    });

    it("clears overpaymentMemo when set to null or blank", async () => {
      mockQueryRunner.manager.findOne.mockResolvedValue({
        ...mockAccount,
        accountType: "LOAN",
        overpaymentMemo: "Extra principal",
      });

      await service.update("user-1", "account-1", {
        overpaymentMemo: "   ",
      });

      const saved = mockQueryRunner.manager.save.mock.calls[0][0];
      expect(saved.overpaymentMemo).toBeNull();
    });

    it("updates credit card statement date fields", async () => {
      mockQueryRunner.manager.findOne.mockResolvedValue({
        ...mockAccount,
        accountType: "CREDIT_CARD",
        statementDueDay: null,
        statementSettlementDay: null,
      });

      await service.update("user-1", "account-1", {
        statementDueDay: 15,
        statementSettlementDay: 25,
      } as any);

      const saved = mockQueryRunner.manager.save.mock.calls[0][0];
      expect(saved.statementDueDay).toBe(15);
      expect(saved.statementSettlementDay).toBe(25);
    });

    it("updates only statementDueDay without affecting statementSettlementDay", async () => {
      mockQueryRunner.manager.findOne.mockResolvedValue({
        ...mockAccount,
        accountType: "CREDIT_CARD",
        statementDueDay: 10,
        statementSettlementDay: 20,
      });

      await service.update("user-1", "account-1", {
        statementDueDay: 5,
      } as any);

      const saved = mockQueryRunner.manager.save.mock.calls[0][0];
      expect(saved.statementDueDay).toBe(5);
      expect(saved.statementSettlementDay).toBe(20);
    });

    it("ignores statement date fields when updating a non-credit-card account", async () => {
      mockQueryRunner.manager.findOne.mockResolvedValue({
        ...mockAccount,
        accountType: "SAVINGS",
        statementDueDay: null,
        statementSettlementDay: null,
      });

      await service.update("user-1", "account-1", {
        statementDueDay: 15,
        statementSettlementDay: 25,
      } as any);

      const saved = mockQueryRunner.manager.save.mock.calls[0][0];
      expect(saved.statementDueDay).toBeNull();
      expect(saved.statementSettlementDay).toBeNull();
    });

    it("clears statement date fields when account type changes away from credit card", async () => {
      mockQueryRunner.manager.findOne.mockResolvedValue({
        ...mockAccount,
        accountType: "CREDIT_CARD",
        statementDueDay: 15,
        statementSettlementDay: 25,
      });

      await service.update("user-1", "account-1", {
        accountType: AccountType.CHEQUING,
      } as any);

      const saved = mockQueryRunner.manager.save.mock.calls[0][0];
      expect(saved.statementDueDay).toBeNull();
      expect(saved.statementSettlementDay).toBeNull();
    });

    it("records action history with beforeData and afterData on update", async () => {
      mockQueryRunner.manager.findOne.mockResolvedValue({ ...mockAccount });

      await service.update("user-1", "account-1", {
        name: "Updated Name",
      });

      expect(mockActionHistoryService.record).toHaveBeenCalledWith(
        "user-1",
        expect.objectContaining({
          entityType: "account",
          entityId: "account-1",
          action: "update",
          beforeData: expect.objectContaining({ name: "Checking" }),
          description: expect.stringContaining("Updated Name"),
        }),
      );
    });

    describe("currency lock", () => {
      it("allows currency change when account has no transactions", async () => {
        mockQueryRunner.manager.findOne.mockResolvedValue({ ...mockAccount });
        mockQueryRunner.manager.count.mockResolvedValue(0);

        await service.update("user-1", "account-1", { currencyCode: "CAD" });

        const saved = mockQueryRunner.manager.save.mock.calls[0][0];
        expect(saved.currencyCode).toBe("CAD");
        expect(mockDataSource.transaction).toHaveBeenCalled();
      });

      it("rejects currency change when account has regular transactions", async () => {
        mockQueryRunner.manager.findOne.mockResolvedValue({ ...mockAccount });
        mockQueryRunner.manager.count
          .mockResolvedValueOnce(3) // transactions
          .mockResolvedValueOnce(0); // investment transactions

        await expect(
          service.update("user-1", "account-1", { currencyCode: "CAD" }),
        ).rejects.toThrow(BadRequestException);
        expect(mockDataSource.transaction).toHaveBeenCalled();
        expect(mockQueryRunner.manager.save).not.toHaveBeenCalled();
      });

      it("rejects currency change when account has investment transactions", async () => {
        mockQueryRunner.manager.findOne.mockResolvedValue({ ...mockAccount });
        mockQueryRunner.manager.count
          .mockResolvedValueOnce(0) // transactions
          .mockResolvedValueOnce(2); // investment transactions

        await expect(
          service.update("user-1", "account-1", { currencyCode: "CAD" }),
        ).rejects.toThrow(BadRequestException);
        expect(mockDataSource.transaction).toHaveBeenCalled();
        expect(mockQueryRunner.manager.save).not.toHaveBeenCalled();
      });

      it("allows other field updates on accounts with transactions when currency is unchanged", async () => {
        mockQueryRunner.manager.findOne.mockResolvedValue({ ...mockAccount });
        mockQueryRunner.manager.count.mockResolvedValue(5);

        await service.update("user-1", "account-1", { name: "Renamed" });

        const saved = mockQueryRunner.manager.save.mock.calls[0][0];
        expect(saved.name).toBe("Renamed");
        expect(mockDataSource.transaction).toHaveBeenCalled();
      });

      it("allows passing the same currency on an account with transactions (no-op)", async () => {
        mockQueryRunner.manager.findOne.mockResolvedValue({ ...mockAccount });
        mockQueryRunner.manager.count.mockResolvedValue(5);

        await service.update("user-1", "account-1", {
          currencyCode: mockAccount.currencyCode,
        });

        expect(mockDataSource.transaction).toHaveBeenCalled();
      });
    });
  });

  describe("close", () => {
    it("closes account with zero balance", async () => {
      mockQueryRunner.manager.findOne.mockResolvedValue({
        ...mockAccount,
        currentBalance: 0,
      });

      const result = await service.close("user-1", "account-1");

      expect(result.isClosed).toBe(true);
      expect(result.closedDate).toBeDefined();
      expect(mockDataSource.transaction).toHaveBeenCalled();
    });

    it("throws when account already closed", async () => {
      mockQueryRunner.manager.findOne.mockResolvedValue({
        ...mockAccount,
        isClosed: true,
      });

      await expect(service.close("user-1", "account-1")).rejects.toThrow(
        "Account is already closed",
      );
      expect(mockDataSource.transaction).toHaveBeenCalled();
    });

    it("throws when balance is non-zero", async () => {
      mockQueryRunner.manager.findOne.mockResolvedValue({
        ...mockAccount,
        currentBalance: 500,
      });

      await expect(service.close("user-1", "account-1")).rejects.toThrow(
        "Cannot close account with non-zero balance",
      );
      expect(mockDataSource.transaction).toHaveBeenCalled();
    });

    it("throws NotFoundException when account not found", async () => {
      mockQueryRunner.manager.findOne.mockResolvedValue(null);

      await expect(service.close("user-1", "nonexistent")).rejects.toThrow(
        NotFoundException,
      );
      expect(mockDataSource.transaction).toHaveBeenCalled();
    });

    it("also closes linked brokerage account for investment cash", async () => {
      mockQueryRunner.manager.findOne
        .mockResolvedValueOnce({
          ...mockAccount,
          currentBalance: 0,
          accountType: AccountType.INVESTMENT,
          accountSubType: AccountSubType.INVESTMENT_CASH,
          linkedAccountId: "brokerage-1",
        })
        .mockResolvedValueOnce({
          id: "brokerage-1",
          isClosed: false,
          currentBalance: 0,
          userId: "user-1",
        });

      await service.close("user-1", "account-1");

      expect(mockQueryRunner.manager.save).toHaveBeenCalledTimes(2);
      expect(mockDataSource.transaction).toHaveBeenCalled();
    });
  });

  describe("reopen", () => {
    it("reopens a closed account", async () => {
      mockQueryRunner.manager.findOne.mockResolvedValue({
        ...mockAccount,
        isClosed: true,
        closedDate: new Date(),
      });

      const result = await service.reopen("user-1", "account-1");

      expect(result.isClosed).toBe(false);
      expect(result.closedDate).toBeNull();
    });

    it("throws when account is not closed", async () => {
      mockQueryRunner.manager.findOne.mockResolvedValue(mockAccount);

      await expect(service.reopen("user-1", "account-1")).rejects.toThrow(
        "Account is not closed",
      );
    });
  });

  describe("getBalance", () => {
    it("returns current balance", async () => {
      accountsRepository.findOne.mockResolvedValue(mockAccount);

      const result = await service.getBalance("user-1", "account-1");

      expect(result).toEqual({ balance: 1500 });
    });
  });

  describe("delete", () => {
    it("deletes account with no transactions", async () => {
      accountsRepository.findOne.mockResolvedValue({ ...mockAccount });
      transactionRepository.count.mockResolvedValue(0);
      investmentTxRepository.count.mockResolvedValue(0);

      await service.delete("user-1", "account-1");

      expect(mockQueryRunner.manager.remove).toHaveBeenCalled();
    });

    it("throws when account has transactions", async () => {
      accountsRepository.findOne.mockResolvedValue(mockAccount);
      transactionRepository.count.mockResolvedValue(5);

      await expect(service.delete("user-1", "account-1")).rejects.toThrow(
        BadRequestException,
      );
    });

    it("throws when account has investment transactions", async () => {
      accountsRepository.findOne.mockResolvedValue(mockAccount);
      transactionRepository.count.mockResolvedValue(0);
      investmentTxRepository.count.mockResolvedValue(2);

      await expect(service.delete("user-1", "account-1")).rejects.toThrow(
        BadRequestException,
      );
    });

    it("unlinks paired investment account before deletion", async () => {
      accountsRepository.findOne.mockResolvedValueOnce({
        ...mockAccount,
        linkedAccountId: "brokerage-1",
      });
      mockQueryRunner.manager.findOne.mockResolvedValueOnce({
        id: "brokerage-1",
        linkedAccountId: "account-1",
      });
      transactionRepository.count.mockResolvedValue(0);
      investmentTxRepository.count.mockResolvedValue(0);

      await service.delete("user-1", "account-1");

      const savedLinked = mockQueryRunner.manager.save.mock.calls[0][0];
      expect(savedLinked.linkedAccountId).toBeNull();
    });

    it("records action history on delete", async () => {
      accountsRepository.findOne.mockResolvedValue({ ...mockAccount });
      transactionRepository.count.mockResolvedValue(0);
      investmentTxRepository.count.mockResolvedValue(0);

      await service.delete("user-1", "account-1");

      expect(mockActionHistoryService.record).toHaveBeenCalledWith(
        "user-1",
        expect.objectContaining({
          entityType: "account",
          entityId: "account-1",
          action: "delete",
          beforeData: expect.objectContaining({ name: "Checking" }),
          description: expect.stringContaining("Checking"),
        }),
      );
    });
  });

  describe("findAll", () => {
    it("stays strictly owner-scoped -- AI/MCP listings exclude joint accounts (N2)", async () => {
      // The joint-account union happens only in the HTTP controller. Every
      // other consumer of findAll -- AI tools, MCP, internal summaries --
      // deliberately sees own accounts only (joint-accounts spec, N2 scope
      // cut). This pins the predicate so a widened findAll fails loudly.
      const where = jest.fn().mockReturnThis();
      const getMany = jest.fn().mockResolvedValue([]);
      accountsRepository.createQueryBuilder.mockReturnValue({
        where,
        andWhere: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        getMany,
      });

      await service.findAll("user-1");

      expect(where).toHaveBeenCalledWith("account.userId = :userId", {
        userId: "user-1",
      });
    });

    it("returns accounts with canDelete computed", async () => {
      const getMany = jest.fn().mockResolvedValue([mockAccount]);
      accountsRepository.createQueryBuilder.mockReturnValue({
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        getMany,
      });

      const result = await service.findAll("user-1");

      expect(result).toHaveLength(1);
      expect(result[0]).toHaveProperty("canDelete");
    });

    it("returns empty array when no accounts", async () => {
      const getMany = jest.fn().mockResolvedValue([]);
      accountsRepository.createQueryBuilder.mockReturnValue({
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        getMany,
      });

      const result = await service.findAll("user-1");

      expect(result).toHaveLength(0);
    });
  });

  describe("getSummary", () => {
    it("returns account summary by type", async () => {
      accountsRepository.find.mockResolvedValue([
        { ...mockAccount, currentBalance: 1000 },
        {
          ...mockAccount,
          id: "account-2",
          accountType: AccountType.CREDIT_CARD,
          currentBalance: -500,
        },
      ]);

      const result = await service.getSummary("user-1");

      expect(result).toBeDefined();
    });
  });

  describe("findByIds", () => {
    it("returns accounts matching provided IDs for the user", async () => {
      const accounts = [
        { id: "acc-1", userId: "user-1" },
        { id: "acc-2", userId: "user-1" },
      ];
      accountsRepository.find.mockResolvedValue(accounts);

      const result = await service.findByIds("user-1", ["acc-1", "acc-2"]);

      expect(accountsRepository.find).toHaveBeenCalledWith({
        where: { id: expect.anything(), userId: "user-1" },
      });
      expect(result).toHaveLength(2);
    });

    it("returns empty array when no IDs provided", async () => {
      const result = await service.findByIds("user-1", []);

      expect(accountsRepository.find).not.toHaveBeenCalled();
      expect(result).toEqual([]);
    });

    it("silently skips IDs that do not belong to user", async () => {
      accountsRepository.find.mockResolvedValue([
        { id: "acc-1", userId: "user-1" },
      ]);

      const result = await service.findByIds("user-1", [
        "acc-1",
        "acc-other-user",
      ]);

      expect(result).toHaveLength(1);
    });
  });

  describe("resetBrokerageBalances", () => {
    it("resets all brokerage account balances to 0", async () => {
      accountsRepository.update.mockResolvedValue({ affected: 2 });

      const result = await service.resetBrokerageBalances("user-1");

      expect(result).toBe(2);
      expect(accountsRepository.update).toHaveBeenCalledWith(
        {
          userId: "user-1",
          accountType: AccountType.INVESTMENT,
          accountSubType: AccountSubType.INVESTMENT_BROKERAGE,
        },
        { currentBalance: 0 },
      );
    });

    it("returns 0 when no brokerage accounts", async () => {
      accountsRepository.update.mockResolvedValue({ affected: 0 });

      const result = await service.resetBrokerageBalances("user-1");

      expect(result).toBe(0);
    });
  });

  describe("createInvestmentAccountPair", () => {
    it("creates cash and brokerage accounts linked together", async () => {
      let saveCallCount = 0;
      accountsRepository.save.mockImplementation((data) => {
        saveCallCount++;
        if (saveCallCount === 1) {
          // TypeORM save mutates in-place and returns the entity
          data.id = "cash-account-1";
          return data;
        }
        if (saveCallCount === 2) {
          data.id = "brokerage-account-1";
          return data;
        }
        return data;
      });

      const result = await service.createInvestmentAccountPair("user-1", {
        name: "My Investment",
        accountType: AccountType.INVESTMENT,
        currencyCode: "USD",
        openingBalance: 5000,
      } as any);

      expect(result.cashAccount).toBeDefined();
      expect(result.brokerageAccount).toBeDefined();

      // First create call should be cash account
      const cashCreate = accountsRepository.create.mock.calls[0][0];
      expect(cashCreate.name).toBe("My Investment - Cash");
      expect(cashCreate.accountSubType).toBe(AccountSubType.INVESTMENT_CASH);
      expect(cashCreate.openingBalance).toBe(5000);
      expect(cashCreate.currentBalance).toBe(5000);
      expect(cashCreate.userId).toBe("user-1");

      // Second create call should be brokerage account
      const brokerageCreate = accountsRepository.create.mock.calls[1][0];
      expect(brokerageCreate.name).toBe("My Investment - Brokerage");
      expect(brokerageCreate.accountSubType).toBe(
        AccountSubType.INVESTMENT_BROKERAGE,
      );
      expect(brokerageCreate.openingBalance).toBe(0);
      expect(brokerageCreate.currentBalance).toBe(0);
      // Linked to cash account via id assigned during save
      expect(brokerageCreate.linkedAccountId).toBe("cash-account-1");

      // Three saves: cash, brokerage, cash again (to set linkedAccountId)
      expect(accountsRepository.save).toHaveBeenCalledTimes(3);

      // Third save updates cash account with link back to brokerage
      expect(result.cashAccount.linkedAccountId).toBe("brokerage-account-1");

      // Verify transactional behavior
      expect(mockDataSource.transaction).toHaveBeenCalled();
    });

    it("defaults opening balance to 0 when not provided", async () => {
      accountsRepository.save.mockImplementation((data) => ({
        ...data,
        id: data.id || "gen-id",
      }));

      await service.createInvestmentAccountPair("user-1", {
        name: "Zero Balance Investment",
        accountType: AccountType.INVESTMENT,
        currencyCode: "CAD",
      } as any);

      const cashCreate = accountsRepository.create.mock.calls[0][0];
      expect(cashCreate.openingBalance).toBe(0);
      expect(cashCreate.currentBalance).toBe(0);
    });

    it("localizes the cash and brokerage suffixes to the request locale", async () => {
      const localized: Record<string, string> = {
        "common.accountSuffix.cash": "Bargeld",
        "common.accountSuffix.brokerage": "Depot",
      };
      jest.spyOn(I18nContext, "current").mockReturnValue({
        t: (key: string) => localized[key] ?? key,
      } as never);

      accountsRepository.save.mockImplementation((data) => ({
        ...data,
        id: data.id || "gen-id",
      }));

      await service.createInvestmentAccountPair("user-1", {
        name: "Depotkonto",
        accountType: AccountType.INVESTMENT,
        currencyCode: "EUR",
      } as any);

      const cashCreate = accountsRepository.create.mock.calls[0][0];
      const brokerageCreate = accountsRepository.create.mock.calls[1][0];
      expect(cashCreate.name).toBe("Depotkonto - Bargeld");
      expect(brokerageCreate.name).toBe("Depotkonto - Depot");
    });
  });

  describe("create - investment pair delegation", () => {
    it("delegates to createInvestmentAccountPair when INVESTMENT with createInvestmentPair", async () => {
      let saveCallCount = 0;
      accountsRepository.save.mockImplementation((data) => {
        saveCallCount++;
        return { ...data, id: `account-${saveCallCount}` };
      });
      accountsRepository.create.mockImplementation((data) => ({ ...data }));

      const result = await service.create("user-1", {
        name: "My Portfolio",
        accountType: AccountType.INVESTMENT,
        currencyCode: "USD",
        openingBalance: 1000,
        createInvestmentPair: true,
      } as any);

      // Should return the pair object
      expect(result).toHaveProperty("cashAccount");
      expect(result).toHaveProperty("brokerageAccount");
    });

    it("creates regular account when INVESTMENT without createInvestmentPair", async () => {
      const result = await service.create("user-1", {
        name: "Regular Investment",
        accountType: AccountType.INVESTMENT,
        currencyCode: "USD",
        openingBalance: 500,
      } as any);

      // Should return a single account, not a pair
      expect(result).not.toHaveProperty("cashAccount");
      expect(result).toHaveProperty("id");
    });
  });

  describe("create - loan delegation", () => {
    it("delegates to createLoanAccount when LOAN with all loan fields", async () => {
      accountsRepository.findOne.mockResolvedValue({
        ...mockAccount,
        id: "source-1",
      });
      accountsRepository.create.mockImplementation((data) => ({
        ...data,
        id: "loan-1",
      }));
      accountsRepository.save.mockImplementation((data) => data);

      const result = await service.create("user-1", {
        name: "Car Loan",
        accountType: AccountType.LOAN,
        currencyCode: "USD",
        openingBalance: 20000,
        paymentAmount: 500,
        paymentFrequency: "MONTHLY",
        paymentStartDate: "2025-01-01",
        sourceAccountId: "source-1",
        interestRate: 5.5,
        institution: "Bank of Test",
      } as any);

      // Should have created the account with negative balance (liability)
      const createCall = accountsRepository.create.mock.calls[0][0];
      expect(createCall.openingBalance).toBe(-20000);
      expect(createCall.currentBalance).toBe(-20000);
      expect(createCall.interestRate).toBe(5.5);
      expect(createCall.institution).toBe("Bank of Test");
      expect(result).toHaveProperty("id");
    });
  });

  describe("create - mortgage delegation", () => {
    it("delegates to createMortgageAccount when MORTGAGE with required mortgage fields", async () => {
      accountsRepository.findOne.mockResolvedValue({
        ...mockAccount,
        id: "source-1",
      });
      accountsRepository.create.mockImplementation((data) => ({
        ...data,
        id: "mortgage-1",
      }));
      accountsRepository.save.mockImplementation((data) => data);

      const result = await service.create("user-1", {
        name: "Home Mortgage",
        accountType: AccountType.MORTGAGE,
        currencyCode: "USD",
        openingBalance: 300000,
        mortgagePaymentFrequency: "MONTHLY",
        paymentStartDate: "2025-01-01",
        sourceAccountId: "source-1",
        amortizationMonths: 300,
        interestRate: 4.5,
        institution: "Mortgage Bank",
      } as any);

      const createCall = accountsRepository.create.mock.calls[0][0];
      expect(createCall.openingBalance).toBe(-300000);
      expect(createCall.currentBalance).toBe(-300000);
      expect(createCall.amortizationMonths).toBe(300);
      expect(result).toHaveProperty("id");
    });
  });

  describe("createLoanAccount", () => {
    const baseLoanDto = {
      name: "Personal Loan",
      accountType: AccountType.LOAN,
      currencyCode: "USD",
      openingBalance: 10000,
      paymentAmount: 250,
      paymentFrequency: "MONTHLY",
      paymentStartDate: "2025-03-01",
      sourceAccountId: "source-1",
      interestRate: 6.0,
      institution: "Test Bank",
    };

    beforeEach(() => {
      accountsRepository.findOne.mockResolvedValue({
        ...mockAccount,
        id: "source-1",
      });
      accountsRepository.create.mockImplementation((data) => ({
        ...data,
        id: "loan-account-1",
        name: data.name || "Personal Loan",
      }));
      accountsRepository.save.mockImplementation((data) => data);
    });

    it("throws BadRequestException when paymentAmount is missing", async () => {
      await expect(
        service.createLoanAccount("user-1", {
          ...baseLoanDto,
          paymentAmount: undefined,
        } as any),
      ).rejects.toThrow(BadRequestException);
    });

    it("throws BadRequestException when paymentFrequency is missing", async () => {
      await expect(
        service.createLoanAccount("user-1", {
          ...baseLoanDto,
          paymentFrequency: undefined,
        } as any),
      ).rejects.toThrow(BadRequestException);
    });

    it("throws BadRequestException when paymentStartDate is missing", async () => {
      await expect(
        service.createLoanAccount("user-1", {
          ...baseLoanDto,
          paymentStartDate: undefined,
        } as any),
      ).rejects.toThrow(BadRequestException);
    });

    it("throws BadRequestException when sourceAccountId is missing", async () => {
      await expect(
        service.createLoanAccount("user-1", {
          ...baseLoanDto,
          sourceAccountId: undefined,
        } as any),
      ).rejects.toThrow(BadRequestException);
    });

    it("throws BadRequestException when interestRate is missing", async () => {
      await expect(
        service.createLoanAccount("user-1", {
          ...baseLoanDto,
          interestRate: undefined,
        } as any),
      ).rejects.toThrow("Loan accounts require an interest rate");
    });

    it("throws BadRequestException when institution is missing", async () => {
      await expect(
        service.createLoanAccount("user-1", {
          ...baseLoanDto,
          institution: undefined,
        } as any),
      ).rejects.toThrow("Loan accounts require an institution name");
    });

    it("verifies source account belongs to user", async () => {
      accountsRepository.findOne.mockResolvedValue(null);

      await expect(
        service.createLoanAccount("user-1", baseLoanDto as any),
      ).rejects.toThrow(NotFoundException);
    });

    it("fetches loan categories when interestCategoryId not provided", async () => {
      await service.createLoanAccount("user-1", baseLoanDto as any);

      expect(categoriesService.findLoanCategories).toHaveBeenCalledWith(
        "user-1",
      );
    });

    it("uses provided interestCategoryId when given", async () => {
      await service.createLoanAccount("user-1", {
        ...baseLoanDto,
        interestCategoryId: "custom-cat-1",
      } as any);

      expect(categoriesService.findLoanCategories).not.toHaveBeenCalled();
      const createCall = accountsRepository.create.mock.calls[0][0];
      expect(createCall.interestCategoryId).toBe("custom-cat-1");
    });

    it("stores loan balance as negative (liability)", async () => {
      await service.createLoanAccount("user-1", baseLoanDto as any);

      const createCall = accountsRepository.create.mock.calls[0][0];
      expect(createCall.openingBalance).toBe(-10000);
      expect(createCall.currentBalance).toBe(-10000);
    });

    it("creates a scheduled transaction for loan payments", async () => {
      await service.createLoanAccount("user-1", baseLoanDto as any);

      expect(scheduledTransactionsService.create).toHaveBeenCalledWith(
        "user-1",
        expect.objectContaining({
          accountId: "source-1",
          name: expect.stringContaining("Loan Payment"),
          payeeName: "Test Bank",
          amount: -250,
          currencyCode: "USD",
          frequency: "MONTHLY",
          isActive: true,
          autoPost: false,
          splits: expect.arrayContaining([
            expect.objectContaining({ memo: "Principal" }),
            expect.objectContaining({ memo: "Interest" }),
          ]),
        }),
      );
    });

    it("updates account with scheduled transaction reference", async () => {
      const result = await service.createLoanAccount(
        "user-1",
        baseLoanDto as any,
      );

      expect(result.scheduledTransactionId).toBe("sched-tx-1");
      // save called twice: once for account creation, once for scheduledTransactionId update
      expect(accountsRepository.save).toHaveBeenCalledTimes(2);
    });

    it("handles negative openingBalance by taking absolute value", async () => {
      await service.createLoanAccount("user-1", {
        ...baseLoanDto,
        openingBalance: -15000,
      } as any);

      const createCall = accountsRepository.create.mock.calls[0][0];
      expect(createCall.openingBalance).toBe(-15000);
      expect(createCall.currentBalance).toBe(-15000);
    });
  });

  describe("createMortgageAccount", () => {
    const baseMortgageDto = {
      name: "Home Mortgage",
      accountType: AccountType.MORTGAGE,
      currencyCode: "CAD",
      openingBalance: 400000,
      mortgagePaymentFrequency: "MONTHLY",
      paymentStartDate: "2025-01-01",
      sourceAccountId: "source-1",
      amortizationMonths: 300,
      interestRate: 5.0,
      institution: "Big Bank",
    };

    beforeEach(() => {
      accountsRepository.findOne.mockResolvedValue({
        ...mockAccount,
        id: "source-1",
      });
      accountsRepository.create.mockImplementation((data) => ({
        ...data,
        id: "mortgage-1",
        name: data.name || "Home Mortgage",
      }));
      accountsRepository.save.mockImplementation((data) => data);
    });

    it("throws BadRequestException when mortgagePaymentFrequency is missing", async () => {
      await expect(
        service.createMortgageAccount("user-1", {
          ...baseMortgageDto,
          mortgagePaymentFrequency: undefined,
        } as any),
      ).rejects.toThrow(BadRequestException);
    });

    it("throws BadRequestException when paymentStartDate is missing", async () => {
      await expect(
        service.createMortgageAccount("user-1", {
          ...baseMortgageDto,
          paymentStartDate: undefined,
        } as any),
      ).rejects.toThrow(BadRequestException);
    });

    it("throws BadRequestException when sourceAccountId is missing", async () => {
      await expect(
        service.createMortgageAccount("user-1", {
          ...baseMortgageDto,
          sourceAccountId: undefined,
        } as any),
      ).rejects.toThrow(BadRequestException);
    });

    it("throws BadRequestException when amortizationMonths is missing", async () => {
      await expect(
        service.createMortgageAccount("user-1", {
          ...baseMortgageDto,
          amortizationMonths: undefined,
        } as any),
      ).rejects.toThrow(BadRequestException);
    });

    it("throws BadRequestException when interestRate is missing", async () => {
      await expect(
        service.createMortgageAccount("user-1", {
          ...baseMortgageDto,
          interestRate: undefined,
        } as any),
      ).rejects.toThrow("Mortgage accounts require an interest rate");
    });

    it("throws BadRequestException when institution is missing", async () => {
      await expect(
        service.createMortgageAccount("user-1", {
          ...baseMortgageDto,
          institution: undefined,
        } as any),
      ).rejects.toThrow("Mortgage accounts require an institution name");
    });

    it("verifies source account belongs to user", async () => {
      accountsRepository.findOne.mockResolvedValue(null);

      await expect(
        service.createMortgageAccount("user-1", baseMortgageDto as any),
      ).rejects.toThrow(NotFoundException);
    });

    it("fetches loan categories when interestCategoryId not provided", async () => {
      await service.createMortgageAccount("user-1", baseMortgageDto as any);

      expect(categoriesService.findLoanCategories).toHaveBeenCalledWith(
        "user-1",
      );
    });

    it("uses provided interestCategoryId when given", async () => {
      await service.createMortgageAccount("user-1", {
        ...baseMortgageDto,
        interestCategoryId: "custom-interest-cat",
      } as any);

      expect(categoriesService.findLoanCategories).not.toHaveBeenCalled();
    });

    it("stores mortgage balance as negative (liability)", async () => {
      await service.createMortgageAccount("user-1", baseMortgageDto as any);

      const createCall = accountsRepository.create.mock.calls[0][0];
      expect(createCall.openingBalance).toBe(-400000);
      expect(createCall.currentBalance).toBe(-400000);
    });

    it("sets mortgage-specific fields on the account", async () => {
      await service.createMortgageAccount("user-1", {
        ...baseMortgageDto,
        mortgageType: "CANADIAN_FIXED",
        termMonths: 60,
      } as any);

      const createCall = accountsRepository.create.mock.calls[0][0];
      expect(createCall.mortgageType).toBe("CANADIAN_FIXED");
      expect(createCall.termMonths).toBe(60);
      expect(createCall.amortizationMonths).toBe(300);
      expect(createCall.originalPrincipal).toBe(400000);
    });

    it("stores ANNUITY when the request names no type", async () => {
      await service.createMortgageAccount("user-1", baseMortgageDto as any);

      expect(accountsRepository.create.mock.calls[0][0]).toMatchObject({
        mortgageType: "ANNUITY",
      });
    });

    it("calculates termEndDate when termMonths provided", async () => {
      await service.createMortgageAccount("user-1", {
        ...baseMortgageDto,
        termMonths: 60,
      } as any);

      const createCall = accountsRepository.create.mock.calls[0][0];
      expect(createCall.termEndDate).toBeDefined();
      expect(createCall.termEndDate).toBeInstanceOf(Date);
    });

    it("sets termEndDate to null when termMonths not provided", async () => {
      await service.createMortgageAccount("user-1", baseMortgageDto as any);

      const createCall = accountsRepository.create.mock.calls[0][0];
      expect(createCall.termEndDate).toBeNull();
    });

    it("creates scheduled transaction for mortgage payments", async () => {
      await service.createMortgageAccount("user-1", baseMortgageDto as any);

      expect(scheduledTransactionsService.create).toHaveBeenCalledWith(
        "user-1",
        expect.objectContaining({
          accountId: "source-1",
          name: expect.stringContaining("Mortgage Payment"),
          payeeName: "Big Bank",
          currencyCode: "CAD",
          frequency: "MONTHLY",
          isActive: true,
          autoPost: false,
          splits: expect.arrayContaining([
            expect.objectContaining({
              memo: "Principal",
              transferAccountId: "mortgage-1",
            }),
            expect.objectContaining({ memo: "Interest" }),
          ]),
        }),
      );
    });

    it("maps accelerated biweekly frequency to BIWEEKLY for scheduled transaction", async () => {
      await service.createMortgageAccount("user-1", {
        ...baseMortgageDto,
        mortgagePaymentFrequency: "ACCELERATED_BIWEEKLY",
      } as any);

      expect(scheduledTransactionsService.create).toHaveBeenCalledWith(
        "user-1",
        expect.objectContaining({
          frequency: "BIWEEKLY",
        }),
      );
    });

    it("maps accelerated weekly frequency to WEEKLY for scheduled transaction", async () => {
      await service.createMortgageAccount("user-1", {
        ...baseMortgageDto,
        mortgagePaymentFrequency: "ACCELERATED_WEEKLY",
      } as any);

      expect(scheduledTransactionsService.create).toHaveBeenCalledWith(
        "user-1",
        expect.objectContaining({
          frequency: "WEEKLY",
        }),
      );
    });

    it("updates account with scheduled transaction reference", async () => {
      const result = await service.createMortgageAccount(
        "user-1",
        baseMortgageDto as any,
      );

      expect(result.scheduledTransactionId).toBe("sched-tx-1");
      expect(accountsRepository.save).toHaveBeenCalledTimes(2);
    });

    it("creates Canadian mortgage with correct parameters", async () => {
      await service.createMortgageAccount("user-1", {
        ...baseMortgageDto,
        mortgageType: "CANADIAN_FIXED",
      } as any);

      const createCall = accountsRepository.create.mock.calls[0][0];
      expect(createCall.mortgageType).toBe("CANADIAN_FIXED");
      // Payment amount should be calculated by the amortization utility
      expect(createCall.paymentAmount).toBeDefined();
      expect(typeof createCall.paymentAmount).toBe("number");
    });
  });

  describe("previewMortgageAmortization", () => {
    it("returns amortization result with expected properties", () => {
      const result = service.previewMortgageAmortization(
        300000,
        5.0,
        300,
        "MONTHLY" as any,
        new Date("2025-01-01"),
        "ANNUITY",
      );

      expect(result).toHaveProperty("paymentAmount");
      expect(result).toHaveProperty("principalPayment");
      expect(result).toHaveProperty("interestPayment");
      expect(result).toHaveProperty("totalPayments");
      expect(result).toHaveProperty("endDate");
      expect(result).toHaveProperty("totalInterest");
      expect(result).toHaveProperty("effectiveAnnualRate");
      expect(result.paymentAmount).toBeGreaterThan(0);
      expect(result.totalPayments).toBe(300);
    });

    it("uses absolute value of mortgage amount", () => {
      const resultPositive = service.previewMortgageAmortization(
        200000,
        4.0,
        300,
        "MONTHLY" as any,
        new Date("2025-01-01"),
        "ANNUITY",
      );
      const resultNegative = service.previewMortgageAmortization(
        -200000,
        4.0,
        300,
        "MONTHLY" as any,
        new Date("2025-01-01"),
        "ANNUITY",
      );

      expect(resultPositive.paymentAmount).toBe(resultNegative.paymentAmount);
    });

    it("supports Canadian mortgage calculation", () => {
      const resultCanadian = service.previewMortgageAmortization(
        300000,
        5.0,
        300,
        "MONTHLY" as any,
        new Date("2025-01-01"),
        "CANADIAN_FIXED",
      );
      const resultUS = service.previewMortgageAmortization(
        300000,
        5.0,
        300,
        "MONTHLY" as any,
        new Date("2025-01-01"),
        "ANNUITY",
      );

      // Canadian and US should produce different payment amounts
      // due to semi-annual compounding vs monthly compounding
      expect(resultCanadian.paymentAmount).not.toBe(resultUS.paymentAmount);
    });
  });

  describe("previewLoanAmortization", () => {
    it("returns amortization result with expected properties", () => {
      const result = service.previewLoanAmortization(
        10000,
        5.5,
        250,
        "MONTHLY" as any,
        new Date("2025-01-01"),
      );

      expect(result).toHaveProperty("principalPayment");
      expect(result).toHaveProperty("interestPayment");
      expect(result).toHaveProperty("remainingBalance");
      expect(result).toHaveProperty("totalPayments");
      expect(result).toHaveProperty("endDate");
      expect(result.principalPayment).toBeGreaterThan(0);
      expect(result.interestPayment).toBeGreaterThan(0);
    });

    it("uses absolute value of loan amount", () => {
      const resultPositive = service.previewLoanAmortization(
        10000,
        5.0,
        300,
        "MONTHLY" as any,
        new Date("2025-01-01"),
      );
      const resultNegative = service.previewLoanAmortization(
        -10000,
        5.0,
        300,
        "MONTHLY" as any,
        new Date("2025-01-01"),
      );

      expect(resultPositive.principalPayment).toBe(
        resultNegative.principalPayment,
      );
      expect(resultPositive.interestPayment).toBe(
        resultNegative.interestPayment,
      );
    });
  });

  describe("updateMortgageRate", () => {
    const mockMortgageAccount = {
      ...mockAccount,
      id: "mortgage-1",
      accountType: AccountType.MORTGAGE,
      currentBalance: -250000,
      interestRate: 5.0,
      paymentAmount: 1500,
      paymentFrequency: "MONTHLY",
      paymentStartDate: new Date("2024-01-01"),
      amortizationMonths: 300,
      mortgageType: "ANNUITY",
      scheduledTransactionId: "sched-tx-1",
      interestCategoryId: "interest-cat-1",
      isClosed: false,
    };

    beforeEach(() => {
      // The ledger debt through the effective date (`datedLoanDebt`), equal
      // here to the fixture's current balance.
      (mockQueryRunner.manager as unknown as { query: jest.Mock }).query = jest
        .fn()
        .mockResolvedValue([{ balance: "-250000" }]);
    });

    it("throws BadRequestException when account is not a mortgage", async () => {
      accountsRepository.findOne.mockResolvedValue({
        ...mockAccount,
        accountType: AccountType.CHEQUING,
      });

      await expect(
        service.updateMortgageRate(
          "user-1",
          "account-1",
          4.5,
          new Date("2025-06-01"),
        ),
      ).rejects.toThrow("This operation is only valid for mortgage accounts");
    });

    it("throws BadRequestException when account is closed", async () => {
      accountsRepository.findOne.mockResolvedValue({
        ...mockMortgageAccount,
        isClosed: true,
      });

      await expect(
        service.updateMortgageRate(
          "user-1",
          "mortgage-1",
          4.5,
          new Date("2025-06-01"),
        ),
      ).rejects.toThrow("Cannot update rate on a closed account");
    });

    it("auto-calculates new payment when newPaymentAmount not provided", async () => {
      accountsRepository.findOne.mockResolvedValue({
        ...mockMortgageAccount,
      });

      const result = await service.updateMortgageRate(
        "user-1",
        "mortgage-1",
        4.0,
        new Date("2025-06-01"),
      );

      expect(result.newRate).toBe(4.0);
      expect(result.paymentAmount).toBeGreaterThan(0);
      expect(result.principalPayment).toBeGreaterThan(0);
      expect(result.interestPayment).toBeGreaterThan(0);
      expect(result.effectiveDate).toBe("2025-06-01");
    });

    it("uses manual payment when newPaymentAmount is provided", async () => {
      accountsRepository.findOne.mockResolvedValue({
        ...mockMortgageAccount,
      });

      const result = await service.updateMortgageRate(
        "user-1",
        "mortgage-1",
        4.0,
        new Date("2025-06-01"),
        2000,
      );

      expect(result.paymentAmount).toBe(2000);
      expect(result.principalPayment).toBeGreaterThan(0);
      expect(result.interestPayment).toBeGreaterThan(0);
    });

    it("records a rate-history row via the rate-changes service", async () => {
      accountsRepository.findOne.mockResolvedValue({
        ...mockMortgageAccount,
      });

      await service.updateMortgageRate(
        "user-1",
        "mortgage-1",
        4.0,
        new Date("2025-06-01"),
      );

      expect(loanRateChangesService.create).toHaveBeenCalledWith(
        "user-1",
        "mortgage-1",
        {
          effectiveDate: "2025-06-01",
          annualRate: 4.0,
          newPaymentAmount: null,
          recalculatePayment: true,
        },
      );
    });

    it("passes an explicit payment through without recalculation", async () => {
      accountsRepository.findOne.mockResolvedValue({
        ...mockMortgageAccount,
      });

      await service.updateMortgageRate(
        "user-1",
        "mortgage-1",
        4.0,
        new Date("2025-06-01"),
        2000,
      );

      expect(loanRateChangesService.create).toHaveBeenCalledWith(
        "user-1",
        "mortgage-1",
        {
          effectiveDate: "2025-06-01",
          annualRate: 4.0,
          newPaymentAmount: 2000,
          recalculatePayment: false,
        },
      );
    });
  });

  describe("getInvestmentAccountPair", () => {
    it("returns cash/brokerage pair when account is INVESTMENT_CASH", async () => {
      const cashAccount = {
        ...mockAccount,
        id: "cash-1",
        accountType: AccountType.INVESTMENT,
        accountSubType: AccountSubType.INVESTMENT_CASH,
        linkedAccountId: "brokerage-1",
      };
      const brokerageAccount = {
        ...mockAccount,
        id: "brokerage-1",
        accountType: AccountType.INVESTMENT,
        accountSubType: AccountSubType.INVESTMENT_BROKERAGE,
        linkedAccountId: "cash-1",
      };

      accountsRepository.findOne
        .mockResolvedValueOnce(cashAccount)
        .mockResolvedValueOnce(brokerageAccount);

      const result = await service.getInvestmentAccountPair("user-1", "cash-1");

      expect(result.cashAccount.id).toBe("cash-1");
      expect(result.brokerageAccount.id).toBe("brokerage-1");
    });

    it("returns cash/brokerage pair when account is INVESTMENT_BROKERAGE", async () => {
      const brokerageAccount = {
        ...mockAccount,
        id: "brokerage-1",
        accountType: AccountType.INVESTMENT,
        accountSubType: AccountSubType.INVESTMENT_BROKERAGE,
        linkedAccountId: "cash-1",
      };
      const cashAccount = {
        ...mockAccount,
        id: "cash-1",
        accountType: AccountType.INVESTMENT,
        accountSubType: AccountSubType.INVESTMENT_CASH,
        linkedAccountId: "brokerage-1",
      };

      accountsRepository.findOne
        .mockResolvedValueOnce(brokerageAccount)
        .mockResolvedValueOnce(cashAccount);

      const result = await service.getInvestmentAccountPair(
        "user-1",
        "brokerage-1",
      );

      expect(result.cashAccount.id).toBe("cash-1");
      expect(result.brokerageAccount.id).toBe("brokerage-1");
    });

    it("throws BadRequestException when account is not an investment type", async () => {
      accountsRepository.findOne.mockResolvedValue({
        ...mockAccount,
        accountType: AccountType.CHEQUING,
        accountSubType: null,
      });

      await expect(
        service.getInvestmentAccountPair("user-1", "account-1"),
      ).rejects.toThrow(
        "This account is not part of an investment account pair",
      );
    });

    it("throws BadRequestException when investment account has no subType", async () => {
      accountsRepository.findOne.mockResolvedValue({
        ...mockAccount,
        accountType: AccountType.INVESTMENT,
        accountSubType: null,
      });

      await expect(
        service.getInvestmentAccountPair("user-1", "account-1"),
      ).rejects.toThrow(
        "This account is not part of an investment account pair",
      );
    });

    it("throws BadRequestException when no linked account exists", async () => {
      accountsRepository.findOne.mockResolvedValue({
        ...mockAccount,
        accountType: AccountType.INVESTMENT,
        accountSubType: AccountSubType.INVESTMENT_CASH,
        linkedAccountId: null,
      });

      await expect(
        service.getInvestmentAccountPair("user-1", "account-1"),
      ).rejects.toThrow(
        "This investment account does not have a linked account",
      );
    });
  });

  describe("update - currency sync on investment account", () => {
    it("syncs currency to linked account when currency changes on investment account", async () => {
      mockQueryRunner.manager.findOne
        .mockResolvedValueOnce({
          ...mockAccount,
          accountType: AccountType.INVESTMENT,
          linkedAccountId: "brokerage-1",
          currencyCode: "USD",
        })
        .mockResolvedValueOnce({
          id: "brokerage-1",
          userId: "user-1",
          currencyCode: "USD",
        });
      mockQueryRunner.manager.save.mockImplementation((data) => data);

      await service.update("user-1", "account-1", { currencyCode: "CAD" });

      // Second save should be the linked account currency update
      const linkedSave = mockQueryRunner.manager.save.mock.calls[1][0];
      expect(linkedSave.currencyCode).toBe("CAD");
      expect(mockDataSource.transaction).toHaveBeenCalled();
    });

    it("does not sync currency when account is not investment type", async () => {
      mockQueryRunner.manager.findOne.mockResolvedValue({
        ...mockAccount,
        accountType: AccountType.CHEQUING,
        linkedAccountId: null,
      });
      mockQueryRunner.manager.save.mockImplementation((data) => data);

      await service.update("user-1", "account-1", { currencyCode: "CAD" });

      // Only one save call for the main account
      expect(mockQueryRunner.manager.save).toHaveBeenCalledTimes(1);
    });
  });

  describe("update - renaming a pair", () => {
    // An earlier test in this file spies on I18nContext without restoring it,
    // so the ambient locale here depends on test order. Pin it rather than
    // inherit it: which words the server appends is part of what these
    // assertions are about.
    beforeEach(() => {
      const localized: Record<string, string> = {
        "common.accountSuffix.cash": "Bargeld",
        "common.accountSuffix.brokerage": "Depot",
      };
      jest.spyOn(I18nContext, "current").mockReturnValue({
        t: (key: string) => localized[key] ?? key,
      } as never);
    });

    afterEach(() => {
      jest.restoreAllMocks();
    });

    const half = (
      id: string,
      subType: AccountSubType,
      name: string,
      linkedTo: string,
    ) => ({
      ...mockAccount,
      id,
      name,
      accountType: AccountType.INVESTMENT,
      accountSubType: subType,
      linkedAccountId: linkedTo,
    });

    // A pair is one account with one name, stored twice. Renaming only the
    // half the user happened to open leaves the two disagreeing, and the row
    // shows whichever half it is built from.
    it("renames the cash half when the brokerage half is renamed", async () => {
      mockQueryRunner.manager.findOne
        .mockResolvedValueOnce(
          half(
            "brok-1",
            AccountSubType.INVESTMENT_BROKERAGE,
            "TFSA - Brokerage",
            "cash-1",
          ),
        )
        .mockResolvedValueOnce(
          half(
            "cash-1",
            AccountSubType.INVESTMENT_CASH,
            "TFSA - Cash",
            "brok-1",
          ),
        );

      await service.update("user-1", "brok-1", { name: "RRSP" });

      const [brokerageSave, cashSave] =
        mockQueryRunner.manager.save.mock.calls.map((c) => c[0]);
      expect(brokerageSave.name).toBe("RRSP - Depot");
      expect(cashSave.id).toBe("cash-1");
      expect(cashSave.name).toBe("RRSP - Bargeld");
    });

    it("renames the brokerage half when the cash half is renamed", async () => {
      mockQueryRunner.manager.findOne
        .mockResolvedValueOnce(
          half(
            "cash-1",
            AccountSubType.INVESTMENT_CASH,
            "TFSA - Cash",
            "brok-1",
          ),
        )
        .mockResolvedValueOnce(
          half(
            "brok-1",
            AccountSubType.INVESTMENT_BROKERAGE,
            "TFSA - Brokerage",
            "cash-1",
          ),
        );

      await service.update("user-1", "cash-1", { name: "RRSP" });

      const [cashSave, brokerageSave] =
        mockQueryRunner.manager.save.mock.calls.map((c) => c[0]);
      expect(cashSave.name).toBe("RRSP - Bargeld");
      expect(brokerageSave.name).toBe("RRSP - Depot");
    });

    // A client that sends the stored name back rather than the base must not
    // end up with "RRSP - Brokerage - Brokerage".
    it("does not stack a second suffix when sent an already suffixed name", async () => {
      mockQueryRunner.manager.findOne
        .mockResolvedValueOnce(
          half(
            "brok-1",
            AccountSubType.INVESTMENT_BROKERAGE,
            "TFSA - Brokerage",
            "cash-1",
          ),
        )
        .mockResolvedValueOnce(
          half(
            "cash-1",
            AccountSubType.INVESTMENT_CASH,
            "TFSA - Cash",
            "brok-1",
          ),
        );

      await service.update("user-1", "brok-1", { name: "RRSP - Depot" });

      const [brokerageSave, cashSave] =
        mockQueryRunner.manager.save.mock.calls.map((c) => c[0]);
      expect(brokerageSave.name).toBe("RRSP - Depot");
      expect(cashSave.name).toBe("RRSP - Bargeld");
    });

    // The English words are stripped alongside the locale's, so a pair created
    // before the user switched language still re-bases instead of keeping the
    // old suffix inside the new base.
    it("strips the English suffix too, not only the current locale's", async () => {
      mockQueryRunner.manager.findOne
        .mockResolvedValueOnce(
          half(
            "brok-1",
            AccountSubType.INVESTMENT_BROKERAGE,
            "TFSA - Brokerage",
            "cash-1",
          ),
        )
        .mockResolvedValueOnce(
          half(
            "cash-1",
            AccountSubType.INVESTMENT_CASH,
            "TFSA - Cash",
            "brok-1",
          ),
        );

      await service.update("user-1", "brok-1", { name: "RRSP - Brokerage" });

      const [brokerageSave, cashSave] =
        mockQueryRunner.manager.save.mock.calls.map((c) => c[0]);
      expect(brokerageSave.name).toBe("RRSP - Depot");
      expect(cashSave.name).toBe("RRSP - Bargeld");
    });

    it("leaves a standalone investment account name exactly as submitted", async () => {
      mockQueryRunner.manager.findOne.mockResolvedValueOnce({
        ...mockAccount,
        accountType: AccountType.INVESTMENT,
        accountSubType: null,
        linkedAccountId: null,
      });

      await service.update("user-1", "account-1", { name: "Self-directed" });

      expect(mockQueryRunner.manager.save).toHaveBeenCalledTimes(1);
      expect(mockQueryRunner.manager.save.mock.calls[0][0].name).toBe(
        "Self-directed",
      );
    });

    it("does not touch the partner when the rename is not part of the update", async () => {
      mockQueryRunner.manager.findOne.mockResolvedValueOnce(
        half(
          "brok-1",
          AccountSubType.INVESTMENT_BROKERAGE,
          "TFSA - Brokerage",
          "cash-1",
        ),
      );

      await service.update("user-1", "brok-1", { description: "notes" });

      expect(mockQueryRunner.manager.save).toHaveBeenCalledTimes(1);
    });
  });

  describe("update - net worth recalculation", () => {
    it("triggers net worth recalc when openingBalance changes", async () => {
      mockQueryRunner.manager.findOne.mockResolvedValue({
        ...mockAccount,
        openingBalance: 1000,
        currentBalance: 1500,
      });
      mockQueryRunner.manager.save.mockImplementation((data) => data);

      await service.update("user-1", "account-1", { openingBalance: 2000 });

      expect(netWorthService.recalculateAccount).toHaveBeenCalledWith(
        "user-1",
        "account-1",
      );
    });

    it("triggers net worth recalc when dateAcquired changes", async () => {
      mockQueryRunner.manager.findOne.mockResolvedValue({ ...mockAccount });
      mockQueryRunner.manager.save.mockImplementation((data) => data);

      await service.update("user-1", "account-1", {
        dateAcquired: "2024-06-01",
      });

      expect(netWorthService.recalculateAccount).toHaveBeenCalledWith(
        "user-1",
        "account-1",
      );
    });

    it("does not trigger net worth recalc for name-only change", async () => {
      mockQueryRunner.manager.findOne.mockResolvedValue({ ...mockAccount });
      mockQueryRunner.manager.save.mockImplementation((data) => data);

      await service.update("user-1", "account-1", { name: "New Name" });

      expect(netWorthService.recalculateAccount).not.toHaveBeenCalled();
    });
  });

  describe("close - investment cash account linked behavior", () => {
    it("also closes linked brokerage account for investment cash", async () => {
      mockQueryRunner.manager.findOne
        .mockResolvedValueOnce({
          ...mockAccount,
          currentBalance: 0,
          accountType: AccountType.INVESTMENT,
          accountSubType: AccountSubType.INVESTMENT_CASH,
          linkedAccountId: "brokerage-1",
        })
        .mockResolvedValueOnce({
          id: "brokerage-1",
          userId: "user-1",
          currentBalance: 0,
          isClosed: false,
        });
      mockQueryRunner.manager.save.mockImplementation((data) => data);

      await service.close("user-1", "account-1");

      // Two saves: one for the cash account, one for the brokerage
      expect(mockQueryRunner.manager.save).toHaveBeenCalledTimes(2);
      const brokerageSave = mockQueryRunner.manager.save.mock.calls[1][0];
      expect(brokerageSave.isClosed).toBe(true);
      expect(brokerageSave.closedDate).toBeDefined();
      expect(mockDataSource.transaction).toHaveBeenCalled();
    });

    it("does not close brokerage if already closed", async () => {
      mockQueryRunner.manager.findOne
        .mockResolvedValueOnce({
          ...mockAccount,
          currentBalance: 0,
          accountType: AccountType.INVESTMENT,
          accountSubType: AccountSubType.INVESTMENT_CASH,
          linkedAccountId: "brokerage-1",
        })
        .mockResolvedValueOnce({
          id: "brokerage-1",
          userId: "user-1",
          currentBalance: 0,
          isClosed: true,
        });
      mockQueryRunner.manager.save.mockImplementation((data) => data);

      await service.close("user-1", "account-1");

      // Only one save for the cash account
      expect(mockQueryRunner.manager.save).toHaveBeenCalledTimes(1);
      expect(mockDataSource.transaction).toHaveBeenCalled();
    });

    it("does not attempt to close linked account for non-investment account", async () => {
      mockQueryRunner.manager.findOne.mockResolvedValue({
        ...mockAccount,
        currentBalance: 0,
        accountSubType: null,
        linkedAccountId: null,
      });
      mockQueryRunner.manager.save.mockImplementation((data) => data);

      await service.close("user-1", "account-1");

      expect(mockQueryRunner.manager.save).toHaveBeenCalledTimes(1);
      expect(mockDataSource.transaction).toHaveBeenCalled();
    });
  });

  describe("close/reopen - the pair acts as one account", () => {
    const brokerageHalf = (over: Record<string, unknown> = {}) => ({
      ...mockAccount,
      id: "brokerage-1",
      currentBalance: 0,
      accountType: AccountType.INVESTMENT,
      accountSubType: AccountSubType.INVESTMENT_BROKERAGE,
      linkedAccountId: "cash-1",
      isClosed: false,
      ...over,
    });
    const cashHalf = (over: Record<string, unknown> = {}) => ({
      ...mockAccount,
      id: "cash-1",
      currentBalance: 0,
      accountType: AccountType.INVESTMENT,
      accountSubType: AccountSubType.INVESTMENT_CASH,
      linkedAccountId: "brokerage-1",
      isClosed: false,
      ...over,
    });

    // The cascade used to run one way only, so closing the brokerage left its
    // cash half open -- half a closed account, from a UI that offers one row.
    it("closes the cash half when the brokerage half is closed", async () => {
      mockQueryRunner.manager.findOne
        .mockResolvedValueOnce(brokerageHalf())
        .mockResolvedValueOnce(cashHalf());

      await service.close("user-1", "brokerage-1");

      expect(mockQueryRunner.manager.save).toHaveBeenCalledTimes(2);
      const cashSave = mockQueryRunner.manager.save.mock.calls[1][0];
      expect(cashSave.id).toBe("cash-1");
      expect(cashSave.isClosed).toBe(true);
      expect(cashSave.closedDate).toBeDefined();
    });

    it("reopens the cash half when the brokerage half is reopened", async () => {
      mockQueryRunner.manager.findOne
        .mockResolvedValueOnce(
          brokerageHalf({ isClosed: true, closedDate: new Date() }),
        )
        .mockResolvedValueOnce(
          cashHalf({ isClosed: true, closedDate: new Date() }),
        );

      await service.reopen("user-1", "brokerage-1");

      expect(mockQueryRunner.manager.save).toHaveBeenCalledTimes(2);
      const cashSave = mockQueryRunner.manager.save.mock.calls[1][0];
      expect(cashSave.id).toBe("cash-1");
      expect(cashSave.isClosed).toBe(false);
      expect(cashSave.closedDate).toBeNull();
    });

    // Closing the brokerage now closes the cash half too, so the balance that
    // blocks the close has to be looked for on both -- otherwise the pair
    // closes over money the user still has.
    it("refuses to close the brokerage when the cash half holds a balance", async () => {
      mockQueryRunner.manager.findOne
        .mockResolvedValueOnce(brokerageHalf())
        .mockResolvedValueOnce(cashHalf({ currentBalance: 250 }));

      await expect(service.close("user-1", "brokerage-1")).rejects.toThrow(
        BadRequestException,
      );
      expect(mockQueryRunner.manager.save).not.toHaveBeenCalled();
    });

    // A brokerage's current_balance is deliberately kept at 0, so the balance
    // check says nothing about the securities it holds: before this guard the
    // server closed an account full of positions and reported success.
    it("refuses to close an investment account that still holds securities", async () => {
      mockQueryRunner.manager.findOne
        .mockResolvedValueOnce(brokerageHalf())
        .mockResolvedValueOnce(cashHalf());
      mockQueryRunner.manager.count.mockResolvedValueOnce(2);

      await expect(service.close("user-1", "brokerage-1")).rejects.toThrow(
        /still holds securities/,
      );
      expect(mockQueryRunner.manager.save).not.toHaveBeenCalled();
    });

    it("counts holdings across both halves, from whichever half is addressed", async () => {
      mockQueryRunner.manager.findOne
        .mockResolvedValueOnce(cashHalf())
        .mockResolvedValueOnce(brokerageHalf());
      mockQueryRunner.manager.count.mockResolvedValueOnce(0);

      await service.close("user-1", "cash-1");

      const [entity, options] = mockQueryRunner.manager.count.mock.calls[0];
      expect(entity).toBe(Holding);
      expect(options.where.accountId._value).toEqual(["cash-1", "brokerage-1"]);
    });

    it("closes a standalone investment account holding nothing", async () => {
      mockQueryRunner.manager.findOne.mockResolvedValueOnce({
        ...mockAccount,
        currentBalance: 0,
        accountType: AccountType.INVESTMENT,
        accountSubType: null,
        linkedAccountId: null,
      });

      await service.close("user-1", "account-1");

      expect(mockQueryRunner.manager.save).toHaveBeenCalledTimes(1);
    });

    it("does not look for holdings when closing a non-investment account", async () => {
      mockQueryRunner.manager.findOne.mockResolvedValueOnce({
        ...mockAccount,
        currentBalance: 0,
      });

      await service.close("user-1", "account-1");

      expect(mockQueryRunner.manager.count).not.toHaveBeenCalled();
    });
  });

  describe("reopen - investment cash account linked behavior", () => {
    it("also reopens linked brokerage account for investment cash", async () => {
      mockQueryRunner.manager.findOne
        .mockResolvedValueOnce({
          ...mockAccount,
          isClosed: true,
          closedDate: new Date(),
          accountType: AccountType.INVESTMENT,
          accountSubType: AccountSubType.INVESTMENT_CASH,
          linkedAccountId: "brokerage-1",
        })
        .mockResolvedValueOnce({
          id: "brokerage-1",
          userId: "user-1",
          isClosed: true,
          closedDate: new Date(),
        });

      await service.reopen("user-1", "account-1");

      expect(mockQueryRunner.manager.save).toHaveBeenCalledTimes(2);
      const brokerageSave = mockQueryRunner.manager.save.mock.calls[1][0];
      expect(brokerageSave.isClosed).toBe(false);
      expect(brokerageSave.closedDate).toBeNull();
    });

    it("does not reopen brokerage if already open", async () => {
      mockQueryRunner.manager.findOne
        .mockResolvedValueOnce({
          ...mockAccount,
          isClosed: true,
          closedDate: new Date(),
          accountType: AccountType.INVESTMENT,
          accountSubType: AccountSubType.INVESTMENT_CASH,
          linkedAccountId: "brokerage-1",
        })
        .mockResolvedValueOnce({
          id: "brokerage-1",
          userId: "user-1",
          isClosed: false,
          closedDate: null,
        });

      await service.reopen("user-1", "account-1");

      // Only one save for the cash account
      expect(mockQueryRunner.manager.save).toHaveBeenCalledTimes(1);
    });

    it("does not attempt to reopen linked account for non-investment account", async () => {
      mockQueryRunner.manager.findOne.mockResolvedValue({
        ...mockAccount,
        isClosed: true,
        closedDate: new Date(),
        accountSubType: null,
        linkedAccountId: null,
      });

      await service.reopen("user-1", "account-1");

      expect(mockQueryRunner.manager.save).toHaveBeenCalledTimes(1);
    });
  });

  describe("delete - scheduled transaction cleanup", () => {
    it("deletes scheduled transaction for loan account", async () => {
      accountsRepository.findOne.mockResolvedValue({
        ...mockAccount,
        accountType: AccountType.LOAN,
        scheduledTransactionId: "sched-tx-to-delete",
        linkedAccountId: null,
      });
      transactionRepository.count.mockResolvedValue(0);
      investmentTxRepository.count.mockResolvedValue(0);

      await service.delete("user-1", "account-1");

      expect(scheduledTransactionsService.remove).toHaveBeenCalledWith(
        "user-1",
        "sched-tx-to-delete",
      );
      expect(mockQueryRunner.manager.remove).toHaveBeenCalled();
    });

    it("deletes scheduled transaction for mortgage account", async () => {
      accountsRepository.findOne.mockResolvedValue({
        ...mockAccount,
        accountType: AccountType.MORTGAGE,
        scheduledTransactionId: "sched-tx-mortgage",
        linkedAccountId: null,
      });
      transactionRepository.count.mockResolvedValue(0);
      investmentTxRepository.count.mockResolvedValue(0);

      await service.delete("user-1", "account-1");

      expect(scheduledTransactionsService.remove).toHaveBeenCalledWith(
        "user-1",
        "sched-tx-mortgage",
      );
    });

    it("continues deletion even if scheduled transaction removal fails", async () => {
      accountsRepository.findOne.mockResolvedValue({
        ...mockAccount,
        accountType: AccountType.LOAN,
        scheduledTransactionId: "sched-tx-gone",
        linkedAccountId: null,
      });
      transactionRepository.count.mockResolvedValue(0);
      investmentTxRepository.count.mockResolvedValue(0);
      scheduledTransactionsService.remove.mockRejectedValue(
        new Error("already deleted"),
      );

      await service.delete("user-1", "account-1");

      expect(mockQueryRunner.manager.remove).toHaveBeenCalled();
    });

    it("does not delete scheduled transaction for non-loan/mortgage accounts", async () => {
      accountsRepository.findOne.mockResolvedValue({
        ...mockAccount,
        accountType: AccountType.CHEQUING,
        scheduledTransactionId: "sched-tx-1",
        linkedAccountId: null,
      });
      transactionRepository.count.mockResolvedValue(0);
      investmentTxRepository.count.mockResolvedValue(0);

      await service.delete("user-1", "account-1");

      expect(scheduledTransactionsService.remove).not.toHaveBeenCalled();
    });
  });

  describe("delete - linked account unlinking", () => {
    it("unlinks paired investment account before deletion", async () => {
      accountsRepository.findOne.mockResolvedValueOnce({
        ...mockAccount,
        linkedAccountId: "brokerage-1",
      });
      mockQueryRunner.manager.findOne.mockResolvedValueOnce({
        id: "brokerage-1",
        linkedAccountId: "account-1",
      });
      transactionRepository.count.mockResolvedValue(0);
      investmentTxRepository.count.mockResolvedValue(0);

      await service.delete("user-1", "account-1");

      const savedLinked = mockQueryRunner.manager.save.mock.calls[0][0];
      expect(savedLinked.linkedAccountId).toBeNull();
      expect(mockQueryRunner.manager.remove).toHaveBeenCalled();
    });

    it("handles case where linked account no longer exists", async () => {
      accountsRepository.findOne.mockResolvedValueOnce({
        ...mockAccount,
        linkedAccountId: "gone-account",
      });
      mockQueryRunner.manager.findOne.mockResolvedValueOnce(null);
      transactionRepository.count.mockResolvedValue(0);
      investmentTxRepository.count.mockResolvedValue(0);

      await service.delete("user-1", "account-1");

      // Should still delete successfully without error
      expect(mockQueryRunner.manager.remove).toHaveBeenCalled();
      // save should not have been called for the linked account
      expect(mockQueryRunner.manager.save).not.toHaveBeenCalled();
    });
  });

  describe("findAll - includeInactive", () => {
    it("includes closed accounts when includeInactive is true", async () => {
      const andWhereMock = jest.fn().mockReturnThis();
      const getMany = jest.fn().mockResolvedValue([
        { ...mockAccount, isClosed: false },
        { ...mockAccount, id: "closed-1", isClosed: true },
      ]);
      accountsRepository.createQueryBuilder.mockReturnValue({
        where: jest.fn().mockReturnThis(),
        andWhere: andWhereMock,
        orderBy: jest.fn().mockReturnThis(),
        getMany,
      });

      const result = await service.findAll("user-1", true);

      // andWhere should NOT be called with isClosed filter
      expect(andWhereMock).not.toHaveBeenCalled();
      expect(result).toHaveLength(2);
    });

    it("filters out closed accounts when includeInactive is false", async () => {
      const andWhereMock = jest.fn().mockReturnThis();
      const getMany = jest.fn().mockResolvedValue([mockAccount]);
      accountsRepository.createQueryBuilder.mockReturnValue({
        where: jest.fn().mockReturnThis(),
        andWhere: andWhereMock,
        orderBy: jest.fn().mockReturnThis(),
        getMany,
      });

      await service.findAll("user-1", false);

      expect(andWhereMock).toHaveBeenCalledWith(
        "account.isClosed = :isClosed",
        { isClosed: false },
      );
    });
  });

  describe("getSummary - net worth derivation", () => {
    const stubAccounts = (accounts: unknown[]) => {
      const getMany = jest.fn().mockResolvedValue(accounts);
      accountsRepository.createQueryBuilder.mockReturnValue({
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        getMany,
      });
    };

    it("sums currentBalance into totalBalance and counts accounts", async () => {
      stubAccounts([
        { ...mockAccount, id: "a1", currentBalance: 5000 },
        { ...mockAccount, id: "a2", currentBalance: 10000 },
        { ...mockAccount, id: "l1", currentBalance: -2000 },
        { ...mockAccount, id: "l2", currentBalance: -300000 },
      ]);

      const result = await service.getSummary("user-1");

      expect(result.totalBalance).toBe(5000 + 10000 - 2000 - 300000);
      expect(result.totalAccounts).toBe(4);
    });

    it("derives assets, liabilities and net worth from the latest monthly snapshot", async () => {
      stubAccounts([{ ...mockAccount, id: "a1", currentBalance: 5000 }]);
      // getLatestNetWorth is the canonical source shared with the dashboard
      // widget and get_account_balances; getSummary must report its latest month.
      netWorthService.getLatestNetWorth.mockResolvedValue({
        assets: 25000,
        liabilities: 302000,
        netWorth: 25000 - 302000,
      });

      const result = await service.getSummary("user-1");

      expect(result.totalAssets).toBe(25000);
      expect(result.totalLiabilities).toBe(302000);
      expect(result.netWorth).toBe(25000 - 302000);
    });

    it("returns zero net worth when no monthly snapshots exist", async () => {
      stubAccounts([{ ...mockAccount, id: "a1", currentBalance: 5000 }]);
      netWorthService.getLatestNetWorth.mockResolvedValue(null);

      const result = await service.getSummary("user-1");

      expect(result.totalAssets).toBe(0);
      expect(result.totalLiabilities).toBe(0);
      expect(result.netWorth).toBe(0);
      // totalBalance still reflects the raw book balance
      expect(result.totalBalance).toBe(5000);
    });

    it("returns zeros across the board when no accounts exist", async () => {
      stubAccounts([]);
      netWorthService.getLatestNetWorth.mockResolvedValue(null);

      const result = await service.getSummary("user-1");

      expect(result.totalAccounts).toBe(0);
      expect(result.totalBalance).toBe(0);
      expect(result.netWorth).toBe(0);
    });
  });

  describe("reorderFavourites()", () => {
    it("applies the new ordering in a single bulk UPDATE scoped to the user", async () => {
      accountsRepository.query.mockResolvedValue(undefined);

      await service.reorderFavourites("user-1", [
        "account-a",
        "account-b",
        "account-c",
      ]);

      expect(mockQueryRunner.query).toHaveBeenCalledTimes(1);
      const [sql, params] = mockQueryRunner.query.mock.calls[0];
      // ids are parameterized, the sort order is the array index, and the
      // userId is the final parameter constraining the update.
      expect(sql).toContain("UPDATE accounts SET favourite_sort_order");
      expect(sql).toContain("accounts.user_id = $4");
      expect(sql).toContain("($1::uuid, 0)");
      expect(sql).toContain("($3::uuid, 2)");
      expect(params).toEqual(["account-a", "account-b", "account-c", "user-1"]);
    });

    it("does nothing when the list is empty", async () => {
      await service.reorderFavourites("user-1", []);
      expect(accountsRepository.query).not.toHaveBeenCalled();
    });

    it("throws BadRequestException when accountIds is not an array", async () => {
      await expect(
        service.reorderFavourites("user-1", "not-array" as unknown as string[]),
      ).rejects.toThrow(BadRequestException);
    });
  });

  // ─── extra branch coverage ────────────────────────────────────────────
  describe("update extra branches", () => {
    it("throws NotFoundException when account is not found", async () => {
      mockQueryRunner.manager.findOne.mockResolvedValue(null);
      await expect(
        service.update("user-1", "missing", { name: "x" }),
      ).rejects.toThrow(NotFoundException);
      expect(mockDataSource.transaction).toHaveBeenCalled();
    });

    it("does NOT adjust currentBalance when openingBalance unchanged", async () => {
      mockQueryRunner.manager.findOne.mockResolvedValue({
        ...mockAccount,
        openingBalance: 1000,
        currentBalance: 1500,
      });
      await service.update("user-1", "account-1", {
        openingBalance: 1000,
      });
      const saved = mockQueryRunner.manager.save.mock.calls[0][0];
      // currentBalance unchanged because diff is zero
      expect(saved.currentBalance).toBe(1500);
    });

    it("updates linked investment account currency when changed", async () => {
      mockQueryRunner.manager.findOne
        .mockResolvedValueOnce({
          ...mockAccount,
          accountType: AccountType.INVESTMENT,
          linkedAccountId: "linked-1",
          currencyCode: "USD",
        })
        .mockResolvedValueOnce({
          id: "linked-1",
          userId: "user-1",
          currencyCode: "USD",
        });
      await service.update("user-1", "account-1", {
        currencyCode: "CAD",
      });
      // 2 saves: original account + linked account
      expect(mockQueryRunner.manager.save).toHaveBeenCalledTimes(2);
    });

    it("does not save linked account when not found", async () => {
      mockQueryRunner.manager.findOne
        .mockResolvedValueOnce({
          ...mockAccount,
          accountType: AccountType.INVESTMENT,
          linkedAccountId: "linked-1",
          currencyCode: "USD",
        })
        .mockResolvedValueOnce(null);
      await service.update("user-1", "account-1", {
        currencyCode: "CAD",
      });
      // Only the main account save runs
      expect(mockQueryRunner.manager.save).toHaveBeenCalledTimes(1);
    });

    it("syncs institution to the linked investment account when changed", async () => {
      mockQueryRunner.manager.findOne
        .mockResolvedValueOnce({
          ...mockAccount,
          accountType: AccountType.INVESTMENT,
          linkedAccountId: "linked-1",
          institutionId: null,
        })
        .mockResolvedValueOnce({
          id: "linked-1",
          userId: "user-1",
          institutionId: null,
        });
      await service.update("user-1", "account-1", { institutionId: "inst-1" });
      // 2 saves: original account + linked partner
      expect(mockQueryRunner.manager.save).toHaveBeenCalledTimes(2);
      const linkedSave = mockQueryRunner.manager.save.mock.calls[1][0];
      expect(linkedSave.institutionId).toBe("inst-1");
    });

    it("triggers net-worth recalc when openingBalance changes", async () => {
      mockQueryRunner.manager.findOne.mockResolvedValue({
        ...mockAccount,
        openingBalance: 1000,
        currentBalance: 1500,
      });
      await service.update("user-1", "account-1", { openingBalance: 1200 });
      // Allow microtask
      await Promise.resolve();
      expect(netWorthService.recalculateAccount).toHaveBeenCalledWith(
        "user-1",
        "account-1",
      );
    });

    it("updates many fields with explicit mapping (description/account number/etc)", async () => {
      mockQueryRunner.manager.findOne.mockResolvedValue({ ...mockAccount });
      await service.update("user-1", "account-1", {
        description: "desc",
        accountNumber: "123",
        institution: "Bank",
        creditLimit: 5000,
        interestRate: 1.5,
        isFavourite: true,
        excludeFromNetWorth: true,
        favouriteSortOrder: 5,
        paymentAmount: 100,
        paymentFrequency: "MONTHLY",
        paymentStartDate: "2025-01-01",
        sourceAccountId: "src-1",
        principalCategoryId: "p-1",
        interestCategoryId: "i-1",
        assetCategoryId: "a-1",
        dateAcquired: "2024-01-01",
        mortgageType: "CANADIAN_FIXED",
      } as never);
      const saved = mockQueryRunner.manager.save.mock.calls[0][0];
      expect(saved.description).toBe("desc");
      expect(saved.accountNumber).toBe("123");
      expect(saved.institution).toBe("Bank");
      expect(saved.paymentStartDate).toBeInstanceOf(Date);
      expect(saved.dateAcquired).toBeInstanceOf(Date);
    });

    it("nulls paymentStartDate and dateAcquired when set to null", async () => {
      mockQueryRunner.manager.findOne.mockResolvedValue({
        ...mockAccount,
        paymentStartDate: new Date("2024-01-01"),
        dateAcquired: new Date("2024-01-01"),
      });
      await service.update("user-1", "account-1", {
        paymentStartDate: null,
        dateAcquired: null,
      } as never);
      const saved = mockQueryRunner.manager.save.mock.calls[0][0];
      expect(saved.paymentStartDate).toBeNull();
      expect(saved.dateAcquired).toBeNull();
    });

    it("termMonths>0 without paymentStartDate sets termEndDate to null", async () => {
      mockQueryRunner.manager.findOne.mockResolvedValue({
        ...mockAccount,
        accountType: AccountType.MORTGAGE,
        paymentStartDate: null,
      });
      await service.update("user-1", "account-1", {
        termMonths: 24,
      } as never);
      const saved = mockQueryRunner.manager.save.mock.calls[0][0];
      expect(saved.termMonths).toBe(24);
      expect(saved.termEndDate).toBeNull();
    });
  });

  describe("updateBalance", () => {
    it("applies the atomic UPDATE and re-reads the balance in one scoped transaction", async () => {
      // The guarded UPDATE answers as the driver does: a matched row, as a tuple.
      mockQueryRunner.query.mockImplementation(async (sql: string) =>
        String(sql).includes("UPDATE accounts")
          ? [[{ id: "account-1" }], 1]
          : [[], 0],
      );
      accountsRepository.findOneOrFail.mockResolvedValue({
        ...mockAccount,
        currentBalance: 200,
      });
      const result = await service.updateBalance("account-1", 100);
      expect(mockQueryRunner.query).toHaveBeenCalledWith(
        expect.stringContaining("UPDATE accounts"),
        [100, "account-1"],
      );
      expect(result.currentBalance).toBe(200);
    });
  });

  describe("recalculateCurrentBalance", () => {
    /**
     * The recomputation locks the account rows and then reads the ledger.
     *
     * That order is the fix, not a detail: it writes an absolute balance, and
     * under READ COMMITTED its SELECT and its UPDATE are separate statement
     * snapshots -- so a delta committing between them used to be overwritten by a
     * total that never saw it (audit P4-005). The double answers the lock, the
     * sum, and the write in the order the transaction issues them.
     */
    function stageRecalc(balanceRows: unknown[]): jest.Mock {
      const query = jest.fn().mockImplementation(async (sql: string) => {
        if (String(sql).includes("FOR UPDATE")) return [{ id: "account-1" }];
        if (String(sql).includes("COALESCE(SUM(t.amount)")) return balanceRows;
        return [];
      });
      (mockQueryRunner.manager as unknown as { query: jest.Mock }).query =
        query;
      return query;
    }

    it("throws NotFoundException when the account is gone", async () => {
      // The ledger sum joins from `accounts`, so no row means no account.
      stageRecalc([]);
      await expect(
        service.recalculateCurrentBalance("user-1", "nope"),
      ).rejects.toThrow(NotFoundException);
    });

    it("computes the new balance from the summed transactions", async () => {
      stageRecalc([{ balance: "150.5" }]);
      accountsRepository.findOneOrFail.mockResolvedValue({
        ...mockAccount,
        currentBalance: 150.5,
      });

      const result = await service.recalculateCurrentBalance(
        "user-1",
        "account-1",
      );

      expect(result.currentBalance).toBe(150.5);
    });

    it("locks the account before reading the ledger, scoped to the owner", async () => {
      const query = stageRecalc([{ balance: "150.5" }]);
      accountsRepository.findOneOrFail.mockResolvedValue({ ...mockAccount });

      await service.recalculateCurrentBalance("user-1", "account-1");

      const statements = query.mock.calls.map((c) => String(c[0]));
      const lockAt = statements.findIndex((sql) => sql.includes("FOR UPDATE"));
      const sumAt = statements.findIndex((sql) =>
        sql.includes("COALESCE(SUM(t.amount)"),
      );
      expect(lockAt).toBeGreaterThanOrEqual(0);
      expect(lockAt).toBeLessThan(sumAt);

      // The balance-write lock is owner-scoped: an own-context recomputation
      // must never lock an account that is not the caller's (maintainer review,
      // PR #1095). The userId reaches lockAccountsForBalanceWrite and lands in
      // the FOR UPDATE predicate.
      const lockCall = query.mock.calls.find((c) =>
        String(c[0]).includes("FOR UPDATE"),
      );
      expect(String(lockCall![0])).toContain("user_id = $2");
      expect(lockCall![1]).toEqual([["account-1"], "user-1"]);
    });

    it("writes only current_balance, never the whole account row", async () => {
      // Saving the entity read before the transaction would write back every
      // other column from that snapshot, so a concurrent rename or
      // opening-balance edit would be reverted by a balance recalculation.
      const query = stageRecalc([{ balance: "275.5" }]);
      accountsRepository.findOneOrFail.mockResolvedValue({
        ...mockAccount,
        currentBalance: 275.5,
      });

      const result = await service.recalculateCurrentBalance(
        "user-1",
        "account-1",
      );

      expect(result.currentBalance).toBe(275.5);
      expect(accountsRepository.save).not.toHaveBeenCalled();
      const write = query.mock.calls
        .map((c) => String(c[0]))
        .find((sql) => sql.startsWith("UPDATE accounts"));
      expect(write).toBe(
        "UPDATE accounts SET current_balance = $1 WHERE id = $2",
      );
    });

    it("resolves an account with no transactions to its opening balance", async () => {
      // The old implementation fell back to `openingBalance` in code when the
      // sum query returned nothing; the LEFT JOIN + COALESCE now answer that
      // case in SQL, so an empty result means only "no such account". The
      // behaviour the fallback protected -- no ledger rows means the opening
      // balance -- is asserted here through the query's own answer.
      stageRecalc([{ balance: "100" }]);
      accountsRepository.findOneOrFail.mockResolvedValue({
        ...mockAccount,
        openingBalance: 100,
        currentBalance: 100,
      });
      const r = await service.recalculateCurrentBalance("user-1", "account-1");
      expect(r.currentBalance).toBe(100);
    });
  });

  describe("getProjectedBalance", () => {
    it("returns 0 when no rows", async () => {
      const ds = mockQueryRunner.manager as unknown as { query: jest.Mock };
      ds.query = jest.fn().mockResolvedValue([]);
      const v = await service.getProjectedBalance("user-1", "account-1");
      expect(v).toBe(0);
    });

    it("returns rounded balance from query result", async () => {
      const ds = mockQueryRunner.manager as unknown as { query: jest.Mock };
      ds.query = jest.fn().mockResolvedValue([{ balance: "1234.56789" }]);
      const v = await service.getProjectedBalance("user-1", "account-1");
      expect(v).toBe(1234.5679);
    });
  });

  describe("getLlmAccounts", () => {
    const allAccounts = [
      {
        id: "a1",
        userId: "user-1",
        name: "Checking",
        accountType: AccountType.CHEQUING,
        accountSubType: null,
        currencyCode: "USD",
        currentBalance: 100,
        futureTransactionsSum: 0,
        creditLimit: null,
        interestRate: null,
        excludeFromNetWorth: false,
        institutionId: "inst-1",
        accountNumber: "1234",
        isClosed: false,
      },
      {
        id: "a2",
        userId: "user-1",
        name: "Savings",
        accountType: AccountType.SAVINGS,
        accountSubType: null,
        currencyCode: "USD",
        currentBalance: 200,
        futureTransactionsSum: 0,
        creditLimit: 5000,
        interestRate: 1.25,
        excludeFromNetWorth: true,
        institutionId: null,
        accountNumber: null,
        isClosed: true,
      },
      {
        id: "a3",
        userId: "user-1",
        name: "Brokerage",
        accountType: AccountType.INVESTMENT,
        accountSubType: AccountSubType.INVESTMENT_BROKERAGE,
        currencyCode: "USD",
        currentBalance: 500,
        futureTransactionsSum: 0,
        creditLimit: null,
        interestRate: null,
        excludeFromNetWorth: false,
        institutionId: null,
        accountNumber: null,
        isClosed: false,
      },
    ];

    beforeEach(() => {
      jest.spyOn(service, "findAll").mockResolvedValue(allAccounts as never);
      (
        netWorthService as unknown as Record<string, jest.Mock>
      ).getLatestNetWorth = jest
        .fn()
        .mockResolvedValue({ assets: 800, liabilities: 0, netWorth: 800 });
      (
        service["portfolioService"] as unknown as {
          getAccountMarketValues: jest.Mock;
        }
      ).getAccountMarketValues = jest
        .fn()
        .mockResolvedValue(new Map([["a3", 750]]));
      institutionsRepository.find = jest
        .fn()
        .mockResolvedValue([{ id: "inst-1", name: "Big Bank" }]);
    });

    it("status defaults to open and filters closed accounts", async () => {
      const r = await service.getLlmAccounts("user-1");
      expect(r.accounts.find((a) => a.name === "Savings")).toBeUndefined();
      expect(r.totalAccounts).toBe(2);
    });

    it("status=closed only returns closed", async () => {
      const r = await service.getLlmAccounts("user-1", { status: "closed" });
      expect(r.accounts.length).toBe(1);
      expect(r.accounts[0].name).toBe("Savings");
      expect(r.totalAccounts).toBe(1);
    });

    it("status=all returns everything", async () => {
      const r = await service.getLlmAccounts("user-1", { status: "all" });
      expect(r.accounts.length).toBe(3);
      expect(r.totalAccounts).toBe(3);
    });

    it("filters by accountTypes", async () => {
      const r = await service.getLlmAccounts("user-1", {
        status: "all",
        accountTypes: [AccountType.CHEQUING],
      });
      expect(r.accounts.length).toBe(1);
      expect(r.accounts[0].name).toBe("Checking");
    });

    it("filters by accountNames (case-insensitive)", async () => {
      const r = await service.getLlmAccounts("user-1", {
        status: "all",
        accountNames: ["checking"],
      });
      expect(r.accounts.length).toBe(1);
      expect(r.accounts[0].name).toBe("Checking");
    });

    it("filters by accountIds", async () => {
      const r = await service.getLlmAccounts("user-1", {
        status: "all",
        accountIds: ["a2"],
      });
      expect(r.accounts.length).toBe(1);
      expect(r.accounts[0].id).toBe("a2");
    });

    it("filters by nameQuery substring (case-insensitive)", async () => {
      const r = await service.getLlmAccounts("user-1", {
        status: "all",
        nameQuery: "ING",
      });
      const names = r.accounts.map((a) => a.name).sort();
      expect(names).toEqual(["Checking", "Savings"]);
    });

    it("carries a mortgage's type, and none on any other account", async () => {
      // The LLM shape is a consumer of the type (AGENTS.md): the assistant and
      // the MCP accounts tool read it from this row.
      const mortgage = {
        ...allAccounts[0],
        accountType: AccountType.MORTGAGE,
        currentBalance: -300000,
      };
      jest.spyOn(service, "findAll").mockResolvedValue([
        {
          ...mortgage,
          id: "m1",
          name: "Canadian fixed",
          mortgageType: "CANADIAN_FIXED",
        },
        {
          ...mortgage,
          id: "m2",
          name: "Annuity",
          mortgageType: "ANNUITY",
        },
        {
          ...allAccounts[0],
          id: "l1",
          name: "Car loan",
          accountType: AccountType.LOAN,
          // The column default every non-mortgage row carries.
          mortgageType: "ANNUITY",
        },
      ] as never);

      const r = await service.getLlmAccounts("user-1");

      expect(
        Object.fromEntries(r.accounts.map((a) => [a.id, a.mortgageType])),
      ).toEqual({
        m1: "CANADIAN_FIXED",
        m2: "ANNUITY",
        l1: null,
      });
    });

    it("carries a dated installment for LINEAR and INTEREST_ONLY, and the bullet", async () => {
      // docs/specs/mortgage-types.md section 5.6: these methods store no
      // payment, so the row names the next installment and its date, and an
      // interest-only row the final payment it would otherwise hide.
      const mortgage = {
        ...allAccounts[0],
        accountType: AccountType.MORTGAGE,
        currentBalance: -265000,
        interestRate: 2,
        paymentAmount: null,
        paymentFrequency: "MONTHLY",
        paymentStartDate: "2024-01-01",
        amortizationMonths: 360,
      };
      jest.spyOn(service, "findAll").mockResolvedValue([
        {
          ...mortgage,
          id: "lin",
          mortgageType: "LINEAR",
          prepaymentMode: null,
          scheduledTransactionId: "sched-lin",
        },
        {
          ...mortgage,
          id: "io",
          mortgageType: "INTEREST_ONLY",
          prepaymentMode: null,
          scheduledTransactionId: "sched-io",
        },
        {
          ...mortgage,
          id: "ann",
          mortgageType: "ANNUITY",
          paymentAmount: 1108.8584,
          scheduledTransactionId: "sched-ann",
        },
      ] as never);
      scheduleRepository.find.mockResolvedValue([
        { id: "sched-lin", splits: [] },
        { id: "sched-io", splits: [] },
      ]);
      scheduledOccurrenceService.expand.mockResolvedValue([
        {
          scheduledTransactionId: "sched-lin",
          dueDate: "2025-07-01",
          amount: -1275,
        },
        {
          scheduledTransactionId: "sched-io",
          dueDate: "2025-07-01",
          amount: -441.6667,
        },
      ]);

      const r = await service.getLlmAccounts("user-1");
      const row = (id: string) => r.accounts.find((a) => a.id === id)!;

      expect(row("lin")).toMatchObject({
        paymentAmount: null,
        mortgageType: "LINEAR",
        prepaymentMode: "SHORTEN_TERM",
        nextInstallment: { dueDate: "2025-07-01", amount: 1275 },
        bullet: null,
      });
      expect(row("io")).toMatchObject({
        paymentAmount: null,
        prepaymentMode: null,
        nextInstallment: { dueDate: "2025-07-01", amount: 441.6667 },
        bullet: { dueDate: "2053-12-01", amount: 265441.6667 },
      });
      expect(row("ann")).toMatchObject({
        paymentAmount: 1108.8584,
        prepaymentMode: null,
        nextInstallment: null,
        bullet: null,
      });
    });

    describe("every balance beside its value in the user's default currency", () => {
      const foreignAccounts = [
        {
          ...allAccounts[0],
          id: "cad-1",
          name: "CAD Chequing",
          currencyCode: "CAD",
          currentBalance: 1000,
          futureTransactionsSum: 250,
        },
        {
          ...allAccounts[0],
          id: "cad-2",
          name: "CAD Savings",
          currencyCode: "CAD",
          currentBalance: 40,
          futureTransactionsSum: 0,
        },
        {
          ...allAccounts[2],
          id: "cad-brokerage",
          name: "CAD Brokerage",
          currencyCode: "CAD",
          currentBalance: 0,
        },
        allAccounts[0],
      ];

      beforeEach(() => {
        jest
          .spyOn(service, "findAll")
          .mockResolvedValue(foreignAccounts as never);
        (
          service["portfolioService"] as unknown as {
            getAccountMarketValues: jest.Mock;
          }
        ).getAccountMarketValues = jest
          .fn()
          .mockResolvedValue(new Map([["cad-brokerage", 2000]]));
      });

      it("prices a foreign account at today's rate, once per currency", async () => {
        exchangeRateService.getRateForDate.mockResolvedValue(0.73);

        const r = await service.getLlmAccounts("user-1");

        expect(r.defaultCurrency).toBe("USD");
        const chequing = r.accounts.find((a) => a.id === "cad-1")!;
        // balance = current + future, converted; currentBalance converted alone.
        expect(chequing.balance).toBe(1250);
        expect(chequing.balanceInDefaultCurrency).toBe(912.5);
        expect(chequing.currentBalanceInDefaultCurrency).toBe(730);
        expect(chequing.exchangeRate).toBe(0.73);
        // A brokerage's balance is its market value, converted the same way.
        const brokerage = r.accounts.find((a) => a.id === "cad-brokerage")!;
        expect(brokerage.balanceInDefaultCurrency).toBe(1460);
        expect(brokerage.currentBalanceInDefaultCurrency).toBe(0);
        expect(r.missingRatePairs).toEqual([]);
        // Three CAD accounts, one lookup: the resolver is memoized per pair.
        expect(exchangeRateService.getRateForDate).toHaveBeenCalledTimes(1);
        expect(exchangeRateService.getRateForDate).toHaveBeenCalledWith(
          "CAD",
          "USD",
          expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
        );
      });

      it("is 1:1 for an account already in the default currency, asking no rate", async () => {
        exchangeRateService.getRateForDate.mockResolvedValue(0.73);

        const r = await service.getLlmAccounts("user-1");

        const usd = r.accounts.find((a) => a.id === "a1")!;
        expect(usd.balanceInDefaultCurrency).toBe(usd.balance);
        expect(usd.currentBalanceInDefaultCurrency).toBe(usd.currentBalance);
        expect(usd.exchangeRate).toBe(1);
        expect(exchangeRateService.getRateForDate).not.toHaveBeenCalledWith(
          "USD",
          "USD",
          expect.anything(),
        );
      });

      it("withholds the converted figure and names the pair when no rate exists", async () => {
        exchangeRateService.getRateForDate.mockResolvedValue(null);

        const r = await service.getLlmAccounts("user-1");

        const chequing = r.accounts.find((a) => a.id === "cad-1")!;
        expect(chequing.balance).toBe(1250);
        expect(chequing.balanceInDefaultCurrency).toBeNull();
        expect(chequing.currentBalanceInDefaultCurrency).toBeNull();
        expect(chequing.exchangeRate).toBeNull();
        expect(r.missingRatePairs).toEqual(["CAD->USD"]);
      });

      it("reports a zero foreign balance as zero, which needs no rate", async () => {
        exchangeRateService.getRateForDate.mockResolvedValue(null);
        jest
          .spyOn(service, "findAll")
          .mockResolvedValue([
            { ...foreignAccounts[1], currentBalance: 0 },
          ] as never);

        const r = await service.getLlmAccounts("user-1");

        expect(r.accounts[0].balanceInDefaultCurrency).toBe(0);
        expect(r.accounts[0].currentBalanceInDefaultCurrency).toBe(0);
        expect(r.missingRatePairs).toEqual([]);
      });

      it("treats a stored rate of zero as absent, never as a rate", async () => {
        exchangeRateService.getRateForDate.mockResolvedValue(0);

        const r = await service.getLlmAccounts("user-1");

        expect(
          r.accounts.find((a) => a.id === "cad-1")!.balanceInDefaultCurrency,
        ).toBeNull();
        expect(r.missingRatePairs).toEqual(["CAD->USD"]);
      });

      it("falls back to the one shared default currency for a user with no preference row", async () => {
        userPreferenceRepository.findOne.mockResolvedValue(null);
        exchangeRateService.getRateForDate.mockResolvedValue(0.73);

        const r = await service.getLlmAccounts("user-1");

        expect(r.defaultCurrency).toBe("USD");
        expect(exchangeRateService.getRateForDate).toHaveBeenCalledWith(
          "CAD",
          "USD",
          expect.any(String),
        );
      });
    });

    it("uses market value for brokerage accounts and currentBalance for others", async () => {
      const r = await service.getLlmAccounts("user-1", { status: "all" });
      const brokerage = r.accounts.find((a) => a.name === "Brokerage")!;
      const checking = r.accounts.find((a) => a.name === "Checking")!;
      expect(brokerage.balance).toBe(750);
      expect(brokerage.currentBalance).toBe(500);
      expect(checking.balance).toBe(100);
    });

    it("exposes full per-account detail incl. null credit/interest/institution", async () => {
      const r = await service.getLlmAccounts("user-1", { status: "all" });
      const checking = r.accounts.find((a) => a.name === "Checking")!;
      const brokerage = r.accounts.find((a) => a.name === "Brokerage")!;
      const savings = r.accounts.find((a) => a.name === "Savings")!;

      expect(checking.creditLimit).toBeNull();
      expect(checking.interestRate).toBeNull();
      expect(checking.institutionName).toBe("Big Bank");
      expect(checking.accountNumber).toBe("1234");
      expect(checking.excludeFromNetWorth).toBe(false);
      // Loan fields are null on non-debt accounts
      expect(checking.paymentAmount).toBeNull();
      expect(checking.paymentFrequency).toBeNull();
      expect(checking.paymentStartDate).toBeNull();
      expect(checking.amortizationMonths).toBeNull();
      expect(checking.originalPrincipal).toBeNull();

      expect(savings.creditLimit).toBe(5000);
      expect(savings.interestRate).toBe(1.25);
      expect(savings.excludeFromNetWorth).toBe(true);
      expect(savings.institutionName).toBeNull();
      expect(savings.accountNumber).toBeNull();

      expect(brokerage.subType).toBe(AccountSubType.INVESTMENT_BROKERAGE);
      expect(brokerage.institutionName).toBeNull();
    });

    it("exposes loan/mortgage schedule fields for debt accounts", async () => {
      const loan = {
        id: "l1",
        userId: "user-1",
        name: "Car Loan",
        accountType: AccountType.LOAN,
        accountSubType: null,
        currencyCode: "USD",
        currentBalance: -8000,
        futureTransactionsSum: 0,
        creditLimit: null,
        interestRate: 6,
        excludeFromNetWorth: false,
        institutionId: null,
        accountNumber: null,
        isClosed: false,
        paymentAmount: 500,
        paymentFrequency: "MONTHLY",
        paymentStartDate: "2024-02-01",
        amortizationMonths: 60,
        originalPrincipal: 20000,
      };
      jest.spyOn(service, "findAll").mockResolvedValue([loan] as never);
      const r = await service.getLlmAccounts("user-1", { status: "all" });
      const car = r.accounts.find((a) => a.name === "Car Loan")!;
      expect(car.paymentAmount).toBe(500);
      expect(car.paymentFrequency).toBe("MONTHLY");
      expect(car.paymentStartDate).toBe("2024-02-01");
      expect(car.amortizationMonths).toBe(60);
      expect(car.originalPrincipal).toBe(20000);
    });

    it("skips the institution lookup when no account references one", async () => {
      const r = await service.getLlmAccounts("user-1", {
        status: "all",
        accountIds: ["a3"],
      });
      expect(institutionsRepository.find).not.toHaveBeenCalled();
      expect(r.accounts[0].institutionName).toBeNull();
    });

    it("returns null institutionName when the institution is not found", async () => {
      institutionsRepository.find = jest.fn().mockResolvedValue([]);
      const r = await service.getLlmAccounts("user-1", {
        status: "all",
        accountIds: ["a1"],
      });
      expect(r.accounts[0].institutionName).toBeNull();
    });

    it("returns totals from the latest net worth snapshot", async () => {
      const r = await service.getLlmAccounts("user-1", { status: "all" });
      expect(r.totalAssets).toBe(800);
      expect(r.totalLiabilities).toBe(0);
      expect(r.netWorth).toBe(800);
    });

    it("falls back to 0 totals when the net worth snapshot is null", async () => {
      (
        netWorthService as unknown as Record<string, jest.Mock>
      ).getLatestNetWorth = jest.fn().mockResolvedValue(null);
      const r = await service.getLlmAccounts("user-1");
      expect(r.totalAssets).toBe(0);
      expect(r.totalLiabilities).toBe(0);
      expect(r.netWorth).toBe(0);
    });
  });

  describe("resetBrokerageBalances", () => {
    it("returns 0 when affected is undefined", async () => {
      accountsRepository.update.mockResolvedValue({});
      const n = await service.resetBrokerageBalances("user-1");
      expect(n).toBe(0);
    });

    it("returns affected count", async () => {
      accountsRepository.update.mockResolvedValue({ affected: 3 });
      const n = await service.resetBrokerageBalances("user-1");
      expect(n).toBe(3);
    });
  });

  describe("getDailyBalances", () => {
    it("uses provided endDate without extending", async () => {
      const ds = mockQueryRunner.manager as unknown as { query: jest.Mock };
      ds.query = jest.fn().mockResolvedValue([]);
      await service.getDailyBalances("user-1", "2024-01-01", "2024-12-31", [
        "a1",
      ]);
      // Only the main rows query runs; no max-date probing
      expect(ds.query).toHaveBeenCalledTimes(1);
    });

    it("extends end to maxFutureDate when no endDate", async () => {
      const ds = mockQueryRunner.manager as unknown as { query: jest.Mock };
      ds.query = jest
        .fn()
        .mockResolvedValueOnce([{ max_date: "2099-01-01" }])
        .mockResolvedValueOnce([
          {
            date: "2024-01-01",
            balance: "100",
            account_id: "a1",
            currency_code: "USD",
          },
        ]);
      const r = await service.getDailyBalances("user-1");
      expect(r.length).toBe(1);
      expect(r[0].balance).toBe(100);
    });

    it("uses default startDate when none provided", async () => {
      const ds = mockQueryRunner.manager as unknown as { query: jest.Mock };
      ds.query = jest
        .fn()
        .mockResolvedValueOnce([{ max_date: null }])
        .mockResolvedValueOnce([]);
      const r = await service.getDailyBalances("user-1");
      expect(r).toEqual([]);
    });

    it("treats no/empty accountIds as null filter", async () => {
      const ds = mockQueryRunner.manager as unknown as { query: jest.Mock };
      ds.query = jest.fn().mockResolvedValue([]);
      await service.getDailyBalances("user-1", "2024-01-01", "2024-12-31", []);
      expect(ds.query).toHaveBeenCalled();
    });

    it("keeps every day (step 1) for ranges within the point budget", async () => {
      const ds = mockQueryRunner.manager as unknown as { query: jest.Mock };
      ds.query = jest.fn().mockResolvedValue([]);
      await service.getDailyBalances("user-1", "2024-01-01", "2024-12-31", [
        "a1",
      ]);
      const params = ds.query.mock.calls[0][1];
      expect(params[2]).toBe("2024-01-01");
      expect(params[3]).toBe("2024-12-31");
      expect(params[4]).toBe(1); // 366 days <= 400 -> no downsampling
    });

    it("downsamples wide ranges with a step greater than 1", async () => {
      const ds = mockQueryRunner.manager as unknown as { query: jest.Mock };
      ds.query = jest.fn().mockResolvedValue([]);
      await service.getDailyBalances("user-1", "2010-01-01", "2024-12-31", [
        "a1",
      ]);
      const params = ds.query.mock.calls[0][1];
      expect(params[4]).toBeGreaterThan(1); // ~5479 days / 400 -> step 14
    });

    it("spans earliest to latest transaction when allTime and no startDate", async () => {
      const ds = mockQueryRunner.manager as unknown as { query: jest.Mock };
      ds.query = jest
        .fn()
        // allTime -> combined MIN/MAX probe (no separate future-extension probe)
        .mockResolvedValueOnce([
          { min_date: "2015-06-01", max_date: "2021-03-15" },
        ])
        // main rows query
        .mockResolvedValueOnce([]);
      await service.getDailyBalances(
        "user-1",
        undefined,
        undefined,
        ["a1"],
        true,
      );
      // Only the MIN/MAX probe and the main query run in all-time mode.
      expect(ds.query).toHaveBeenCalledTimes(2);
      const params = ds.query.mock.calls[1][1];
      expect(params[2]).toBe("2015-06-01"); // start = earliest transaction
      expect(params[3]).toBe("2021-03-15"); // end clamped to latest transaction
    });

    it("falls back to the one-year default and today when allTime finds no transactions", async () => {
      const ds = mockQueryRunner.manager as unknown as { query: jest.Mock };
      ds.query = jest
        .fn()
        .mockResolvedValueOnce([{ min_date: null, max_date: null }])
        .mockResolvedValueOnce([]);
      await service.getDailyBalances(
        "user-1",
        undefined,
        undefined,
        ["a1"],
        true,
      );
      const params = ds.query.mock.calls[1][1];
      expect(params[2]).toMatch(/^\d{4}-\d{2}-\d{2}$/); // start = one year ago
      expect(params[3]).toMatch(/^\d{4}-\d{2}-\d{2}$/); // end = today (not clamped)
    });

    it("does not probe for earliest transaction when startDate is given", async () => {
      const ds = mockQueryRunner.manager as unknown as { query: jest.Mock };
      ds.query = jest.fn().mockResolvedValue([]);
      await service.getDailyBalances(
        "user-1",
        "2024-01-01",
        "2024-12-31",
        ["a1"],
        true,
      );
      // endDate + startDate both supplied -> only the main query runs
      expect(ds.query).toHaveBeenCalledTimes(1);
      expect(ds.query.mock.calls[0][1][2]).toBe("2024-01-01");
    });
  });

  describe("applyDueTransactionBalances cron", () => {
    it("returns early when no users", async () => {
      const ds = mockQueryRunner.manager as unknown as { query: jest.Mock };
      // One sequenced mock serves both the timezone fan-out (still on
      // dataSource.query -- shared util, converted with a later R task) and the
      // per-timezone work that now runs through the withScopedDb manager.
      ds.query = mockDataSource.query = jest.fn().mockResolvedValue([]);
      await service.applyDueTransactionBalances();
      expect(ds.query).toHaveBeenCalledTimes(1);
    });

    it("skips invalid timezone users and continues", async () => {
      const ds = mockQueryRunner.manager as unknown as { query: jest.Mock };
      // One sequenced mock serves both the timezone fan-out (still on
      // dataSource.query -- shared util, converted with a later R task) and the
      // per-timezone work that now runs through the withScopedDb manager.
      ds.query = mockDataSource.query = jest
        .fn()
        // userRows
        .mockResolvedValueOnce([
          { user_id: "u1", timezone: "Invalid/Zone" },
          { user_id: "u2", timezone: null },
          { user_id: "u3", timezone: "browser" },
        ])
        // accountRows for UTC tz (u2 + u3) - empty so continues
        .mockResolvedValueOnce([]);
      await service.applyDueTransactionBalances();
      // Should not throw
    });

    it("processes due balances for valid timezone", async () => {
      const ds = mockQueryRunner.manager as unknown as { query: jest.Mock };
      // One sequenced mock serves both the timezone fan-out (still on
      // dataSource.query -- shared util, converted with a later R task) and the
      // per-timezone work that now runs through the withScopedDb manager.
      ds.query = mockDataSource.query = jest
        .fn()
        // userRows
        .mockResolvedValueOnce([{ user_id: "u1", timezone: "America/Toronto" }])
        // accountRows
        .mockResolvedValueOnce([{ account_id: "a1" }])
        // ...locked FOR UPDATE before the ledger is read, so the absolute write
        // cannot overwrite a delta that commits in between (audit P4-005)
        .mockResolvedValueOnce([{ id: "a1" }])
        // balances
        .mockResolvedValueOnce([{ account_id: "a1", balance: "150" }])
        // bulk UPDATE ... FROM (VALUES ...)
        .mockResolvedValueOnce(undefined);
      await service.applyDueTransactionBalances();
      // Balances applied via a single bulk UPDATE, not one update per account
      const bulkUpdateCall = ds.query.mock.calls.find(
        (c) =>
          typeof c[0] === "string" &&
          c[0].includes("UPDATE accounts SET current_balance"),
      );
      expect(bulkUpdateCall).toBeDefined();
      expect(bulkUpdateCall?.[1]).toEqual(["a1", 150]);
      expect(accountsRepository.update).not.toHaveBeenCalled();
      // And the lock came first.
      const statements = ds.query.mock.calls.map((c) => String(c[0]));
      expect(
        statements.findIndex((sql) => sql.includes("FOR UPDATE")),
      ).toBeLessThan(
        statements.findIndex((sql) => sql.includes("COALESCE(SUM(t.amount)")),
      );
    });

    it("logs error when query throws", async () => {
      const ds = mockQueryRunner.manager as unknown as { query: jest.Mock };
      // One sequenced mock serves both the timezone fan-out (still on
      // dataSource.query -- shared util, converted with a later R task) and the
      // per-timezone work that now runs through the withScopedDb manager.
      ds.query = mockDataSource.query = jest
        .fn()
        .mockRejectedValue(new Error("db down"));
      await service.applyDueTransactionBalances();
      // Should not throw
    });
  });

  describe("resolveByName", () => {
    it("returns the open account matching the name case-insensitively", async () => {
      jest.spyOn(service, "findAll").mockResolvedValue([
        { id: "a1", name: "Checking", currencyCode: "USD" },
        { id: "a2", name: "Savings", currencyCode: "CAD" },
      ] as never);

      const result = await service.resolveByName("user-1", "checking");
      expect(service.findAll).toHaveBeenCalledWith("user-1", false);
      expect(result).toEqual({
        id: "a1",
        name: "Checking",
        currencyCode: "USD",
      });
    });

    it("returns undefined when no open account matches", async () => {
      jest
        .spyOn(service, "findAll")
        .mockResolvedValue([
          { id: "a1", name: "Checking", currencyCode: "USD" },
        ] as never);
      const result = await service.resolveByName("user-1", "Nope");
      expect(result).toBeUndefined();
    });
  });

  describe("resolveAccountFilter", () => {
    it("returns accountIds: undefined when no names are supplied", async () => {
      const findAllSpy = jest.spyOn(service, "findAll");
      expect(await service.resolveAccountFilter("user-1")).toEqual({
        accountIds: undefined,
      });
      expect(await service.resolveAccountFilter("user-1", [])).toEqual({
        accountIds: undefined,
      });
      expect(findAllSpy).not.toHaveBeenCalled();
    });

    it("maps names to ids case-insensitively over open accounts", async () => {
      jest.spyOn(service, "findAll").mockResolvedValue([
        { id: "a1", name: "Checking", currencyCode: "USD" },
        { id: "a2", name: "RRSP", currencyCode: "CAD" },
      ] as never);

      const result = await service.resolveAccountFilter("user-1", [
        "checking",
        "RRSP",
      ]);
      expect(service.findAll).toHaveBeenCalledWith("user-1", false);
      expect(result).toEqual({ accountIds: ["a1", "a2"] });
    });

    it("returns a did-you-mean error when a name does not match", async () => {
      jest.spyOn(service, "findAll").mockResolvedValue([
        { id: "a1", name: "Checking", currencyCode: "USD" },
        { id: "a2", name: "Savings", currencyCode: "USD" },
      ] as never);

      const result = await service.resolveAccountFilter("user-1", ["Savngs"]);
      expect(result.accountIds).toBeUndefined();
      expect(result.error).toContain("Unknown account: Savngs.");
      expect(result.error).toContain("Did you mean 'Savings'?");
      expect(result.error).toContain("Call list_accounts");
    });

    it("errors on any unresolved name rather than running with a partial set", async () => {
      jest
        .spyOn(service, "findAll")
        .mockResolvedValue([
          { id: "a1", name: "Checking", currencyCode: "USD" },
        ] as never);

      const result = await service.resolveAccountFilter("user-1", [
        "Checking",
        "Nope",
      ]);
      expect(result.accountIds).toBeUndefined();
      expect(result.error).toContain("Unknown account: Nope.");
    });
  });

  describe("resolveBrokerageByName", () => {
    const rrspBrokerage = {
      id: "b1",
      name: "RRSP - Brokerage",
      currencyCode: "CAD",
      accountType: AccountType.INVESTMENT,
      accountSubType: AccountSubType.INVESTMENT_BROKERAGE,
    };
    const rrspCash = {
      id: "c1",
      name: "RRSP - Cash",
      currencyCode: "CAD",
      accountType: AccountType.INVESTMENT,
      accountSubType: AccountSubType.INVESTMENT_CASH,
    };

    it("returns an exact case-insensitive match over all open accounts", async () => {
      jest
        .spyOn(service, "findAll")
        .mockResolvedValue([
          rrspBrokerage,
          rrspCash,
          { id: "a1", name: "Checking", currencyCode: "USD" },
        ] as never);

      const result = await service.resolveBrokerageByName(
        "user-1",
        "rrsp - brokerage",
      );
      expect(service.findAll).toHaveBeenCalledWith("user-1", false);
      expect(result.match).toEqual({
        id: "b1",
        name: "RRSP - Brokerage",
        currencyCode: "CAD",
      });
      expect(result.candidates).toEqual([]);
    });

    it("resolves the base pair name to its brokerage account", async () => {
      jest
        .spyOn(service, "findAll")
        .mockResolvedValue([rrspBrokerage, rrspCash] as never);

      const result = await service.resolveBrokerageByName("user-1", "RRSP");
      expect(result.match).toEqual({
        id: "b1",
        name: "RRSP - Brokerage",
        currencyCode: "CAD",
      });
      expect(result.candidates).toEqual([]);
    });

    it("returns candidates when the base name is ambiguous", async () => {
      jest.spyOn(service, "findAll").mockResolvedValue([
        rrspBrokerage,
        {
          id: "b2",
          name: "RRSP - Brokerage",
          currencyCode: "CAD",
          accountType: AccountType.INVESTMENT,
          accountSubType: AccountSubType.INVESTMENT_BROKERAGE,
        },
      ] as never);

      const result = await service.resolveBrokerageByName("user-1", "RRSP");
      expect(result.match).toBeUndefined();
      expect(result.candidates).toEqual([
        { id: "b1", name: "RRSP - Brokerage" },
        { id: "b2", name: "RRSP - Brokerage" },
      ]);
    });

    it("does not match the cash half of the pair by its base name", async () => {
      jest.spyOn(service, "findAll").mockResolvedValue([rrspCash] as never);

      const result = await service.resolveBrokerageByName("user-1", "RRSP");
      expect(result.match).toBeUndefined();
      expect(result.candidates).toEqual([]);
    });

    it("returns no match when nothing matches", async () => {
      jest
        .spyOn(service, "findAll")
        .mockResolvedValue([rrspBrokerage] as never);

      const result = await service.resolveBrokerageByName("user-1", "TFSA");
      expect(result.match).toBeUndefined();
      expect(result.candidates).toEqual([]);
    });
  });
});
