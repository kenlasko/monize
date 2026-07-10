import { Test, TestingModule } from "@nestjs/testing";
import { getRepositoryToken } from "@nestjs/typeorm";
import { BadRequestException, NotFoundException } from "@nestjs/common";
import { DataSource } from "typeorm";
import { TransactionSplitService } from "./transaction-split.service";
import { Transaction } from "./entities/transaction.entity";
import { TransactionSplit } from "./entities/transaction-split.entity";
import { Category } from "../categories/entities/category.entity";
import { AccountsService } from "../accounts/accounts.service";
import { isTransactionInFuture } from "../common/date-utils";

jest.mock("../common/date-utils", () => ({
  isTransactionInFuture: jest.fn().mockReturnValue(false),
}));

const mockedIsTransactionInFuture =
  isTransactionInFuture as jest.MockedFunction<typeof isTransactionInFuture>;

describe("TransactionSplitService", () => {
  let service: TransactionSplitService;
  let transactionsRepository: Record<string, jest.Mock>;
  let splitsRepository: Record<string, jest.Mock>;
  let categoriesRepository: Record<string, jest.Mock>;
  let accountsService: Record<string, jest.Mock>;
  let mockQueryRunner: Record<string, any>;

  const mockTransaction: Partial<Transaction> = {
    id: "tx-1",
    userId: "user-1",
    accountId: "account-1",
    amount: -100,
    transactionDate: "2026-01-15",
    payeeName: "Grocery Store",
    isSplit: true,
    categoryId: null,
  };

  const mockSplit: Partial<TransactionSplit> = {
    id: "split-1",
    transactionId: "tx-1",
    categoryId: "cat-1",
    transferAccountId: null,
    linkedTransactionId: null,
    amount: -60,
    memo: "Food",
    createdAt: new Date("2026-01-15"),
  };

  const mockSplit2: Partial<TransactionSplit> = {
    id: "split-2",
    transactionId: "tx-1",
    categoryId: "cat-2",
    transferAccountId: null,
    linkedTransactionId: null,
    amount: -40,
    memo: "Drinks",
    createdAt: new Date("2026-01-15"),
  };

  beforeEach(async () => {
    mockedIsTransactionInFuture.mockReturnValue(false);

    transactionsRepository = {
      create: jest
        .fn()
        .mockImplementation((data) => ({ ...data, id: "new-tx" })),
      save: jest
        .fn()
        .mockImplementation((data) => ({ ...data, id: data.id || "new-tx" })),
      update: jest.fn().mockResolvedValue(undefined),
      findOne: jest.fn(),
      find: jest.fn().mockResolvedValue([]),
      remove: jest.fn().mockResolvedValue(undefined),
    };

    splitsRepository = {
      create: jest
        .fn()
        .mockImplementation((data) => ({ ...data, id: "new-split" })),
      save: jest.fn().mockImplementation((data) => {
        if (Array.isArray(data)) {
          return data.map((d: any, i: number) => ({
            ...d,
            id: d.id || `new-split-${i + 1}`,
          }));
        }
        return { ...data, id: data.id || "new-split" };
      }),
      find: jest.fn().mockResolvedValue([]),
      findOne: jest.fn(),
      update: jest.fn().mockResolvedValue(undefined),
      delete: jest.fn().mockResolvedValue(undefined),
      remove: jest.fn().mockResolvedValue(undefined),
    };

    categoriesRepository = {
      findOne: jest.fn().mockResolvedValue({ id: "cat-1", userId: "user-1" }),
    };

    accountsService = {
      findOne: jest.fn().mockResolvedValue({
        id: "account-2",
        name: "Savings",
        currencyCode: "USD",
      }),
      updateBalance: jest.fn().mockResolvedValue(undefined),
      recalculateCurrentBalance: jest.fn().mockResolvedValue(undefined),
    };

    mockQueryRunner = {
      connect: jest.fn(),
      startTransaction: jest.fn(),
      commitTransaction: jest.fn(),
      rollbackTransaction: jest.fn(),
      release: jest.fn(),
      query: jest.fn().mockResolvedValue([]),
      manager: {
        create: jest.fn().mockImplementation((_Entity: any, data: any) => {
          if (_Entity === TransactionSplit)
            return splitsRepository.create(data);
          if (_Entity === Transaction)
            return transactionsRepository.create(data);
          return { ...data, id: "new-entity" };
        }),
        save: jest.fn().mockImplementation((data: any) => {
          if (Array.isArray(data)) return splitsRepository.save(data);
          if ("userId" in data) return transactionsRepository.save(data);
          return splitsRepository.save(data);
        }),
        update: jest
          .fn()
          .mockImplementation((_Entity: any, id: any, data: any) => {
            if (_Entity === TransactionSplit)
              return splitsRepository.update(id, data);
            if (_Entity === Transaction)
              return transactionsRepository.update(id, data);
            return Promise.resolve(undefined);
          }),
        delete: jest.fn().mockResolvedValue(undefined),
        findOne: jest.fn().mockResolvedValue(null),
        find: jest.fn().mockImplementation((_Entity: any, _opts?: any) => {
          if (_Entity === Category) {
            return Promise.resolve([
              { id: "cat-1" },
              { id: "cat-2" },
              { id: "cat-3" },
            ]);
          }
          return Promise.resolve([]);
        }),
        remove: jest.fn().mockResolvedValue(undefined),
        getRepository: jest.fn().mockImplementation((entity: any) => {
          if (entity === TransactionSplit) return splitsRepository;
          if (entity === Transaction) return transactionsRepository;
          return {};
        }),
      },
    };

    const mockDataSource = {
      createQueryRunner: jest.fn().mockReturnValue(mockQueryRunner),
    };

    const investmentTransactionsService = {
      createEmbeddedForSplit: jest.fn().mockResolvedValue({}),
      reverseAndRemoveEmbedded: jest.fn().mockResolvedValue(undefined),
    };

    const netWorthService = {
      triggerDebouncedRecalc: jest.fn(),
    };

    const {
      InvestmentTransactionsService,
      // eslint-disable-next-line @typescript-eslint/no-require-imports
    } = require("../securities/investment-transactions.service");
    const {
      NetWorthService,
      // eslint-disable-next-line @typescript-eslint/no-require-imports
    } = require("../net-worth/net-worth.service");

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TransactionSplitService,
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
        { provide: AccountsService, useValue: accountsService },
        {
          provide: InvestmentTransactionsService,
          useValue: investmentTransactionsService,
        },
        { provide: NetWorthService, useValue: netWorthService },
        { provide: DataSource, useValue: mockDataSource },
      ],
    }).compile();

    service = module.get<TransactionSplitService>(TransactionSplitService);
  });

  describe("validateSplits", () => {
    it("passes validation for two splits equaling transaction amount", () => {
      const splits = [
        { amount: -60, categoryId: "cat-1" },
        { amount: -40, categoryId: "cat-2" },
      ];
      expect(() => service.validateSplits(splits, -100)).not.toThrow();
    });

    it("passes validation for a single transfer split", () => {
      const splits = [{ amount: -100, transferAccountId: "account-2" }];
      expect(() => service.validateSplits(splits, -100)).not.toThrow();
    });

    it("throws when fewer than 2 splits and no transfer", () => {
      const splits = [{ amount: -100, categoryId: "cat-1" }];
      expect(() => service.validateSplits(splits, -100)).toThrow(
        BadRequestException,
      );
      expect(() => service.validateSplits(splits, -100)).toThrow(
        "Split transactions must have at least 2 splits",
      );
    });

    it("throws when split amounts do not equal transaction amount", () => {
      const splits = [
        { amount: -60, categoryId: "cat-1" },
        { amount: -30, categoryId: "cat-2" },
      ];
      expect(() => service.validateSplits(splits, -100)).toThrow(
        BadRequestException,
      );
      expect(() => service.validateSplits(splits, -100)).toThrow(
        /Split amounts .* must equal transaction amount/,
      );
    });

    it("allows zero amount splits when total matches", () => {
      const splits = [
        { amount: 0, categoryId: "cat-1" },
        { amount: -100, categoryId: "cat-2" },
      ];
      expect(() => service.validateSplits(splits, -100)).not.toThrow();
    });

    it("handles floating point precision correctly", () => {
      const splits = [
        { amount: -33.3333, categoryId: "cat-1" },
        { amount: -33.3333, categoryId: "cat-2" },
        { amount: -33.3334, categoryId: "cat-3" },
      ];
      expect(() => service.validateSplits(splits, -100)).not.toThrow();
    });

    it("passes with multiple splits summing to positive amount", () => {
      const splits = [
        { amount: 50, categoryId: "cat-1" },
        { amount: 30, categoryId: "cat-2" },
        { amount: 20, categoryId: "cat-3" },
      ];
      expect(() => service.validateSplits(splits, 100)).not.toThrow();
    });
  });

  describe("createSplits", () => {
    it("creates category splits without transfer logic", async () => {
      const splits = [
        { amount: -60, categoryId: "cat-1", memo: "Food" },
        { amount: -40, categoryId: "cat-2", memo: "Drinks" },
      ];

      const result = await service.createSplits("tx-1", splits);

      // Regular splits are batch-created and batch-saved
      expect(mockQueryRunner.manager.create).toHaveBeenCalledTimes(2);
      expect(mockQueryRunner.manager.save).toHaveBeenCalledTimes(1);
      expect(result).toHaveLength(2);

      expect(mockQueryRunner.manager.create).toHaveBeenCalledWith(
        TransactionSplit,
        {
          transactionId: "tx-1",
          kind: "category",
          categoryId: "cat-1",
          transferAccountId: null,
          amount: -60,
          memo: "Food",
        },
      );
    });

    it("creates a transfer split with linked transaction when userId and sourceAccountId provided", async () => {
      accountsService.findOne
        .mockResolvedValueOnce({
          id: "account-2",
          name: "Savings",
          currencyCode: "USD",
        })
        .mockResolvedValueOnce({
          id: "account-1",
          name: "Checking",
          currencyCode: "USD",
        });

      // The linked transaction save (only transactionsRepository.save call in this flow)
      transactionsRepository.save.mockResolvedValueOnce({
        id: "linked-tx-1",
        accountId: "account-2",
        amount: 50,
      });

      // The split save
      splitsRepository.save.mockResolvedValueOnce({
        id: "split-new",
        transactionId: "tx-1",
        transferAccountId: "account-2",
        amount: -50,
      });

      const splits = [
        { amount: -50, transferAccountId: "account-2", memo: "Transfer part" },
      ];

      const result = await service.createSplits(
        "tx-1",
        splits,
        "user-1",
        "account-1",
        new Date("2026-01-15"),
        "Store",
      );

      expect(accountsService.findOne).toHaveBeenCalledWith(
        "user-1",
        "account-2",
      );
      expect(accountsService.findOne).toHaveBeenCalledWith(
        "user-1",
        "account-1",
      );
      expect(transactionsRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: "user-1",
          accountId: "account-2",
          amount: 50,
          isTransfer: true,
          payeeName: "Store",
          // The counterpart's date is the parent's calendar day as a plain
          // yyyy-MM-dd string, not a Date object that would shift west of UTC.
          transactionDate: "2026-01-15",
        }),
      );
      expect(splitsRepository.update).toHaveBeenCalledWith(
        "split-new",
        expect.objectContaining({ linkedTransactionId: "linked-tx-1" }),
      );
      expect(transactionsRepository.update).toHaveBeenCalledWith(
        "linked-tx-1",
        expect.objectContaining({ linkedTransactionId: "tx-1" }),
      );
      expect(accountsService.updateBalance).toHaveBeenCalledWith(
        "account-2",
        50,
        expect.anything(),
      );
      expect(result).toHaveLength(1);
      expect(result[0].linkedTransactionId).toBe("linked-tx-1");
    });

    it("uses default payee name when parentPayeeName is null", async () => {
      accountsService.findOne
        .mockResolvedValueOnce({
          id: "account-2",
          name: "Savings",
          currencyCode: "CAD",
        })
        .mockResolvedValueOnce({
          id: "account-1",
          name: "Checking",
          currencyCode: "CAD",
        });

      splitsRepository.save.mockResolvedValueOnce({
        id: "split-new",
        transactionId: "tx-1",
        transferAccountId: "account-2",
        amount: -50,
      });
      transactionsRepository.save.mockResolvedValueOnce({
        id: "linked-tx-1",
        accountId: "account-2",
      });

      const splits = [{ amount: -50, transferAccountId: "account-2" }];

      await service.createSplits(
        "tx-1",
        splits,
        "user-1",
        "account-1",
        new Date("2026-01-15"),
        null,
      );

      expect(transactionsRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          payeeName: "Transfer from Checking",
        }),
      );
    });

    it("skips transfer logic when userId is not provided", async () => {
      const splits = [{ amount: -100, transferAccountId: "account-2" }];

      splitsRepository.save.mockResolvedValueOnce([
        {
          id: "split-new",
          transactionId: "tx-1",
          transferAccountId: "account-2",
          amount: -100,
        },
      ]);

      const result = await service.createSplits("tx-1", splits);

      expect(accountsService.findOne).not.toHaveBeenCalled();
      expect(transactionsRepository.create).not.toHaveBeenCalled();
      expect(result).toHaveLength(1);
    });

    it("sets null for optional fields when not provided", async () => {
      const splits = [{ amount: -60 }, { amount: -40 }];

      await service.createSplits("tx-1", splits);

      expect(mockQueryRunner.manager.create).toHaveBeenCalledWith(
        TransactionSplit,
        {
          transactionId: "tx-1",
          kind: "category",
          categoryId: null,
          transferAccountId: null,
          amount: -60,
          memo: null,
        },
      );
    });
  });

  describe("deleteTransferSplitLinkedTransactions", () => {
    it("removes linked transactions and reverses balances for transfer splits", async () => {
      const transferSplit = {
        id: "split-1",
        transactionId: "tx-1",
        linkedTransactionId: "linked-tx-1",
        transferAccountId: "account-2",
      };

      splitsRepository.find.mockResolvedValue([transferSplit]);
      transactionsRepository.find.mockResolvedValue([
        { id: "linked-tx-1", accountId: "account-2", amount: 50 },
      ]);

      await service.deleteTransferSplitLinkedTransactions("tx-1");

      expect(splitsRepository.find).toHaveBeenCalledWith({
        where: { transactionId: "tx-1" },
        relations: ["linkedTransaction"],
      });
      expect(transactionsRepository.find).toHaveBeenCalledWith({
        where: { id: expect.anything() },
      });
      expect(accountsService.updateBalance).toHaveBeenCalledWith(
        "account-2",
        -50,
        undefined,
      );
      expect(transactionsRepository.remove).toHaveBeenCalledWith(
        expect.objectContaining({ id: "linked-tx-1" }),
      );
    });

    it("skips splits without linkedTransactionId or transferAccountId", async () => {
      const categorySplit = {
        id: "split-1",
        transactionId: "tx-1",
        linkedTransactionId: null,
        transferAccountId: null,
      };

      splitsRepository.find.mockResolvedValue([categorySplit]);

      await service.deleteTransferSplitLinkedTransactions("tx-1");

      expect(transactionsRepository.find).not.toHaveBeenCalled();
      expect(accountsService.updateBalance).not.toHaveBeenCalled();
      expect(transactionsRepository.remove).not.toHaveBeenCalled();
    });

    it("handles case where linked transaction not found in DB", async () => {
      const transferSplit = {
        id: "split-1",
        transactionId: "tx-1",
        linkedTransactionId: "linked-tx-1",
        transferAccountId: "account-2",
      };

      splitsRepository.find.mockResolvedValue([transferSplit]);
      transactionsRepository.find.mockResolvedValue([]);

      await service.deleteTransferSplitLinkedTransactions("tx-1");

      expect(accountsService.updateBalance).not.toHaveBeenCalled();
      expect(transactionsRepository.remove).not.toHaveBeenCalled();
    });

    it("does nothing when no splits exist", async () => {
      splitsRepository.find.mockResolvedValue([]);

      await service.deleteTransferSplitLinkedTransactions("tx-1");

      expect(transactionsRepository.find).not.toHaveBeenCalled();
    });

    it("handles multiple transfer splits", async () => {
      const splits = [
        {
          id: "split-1",
          transactionId: "tx-1",
          linkedTransactionId: "linked-tx-1",
          transferAccountId: "account-2",
        },
        {
          id: "split-2",
          transactionId: "tx-1",
          linkedTransactionId: "linked-tx-2",
          transferAccountId: "account-3",
        },
      ];

      splitsRepository.find.mockResolvedValue(splits);
      transactionsRepository.find.mockResolvedValue([
        { id: "linked-tx-1", accountId: "account-2", amount: 30 },
        { id: "linked-tx-2", accountId: "account-3", amount: 70 },
      ]);

      await service.deleteTransferSplitLinkedTransactions("tx-1");

      expect(accountsService.updateBalance).toHaveBeenCalledTimes(2);
      expect(transactionsRepository.remove).toHaveBeenCalledTimes(2);
    });
  });

  describe("getSplits", () => {
    it("returns splits ordered by createdAt ASC with relations", async () => {
      splitsRepository.find.mockResolvedValue([mockSplit, mockSplit2]);

      const result = await service.getSplits("tx-1");

      expect(splitsRepository.find).toHaveBeenCalledWith({
        where: { transactionId: "tx-1" },
        relations: ["category", "transferAccount", "investmentTransaction"],
        order: { createdAt: "ASC" },
      });
      expect(result).toEqual([mockSplit, mockSplit2]);
    });

    it("returns empty array when no splits exist", async () => {
      splitsRepository.find.mockResolvedValue([]);

      const result = await service.getSplits("tx-1");

      expect(result).toEqual([]);
    });
  });

  describe("updateSplits", () => {
    it("validates, deletes old splits, creates new splits, and marks transaction as split", async () => {
      const transaction = { ...mockTransaction } as Transaction;
      const newSplits = [
        { amount: -70, categoryId: "cat-1" },
        { amount: -30, categoryId: "cat-2" },
      ];

      // deleteTransferSplitLinkedTransactions mock - no transfer splits
      splitsRepository.find.mockResolvedValue([]);

      const result = await service.updateSplits(
        transaction,
        newSplits,
        "user-1",
      );

      expect(mockQueryRunner.manager.delete).toHaveBeenCalledWith(
        TransactionSplit,
        { transactionId: "tx-1" },
      );
      // Regular splits are batch-created via queryRunner
      expect(mockQueryRunner.manager.create).toHaveBeenCalledTimes(2);
      expect(mockQueryRunner.manager.update).toHaveBeenCalledWith(
        Transaction,
        "tx-1",
        { isSplit: true, categoryId: null },
      );
      expect(result).toHaveLength(2);
    });

    it("throws when splits fail validation", async () => {
      const transaction = { ...mockTransaction } as Transaction;
      const invalidSplits = [
        { amount: -50, categoryId: "cat-1" },
        { amount: -30, categoryId: "cat-2" },
      ];

      await expect(
        service.updateSplits(transaction, invalidSplits, "user-1"),
      ).rejects.toThrow(BadRequestException);
    });

    it("deletes transfer linked transactions before replacing splits", async () => {
      const transaction = { ...mockTransaction } as Transaction;
      const oldTransferSplit = {
        id: "old-split",
        transactionId: "tx-1",
        linkedTransactionId: "old-linked-tx",
        transferAccountId: "account-2",
      };

      splitsRepository.find.mockResolvedValue([oldTransferSplit]);
      transactionsRepository.find.mockResolvedValue([
        { id: "old-linked-tx", accountId: "account-2", amount: 100 },
      ]);

      const newSplits = [
        { amount: -60, categoryId: "cat-1" },
        { amount: -40, categoryId: "cat-2" },
      ];

      splitsRepository.save.mockResolvedValueOnce([
        { id: "s1", ...newSplits[0], transactionId: "tx-1" },
        { id: "s2", ...newSplits[1], transactionId: "tx-1" },
      ]);

      await service.updateSplits(transaction, newSplits, "user-1");

      expect(accountsService.updateBalance).toHaveBeenCalledWith(
        "account-2",
        -100,
        mockQueryRunner,
      );
      expect(transactionsRepository.remove).toHaveBeenCalledWith(
        expect.objectContaining({ id: "old-linked-tx" }),
      );
    });
  });

  describe("addSplit", () => {
    it("adds a category split to an existing split transaction", async () => {
      const transaction = { ...mockTransaction, isSplit: true } as Transaction;
      const existingSplits = [
        { ...mockSplit, amount: -60 },
        { ...mockSplit2, amount: -30 },
      ];

      splitsRepository.find.mockResolvedValue(existingSplits);
      splitsRepository.save.mockResolvedValue({
        id: "new-split-id",
        transactionId: "tx-1",
        amount: -10,
        categoryId: "cat-3",
        memo: null,
      });
      splitsRepository.findOne.mockResolvedValue({
        id: "new-split-id",
        transactionId: "tx-1",
        amount: -10,
        categoryId: "cat-3",
        category: { id: "cat-3", name: "Other" },
        transferAccount: null,
      });

      const result = await service.addSplit(
        transaction,
        { amount: -10, categoryId: "cat-3" },
        "user-1",
      );

      expect(splitsRepository.create).toHaveBeenCalledWith({
        transactionId: "tx-1",
        kind: "category",
        categoryId: "cat-3",
        transferAccountId: null,
        amount: -10,
        memo: null,
      });
      expect(result.id).toBe("new-split-id");
    });

    it("throws when adding split would exceed transaction amount", async () => {
      const transaction = { ...mockTransaction, amount: -100 } as Transaction;
      const existingSplits = [{ ...mockSplit, amount: -90 }];

      splitsRepository.find.mockResolvedValue(existingSplits);

      await expect(
        service.addSplit(
          transaction,
          { amount: -20, categoryId: "cat-3" },
          "user-1",
        ),
      ).rejects.toThrow(BadRequestException);
    });

    it("marks transaction as split when total reaches 2 splits", async () => {
      const transaction = {
        ...mockTransaction,
        isSplit: false,
        amount: -100,
      } as Transaction;
      const existingSplits = [{ ...mockSplit, amount: -60 }];

      splitsRepository.find.mockResolvedValue(existingSplits);
      splitsRepository.save.mockResolvedValue({
        id: "new-split-id",
        transactionId: "tx-1",
        amount: -40,
      });
      splitsRepository.findOne.mockResolvedValue({
        id: "new-split-id",
        transactionId: "tx-1",
        amount: -40,
        category: null,
        transferAccount: null,
      });

      await service.addSplit(
        transaction,
        { amount: -40, categoryId: "cat-2" },
        "user-1",
      );

      expect(transactionsRepository.update).toHaveBeenCalledWith("tx-1", {
        isSplit: true,
        categoryId: null,
      });
    });

    it("does not update isSplit when already split", async () => {
      const transaction = {
        ...mockTransaction,
        isSplit: true,
        amount: -100,
      } as Transaction;
      const existingSplits = [
        { ...mockSplit, amount: -40 },
        { ...mockSplit2, amount: -30 },
      ];

      splitsRepository.find.mockResolvedValue(existingSplits);
      splitsRepository.save.mockResolvedValue({
        id: "new-split-id",
        transactionId: "tx-1",
        amount: -30,
      });
      splitsRepository.findOne.mockResolvedValue({
        id: "new-split-id",
        transactionId: "tx-1",
        amount: -30,
        category: null,
        transferAccount: null,
      });

      await service.addSplit(
        transaction,
        { amount: -30, categoryId: "cat-3" },
        "user-1",
      );

      expect(transactionsRepository.update).not.toHaveBeenCalled();
    });

    it("creates linked transaction for transfer split", async () => {
      const transaction = {
        ...mockTransaction,
        isSplit: true,
        amount: -100,
        payeeName: "My Transfer",
      } as Transaction;
      const existingSplits = [{ ...mockSplit, amount: -60 }];

      splitsRepository.find.mockResolvedValue(existingSplits);

      accountsService.findOne
        .mockResolvedValueOnce({
          id: "account-2",
          name: "Savings",
          currencyCode: "CAD",
        })
        .mockResolvedValueOnce({
          id: "account-1",
          name: "Checking",
          currencyCode: "CAD",
        });

      splitsRepository.save.mockResolvedValue({
        id: "new-split-id",
        transactionId: "tx-1",
        transferAccountId: "account-2",
        amount: -40,
      });
      transactionsRepository.save.mockResolvedValue({
        id: "linked-tx-new",
        accountId: "account-2",
        amount: 40,
      });
      splitsRepository.findOne.mockResolvedValue({
        id: "new-split-id",
        transactionId: "tx-1",
        amount: -40,
        transferAccountId: "account-2",
        linkedTransactionId: "linked-tx-new",
        category: null,
        transferAccount: { id: "account-2", name: "Savings" },
      });

      const result = await service.addSplit(
        transaction,
        { amount: -40, transferAccountId: "account-2" },
        "user-1",
      );

      expect(transactionsRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: "user-1",
          accountId: "account-2",
          amount: 40,
          isTransfer: true,
          payeeName: "My Transfer",
        }),
      );
      expect(accountsService.updateBalance).toHaveBeenCalledWith(
        "account-2",
        40,
        mockQueryRunner,
      );
      expect(result.linkedTransactionId).toBe("linked-tx-new");
    });

    it("throws NotFoundException when saved split cannot be found with relations", async () => {
      const transaction = {
        ...mockTransaction,
        isSplit: true,
        amount: -100,
      } as Transaction;

      splitsRepository.find.mockResolvedValue([{ ...mockSplit, amount: -60 }]);
      splitsRepository.save.mockResolvedValue({
        id: "ghost-split",
        transactionId: "tx-1",
        amount: -40,
      });
      splitsRepository.findOne.mockResolvedValue(null);

      await expect(
        service.addSplit(
          transaction,
          { amount: -40, categoryId: "cat-2" },
          "user-1",
        ),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe("removeSplit", () => {
    it("removes a category split from a transaction with more than 2 splits", async () => {
      const transaction = { ...mockTransaction } as Transaction;
      const splitToRemove = {
        ...mockSplit,
        linkedTransactionId: null,
        transferAccountId: null,
      };

      splitsRepository.findOne.mockResolvedValue(splitToRemove);
      mockQueryRunner.manager.find.mockResolvedValue([
        { ...mockSplit2 },
        {
          id: "split-3",
          transactionId: "tx-1",
          amount: -20,
          categoryId: "cat-3",
        },
      ]);

      await service.removeSplit(transaction, "split-1", "user-1");

      expect(mockQueryRunner.manager.remove).toHaveBeenCalledWith(
        splitToRemove,
      );
      expect(mockQueryRunner.manager.update).not.toHaveBeenCalledWith(
        Transaction,
        expect.anything(),
        expect.anything(),
      );
    });

    it("throws NotFoundException when split not found", async () => {
      const transaction = { ...mockTransaction } as Transaction;
      splitsRepository.findOne.mockResolvedValue(null);

      await expect(
        service.removeSplit(transaction, "nonexistent", "user-1"),
      ).rejects.toThrow(NotFoundException);
    });

    it("removes linked transaction for transfer split", async () => {
      const transaction = { ...mockTransaction } as Transaction;
      const transferSplit = {
        id: "split-1",
        transactionId: "tx-1",
        linkedTransactionId: "linked-tx-1",
        transferAccountId: "account-2",
        amount: -50,
      };

      splitsRepository.findOne.mockResolvedValue(transferSplit);
      mockQueryRunner.manager.findOne.mockResolvedValue({
        id: "linked-tx-1",
        accountId: "account-2",
        amount: 50,
      });
      // remaining splits after removal -- still 2+
      mockQueryRunner.manager.find.mockResolvedValue([
        {
          id: "split-2",
          transactionId: "tx-1",
          amount: -30,
          categoryId: "cat-1",
        },
        {
          id: "split-3",
          transactionId: "tx-1",
          amount: -20,
          categoryId: "cat-2",
        },
      ]);

      await service.removeSplit(transaction, "split-1", "user-1");

      expect(accountsService.updateBalance).toHaveBeenCalledWith(
        "account-2",
        -50,
        mockQueryRunner,
      );
      expect(mockQueryRunner.manager.remove).toHaveBeenCalledWith(
        expect.objectContaining({ id: "linked-tx-1" }),
      );
    });

    it("collapses to non-split when only 1 split remains (category)", async () => {
      const transaction = { ...mockTransaction } as Transaction;
      const splitToRemove = {
        ...mockSplit,
        linkedTransactionId: null,
        transferAccountId: null,
      };

      splitsRepository.findOne.mockResolvedValue(splitToRemove);

      const lastSplit = {
        id: "split-2",
        transactionId: "tx-1",
        categoryId: "cat-2",
        linkedTransactionId: null,
        transferAccountId: null,
        amount: -40,
      };
      mockQueryRunner.manager.find.mockResolvedValue([lastSplit]);

      await service.removeSplit(transaction, "split-1", "user-1");

      expect(mockQueryRunner.manager.update).toHaveBeenCalledWith(
        Transaction,
        "tx-1",
        { isSplit: false, categoryId: "cat-2" },
      );
      expect(mockQueryRunner.manager.remove).toHaveBeenCalledWith(lastSplit);
    });

    it("collapses to non-split and removes linked transaction when last split is a transfer", async () => {
      const transaction = { ...mockTransaction } as Transaction;
      const splitToRemove = {
        ...mockSplit,
        linkedTransactionId: null,
        transferAccountId: null,
      };

      splitsRepository.findOne.mockResolvedValue(splitToRemove);

      const lastSplit = {
        id: "split-2",
        transactionId: "tx-1",
        categoryId: null,
        linkedTransactionId: "linked-tx-2",
        transferAccountId: "account-3",
        amount: -40,
      };
      mockQueryRunner.manager.find.mockResolvedValue([lastSplit]);
      mockQueryRunner.manager.findOne.mockResolvedValue({
        id: "linked-tx-2",
        accountId: "account-3",
        amount: 40,
      });

      await service.removeSplit(transaction, "split-1", "user-1");

      expect(accountsService.updateBalance).toHaveBeenCalledWith(
        "account-3",
        -40,
        mockQueryRunner,
      );
      expect(mockQueryRunner.manager.remove).toHaveBeenCalledWith(
        expect.objectContaining({ id: "linked-tx-2" }),
      );
      expect(mockQueryRunner.manager.update).toHaveBeenCalledWith(
        Transaction,
        "tx-1",
        { isSplit: false, categoryId: null },
      );
      expect(mockQueryRunner.manager.remove).toHaveBeenCalledWith(lastSplit);
    });

    it("sets isSplit false when no splits remain", async () => {
      const transaction = { ...mockTransaction } as Transaction;
      const splitToRemove = {
        ...mockSplit,
        linkedTransactionId: null,
        transferAccountId: null,
      };

      splitsRepository.findOne.mockResolvedValue(splitToRemove);
      splitsRepository.find.mockResolvedValue([]);

      await service.removeSplit(transaction, "split-1", "user-1");

      expect(transactionsRepository.update).toHaveBeenCalledWith("tx-1", {
        isSplit: false,
      });
    });

    it("handles linked transaction not found gracefully for transfer split removal", async () => {
      const transaction = { ...mockTransaction } as Transaction;
      const transferSplit = {
        id: "split-1",
        transactionId: "tx-1",
        linkedTransactionId: "linked-tx-1",
        transferAccountId: "account-2",
        amount: -50,
      };

      splitsRepository.findOne.mockResolvedValue(transferSplit);
      mockQueryRunner.manager.findOne.mockResolvedValue(null);
      mockQueryRunner.manager.find.mockResolvedValue([
        {
          id: "split-2",
          transactionId: "tx-1",
          amount: -50,
          categoryId: "cat-1",
        },
        {
          id: "split-3",
          transactionId: "tx-1",
          amount: -25,
          categoryId: "cat-2",
        },
      ]);

      await service.removeSplit(transaction, "split-1", "user-1");

      expect(accountsService.updateBalance).not.toHaveBeenCalled();
      expect(mockQueryRunner.manager.remove).toHaveBeenCalledWith(
        transferSplit,
      );
    });
  });

  describe("future-dated transactions", () => {
    describe("createSplits", () => {
      it("does NOT call updateBalance on the transfer account for future-dated transactions", async () => {
        mockedIsTransactionInFuture.mockReturnValue(true);

        accountsService.findOne
          .mockResolvedValueOnce({
            id: "account-2",
            name: "Savings",
            currencyCode: "USD",
          })
          .mockResolvedValueOnce({
            id: "account-1",
            name: "Checking",
            currencyCode: "USD",
          });

        transactionsRepository.save.mockResolvedValueOnce({
          id: "linked-tx-1",
          accountId: "account-2",
          amount: 50,
        });

        splitsRepository.save.mockResolvedValueOnce({
          id: "split-new",
          transactionId: "tx-1",
          transferAccountId: "account-2",
          amount: -50,
        });

        const splits = [
          {
            amount: -50,
            transferAccountId: "account-2",
            memo: "Transfer part",
          },
        ];

        await service.createSplits(
          "tx-1",
          splits,
          "user-1",
          "account-1",
          new Date("2027-06-15"),
          "Store",
        );

        expect(transactionsRepository.create).toHaveBeenCalled();
        expect(transactionsRepository.save).toHaveBeenCalled();
        expect(accountsService.updateBalance).not.toHaveBeenCalled();
      });
    });

    describe("deleteTransferSplitLinkedTransactions", () => {
      it("does NOT call updateBalance when deleting linked transactions with future dates", async () => {
        mockedIsTransactionInFuture.mockReturnValue(true);

        const transferSplit = {
          id: "split-1",
          transactionId: "tx-1",
          linkedTransactionId: "linked-tx-1",
          transferAccountId: "account-2",
        };

        splitsRepository.find.mockResolvedValue([transferSplit]);
        transactionsRepository.find.mockResolvedValue([
          {
            id: "linked-tx-1",
            accountId: "account-2",
            amount: 50,
            transactionDate: "2027-06-15",
          },
        ]);

        await service.deleteTransferSplitLinkedTransactions("tx-1");

        expect(transactionsRepository.find).toHaveBeenCalled();
        expect(accountsService.updateBalance).not.toHaveBeenCalled();
        expect(transactionsRepository.remove).toHaveBeenCalledWith(
          expect.objectContaining({ id: "linked-tx-1" }),
        );
      });

      it("calls updateBalance for past-dated linked transactions but not future-dated ones", async () => {
        mockedIsTransactionInFuture
          .mockReturnValueOnce(false)
          .mockReturnValueOnce(true);

        const splits = [
          {
            id: "split-1",
            transactionId: "tx-1",
            linkedTransactionId: "linked-tx-1",
            transferAccountId: "account-2",
          },
          {
            id: "split-2",
            transactionId: "tx-1",
            linkedTransactionId: "linked-tx-2",
            transferAccountId: "account-3",
          },
        ];

        splitsRepository.find.mockResolvedValue(splits);
        transactionsRepository.find.mockResolvedValue([
          {
            id: "linked-tx-1",
            accountId: "account-2",
            amount: 30,
            transactionDate: "2026-01-15",
          },
          {
            id: "linked-tx-2",
            accountId: "account-3",
            amount: 70,
            transactionDate: "2027-06-15",
          },
        ]);

        await service.deleteTransferSplitLinkedTransactions("tx-1");

        expect(accountsService.updateBalance).toHaveBeenCalledTimes(1);
        expect(accountsService.updateBalance).toHaveBeenCalledWith(
          "account-2",
          -30,
          undefined,
        );
        expect(transactionsRepository.remove).toHaveBeenCalledTimes(2);
      });
    });
  });

  describe("createSplits atomicity", () => {
    it("commits own transaction when no external queryRunner provided", async () => {
      const splits = [
        { amount: -60, categoryId: "cat-1", memo: "Food" },
        { amount: -40, categoryId: "cat-2", memo: "Drinks" },
      ];

      await service.createSplits("tx-1", splits, "user-1", "account-1");

      expect(mockQueryRunner.connect).toHaveBeenCalled();
      expect(mockQueryRunner.startTransaction).toHaveBeenCalled();
      expect(mockQueryRunner.commitTransaction).toHaveBeenCalled();
      expect(mockQueryRunner.rollbackTransaction).not.toHaveBeenCalled();
      expect(mockQueryRunner.release).toHaveBeenCalled();
    });

    it("rolls back own transaction on error and releases queryRunner", async () => {
      splitsRepository.save.mockRejectedValue(new Error("Split save error"));

      const splits = [{ amount: -60, categoryId: "cat-1", memo: "Food" }];

      await expect(
        service.createSplits("tx-1", splits, "user-1", "account-1"),
      ).rejects.toThrow("Split save error");

      expect(mockQueryRunner.rollbackTransaction).toHaveBeenCalled();
      expect(mockQueryRunner.commitTransaction).not.toHaveBeenCalled();
      expect(mockQueryRunner.release).toHaveBeenCalled();
    });

    it("does not manage transaction lifecycle when external queryRunner provided", async () => {
      const externalQr = {
        connect: jest.fn(),
        startTransaction: jest.fn(),
        commitTransaction: jest.fn(),
        rollbackTransaction: jest.fn(),
        release: jest.fn(),
        manager: {
          create: jest
            .fn()
            .mockImplementation((_Entity: any, data: any) =>
              splitsRepository.create(data),
            ),
          save: jest.fn().mockImplementation((data: any) => {
            if (Array.isArray(data)) return splitsRepository.save(data);
            return splitsRepository.save(data);
          }),
          update: jest.fn().mockResolvedValue(undefined),
          find: jest.fn().mockImplementation((_Entity: any) => {
            if (_Entity === Category) {
              return Promise.resolve([{ id: "cat-1" }, { id: "cat-2" }]);
            }
            return Promise.resolve([]);
          }),
        },
      } as any;

      const splits = [
        { amount: -60, categoryId: "cat-1", memo: "Food" },
        { amount: -40, categoryId: "cat-2", memo: "Drinks" },
      ];

      await service.createSplits(
        "tx-1",
        splits,
        "user-1",
        "account-1",
        new Date("2026-01-15"),
        null,
        externalQr,
      );

      // Should NOT manage transaction lifecycle for external queryRunner
      expect(externalQr.connect).not.toHaveBeenCalled();
      expect(externalQr.startTransaction).not.toHaveBeenCalled();
      expect(externalQr.commitTransaction).not.toHaveBeenCalled();
      expect(externalQr.rollbackTransaction).not.toHaveBeenCalled();
      expect(externalQr.release).not.toHaveBeenCalled();
    });
  });

  describe("investment splits", () => {
    it("validates that the cash impact matches the split amount for BUY", () => {
      // 75 shares @ $10 = $750 cash out (negative)
      const splits = [
        { amount: 1000, categoryId: "cat-1" },
        { amount: -250, categoryId: "cat-2" },
        {
          amount: -750,
          investment: {
            action: "BUY" as any,
            securityId: "sec-1",
            quantity: 75,
            price: 10,
            commission: 0,
          },
        },
      ];
      expect(() => service.validateSplits(splits, 0)).not.toThrow();
    });

    it("rejects when investment split amount does not match computed cash impact", () => {
      const splits = [
        { amount: 1000, categoryId: "cat-1" },
        { amount: -250, categoryId: "cat-2" },
        {
          amount: -700, // Wrong: should be -750
          investment: {
            action: "BUY" as any,
            securityId: "sec-1",
            quantity: 75,
            price: 10,
            commission: 0,
          },
        },
      ];
      expect(() => service.validateSplits(splits, 50)).toThrow(
        BadRequestException,
      );
      expect(() => service.validateSplits(splits, 50)).toThrow(
        /does not match the cash impact/,
      );
    });

    it("rejects investment splits that combine with categoryId", () => {
      const splits = [
        { amount: -50, categoryId: "cat-1" },
        {
          amount: -50,
          categoryId: "cat-2",
          investment: {
            action: "BUY" as any,
            securityId: "sec-1",
            quantity: 5,
            price: 10,
          },
        },
      ];
      expect(() => service.validateSplits(splits, -100)).toThrow(
        BadRequestException,
      );
    });

    it("rejects disallowed actions inside a split", () => {
      const splits = [
        { amount: -100, categoryId: "cat-1" },
        {
          amount: 0,
          investment: {
            action: "ADD_SHARES" as any,
            securityId: "sec-1",
            quantity: 5,
          },
        },
      ];
      expect(() => service.validateSplits(splits, -100)).toThrow(
        BadRequestException,
      );
      expect(() => service.validateSplits(splits, -100)).toThrow(
        /not allowed inside a split transaction/,
      );
    });

    it("requires the parent account to be INVESTMENT_CASH", async () => {
      accountsService.findOne.mockResolvedValueOnce({
        id: "account-1",
        accountSubType: "CHECKING",
        linkedAccountId: null,
      });

      const splits = [
        { amount: 1000, categoryId: "cat-1" },
        { amount: -250, categoryId: "cat-2" },
        {
          amount: -750,
          investment: {
            action: "BUY" as any,
            securityId: "sec-1",
            quantity: 75,
            price: 10,
          },
        },
      ];

      await expect(
        service.createSplits(
          "tx-1",
          splits,
          "user-1",
          "account-1",
          new Date("2026-05-09"),
        ),
      ).rejects.toThrow(/INVESTMENT_CASH/);
    });

    it("creates investment split via embedded path on INVESTMENT_CASH parent", async () => {
      accountsService.findOne.mockResolvedValueOnce({
        id: "account-1",
        accountSubType: "INVESTMENT_CASH",
        linkedAccountId: "brokerage-1",
      });

      const splits = [
        { amount: 1000, categoryId: "cat-1" },
        { amount: -250, categoryId: "cat-2" },
        {
          amount: -750,
          investment: {
            action: "BUY" as any,
            securityId: "sec-1",
            quantity: 75,
            price: 10,
            commission: 0,
          },
        },
      ];

      const result = await service.createSplits(
        "tx-1",
        splits,
        "user-1",
        "account-1",
        new Date("2026-05-09"),
      );

      // Two regular splits + one investment split
      expect(result).toHaveLength(3);
      expect(mockQueryRunner.manager.create).toHaveBeenCalledWith(
        TransactionSplit,
        expect.objectContaining({
          kind: "investment",
          categoryId: null,
          transferAccountId: null,
          amount: -750,
        }),
      );
    });

    it("rejects investment split when payload is missing", () => {
      const splits = [
        { amount: -100, categoryId: "cat-1" },
        {
          amount: 0,
          splitKind: "investment" as any,
          // no `investment` payload provided
        },
      ];
      expect(() => service.validateSplits(splits, -100)).toThrow(
        BadRequestException,
      );
      expect(() => service.validateSplits(splits, -100)).toThrow(
        /requires an investment payload/,
      );
    });

    it("rejects investment split combined with transferAccountId", () => {
      const splits = [
        { amount: -50, categoryId: "cat-1" },
        {
          amount: -50,
          transferAccountId: "account-2",
          investment: {
            action: "BUY" as any,
            securityId: "sec-1",
            quantity: 5,
            price: 10,
          },
        },
      ];
      expect(() => service.validateSplits(splits, -100)).toThrow(
        BadRequestException,
      );
    });

    it("validates with exchangeRate when security currency differs", () => {
      // 75 shares @ $10 USD = $750 USD; with rate 1.35 -> $1012.50 in parent currency
      const splits = [
        { amount: 1350, categoryId: "cat-1" },
        { amount: -337.5, categoryId: "cat-2" },
        {
          amount: -1012.5,
          investment: {
            action: "BUY" as any,
            securityId: "sec-1",
            quantity: 75,
            price: 10,
            commission: 0,
            exchangeRate: 1.35,
          },
        },
      ];
      expect(() => service.validateSplits(splits, 0)).not.toThrow();
    });

    it("accepts a single investment split as a passthrough", () => {
      const splits = [
        {
          amount: -750,
          investment: {
            action: "BUY" as any,
            securityId: "sec-1",
            quantity: 75,
            price: 10,
            commission: 0,
          },
        },
      ];
      expect(() => service.validateSplits(splits, -750)).not.toThrow();
    });

    it("rejects investment splits when userId or sourceAccountId is missing", async () => {
      const splits = [
        { amount: 1000, categoryId: "cat-1" },
        { amount: -250, categoryId: "cat-2" },
        {
          amount: -750,
          investment: {
            action: "BUY" as any,
            securityId: "sec-1",
            quantity: 75,
            price: 10,
          },
        },
      ];

      await expect(
        service.createSplits("tx-1", splits, undefined, "account-1"),
      ).rejects.toThrow(/known source account/);
    });

    it("rejects when INVESTMENT_CASH parent has no linkedAccountId", async () => {
      accountsService.findOne.mockResolvedValueOnce({
        id: "account-1",
        accountSubType: "INVESTMENT_CASH",
        linkedAccountId: null,
      });

      const splits = [
        { amount: 1000, categoryId: "cat-1" },
        { amount: -250, categoryId: "cat-2" },
        {
          amount: -750,
          investment: {
            action: "BUY" as any,
            securityId: "sec-1",
            quantity: 75,
            price: 10,
          },
        },
      ];

      await expect(
        service.createSplits(
          "tx-1",
          splits,
          "user-1",
          "account-1",
          new Date("2026-05-09"),
        ),
      ).rejects.toThrow(/not linked to a brokerage account/);
    });

    it("rejects adding an investment split via addSplit", async () => {
      const transaction = { ...mockTransaction, isSplit: true } as Transaction;
      await expect(
        service.addSplit(
          transaction,
          {
            amount: -750,
            investment: {
              action: "BUY" as any,
              securityId: "sec-1",
              quantity: 75,
              price: 10,
            },
          } as any,
          "user-1",
        ),
      ).rejects.toThrow(/cannot be added incrementally/);
    });

    it("removeSplit reverses holdings via reverseAndRemoveEmbedded for an investment split", async () => {
      const investmentTx = { id: "inv-1", action: "BUY" };
      splitsRepository.findOne.mockResolvedValue({
        id: "split-3",
        transactionId: "tx-1",
        kind: "investment",
        investmentTransaction: investmentTx,
      });
      const remaining = [
        { id: "split-1", kind: "category", categoryId: "cat-1" },
        { id: "split-2", kind: "category", categoryId: "cat-2" },
      ];
      mockQueryRunner.manager.find = jest.fn().mockResolvedValue(remaining);

      const investmentService = (service as any).investmentTransactionsService;

      await service.removeSplit(
        { ...mockTransaction } as Transaction,
        "split-3",
        "user-1",
      );

      expect(investmentService.reverseAndRemoveEmbedded).toHaveBeenCalledWith(
        mockQueryRunner,
        "user-1",
        investmentTx,
      );
      expect(mockQueryRunner.commitTransaction).toHaveBeenCalled();
    });

    it("removeSplit keeps isSplit=true when the last remaining split is investment", async () => {
      splitsRepository.findOne.mockResolvedValue({
        id: "split-1",
        transactionId: "tx-1",
        kind: "category",
        categoryId: "cat-1",
      });
      // After removing the category split, an investment split remains alone
      mockQueryRunner.manager.find = jest.fn().mockResolvedValue([
        {
          id: "split-2",
          kind: "investment",
          investmentTransaction: { id: "inv-1" },
        },
      ]);

      await service.removeSplit(
        { ...mockTransaction } as Transaction,
        "split-1",
        "user-1",
      );

      // The collapse path should be skipped: no Transaction update to isSplit=false
      const updateCalls = (mockQueryRunner.manager.update as jest.Mock).mock
        .calls;
      const setIsSplitFalse = updateCalls.find(
        ([entity, _id, data]: any[]) =>
          entity === Transaction && data?.isSplit === false,
      );
      expect(setIsSplitFalse).toBeUndefined();
      expect(mockQueryRunner.commitTransaction).toHaveBeenCalled();
    });

    it("deleteSplitSideEffects reverses each investment split", async () => {
      const externalQr: any = {
        ...mockQueryRunner,
        manager: { ...mockQueryRunner.manager, getRepository: jest.fn() },
      };
      const splitsRepo = {
        find: jest.fn().mockResolvedValue([
          {
            id: "split-1",
            kind: "investment",
            investmentTransaction: { id: "inv-a" },
          },
          {
            id: "split-2",
            kind: "investment",
            investmentTransaction: { id: "inv-b" },
          },
          // Without an investmentTransaction relation - skipped
          {
            id: "split-3",
            kind: "investment",
            investmentTransaction: null,
          },
        ]),
      };
      const txRepo = { find: jest.fn().mockResolvedValue([]) };
      externalQr.manager.getRepository = jest.fn().mockImplementation((e) => {
        if (e === TransactionSplit) return splitsRepo;
        if (e === Transaction) return txRepo;
        return {};
      });

      const investmentService = (service as any).investmentTransactionsService;
      investmentService.reverseAndRemoveEmbedded.mockClear();

      await service.deleteSplitSideEffects("tx-1", "user-1", externalQr);

      expect(investmentService.reverseAndRemoveEmbedded).toHaveBeenCalledTimes(
        2,
      );
      expect(investmentService.reverseAndRemoveEmbedded).toHaveBeenCalledWith(
        externalQr,
        "user-1",
        { id: "inv-a" },
      );
      expect(investmentService.reverseAndRemoveEmbedded).toHaveBeenCalledWith(
        externalQr,
        "user-1",
        { id: "inv-b" },
      );
    });

    it("supports multiple investment splits in one createSplits call", async () => {
      accountsService.findOne.mockResolvedValueOnce({
        id: "account-1",
        accountSubType: "INVESTMENT_CASH",
        linkedAccountId: "brokerage-1",
      });

      const splits = [
        { amount: 5000, categoryId: "cat-1" },
        {
          amount: -3000,
          investment: {
            action: "BUY" as any,
            securityId: "sec-1",
            quantity: 30,
            price: 100,
            commission: 0,
          },
        },
        {
          amount: -2000,
          investment: {
            action: "BUY" as any,
            securityId: "sec-2",
            quantity: 20,
            price: 100,
            commission: 0,
          },
        },
      ];

      const result = await service.createSplits(
        "tx-1",
        splits,
        "user-1",
        "account-1",
        new Date("2026-05-09"),
      );
      expect(result).toHaveLength(3);

      const investmentService = (service as any).investmentTransactionsService;
      expect(investmentService.createEmbeddedForSplit).toHaveBeenCalledTimes(2);
    });
  });
});
