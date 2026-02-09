import { Test, TestingModule } from "@nestjs/testing";
import { getRepositoryToken } from "@nestjs/typeorm";
import { NotFoundException, ForbiddenException } from "@nestjs/common";
import { AccountsService } from "./accounts.service";
import { Account, AccountType } from "./entities/account.entity";
import { Transaction } from "../transactions/entities/transaction.entity";
import { InvestmentTransaction } from "../securities/entities/investment-transaction.entity";
import { CategoriesService } from "../categories/categories.service";
import { ScheduledTransactionsService } from "../scheduled-transactions/scheduled-transactions.service";
import { NetWorthService } from "../net-worth/net-worth.service";

describe("AccountsService", () => {
  let service: AccountsService;
  let accountsRepository: Record<string, jest.Mock>;
  let transactionRepository: Record<string, jest.Mock>;
  let investmentTxRepository: Record<string, jest.Mock>;

  const mockAccount = {
    id: "account-1",
    userId: "user-1",
    name: "Checking",
    accountType: "CHEQUING",
    currencyCode: "USD",
    openingBalance: 1000,
    currentBalance: 1500,
    isClosed: false,
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

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AccountsService,
        { provide: getRepositoryToken(Account), useValue: accountsRepository },
        {
          provide: getRepositoryToken(Transaction),
          useValue: transactionRepository,
        },
        {
          provide: getRepositoryToken(InvestmentTransaction),
          useValue: investmentTxRepository,
        },
        { provide: CategoriesService, useValue: {} },
        { provide: ScheduledTransactionsService, useValue: {} },
        {
          provide: NetWorthService,
          useValue: { recalculateAccount: jest.fn() },
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

    it("throws ForbiddenException when account belongs to different user", async () => {
      accountsRepository.findOne.mockResolvedValue({
        ...mockAccount,
        userId: "other-user",
      });

      await expect(service.findOne("user-1", "account-1")).rejects.toThrow(
        ForbiddenException,
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
});
