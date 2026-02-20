import { Test, TestingModule } from "@nestjs/testing";
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
import { CategoriesService } from "../categories/categories.service";
import { ScheduledTransactionsService } from "../scheduled-transactions/scheduled-transactions.service";
import { NetWorthService } from "../net-worth/net-worth.service";
import { LoanMortgageAccountService } from "./loan-mortgage-account.service";
import { DataSource } from "typeorm";

describe("AccountsService", () => {
  let service: AccountsService;
  let accountsRepository: Record<string, jest.Mock>;
  let transactionRepository: Record<string, jest.Mock>;
  let investmentTxRepository: Record<string, jest.Mock>;
  let scheduledTransactionsService: Record<string, jest.Mock>;
  let categoriesService: Record<string, jest.Mock>;
  let netWorthService: Record<string, jest.Mock>;
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
  };

  beforeEach(async () => {
    accountsRepository = {
      create: jest
        .fn()
        .mockImplementation((data) => ({ ...data, id: "new-account" })),
      save: jest.fn().mockImplementation((data) => data),
      findOne: jest.fn(),
      find: jest.fn(),
      remove: jest.fn(),
      count: jest.fn(),
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

    categoriesService = {
      findLoanCategories: jest.fn().mockResolvedValue({
        interestCategory: { id: "interest-cat-1" },
      }),
    };

    netWorthService = {
      recalculateAccount: jest.fn().mockResolvedValue(undefined),
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
        { provide: CategoriesService, useValue: categoriesService },
        {
          provide: ScheduledTransactionsService,
          useValue: scheduledTransactionsService,
        },
        { provide: NetWorthService, useValue: netWorthService },
        LoanMortgageAccountService,
        { provide: DataSource, useValue: { query: jest.fn() } },
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
  });

  describe("updateBalance", () => {
    it("adds positive amount to balance", async () => {
      accountsRepository.findOne.mockResolvedValue({
        ...mockAccount,
        currentBalance: 1000,
      });

      await service.updateBalance("account-1", 500);

      const savedAccount = accountsRepository.save.mock.calls[0][0];
      expect(savedAccount.currentBalance).toBe(1500);
    });

    it("subtracts negative amount from balance", async () => {
      accountsRepository.findOne.mockResolvedValue({
        ...mockAccount,
        currentBalance: 1000,
      });

      await service.updateBalance("account-1", -300);

      const savedAccount = accountsRepository.save.mock.calls[0][0];
      expect(savedAccount.currentBalance).toBe(700);
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

    it("rounds to 2 decimal places to avoid floating point errors", async () => {
      accountsRepository.findOne.mockResolvedValue({
        ...mockAccount,
        currentBalance: 10.1,
      });

      await service.updateBalance("account-1", 10.2);

      const savedAccount = accountsRepository.save.mock.calls[0][0];
      expect(savedAccount.currentBalance).toBe(20.3);
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
      accountsRepository.findOne.mockResolvedValue({ ...mockAccount });

      const result = await service.update("user-1", "account-1", {
        name: "Updated Name",
      });

      expect(result.name).toBe("Updated Name");
    });

    it("throws BadRequestException for closed account", async () => {
      accountsRepository.findOne.mockResolvedValue({
        ...mockAccount,
        isClosed: true,
      });

      await expect(
        service.update("user-1", "account-1", { name: "New" }),
      ).rejects.toThrow(BadRequestException);
    });

    it("adjusts currentBalance when openingBalance changes", async () => {
      accountsRepository.findOne.mockResolvedValue({
        ...mockAccount,
        openingBalance: 1000,
        currentBalance: 1500,
      });

      await service.update("user-1", "account-1", { openingBalance: 1200 });

      const saved = accountsRepository.save.mock.calls[0][0];
      expect(saved.currentBalance).toBe(1700);
    });

    it("recalculates termEndDate when termMonths changes to a positive value", async () => {
      const startDate = new Date("2025-01-15T12:00:00Z");
      accountsRepository.findOne.mockResolvedValue({
        ...mockAccount,
        accountType: "MORTGAGE",
        paymentStartDate: startDate,
        termMonths: 60,
        termEndDate: new Date("2030-01-15"),
      });

      await service.update("user-1", "account-1", { termMonths: 36 });

      const saved = accountsRepository.save.mock.calls[0][0];
      expect(saved.termMonths).toBe(36);
      expect(saved.termEndDate).toBeInstanceOf(Date);
      expect(saved.termEndDate.getTime()).toBeGreaterThan(startDate.getTime());
    });

    it("sets termEndDate to null when termMonths is set to 0", async () => {
      accountsRepository.findOne.mockResolvedValue({
        ...mockAccount,
        accountType: "MORTGAGE",
        paymentStartDate: new Date("2025-01-01"),
        termMonths: 60,
        termEndDate: new Date("2030-01-01"),
      });

      await service.update("user-1", "account-1", { termMonths: 0 });

      const saved = accountsRepository.save.mock.calls[0][0];
      expect(saved.termMonths).toBeNull();
      expect(saved.termEndDate).toBeNull();
    });

    it("updates amortizationMonths when provided", async () => {
      accountsRepository.findOne.mockResolvedValue({
        ...mockAccount,
        accountType: "MORTGAGE",
        amortizationMonths: 300,
      });

      await service.update("user-1", "account-1", { amortizationMonths: 360 });

      const saved = accountsRepository.save.mock.calls[0][0];
      expect(saved.amortizationMonths).toBe(360);
    });
  });

  describe("close", () => {
    it("closes account with zero balance", async () => {
      accountsRepository.findOne.mockResolvedValue({
        ...mockAccount,
        currentBalance: 0,
      });

      const result = await service.close("user-1", "account-1");

      expect(result.isClosed).toBe(true);
      expect(result.closedDate).toBeDefined();
    });

    it("throws when account already closed", async () => {
      accountsRepository.findOne.mockResolvedValue({
        ...mockAccount,
        isClosed: true,
      });

      await expect(service.close("user-1", "account-1")).rejects.toThrow(
        "Account is already closed",
      );
    });

    it("throws when balance is non-zero", async () => {
      accountsRepository.findOne.mockResolvedValue({
        ...mockAccount,
        currentBalance: 500,
      });

      await expect(service.close("user-1", "account-1")).rejects.toThrow(
        "Cannot close account with non-zero balance",
      );
    });

    it("also closes linked brokerage account for investment cash", async () => {
      accountsRepository.findOne
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

      expect(accountsRepository.save).toHaveBeenCalledTimes(2);
    });
  });

  describe("reopen", () => {
    it("reopens a closed account", async () => {
      accountsRepository.findOne.mockResolvedValue({
        ...mockAccount,
        isClosed: true,
        closedDate: new Date(),
      });

      const result = await service.reopen("user-1", "account-1");

      expect(result.isClosed).toBe(false);
      expect(result.closedDate).toBeNull();
    });

    it("throws when account is not closed", async () => {
      accountsRepository.findOne.mockResolvedValue(mockAccount);

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

      expect(accountsRepository.remove).toHaveBeenCalled();
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
      accountsRepository.findOne
        .mockResolvedValueOnce({
          ...mockAccount,
          linkedAccountId: "brokerage-1",
        })
        .mockResolvedValueOnce({
          id: "brokerage-1",
          linkedAccountId: "account-1",
        });
      transactionRepository.count.mockResolvedValue(0);
      investmentTxRepository.count.mockResolvedValue(0);

      await service.delete("user-1", "account-1");

      const savedLinked = accountsRepository.save.mock.calls[0][0];
      expect(savedLinked.linkedAccountId).toBeNull();
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

  describe("resetBrokerageBalances", () => {
    it("resets all brokerage account balances to 0", async () => {
      accountsRepository.find.mockResolvedValue([
        { id: "brk-1", currentBalance: 5000 },
        { id: "brk-2", currentBalance: 3000 },
      ]);

      const result = await service.resetBrokerageBalances("user-1");

      expect(result).toBe(2);
      expect(accountsRepository.save).toHaveBeenCalledTimes(2);
    });

    it("returns 0 when no brokerage accounts", async () => {
      accountsRepository.find.mockResolvedValue([]);

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
      accountsRepository.create.mockImplementation((data) => ({ ...data }));

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
    });

    it("defaults opening balance to 0 when not provided", async () => {
      accountsRepository.save.mockImplementation((data) => ({
        ...data,
        id: data.id || "gen-id",
      }));
      accountsRepository.create.mockImplementation((data) => ({ ...data }));

      await service.createInvestmentAccountPair("user-1", {
        name: "Zero Balance Investment",
        accountType: AccountType.INVESTMENT,
        currencyCode: "CAD",
      } as any);

      const cashCreate = accountsRepository.create.mock.calls[0][0];
      expect(cashCreate.openingBalance).toBe(0);
      expect(cashCreate.currentBalance).toBe(0);
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

    it("updates account interestRate and paymentAmount", async () => {
      accountsRepository.findOne.mockResolvedValue({
        ...mockMortgageAccount,
      });

      await service.updateMortgageRate(
        "user-1",
        "mortgage-1",
        4.0,
        new Date("2025-06-01"),
      );

      const savedAccount = accountsRepository.save.mock.calls[0][0];
      expect(savedAccount.interestRate).toBe(4.0);
      expect(savedAccount.paymentAmount).toBeGreaterThan(0);
    });

    it("updates scheduled transaction when scheduledTransactionId exists", async () => {
      accountsRepository.findOne.mockResolvedValue({
        ...mockMortgageAccount,
      });

      await service.updateMortgageRate(
        "user-1",
        "mortgage-1",
        4.0,
        new Date("2025-06-01"),
      );

      expect(scheduledTransactionsService.update).toHaveBeenCalledWith(
        "user-1",
        "sched-tx-1",
        expect.objectContaining({
          amount: expect.any(Number),
          splits: expect.arrayContaining([
            expect.objectContaining({ memo: "Principal" }),
            expect.objectContaining({ memo: "Interest" }),
          ]),
        }),
      );
    });

    it("does not update scheduled transaction when scheduledTransactionId is null", async () => {
      accountsRepository.findOne.mockResolvedValue({
        ...mockMortgageAccount,
        scheduledTransactionId: null,
      });

      await service.updateMortgageRate(
        "user-1",
        "mortgage-1",
        4.0,
        new Date("2025-06-01"),
      );

      expect(scheduledTransactionsService.update).not.toHaveBeenCalled();
    });

    it("handles scheduled transaction update failure gracefully", async () => {
      accountsRepository.findOne.mockResolvedValue({
        ...mockMortgageAccount,
      });
      scheduledTransactionsService.update.mockRejectedValue(
        new Error("update failed"),
      );

      // Should not throw - the error is caught and logged
      const result = await service.updateMortgageRate(
        "user-1",
        "mortgage-1",
        4.0,
        new Date("2025-06-01"),
      );

      expect(result.newRate).toBe(4.0);
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
      accountsRepository.findOne
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
      accountsRepository.save.mockImplementation((data) => data);

      await service.update("user-1", "account-1", { currencyCode: "CAD" });

      // Second save should be the linked account currency update
      const linkedSave = accountsRepository.save.mock.calls[1][0];
      expect(linkedSave.currencyCode).toBe("CAD");
    });

    it("does not sync currency when account is not investment type", async () => {
      accountsRepository.findOne.mockResolvedValue({
        ...mockAccount,
        accountType: AccountType.CHEQUING,
        linkedAccountId: null,
      });
      accountsRepository.save.mockImplementation((data) => data);

      await service.update("user-1", "account-1", { currencyCode: "CAD" });

      // Only one save call for the main account
      expect(accountsRepository.save).toHaveBeenCalledTimes(1);
    });
  });

  describe("update - net worth recalculation", () => {
    it("triggers net worth recalc when openingBalance changes", async () => {
      accountsRepository.findOne.mockResolvedValue({
        ...mockAccount,
        openingBalance: 1000,
        currentBalance: 1500,
      });
      accountsRepository.save.mockImplementation((data) => data);

      await service.update("user-1", "account-1", { openingBalance: 2000 });

      expect(netWorthService.recalculateAccount).toHaveBeenCalledWith(
        "user-1",
        "account-1",
      );
    });

    it("triggers net worth recalc when dateAcquired changes", async () => {
      accountsRepository.findOne.mockResolvedValue({ ...mockAccount });
      accountsRepository.save.mockImplementation((data) => data);

      await service.update("user-1", "account-1", {
        dateAcquired: "2024-06-01",
      });

      expect(netWorthService.recalculateAccount).toHaveBeenCalledWith(
        "user-1",
        "account-1",
      );
    });

    it("does not trigger net worth recalc for name-only change", async () => {
      accountsRepository.findOne.mockResolvedValue({ ...mockAccount });
      accountsRepository.save.mockImplementation((data) => data);

      await service.update("user-1", "account-1", { name: "New Name" });

      expect(netWorthService.recalculateAccount).not.toHaveBeenCalled();
    });
  });

  describe("close - investment cash account linked behavior", () => {
    it("also closes linked brokerage account for investment cash", async () => {
      accountsRepository.findOne
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
      accountsRepository.save.mockImplementation((data) => data);

      await service.close("user-1", "account-1");

      // Two saves: one for the cash account, one for the brokerage
      expect(accountsRepository.save).toHaveBeenCalledTimes(2);
      const brokerageSave = accountsRepository.save.mock.calls[1][0];
      expect(brokerageSave.isClosed).toBe(true);
      expect(brokerageSave.closedDate).toBeDefined();
    });

    it("does not close brokerage if already closed", async () => {
      accountsRepository.findOne
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
      accountsRepository.save.mockImplementation((data) => data);

      await service.close("user-1", "account-1");

      // Only one save for the cash account
      expect(accountsRepository.save).toHaveBeenCalledTimes(1);
    });

    it("does not attempt to close linked account for non-investment account", async () => {
      accountsRepository.findOne.mockResolvedValue({
        ...mockAccount,
        currentBalance: 0,
        accountSubType: null,
        linkedAccountId: null,
      });
      accountsRepository.save.mockImplementation((data) => data);

      await service.close("user-1", "account-1");

      expect(accountsRepository.save).toHaveBeenCalledTimes(1);
    });
  });

  describe("reopen - investment cash account linked behavior", () => {
    it("also reopens linked brokerage account for investment cash", async () => {
      accountsRepository.findOne
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
      accountsRepository.save.mockImplementation((data) => data);

      await service.reopen("user-1", "account-1");

      expect(accountsRepository.save).toHaveBeenCalledTimes(2);
      const brokerageSave = accountsRepository.save.mock.calls[1][0];
      expect(brokerageSave.isClosed).toBe(false);
      expect(brokerageSave.closedDate).toBeNull();
    });

    it("does not reopen brokerage if already open", async () => {
      accountsRepository.findOne
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
      accountsRepository.save.mockImplementation((data) => data);

      await service.reopen("user-1", "account-1");

      // Only one save for the cash account
      expect(accountsRepository.save).toHaveBeenCalledTimes(1);
    });

    it("does not attempt to reopen linked account for non-investment account", async () => {
      accountsRepository.findOne.mockResolvedValue({
        ...mockAccount,
        isClosed: true,
        closedDate: new Date(),
        accountSubType: null,
        linkedAccountId: null,
      });
      accountsRepository.save.mockImplementation((data) => data);

      await service.reopen("user-1", "account-1");

      expect(accountsRepository.save).toHaveBeenCalledTimes(1);
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
      expect(accountsRepository.remove).toHaveBeenCalled();
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

      expect(accountsRepository.remove).toHaveBeenCalled();
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
      accountsRepository.findOne
        .mockResolvedValueOnce({
          ...mockAccount,
          linkedAccountId: "brokerage-1",
        })
        .mockResolvedValueOnce({
          id: "brokerage-1",
          linkedAccountId: "account-1",
        });
      transactionRepository.count.mockResolvedValue(0);
      investmentTxRepository.count.mockResolvedValue(0);

      await service.delete("user-1", "account-1");

      const savedLinked = accountsRepository.save.mock.calls[0][0];
      expect(savedLinked.linkedAccountId).toBeNull();
      expect(accountsRepository.remove).toHaveBeenCalled();
    });

    it("handles case where linked account no longer exists", async () => {
      accountsRepository.findOne
        .mockResolvedValueOnce({
          ...mockAccount,
          linkedAccountId: "gone-account",
        })
        .mockResolvedValueOnce(null);
      transactionRepository.count.mockResolvedValue(0);
      investmentTxRepository.count.mockResolvedValue(0);

      await service.delete("user-1", "account-1");

      // Should still delete successfully without error
      expect(accountsRepository.remove).toHaveBeenCalled();
      // save should not have been called for the linked account
      expect(accountsRepository.save).not.toHaveBeenCalled();
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

  describe("getSummary - asset vs liability categorization", () => {
    it("categorizes chequing, savings, investment, cash, asset as assets", async () => {
      const assetAccounts = [
        {
          ...mockAccount,
          id: "a1",
          accountType: AccountType.CHEQUING,
          currentBalance: 1000,
        },
        {
          ...mockAccount,
          id: "a2",
          accountType: AccountType.SAVINGS,
          currentBalance: 2000,
        },
        {
          ...mockAccount,
          id: "a3",
          accountType: AccountType.INVESTMENT,
          currentBalance: 5000,
        },
        {
          ...mockAccount,
          id: "a4",
          accountType: AccountType.CASH,
          currentBalance: 500,
        },
        {
          ...mockAccount,
          id: "a5",
          accountType: AccountType.ASSET,
          currentBalance: 10000,
        },
      ];

      const getMany = jest.fn().mockResolvedValue(assetAccounts);
      accountsRepository.createQueryBuilder.mockReturnValue({
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        getMany,
      });

      const result = await service.getSummary("user-1");

      expect(result.totalAssets).toBe(18500);
      expect(result.totalLiabilities).toBe(0);
      expect(result.netWorth).toBe(18500);
      expect(result.totalAccounts).toBe(5);
    });

    it("categorizes credit card, loan, mortgage, line of credit as liabilities", async () => {
      const liabilityAccounts = [
        {
          ...mockAccount,
          id: "l1",
          accountType: AccountType.CREDIT_CARD,
          currentBalance: -500,
        },
        {
          ...mockAccount,
          id: "l2",
          accountType: AccountType.LOAN,
          currentBalance: -10000,
        },
        {
          ...mockAccount,
          id: "l3",
          accountType: AccountType.MORTGAGE,
          currentBalance: -200000,
        },
        {
          ...mockAccount,
          id: "l4",
          accountType: AccountType.LINE_OF_CREDIT,
          currentBalance: -3000,
        },
      ];

      const getMany = jest.fn().mockResolvedValue(liabilityAccounts);
      accountsRepository.createQueryBuilder.mockReturnValue({
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        getMany,
      });

      const result = await service.getSummary("user-1");

      expect(result.totalAssets).toBe(0);
      expect(result.totalLiabilities).toBe(213500);
      expect(result.netWorth).toBe(-213500);
      expect(result.totalAccounts).toBe(4);
    });

    it("correctly computes net worth from mixed assets and liabilities", async () => {
      const mixedAccounts = [
        {
          ...mockAccount,
          id: "a1",
          accountType: AccountType.CHEQUING,
          currentBalance: 5000,
        },
        {
          ...mockAccount,
          id: "a2",
          accountType: AccountType.SAVINGS,
          currentBalance: 10000,
        },
        {
          ...mockAccount,
          id: "l1",
          accountType: AccountType.CREDIT_CARD,
          currentBalance: -2000,
        },
        {
          ...mockAccount,
          id: "l2",
          accountType: AccountType.MORTGAGE,
          currentBalance: -300000,
        },
      ];

      const getMany = jest.fn().mockResolvedValue(mixedAccounts);
      accountsRepository.createQueryBuilder.mockReturnValue({
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        getMany,
      });

      const result = await service.getSummary("user-1");

      expect(result.totalAssets).toBe(15000);
      expect(result.totalLiabilities).toBe(302000);
      expect(result.netWorth).toBe(15000 - 302000);
      expect(result.totalBalance).toBe(5000 + 10000 - 2000 - 300000);
      expect(result.totalAccounts).toBe(4);
    });

    it("returns zeros when no accounts exist", async () => {
      const getMany = jest.fn().mockResolvedValue([]);
      accountsRepository.createQueryBuilder.mockReturnValue({
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        getMany,
      });

      const result = await service.getSummary("user-1");

      expect(result.totalAccounts).toBe(0);
      expect(result.totalAssets).toBe(0);
      expect(result.totalLiabilities).toBe(0);
      expect(result.netWorth).toBe(0);
      expect(result.totalBalance).toBe(0);
    });
  });
});
