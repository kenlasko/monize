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
import { Institution } from "../institutions/entities/institution.entity";
import { CategoriesService } from "../categories/categories.service";
import { ScheduledTransactionsService } from "../scheduled-transactions/scheduled-transactions.service";
import { NetWorthService } from "../net-worth/net-worth.service";
import { PortfolioService } from "../securities/portfolio.service";
import { LoanMortgageAccountService } from "./loan-mortgage-account.service";
import { LoanRateChangesService } from "../loan-rate-changes/loan-rate-changes.service";
import { DataSource } from "typeorm";
import { ActionHistoryService } from "../action-history/action-history.service";

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
  let mockQrRepo: Record<string, jest.Mock>;
  let mockActionHistoryService: Record<string, jest.Mock>;
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

    mockQrRepo = {
      create: jest.fn().mockImplementation((data) => ({ ...data })),
      save: jest.fn().mockImplementation((data) => data),
    };

    mockActionHistoryService = {
      record: jest.fn().mockResolvedValue(null),
    };

    mockQueryRunner = {
      connect: jest.fn().mockResolvedValue(undefined),
      startTransaction: jest.fn().mockResolvedValue(undefined),
      commitTransaction: jest.fn().mockResolvedValue(undefined),
      rollbackTransaction: jest.fn().mockResolvedValue(undefined),
      release: jest.fn().mockResolvedValue(undefined),
      query: jest.fn().mockResolvedValue(undefined),
      manager: {
        getRepository: jest.fn().mockReturnValue(mockQrRepo),
        findOne: jest.fn(),
        findOneOrFail: jest.fn(),
        save: jest.fn().mockImplementation((data) => data),
        remove: jest.fn().mockImplementation((data) => data),
        count: jest.fn().mockResolvedValue(0),
      },
    };

    institutionsRepository = {
      findOne: jest.fn().mockResolvedValue({ id: "inst-1" }),
    };

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
        LoanMortgageAccountService,
        {
          provide: LoanRateChangesService,
          useValue: loanRateChangesService,
        },
        {
          provide: DataSource,
          useValue: {
            query: jest.fn().mockResolvedValue([]),
            createQueryRunner: jest.fn().mockReturnValue(mockQueryRunner),
          },
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
    it("adds positive amount to balance", async () => {
      accountsRepository.findOne.mockResolvedValue({
        ...mockAccount,
        currentBalance: 1000,
      });
      accountsRepository.query.mockResolvedValue(undefined);
      accountsRepository.findOneOrFail.mockResolvedValue({
        ...mockAccount,
        currentBalance: 1500,
      });

      const result = await service.updateBalance("account-1", 500);

      expect(accountsRepository.query).toHaveBeenCalledWith(
        `UPDATE accounts SET current_balance = ROUND(CAST(current_balance AS numeric) + $1, 4) WHERE id = $2`,
        [500, "account-1"],
      );
      expect(result.currentBalance).toBe(1500);
    });

    it("subtracts negative amount from balance", async () => {
      accountsRepository.findOne.mockResolvedValue({
        ...mockAccount,
        currentBalance: 1000,
      });
      accountsRepository.query.mockResolvedValue(undefined);
      accountsRepository.findOneOrFail.mockResolvedValue({
        ...mockAccount,
        currentBalance: 700,
      });

      const result = await service.updateBalance("account-1", -300);

      expect(accountsRepository.query).toHaveBeenCalledWith(
        `UPDATE accounts SET current_balance = ROUND(CAST(current_balance AS numeric) + $1, 4) WHERE id = $2`,
        [-300, "account-1"],
      );
      expect(result.currentBalance).toBe(700);
    });

    it("throws NotFoundException when account not found", async () => {
      accountsRepository.findOne.mockResolvedValue(null);

      await expect(service.updateBalance("nonexistent", 100)).rejects.toThrow(
        NotFoundException,
      );
    });

    it("throws BadRequestException for closed accounts", async () => {
      accountsRepository.findOne.mockResolvedValue({
        ...mockAccount,
        isClosed: true,
      });

      await expect(service.updateBalance("account-1", 100)).rejects.toThrow(
        "Cannot modify balance of a closed account",
      );
    });

    it("rounds to 4 decimal places to match DB schema precision", async () => {
      accountsRepository.findOne.mockResolvedValue({
        ...mockAccount,
        currentBalance: 10.1,
      });
      accountsRepository.query.mockResolvedValue(undefined);
      accountsRepository.findOneOrFail.mockResolvedValue({
        ...mockAccount,
        currentBalance: 20.3,
      });

      const result = await service.updateBalance("account-1", 10.2);

      expect(accountsRepository.query).toHaveBeenCalledWith(
        `UPDATE accounts SET current_balance = ROUND(CAST(current_balance AS numeric) + $1, 4) WHERE id = $2`,
        [10.2, "account-1"],
      );
      expect(result.currentBalance).toBe(20.3);
    });

    it("uses atomic SQL UPDATE to prevent race conditions", async () => {
      accountsRepository.findOne.mockResolvedValue({
        ...mockAccount,
        currentBalance: 1000,
      });
      accountsRepository.query.mockResolvedValue(undefined);
      accountsRepository.findOneOrFail.mockResolvedValue({
        ...mockAccount,
        currentBalance: 1100,
      });

      await service.updateBalance("account-1", 100);

      expect(accountsRepository.query).toHaveBeenCalledWith(
        expect.stringContaining("UPDATE accounts"),
        [100, "account-1"],
      );
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
      expect(mockQueryRunner.commitTransaction).toHaveBeenCalled();
      expect(mockQueryRunner.release).toHaveBeenCalled();
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
      expect(mockQueryRunner.rollbackTransaction).toHaveBeenCalled();
    });

    it("links and unlinks a loan account for the equity view", async () => {
      mockQueryRunner.manager.findOne.mockResolvedValue({ ...mockAccount });
      await service.update("user-1", "account-1", { linkedLoanAccountId: "loan-1" });
      expect(mockQueryRunner.manager.save.mock.calls[0][0].linkedLoanAccountId).toBe("loan-1");

      mockQueryRunner.manager.save.mockClear();
      mockQueryRunner.manager.findOne.mockResolvedValue({
        ...mockAccount,
        linkedLoanAccountId: "loan-1",
      });
      await service.update("user-1", "account-1", { linkedLoanAccountId: null });
      expect(mockQueryRunner.manager.save.mock.calls[0][0].linkedLoanAccountId).toBeNull();
    });

    it("throws BadRequestException for closed account", async () => {
      mockQueryRunner.manager.findOne.mockResolvedValue({
        ...mockAccount,
        isClosed: true,
      });

      await expect(
        service.update("user-1", "account-1", { name: "New" }),
      ).rejects.toThrow(BadRequestException);
      expect(mockQueryRunner.rollbackTransaction).toHaveBeenCalled();
      expect(mockQueryRunner.release).toHaveBeenCalled();
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
      expect(mockQueryRunner.commitTransaction).toHaveBeenCalled();
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
        expect(mockQueryRunner.commitTransaction).toHaveBeenCalled();
      });

      it("rejects currency change when account has regular transactions", async () => {
        mockQueryRunner.manager.findOne.mockResolvedValue({ ...mockAccount });
        mockQueryRunner.manager.count
          .mockResolvedValueOnce(3) // transactions
          .mockResolvedValueOnce(0); // investment transactions

        await expect(
          service.update("user-1", "account-1", { currencyCode: "CAD" }),
        ).rejects.toThrow(BadRequestException);
        expect(mockQueryRunner.rollbackTransaction).toHaveBeenCalled();
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
        expect(mockQueryRunner.rollbackTransaction).toHaveBeenCalled();
        expect(mockQueryRunner.manager.save).not.toHaveBeenCalled();
      });

      it("allows other field updates on accounts with transactions when currency is unchanged", async () => {
        mockQueryRunner.manager.findOne.mockResolvedValue({ ...mockAccount });
        mockQueryRunner.manager.count.mockResolvedValue(5);

        await service.update("user-1", "account-1", { name: "Renamed" });

        const saved = mockQueryRunner.manager.save.mock.calls[0][0];
        expect(saved.name).toBe("Renamed");
        expect(mockQueryRunner.commitTransaction).toHaveBeenCalled();
      });

      it("allows passing the same currency on an account with transactions (no-op)", async () => {
        mockQueryRunner.manager.findOne.mockResolvedValue({ ...mockAccount });
        mockQueryRunner.manager.count.mockResolvedValue(5);

        await service.update("user-1", "account-1", {
          currencyCode: mockAccount.currencyCode,
        });

        expect(mockQueryRunner.commitTransaction).toHaveBeenCalled();
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
      expect(mockQueryRunner.commitTransaction).toHaveBeenCalled();
      expect(mockQueryRunner.release).toHaveBeenCalled();
    });

    it("throws when account already closed", async () => {
      mockQueryRunner.manager.findOne.mockResolvedValue({
        ...mockAccount,
        isClosed: true,
      });

      await expect(service.close("user-1", "account-1")).rejects.toThrow(
        "Account is already closed",
      );
      expect(mockQueryRunner.rollbackTransaction).toHaveBeenCalled();
      expect(mockQueryRunner.release).toHaveBeenCalled();
    });

    it("throws when balance is non-zero", async () => {
      mockQueryRunner.manager.findOne.mockResolvedValue({
        ...mockAccount,
        currentBalance: 500,
      });

      await expect(service.close("user-1", "account-1")).rejects.toThrow(
        "Cannot close account with non-zero balance",
      );
      expect(mockQueryRunner.rollbackTransaction).toHaveBeenCalled();
      expect(mockQueryRunner.release).toHaveBeenCalled();
    });

    it("throws NotFoundException when account not found", async () => {
      mockQueryRunner.manager.findOne.mockResolvedValue(null);

      await expect(service.close("user-1", "nonexistent")).rejects.toThrow(
        NotFoundException,
      );
      expect(mockQueryRunner.rollbackTransaction).toHaveBeenCalled();
      expect(mockQueryRunner.release).toHaveBeenCalled();
    });

    it("also closes linked brokerage account for investment cash", async () => {
      mockQueryRunner.manager.findOne
        .mockResolvedValueOnce({
          ...mockAccount,
          currentBalance: 0,
          accountSubType: AccountSubType.INVESTMENT_CASH,
          linkedAccountId: "brokerage-1",
        })
        .mockResolvedValueOnce({
          id: "brokerage-1",
          isClosed: false,
          userId: "user-1",
        });

      await service.close("user-1", "account-1");

      expect(mockQueryRunner.manager.save).toHaveBeenCalledTimes(2);
      expect(mockQueryRunner.commitTransaction).toHaveBeenCalled();
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
      mockQrRepo.save.mockImplementation((data) => {
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
      const cashCreate = mockQrRepo.create.mock.calls[0][0];
      expect(cashCreate.name).toBe("My Investment - Cash");
      expect(cashCreate.accountSubType).toBe(AccountSubType.INVESTMENT_CASH);
      expect(cashCreate.openingBalance).toBe(5000);
      expect(cashCreate.currentBalance).toBe(5000);
      expect(cashCreate.userId).toBe("user-1");

      // Second create call should be brokerage account
      const brokerageCreate = mockQrRepo.create.mock.calls[1][0];
      expect(brokerageCreate.name).toBe("My Investment - Brokerage");
      expect(brokerageCreate.accountSubType).toBe(
        AccountSubType.INVESTMENT_BROKERAGE,
      );
      expect(brokerageCreate.openingBalance).toBe(0);
      expect(brokerageCreate.currentBalance).toBe(0);
      // Linked to cash account via id assigned during save
      expect(brokerageCreate.linkedAccountId).toBe("cash-account-1");

      // Three saves: cash, brokerage, cash again (to set linkedAccountId)
      expect(mockQrRepo.save).toHaveBeenCalledTimes(3);

      // Third save updates cash account with link back to brokerage
      expect(result.cashAccount.linkedAccountId).toBe("brokerage-account-1");

      // Verify transactional behavior
      expect(mockQueryRunner.connect).toHaveBeenCalled();
      expect(mockQueryRunner.startTransaction).toHaveBeenCalled();
      expect(mockQueryRunner.commitTransaction).toHaveBeenCalled();
      expect(mockQueryRunner.release).toHaveBeenCalled();
    });

    it("defaults opening balance to 0 when not provided", async () => {
      mockQrRepo.save.mockImplementation((data) => ({
        ...data,
        id: data.id || "gen-id",
      }));

      await service.createInvestmentAccountPair("user-1", {
        name: "Zero Balance Investment",
        accountType: AccountType.INVESTMENT,
        currencyCode: "CAD",
      } as any);

      const cashCreate = mockQrRepo.create.mock.calls[0][0];
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

      mockQrRepo.save.mockImplementation((data) => ({
        ...data,
        id: data.id || "gen-id",
      }));

      await service.createInvestmentAccountPair("user-1", {
        name: "Depotkonto",
        accountType: AccountType.INVESTMENT,
        currencyCode: "EUR",
      } as any);

      const cashCreate = mockQrRepo.create.mock.calls[0][0];
      const brokerageCreate = mockQrRepo.create.mock.calls[1][0];
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
        isCanadianMortgage: true,
        isVariableRate: false,
        termMonths: 60,
      } as any);

      const createCall = accountsRepository.create.mock.calls[0][0];
      expect(createCall.isCanadianMortgage).toBe(true);
      expect(createCall.isVariableRate).toBe(false);
      expect(createCall.termMonths).toBe(60);
      expect(createCall.amortizationMonths).toBe(300);
      expect(createCall.originalPrincipal).toBe(400000);
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
        isCanadianMortgage: true,
        isVariableRate: false,
      } as any);

      const createCall = accountsRepository.create.mock.calls[0][0];
      expect(createCall.isCanadianMortgage).toBe(true);
      expect(createCall.isVariableRate).toBe(false);
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
        false,
        false,
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
        false,
        false,
      );
      const resultNegative = service.previewMortgageAmortization(
        -200000,
        4.0,
        300,
        "MONTHLY" as any,
        new Date("2025-01-01"),
        false,
        false,
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
        true,
        false,
      );
      const resultUS = service.previewMortgageAmortization(
        300000,
        5.0,
        300,
        "MONTHLY" as any,
        new Date("2025-01-01"),
        false,
        false,
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
      isCanadianMortgage: false,
      isVariableRate: false,
      scheduledTransactionId: "sched-tx-1",
      interestCategoryId: "interest-cat-1",
      isClosed: false,
    };

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
      expect(mockQueryRunner.commitTransaction).toHaveBeenCalled();
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
          accountSubType: AccountSubType.INVESTMENT_CASH,
          linkedAccountId: "brokerage-1",
        })
        .mockResolvedValueOnce({
          id: "brokerage-1",
          userId: "user-1",
          isClosed: false,
        });
      mockQueryRunner.manager.save.mockImplementation((data) => data);

      await service.close("user-1", "account-1");

      // Two saves: one for the cash account, one for the brokerage
      expect(mockQueryRunner.manager.save).toHaveBeenCalledTimes(2);
      const brokerageSave = mockQueryRunner.manager.save.mock.calls[1][0];
      expect(brokerageSave.isClosed).toBe(true);
      expect(brokerageSave.closedDate).toBeDefined();
      expect(mockQueryRunner.commitTransaction).toHaveBeenCalled();
    });

    it("does not close brokerage if already closed", async () => {
      mockQueryRunner.manager.findOne
        .mockResolvedValueOnce({
          ...mockAccount,
          currentBalance: 0,
          accountSubType: AccountSubType.INVESTMENT_CASH,
          linkedAccountId: "brokerage-1",
        })
        .mockResolvedValueOnce({
          id: "brokerage-1",
          userId: "user-1",
          isClosed: true,
        });
      mockQueryRunner.manager.save.mockImplementation((data) => data);

      await service.close("user-1", "account-1");

      // Only one save for the cash account
      expect(mockQueryRunner.manager.save).toHaveBeenCalledTimes(1);
      expect(mockQueryRunner.commitTransaction).toHaveBeenCalled();
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
      expect(mockQueryRunner.commitTransaction).toHaveBeenCalled();
    });
  });

  describe("reopen - investment cash account linked behavior", () => {
    it("also reopens linked brokerage account for investment cash", async () => {
      mockQueryRunner.manager.findOne
        .mockResolvedValueOnce({
          ...mockAccount,
          isClosed: true,
          closedDate: new Date(),
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

      expect(accountsRepository.query).toHaveBeenCalledTimes(1);
      const [sql, params] = accountsRepository.query.mock.calls[0];
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
      expect(mockQueryRunner.rollbackTransaction).toHaveBeenCalled();
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
        isCanadianMortgage: true,
        isVariableRate: false,
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

  describe("updateBalance with queryRunner", () => {
    it("uses provided queryRunner instead of dataSource", async () => {
      accountsRepository.findOne.mockResolvedValue({
        ...mockAccount,
        currentBalance: 100,
      });
      mockQueryRunner.manager.findOneOrFail.mockResolvedValue({
        ...mockAccount,
        currentBalance: 200,
      });
      const result = await service.updateBalance(
        "account-1",
        100,
        mockQueryRunner as never,
      );
      expect(mockQueryRunner.query).toHaveBeenCalled();
      expect(result.currentBalance).toBe(200);
    });
  });

  describe("recalculateCurrentBalance", () => {
    it("throws NotFoundException when account not found", async () => {
      accountsRepository.findOne.mockResolvedValue(null);
      await expect(service.recalculateCurrentBalance("nope")).rejects.toThrow(
        NotFoundException,
      );
    });

    it("computes new balance with provided queryRunner", async () => {
      accountsRepository.findOne.mockResolvedValue({
        id: "account-1",
        openingBalance: 100,
      });
      const qr = {
        ...mockQueryRunner,
        query: jest
          .fn()
          .mockResolvedValueOnce([{ balance: "150.5" }])
          .mockResolvedValueOnce(undefined),
      };
      const result = await service.recalculateCurrentBalance(
        "account-1",
        qr as never,
      );
      expect(result.currentBalance).toBe(150.5);
    });

    it("falls back to openingBalance when query returns empty", async () => {
      accountsRepository.findOne.mockResolvedValue({
        id: "account-1",
        openingBalance: 100,
        currentBalance: 50,
      });
      const ds = service["dataSource"] as unknown as { query: jest.Mock };
      ds.query = jest.fn().mockResolvedValue([]);
      const r = await service.recalculateCurrentBalance("account-1");
      expect(r.currentBalance).toBe(100);
    });

    it("computes balance via dataSource when no queryRunner", async () => {
      accountsRepository.findOne.mockResolvedValue({
        id: "account-1",
        openingBalance: 100,
      });
      accountsRepository.save.mockImplementation((d) => Promise.resolve(d));
      const ds = service["dataSource"] as unknown as { query: jest.Mock };
      ds.query = jest.fn().mockResolvedValue([{ balance: "275.5" }]);
      const r = await service.recalculateCurrentBalance("account-1");
      expect(r.currentBalance).toBe(275.5);
    });
  });

  describe("getProjectedBalance", () => {
    it("returns 0 when no rows", async () => {
      const ds = service["dataSource"] as unknown as { query: jest.Mock };
      ds.query = jest.fn().mockResolvedValue([]);
      const v = await service.getProjectedBalance("user-1", "account-1");
      expect(v).toBe(0);
    });

    it("returns rounded balance from query result", async () => {
      const ds = service["dataSource"] as unknown as { query: jest.Mock };
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

      expect(savings.creditLimit).toBe(5000);
      expect(savings.interestRate).toBe(1.25);
      expect(savings.excludeFromNetWorth).toBe(true);
      expect(savings.institutionName).toBeNull();
      expect(savings.accountNumber).toBeNull();

      expect(brokerage.subType).toBe(AccountSubType.INVESTMENT_BROKERAGE);
      expect(brokerage.institutionName).toBeNull();
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
      const ds = service["dataSource"] as unknown as { query: jest.Mock };
      ds.query = jest.fn().mockResolvedValue([]);
      await service.getDailyBalances("user-1", "2024-01-01", "2024-12-31", [
        "a1",
      ]);
      // Only the main rows query runs; no max-date probing
      expect(ds.query).toHaveBeenCalledTimes(1);
    });

    it("extends end to maxFutureDate when no endDate", async () => {
      const ds = service["dataSource"] as unknown as { query: jest.Mock };
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
      const ds = service["dataSource"] as unknown as { query: jest.Mock };
      ds.query = jest
        .fn()
        .mockResolvedValueOnce([{ max_date: null }])
        .mockResolvedValueOnce([]);
      const r = await service.getDailyBalances("user-1");
      expect(r).toEqual([]);
    });

    it("treats no/empty accountIds as null filter", async () => {
      const ds = service["dataSource"] as unknown as { query: jest.Mock };
      ds.query = jest.fn().mockResolvedValue([]);
      await service.getDailyBalances("user-1", "2024-01-01", "2024-12-31", []);
      expect(ds.query).toHaveBeenCalled();
    });
  });

  describe("applyDueTransactionBalances cron", () => {
    it("returns early when no users", async () => {
      const ds = service["dataSource"] as unknown as { query: jest.Mock };
      ds.query = jest.fn().mockResolvedValue([]);
      await service.applyDueTransactionBalances();
      expect(ds.query).toHaveBeenCalledTimes(1);
    });

    it("skips invalid timezone users and continues", async () => {
      const ds = service["dataSource"] as unknown as { query: jest.Mock };
      ds.query = jest
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
      const ds = service["dataSource"] as unknown as { query: jest.Mock };
      ds.query = jest
        .fn()
        // userRows
        .mockResolvedValueOnce([{ user_id: "u1", timezone: "America/Toronto" }])
        // accountRows
        .mockResolvedValueOnce([{ account_id: "a1" }])
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
    });

    it("logs error when query throws", async () => {
      const ds = service["dataSource"] as unknown as { query: jest.Mock };
      ds.query = jest.fn().mockRejectedValue(new Error("db down"));
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
