import { Test, TestingModule } from "@nestjs/testing";
import { getRepositoryToken } from "@nestjs/typeorm";
import { BadRequestException, NotFoundException } from "@nestjs/common";
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
      remove: jest.fn().mockResolvedValue(undefined),
    };

    splitsRepository = {
      create: jest
        .fn()
        .mockImplementation((data) => ({ ...data, id: "new-split" })),
      save: jest.fn().mockImplementation((data) => ({
        ...data,
        id: data.id || "new-split",
      })),
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

    it("throws when any split amount is zero", () => {
      const splits = [
        { amount: 0, categoryId: "cat-1" },
        { amount: -100, categoryId: "cat-2" },
      ];
      expect(() => service.validateSplits(splits, -100)).toThrow(
        BadRequestException,
      );
      expect(() => service.validateSplits(splits, -100)).toThrow(
        "Split amounts cannot be zero",
      );
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

      expect(splitsRepository.create).toHaveBeenCalledTimes(2);
      expect(splitsRepository.save).toHaveBeenCalledTimes(2);
      expect(result).toHaveLength(2);

      expect(splitsRepository.create).toHaveBeenCalledWith({
        transactionId: "tx-1",
        categoryId: "cat-1",
        transferAccountId: null,
        amount: -60,
        memo: "Food",
      });
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

      splitsRepository.save.mockResolvedValueOnce({
        id: "split-new",
        transactionId: "tx-1",
        transferAccountId: "account-2",
        amount: -100,
      });

      const result = await service.createSplits("tx-1", splits);

      expect(accountsService.findOne).not.toHaveBeenCalled();
      expect(transactionsRepository.create).not.toHaveBeenCalled();
      expect(result).toHaveLength(1);
    });

    it("sets null for optional fields when not provided", async () => {
      const splits = [{ amount: -60 }, { amount: -40 }];

      await service.createSplits("tx-1", splits);

      expect(splitsRepository.create).toHaveBeenCalledWith({
        transactionId: "tx-1",
        categoryId: null,
        transferAccountId: null,
        amount: -60,
        memo: null,
      });
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
      transactionsRepository.findOne.mockResolvedValue({
        id: "linked-tx-1",
        accountId: "account-2",
        amount: 50,
      });

      await service.deleteTransferSplitLinkedTransactions("tx-1");

      expect(splitsRepository.find).toHaveBeenCalledWith({
        where: { transactionId: "tx-1" },
        relations: ["linkedTransaction"],
      });
      expect(accountsService.updateBalance).toHaveBeenCalledWith(
        "account-2",
        -50,
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

      expect(transactionsRepository.findOne).not.toHaveBeenCalled();
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
      transactionsRepository.findOne.mockResolvedValue(null);

      await service.deleteTransferSplitLinkedTransactions("tx-1");

      expect(accountsService.updateBalance).not.toHaveBeenCalled();
      expect(transactionsRepository.remove).not.toHaveBeenCalled();
    });

    it("does nothing when no splits exist", async () => {
      splitsRepository.find.mockResolvedValue([]);

      await service.deleteTransferSplitLinkedTransactions("tx-1");

      expect(transactionsRepository.findOne).not.toHaveBeenCalled();
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
      transactionsRepository.findOne
        .mockResolvedValueOnce({
          id: "linked-tx-1",
          accountId: "account-2",
          amount: 30,
        })
        .mockResolvedValueOnce({
          id: "linked-tx-2",
          accountId: "account-3",
          amount: 70,
        });

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
        relations: ["category", "transferAccount"],
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

      splitsRepository.save
        .mockResolvedValueOnce({
          id: "new-split-1",
          ...newSplits[0],
          transactionId: "tx-1",
        })
        .mockResolvedValueOnce({
          id: "new-split-2",
          ...newSplits[1],
          transactionId: "tx-1",
        });

      // deleteTransferSplitLinkedTransactions mock
      splitsRepository.find.mockResolvedValue([]);

      const result = await service.updateSplits(
        transaction,
        newSplits,
        "user-1",
      );

      expect(splitsRepository.delete).toHaveBeenCalledWith({
        transactionId: "tx-1",
      });
      expect(splitsRepository.create).toHaveBeenCalledTimes(2);
      expect(transactionsRepository.update).toHaveBeenCalledWith("tx-1", {
        isSplit: true,
        categoryId: null,
      });
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
      transactionsRepository.findOne.mockResolvedValue({
        id: "old-linked-tx",
        accountId: "account-2",
        amount: 100,
      });

      const newSplits = [
        { amount: -60, categoryId: "cat-1" },
        { amount: -40, categoryId: "cat-2" },
      ];

      splitsRepository.save
        .mockResolvedValueOnce({
          id: "s1",
          ...newSplits[0],
          transactionId: "tx-1",
        })
        .mockResolvedValueOnce({
          id: "s2",
          ...newSplits[1],
          transactionId: "tx-1",
        });

      await service.updateSplits(transaction, newSplits, "user-1");

      expect(accountsService.updateBalance).toHaveBeenCalledWith(
        "account-2",
        -100,
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
      splitsRepository.find.mockResolvedValue([
        { ...mockSplit2 },
        {
          id: "split-3",
          transactionId: "tx-1",
          amount: -20,
          categoryId: "cat-3",
        },
      ]);

      await service.removeSplit(transaction, "split-1", "user-1");

      expect(splitsRepository.remove).toHaveBeenCalledWith(splitToRemove);
      expect(transactionsRepository.update).not.toHaveBeenCalled();
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
      transactionsRepository.findOne.mockResolvedValue({
        id: "linked-tx-1",
        accountId: "account-2",
        amount: 50,
      });
      // remaining splits after removal -- still 2+
      splitsRepository.find.mockResolvedValue([
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
      );
      expect(transactionsRepository.remove).toHaveBeenCalledWith(
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
      splitsRepository.find.mockResolvedValue([lastSplit]);

      await service.removeSplit(transaction, "split-1", "user-1");

      expect(transactionsRepository.update).toHaveBeenCalledWith("tx-1", {
        isSplit: false,
        categoryId: "cat-2",
      });
      expect(splitsRepository.remove).toHaveBeenCalledWith(lastSplit);
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
      splitsRepository.find.mockResolvedValue([lastSplit]);
      transactionsRepository.findOne.mockResolvedValue({
        id: "linked-tx-2",
        accountId: "account-3",
        amount: 40,
      });

      await service.removeSplit(transaction, "split-1", "user-1");

      expect(accountsService.updateBalance).toHaveBeenCalledWith(
        "account-3",
        -40,
      );
      expect(transactionsRepository.remove).toHaveBeenCalledWith(
        expect.objectContaining({ id: "linked-tx-2" }),
      );
      expect(transactionsRepository.update).toHaveBeenCalledWith("tx-1", {
        isSplit: false,
        categoryId: null,
      });
      expect(splitsRepository.remove).toHaveBeenCalledWith(lastSplit);
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
      transactionsRepository.findOne.mockResolvedValue(null);
      splitsRepository.find.mockResolvedValue([
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
      expect(splitsRepository.remove).toHaveBeenCalledWith(transferSplit);
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
        transactionsRepository.findOne.mockResolvedValue({
          id: "linked-tx-1",
          accountId: "account-2",
          amount: 50,
          transactionDate: "2027-06-15",
        });

        await service.deleteTransferSplitLinkedTransactions("tx-1");

        expect(transactionsRepository.findOne).toHaveBeenCalled();
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
        transactionsRepository.findOne
          .mockResolvedValueOnce({
            id: "linked-tx-1",
            accountId: "account-2",
            amount: 30,
            transactionDate: "2026-01-15",
          })
          .mockResolvedValueOnce({
            id: "linked-tx-2",
            accountId: "account-3",
            amount: 70,
            transactionDate: "2027-06-15",
          });

        await service.deleteTransferSplitLinkedTransactions("tx-1");

        expect(accountsService.updateBalance).toHaveBeenCalledTimes(1);
        expect(accountsService.updateBalance).toHaveBeenCalledWith(
          "account-2",
          -30,
        );
        expect(transactionsRepository.remove).toHaveBeenCalledTimes(2);
      });
    });
  });
});
