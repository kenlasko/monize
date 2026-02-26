import { Test, TestingModule } from "@nestjs/testing";
import { getRepositoryToken } from "@nestjs/typeorm";
import { BadRequestException } from "@nestjs/common";
import { TransactionBulkUpdateService } from "./transaction-bulk-update.service";
import { Transaction, TransactionStatus } from "./entities/transaction.entity";
import { Category } from "../categories/entities/category.entity";
import { AccountsService } from "../accounts/accounts.service";
import { NetWorthService } from "../net-worth/net-worth.service";
import { BulkUpdateDto } from "./dto/bulk-update.dto";

jest.mock("../common/date-utils");

describe("TransactionBulkUpdateService", () => {
  let service: TransactionBulkUpdateService;
  let transactionsRepository: Record<string, jest.Mock>;
  let categoriesRepository: Record<string, jest.Mock>;
  let accountsService: Record<string, jest.Mock>;
  let netWorthService: Record<string, jest.Mock>;

  const userId = "user-1";

  const makeTransaction = (
    overrides: Partial<Transaction> = {},
  ): Transaction => {
    return {
      id: "tx-1",
      userId,
      accountId: "account-1",
      amount: 100,
      status: TransactionStatus.UNRECONCILED,
      transactionDate: "2026-01-15",
      currencyCode: "CAD",
      exchangeRate: 1,
      description: null,
      referenceNumber: null,
      reconciledDate: null,
      payeeId: null,
      payee: null,
      payeeName: null,
      categoryId: null,
      category: null,
      isSplit: false,
      parentTransactionId: null,
      isTransfer: false,
      linkedTransactionId: null,
      linkedTransaction: null,
      splits: [],
      createdAt: new Date("2026-01-15"),
      updatedAt: new Date("2026-01-15"),
      ...overrides,
    } as Transaction;
  };

  const createMockQueryBuilder = (
    overrides: Record<string, jest.Mock> = {},
  ) => ({
    select: jest.fn().mockReturnThis(),
    addSelect: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    leftJoin: jest.fn().mockReturnThis(),
    groupBy: jest.fn().mockReturnThis(),
    setParameter: jest.fn().mockReturnThis(),
    update: jest.fn().mockReturnThis(),
    set: jest.fn().mockReturnThis(),
    getMany: jest.fn().mockResolvedValue([]),
    getRawMany: jest.fn().mockResolvedValue([]),
    execute: jest.fn().mockResolvedValue({ affected: 0 }),
    ...overrides,
  });

  beforeEach(async () => {
    transactionsRepository = {
      createQueryBuilder: jest.fn(),
    };

    categoriesRepository = {
      find: jest.fn().mockResolvedValue([]),
    };

    accountsService = {
      updateBalance: jest.fn().mockResolvedValue(undefined),
      recalculateCurrentBalance: jest.fn().mockResolvedValue(undefined),
    };

    netWorthService = {
      recalculateAccount: jest.fn().mockResolvedValue(undefined),
      triggerDebouncedRecalc: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TransactionBulkUpdateService,
        {
          provide: getRepositoryToken(Transaction),
          useValue: transactionsRepository,
        },
        {
          provide: getRepositoryToken(Category),
          useValue: categoriesRepository,
        },
        { provide: AccountsService, useValue: accountsService },
        { provide: NetWorthService, useValue: netWorthService },
      ],
    }).compile();

    service = module.get<TransactionBulkUpdateService>(
      TransactionBulkUpdateService,
    );
  });

  describe("bulkUpdate", () => {
    it("throws BadRequestException when no update fields are provided", async () => {
      const dto: BulkUpdateDto = {
        mode: "ids",
        transactionIds: ["tx-1"],
      };

      await expect(service.bulkUpdate(userId, dto)).rejects.toThrow(
        BadRequestException,
      );
    });

    it("returns zero updated when no transactions match (ids mode)", async () => {
      const resolveQb = createMockQueryBuilder({
        getMany: jest.fn().mockResolvedValue([]),
      });
      transactionsRepository.createQueryBuilder.mockReturnValue(resolveQb);

      const dto: BulkUpdateDto = {
        mode: "ids",
        transactionIds: ["nonexistent"],
        description: "test",
      };

      const result = await service.bulkUpdate(userId, dto);

      expect(result).toEqual({ updated: 0, skipped: 0, skippedReasons: [] });
    });

    it("updates transactions by explicit IDs", async () => {
      const tx1 = makeTransaction({ id: "tx-1" });
      const tx2 = makeTransaction({ id: "tx-2" });

      // First call: resolve IDs
      const resolveQb = createMockQueryBuilder({
        getMany: jest.fn().mockResolvedValue([{ id: "tx-1" }, { id: "tx-2" }]),
      });
      // Second call: exclusions
      const exclusionsQb = createMockQueryBuilder({
        getMany: jest.fn().mockResolvedValue([tx1, tx2]),
      });
      // Third call: batch update
      const updateQb = createMockQueryBuilder({
        execute: jest.fn().mockResolvedValue({ affected: 2 }),
      });

      transactionsRepository.createQueryBuilder
        .mockReturnValueOnce(resolveQb)
        .mockReturnValueOnce(exclusionsQb)
        .mockReturnValueOnce(updateQb);

      const dto: BulkUpdateDto = {
        mode: "ids",
        transactionIds: ["tx-1", "tx-2"],
        description: "Bulk updated",
      };

      const result = await service.bulkUpdate(userId, dto);

      expect(result.updated).toBe(2);
      expect(result.skipped).toBe(0);
      expect(updateQb.set).toHaveBeenCalledWith(
        expect.objectContaining({ description: "Bulk updated" }),
      );
    });

    it("includes reconciled transactions in bulk updates", async () => {
      const tx1 = makeTransaction({ id: "tx-1" });
      const tx2 = makeTransaction({
        id: "tx-2",
        status: TransactionStatus.RECONCILED,
      });

      const resolveQb = createMockQueryBuilder({
        getMany: jest.fn().mockResolvedValue([{ id: "tx-1" }, { id: "tx-2" }]),
      });
      const exclusionsQb = createMockQueryBuilder({
        getMany: jest.fn().mockResolvedValue([tx1, tx2]),
      });
      const updateQb = createMockQueryBuilder({
        execute: jest.fn().mockResolvedValue({ affected: 2 }),
      });

      transactionsRepository.createQueryBuilder
        .mockReturnValueOnce(resolveQb)
        .mockReturnValueOnce(exclusionsQb)
        .mockReturnValueOnce(updateQb);

      const dto: BulkUpdateDto = {
        mode: "ids",
        transactionIds: ["tx-1", "tx-2"],
        description: "test",
      };

      const result = await service.bulkUpdate(userId, dto);

      expect(result.updated).toBe(2);
      expect(result.skipped).toBe(0);
    });

    it("skips transfers when updating payee", async () => {
      const tx1 = makeTransaction({ id: "tx-1" });
      const tx2 = makeTransaction({ id: "tx-2", isTransfer: true });

      const resolveQb = createMockQueryBuilder({
        getMany: jest.fn().mockResolvedValue([{ id: "tx-1" }, { id: "tx-2" }]),
      });
      const exclusionsQb = createMockQueryBuilder({
        getMany: jest.fn().mockResolvedValue([tx1, tx2]),
      });
      const updateQb = createMockQueryBuilder({
        execute: jest.fn().mockResolvedValue({ affected: 1 }),
      });

      transactionsRepository.createQueryBuilder
        .mockReturnValueOnce(resolveQb)
        .mockReturnValueOnce(exclusionsQb)
        .mockReturnValueOnce(updateQb);

      const dto: BulkUpdateDto = {
        mode: "ids",
        transactionIds: ["tx-1", "tx-2"],
        payeeId: "payee-1",
        payeeName: "Store",
      };

      const result = await service.bulkUpdate(userId, dto);

      expect(result.updated).toBe(1);
      expect(result.skipped).toBe(1);
      expect(result.skippedReasons).toContain("1 transfer");
    });

    it("skips split transactions when updating category", async () => {
      const tx1 = makeTransaction({ id: "tx-1" });
      const tx2 = makeTransaction({ id: "tx-2", isSplit: true });

      const resolveQb = createMockQueryBuilder({
        getMany: jest.fn().mockResolvedValue([{ id: "tx-1" }, { id: "tx-2" }]),
      });
      const exclusionsQb = createMockQueryBuilder({
        getMany: jest.fn().mockResolvedValue([tx1, tx2]),
      });
      const updateQb = createMockQueryBuilder({
        execute: jest.fn().mockResolvedValue({ affected: 1 }),
      });

      transactionsRepository.createQueryBuilder
        .mockReturnValueOnce(resolveQb)
        .mockReturnValueOnce(exclusionsQb)
        .mockReturnValueOnce(updateQb);

      const dto: BulkUpdateDto = {
        mode: "ids",
        transactionIds: ["tx-1", "tx-2"],
        categoryId: "cat-1",
      };

      const result = await service.bulkUpdate(userId, dto);

      expect(result.updated).toBe(1);
      expect(result.skipped).toBe(1);
      expect(result.skippedReasons).toContain("1 split");
    });

    it("adjusts balances when changing status to VOID", async () => {
      const tx1 = makeTransaction({
        id: "tx-1",
        accountId: "acc-1",
        amount: 50,
      });
      const tx2 = makeTransaction({
        id: "tx-2",
        accountId: "acc-1",
        amount: -30,
      });

      const resolveQb = createMockQueryBuilder({
        getMany: jest.fn().mockResolvedValue([{ id: "tx-1" }, { id: "tx-2" }]),
      });
      const exclusionsQb = createMockQueryBuilder({
        getMany: jest.fn().mockResolvedValue([tx1, tx2]),
      });
      // Balance deltas query
      const balanceQb = createMockQueryBuilder({
        getRawMany: jest
          .fn()
          .mockResolvedValue([{ accountId: "acc-1", totalAmount: "20" }]),
      });
      const updateQb = createMockQueryBuilder({
        execute: jest.fn().mockResolvedValue({ affected: 2 }),
      });
      // Net worth recalc query
      const accountIdsQb = createMockQueryBuilder({
        getRawMany: jest.fn().mockResolvedValue([{ accountId: "acc-1" }]),
      });

      transactionsRepository.createQueryBuilder
        .mockReturnValueOnce(resolveQb)
        .mockReturnValueOnce(exclusionsQb)
        .mockReturnValueOnce(balanceQb)
        .mockReturnValueOnce(updateQb)
        .mockReturnValueOnce(accountIdsQb);

      const dto: BulkUpdateDto = {
        mode: "ids",
        transactionIds: ["tx-1", "tx-2"],
        status: TransactionStatus.VOID,
      };

      const result = await service.bulkUpdate(userId, dto);

      expect(result.updated).toBe(2);
      expect(accountsService.updateBalance).toHaveBeenCalledWith("acc-1", -20);
      expect(netWorthService.triggerDebouncedRecalc).toHaveBeenCalledWith(
        "acc-1",
        userId,
      );
    });

    it("adjusts balances when changing status from VOID to non-VOID", async () => {
      const tx1 = makeTransaction({
        id: "tx-1",
        accountId: "acc-1",
        amount: 100,
        status: TransactionStatus.VOID,
      });

      const resolveQb = createMockQueryBuilder({
        getMany: jest.fn().mockResolvedValue([{ id: "tx-1" }]),
      });
      const exclusionsQb = createMockQueryBuilder({
        getMany: jest.fn().mockResolvedValue([tx1]),
      });
      const balanceQb = createMockQueryBuilder({
        getRawMany: jest
          .fn()
          .mockResolvedValue([{ accountId: "acc-1", totalAmount: "100" }]),
      });
      const updateQb = createMockQueryBuilder({
        execute: jest.fn().mockResolvedValue({ affected: 1 }),
      });
      const accountIdsQb = createMockQueryBuilder({
        getRawMany: jest.fn().mockResolvedValue([{ accountId: "acc-1" }]),
      });

      transactionsRepository.createQueryBuilder
        .mockReturnValueOnce(resolveQb)
        .mockReturnValueOnce(exclusionsQb)
        .mockReturnValueOnce(balanceQb)
        .mockReturnValueOnce(updateQb)
        .mockReturnValueOnce(accountIdsQb);

      const dto: BulkUpdateDto = {
        mode: "ids",
        transactionIds: ["tx-1"],
        status: TransactionStatus.CLEARED,
      };

      const result = await service.bulkUpdate(userId, dto);

      expect(result.updated).toBe(1);
      expect(accountsService.updateBalance).toHaveBeenCalledWith("acc-1", 100);
    });

    it("only updates specified fields (partial update)", async () => {
      const tx = makeTransaction({ id: "tx-1" });

      const resolveQb = createMockQueryBuilder({
        getMany: jest.fn().mockResolvedValue([{ id: "tx-1" }]),
      });
      const exclusionsQb = createMockQueryBuilder({
        getMany: jest.fn().mockResolvedValue([tx]),
      });
      const updateQb = createMockQueryBuilder({
        execute: jest.fn().mockResolvedValue({ affected: 1 }),
      });

      transactionsRepository.createQueryBuilder
        .mockReturnValueOnce(resolveQb)
        .mockReturnValueOnce(exclusionsQb)
        .mockReturnValueOnce(updateQb);

      const dto: BulkUpdateDto = {
        mode: "ids",
        transactionIds: ["tx-1"],
        categoryId: "cat-1",
      };

      await service.bulkUpdate(userId, dto);

      const setArg = updateQb.set.mock.calls[0][0];
      expect(setArg).toEqual({ categoryId: "cat-1" });
      expect(setArg).not.toHaveProperty("description");
      expect(setArg).not.toHaveProperty("payeeId");
      expect(setArg).not.toHaveProperty("status");
    });

    it("clears fields when null is provided", async () => {
      const tx = makeTransaction({ id: "tx-1" });

      const resolveQb = createMockQueryBuilder({
        getMany: jest.fn().mockResolvedValue([{ id: "tx-1" }]),
      });
      const exclusionsQb = createMockQueryBuilder({
        getMany: jest.fn().mockResolvedValue([tx]),
      });
      const updateQb = createMockQueryBuilder({
        execute: jest.fn().mockResolvedValue({ affected: 1 }),
      });

      transactionsRepository.createQueryBuilder
        .mockReturnValueOnce(resolveQb)
        .mockReturnValueOnce(exclusionsQb)
        .mockReturnValueOnce(updateQb);

      const dto: BulkUpdateDto = {
        mode: "ids",
        transactionIds: ["tx-1"],
        categoryId: null,
        description: null,
      };

      await service.bulkUpdate(userId, dto);

      const setArg = updateQb.set.mock.calls[0][0];
      expect(setArg).toEqual({ categoryId: null, description: null });
    });

    it("applies filters in filter mode", async () => {
      const tx = makeTransaction({ id: "tx-1" });

      const resolveQb = createMockQueryBuilder({
        getMany: jest.fn().mockResolvedValue([{ id: "tx-1" }]),
      });
      const exclusionsQb = createMockQueryBuilder({
        getMany: jest.fn().mockResolvedValue([tx]),
      });
      const updateQb = createMockQueryBuilder({
        execute: jest.fn().mockResolvedValue({ affected: 1 }),
      });

      transactionsRepository.createQueryBuilder
        .mockReturnValueOnce(resolveQb)
        .mockReturnValueOnce(exclusionsQb)
        .mockReturnValueOnce(updateQb);

      const dto: BulkUpdateDto = {
        mode: "filter",
        filters: {
          accountIds: ["acc-1"],
          startDate: "2026-01-01",
          endDate: "2026-01-31",
        },
        description: "filtered update",
      };

      const result = await service.bulkUpdate(userId, dto);

      expect(result.updated).toBe(1);
      expect(resolveQb.andWhere).toHaveBeenCalled();
    });

    it("returns zero when all transactions are excluded", async () => {
      const tx = makeTransaction({
        id: "tx-1",
        isTransfer: true,
      });

      const resolveQb = createMockQueryBuilder({
        getMany: jest.fn().mockResolvedValue([{ id: "tx-1" }]),
      });
      const exclusionsQb = createMockQueryBuilder({
        getMany: jest.fn().mockResolvedValue([tx]),
      });

      transactionsRepository.createQueryBuilder
        .mockReturnValueOnce(resolveQb)
        .mockReturnValueOnce(exclusionsQb);

      const dto: BulkUpdateDto = {
        mode: "ids",
        transactionIds: ["tx-1"],
        payeeId: "some-payee-id",
      };

      const result = await service.bulkUpdate(userId, dto);

      expect(result.updated).toBe(0);
      expect(result.skipped).toBe(1);
    });

    it("excludes future-dated transactions from balance updates when changing status to VOID", async () => {
      const pastTx = makeTransaction({
        id: "tx-1",
        accountId: "acc-1",
        amount: 50,
        transactionDate: "2026-01-15",
      });
      const futureTx = makeTransaction({
        id: "tx-2",
        accountId: "acc-1",
        amount: 200,
        transactionDate: "2027-06-15",
      });

      const resolveQb = createMockQueryBuilder({
        getMany: jest.fn().mockResolvedValue([{ id: "tx-1" }, { id: "tx-2" }]),
      });
      const exclusionsQb = createMockQueryBuilder({
        getMany: jest.fn().mockResolvedValue([pastTx, futureTx]),
      });
      // Balance deltas query - only returns the past-dated transaction's amount
      // because the query filters with transactionDate <= today
      const balanceQb = createMockQueryBuilder({
        getRawMany: jest
          .fn()
          .mockResolvedValue([{ accountId: "acc-1", totalAmount: "50" }]),
      });
      const updateQb = createMockQueryBuilder({
        execute: jest.fn().mockResolvedValue({ affected: 2 }),
      });
      const accountIdsQb = createMockQueryBuilder({
        getRawMany: jest.fn().mockResolvedValue([{ accountId: "acc-1" }]),
      });

      transactionsRepository.createQueryBuilder
        .mockReturnValueOnce(resolveQb)
        .mockReturnValueOnce(exclusionsQb)
        .mockReturnValueOnce(balanceQb)
        .mockReturnValueOnce(updateQb)
        .mockReturnValueOnce(accountIdsQb);

      const dto: BulkUpdateDto = {
        mode: "ids",
        transactionIds: ["tx-1", "tx-2"],
        status: TransactionStatus.VOID,
      };

      const result = await service.bulkUpdate(userId, dto);

      expect(result.updated).toBe(2);
      // The balance query should include the today filter via andWhere
      expect(balanceQb.andWhere).toHaveBeenCalledWith(
        "transaction.transactionDate <= :today",
        expect.objectContaining({ today: expect.any(String) }),
      );
      // Only the past transaction's amount (50) should be used for balance update
      expect(accountsService.updateBalance).toHaveBeenCalledWith("acc-1", -50);
    });

    it("excludes future-dated transactions from balance updates when unvoiding", async () => {
      const pastTx = makeTransaction({
        id: "tx-1",
        accountId: "acc-1",
        amount: 100,
        status: TransactionStatus.VOID,
        transactionDate: "2026-01-15",
      });
      const futureTx = makeTransaction({
        id: "tx-2",
        accountId: "acc-1",
        amount: 300,
        status: TransactionStatus.VOID,
        transactionDate: "2027-06-15",
      });

      const resolveQb = createMockQueryBuilder({
        getMany: jest.fn().mockResolvedValue([{ id: "tx-1" }, { id: "tx-2" }]),
      });
      const exclusionsQb = createMockQueryBuilder({
        getMany: jest.fn().mockResolvedValue([pastTx, futureTx]),
      });
      // Balance deltas query - only the past transaction contributes
      const balanceQb = createMockQueryBuilder({
        getRawMany: jest
          .fn()
          .mockResolvedValue([{ accountId: "acc-1", totalAmount: "100" }]),
      });
      const updateQb = createMockQueryBuilder({
        execute: jest.fn().mockResolvedValue({ affected: 2 }),
      });
      const accountIdsQb = createMockQueryBuilder({
        getRawMany: jest.fn().mockResolvedValue([{ accountId: "acc-1" }]),
      });

      transactionsRepository.createQueryBuilder
        .mockReturnValueOnce(resolveQb)
        .mockReturnValueOnce(exclusionsQb)
        .mockReturnValueOnce(balanceQb)
        .mockReturnValueOnce(updateQb)
        .mockReturnValueOnce(accountIdsQb);

      const dto: BulkUpdateDto = {
        mode: "ids",
        transactionIds: ["tx-1", "tx-2"],
        status: TransactionStatus.CLEARED,
      };

      const result = await service.bulkUpdate(userId, dto);

      expect(result.updated).toBe(2);
      expect(balanceQb.andWhere).toHaveBeenCalledWith(
        "transaction.transactionDate <= :today",
        expect.objectContaining({ today: expect.any(String) }),
      );
      // Only the past transaction's amount (100) should be added back
      expect(accountsService.updateBalance).toHaveBeenCalledWith("acc-1", 100);
    });
  });
});
