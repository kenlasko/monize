import { Test, TestingModule } from "@nestjs/testing";
import { getRepositoryToken } from "@nestjs/typeorm";
import { TransactionsService } from "./transactions.service";
import { Transaction, TransactionStatus } from "./entities/transaction.entity";
import { TransactionSplit } from "./entities/transaction-split.entity";
import { Category } from "../categories/entities/category.entity";
import { InvestmentTransaction } from "../securities/entities/investment-transaction.entity";
import { AccountsService } from "../accounts/accounts.service";
import { PayeesService } from "../payees/payees.service";
import { NetWorthService } from "../net-worth/net-worth.service";

describe("TransactionsService", () => {
  let service: TransactionsService;
  let transactionsRepository: Record<string, jest.Mock>;
  let splitsRepository: Record<string, jest.Mock>;
  let categoriesRepository: Record<string, jest.Mock>;
  let investmentTxRepository: Record<string, jest.Mock>;
  let accountsService: Record<string, jest.Mock>;
  let payeesService: Record<string, jest.Mock>;
  let netWorthService: Record<string, jest.Mock>;

  const mockAccount = {
    id: "account-1",
    userId: "user-1",
    name: "Checking",
    accountType: "CHEQUING",
    currencyCode: "USD",
    currentBalance: 1000,
    isClosed: false,
  };

  beforeEach(async () => {
    transactionsRepository = {
      create: jest.fn().mockImplementation((data) => ({ ...data, id: "tx-1" })),
      save: jest
        .fn()
        .mockImplementation((data) => ({ ...data, id: data.id || "tx-1" })),
      findOne: jest.fn(),
      find: jest.fn(),
      remove: jest.fn(),
      update: jest.fn(),
      count: jest.fn(),
      createQueryBuilder: jest.fn(),
    };

    splitsRepository = {
      create: jest.fn().mockImplementation((data) => data),
      save: jest
        .fn()
        .mockImplementation((data) => ({ ...data, id: "split-1" })),
      find: jest.fn().mockResolvedValue([]),
      update: jest.fn(),
      delete: jest.fn(),
    };

    categoriesRepository = {
      find: jest.fn().mockResolvedValue([]),
    };

    investmentTxRepository = {
      find: jest.fn().mockResolvedValue([]),
    };

    accountsService = {
      findOne: jest.fn().mockResolvedValue(mockAccount),
      updateBalance: jest.fn().mockResolvedValue(mockAccount),
    };

    payeesService = {
      findOne: jest.fn(),
    };

    netWorthService = {
      recalculateAccount: jest.fn().mockResolvedValue(undefined),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TransactionsService,
        {
          provide: getRepositoryToken(Transaction),
          useValue: transactionsRepository,
        },
        {
          provide: getRepositoryToken(TransactionSplit),
          useValue: splitsRepository,
        },
        {
          provide: getRepositoryToken(Category),
          useValue: categoriesRepository,
        },
        {
          provide: getRepositoryToken(InvestmentTransaction),
          useValue: investmentTxRepository,
        },
        { provide: AccountsService, useValue: accountsService },
        { provide: PayeesService, useValue: payeesService },
        { provide: NetWorthService, useValue: netWorthService },
      ],
    }).compile();

    service = module.get<TransactionsService>(TransactionsService);
  });

  describe("validateSplits (via create)", () => {
    it("rejects splits with fewer than 2 entries (non-transfer)", async () => {
      transactionsRepository.findOne.mockResolvedValue({
        id: "tx-1",
        userId: "user-1",
        splits: [],
      });

      await expect(
        service.create("user-1", {
          accountId: "account-1",
          transactionDate: "2026-01-15",
          amount: -100,
          currencyCode: "USD",
          splits: [{ amount: -100, categoryId: "cat-1" }],
        } as any),
      ).rejects.toThrow("Split transactions must have at least 2 splits");
    });

    it("rejects splits where sum does not match transaction amount", async () => {
      await expect(
        service.create("user-1", {
          accountId: "account-1",
          transactionDate: "2026-01-15",
          amount: -100,
          currencyCode: "USD",
          splits: [
            { amount: -60, categoryId: "cat-1" },
            { amount: -30, categoryId: "cat-2" },
          ],
        } as any),
      ).rejects.toThrow("Split amounts");
    });

    it("rejects splits with zero amount", async () => {
      await expect(
        service.create("user-1", {
          accountId: "account-1",
          transactionDate: "2026-01-15",
          amount: -100,
          currencyCode: "USD",
          splits: [
            { amount: 0, categoryId: "cat-1" },
            { amount: -100, categoryId: "cat-2" },
          ],
        } as any),
      ).rejects.toThrow("Split amounts cannot be zero");
    });

    it("allows single split for transfers (with transferAccountId)", async () => {
      transactionsRepository.findOne.mockResolvedValue({
        id: "tx-1",
        userId: "user-1",
        splits: [{ amount: -100, transferAccountId: "acc-2" }],
      });

      // Should not throw for single split with transfer
      await expect(
        service.create("user-1", {
          accountId: "account-1",
          transactionDate: "2026-01-15",
          amount: -100,
          currencyCode: "USD",
          splits: [{ amount: -100, transferAccountId: "acc-2" }],
        } as any),
      ).resolves.toBeDefined();
    });
  });

  describe("create", () => {
    it("creates a basic transaction and updates balance", async () => {
      transactionsRepository.findOne.mockResolvedValue({
        id: "tx-1",
        userId: "user-1",
        accountId: "account-1",
        amount: -50,
        status: TransactionStatus.UNRECONCILED,
        splits: [],
      });

      await service.create("user-1", {
        accountId: "account-1",
        transactionDate: "2026-01-15",
        amount: -50,
        currencyCode: "USD",
      } as any);

      expect(transactionsRepository.create).toHaveBeenCalled();
      expect(transactionsRepository.save).toHaveBeenCalled();
      expect(accountsService.updateBalance).toHaveBeenCalledWith(
        "account-1",
        -50,
      );
    });

    it("does not update balance for VOID transactions", async () => {
      transactionsRepository.create.mockReturnValue({
        id: "tx-1",
        status: TransactionStatus.VOID,
      });
      transactionsRepository.save.mockResolvedValue({
        id: "tx-1",
        status: TransactionStatus.VOID,
      });
      transactionsRepository.findOne.mockResolvedValue({
        id: "tx-1",
        userId: "user-1",
        status: TransactionStatus.VOID,
        splits: [],
      });

      await service.create("user-1", {
        accountId: "account-1",
        transactionDate: "2026-01-15",
        amount: -50,
        currencyCode: "USD",
        status: TransactionStatus.VOID,
      } as any);

      expect(accountsService.updateBalance).not.toHaveBeenCalled();
    });

    it("auto-assigns category from payee default", async () => {
      payeesService.findOne.mockResolvedValue({
        id: "payee-1",
        defaultCategoryId: "cat-1",
      });
      transactionsRepository.findOne.mockResolvedValue({
        id: "tx-1",
        userId: "user-1",
        categoryId: "cat-1",
        splits: [],
        status: TransactionStatus.UNRECONCILED,
      });

      await service.create("user-1", {
        accountId: "account-1",
        transactionDate: "2026-01-15",
        amount: -50,
        currencyCode: "USD",
        payeeId: "payee-1",
      } as any);

      const createCall = transactionsRepository.create.mock.calls[0][0];
      expect(createCall.categoryId).toBe("cat-1");
    });

    it("verifies account belongs to user", async () => {
      transactionsRepository.findOne.mockResolvedValue({
        id: "tx-1",
        userId: "user-1",
        accountId: "account-1",
        amount: -50,
        status: TransactionStatus.UNRECONCILED,
        splits: [],
      });

      await service.create("user-1", {
        accountId: "account-1",
        transactionDate: "2026-01-15",
        amount: -50,
        currencyCode: "USD",
      } as any);

      expect(accountsService.findOne).toHaveBeenCalledWith(
        "user-1",
        "account-1",
      );
    });
  });
});
