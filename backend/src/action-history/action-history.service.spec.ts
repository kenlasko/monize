import { Test, TestingModule } from "@nestjs/testing";
import { getRepositoryToken } from "@nestjs/typeorm";
import { NotFoundException, ConflictException } from "@nestjs/common";
import { DataSource } from "typeorm";
import { ActionHistoryService } from "./action-history.service";
import { ActionHistory } from "./entities/action-history.entity";

describe("ActionHistoryService", () => {
  let service: ActionHistoryService;
  let mockRepository: Record<string, jest.Mock>;
  let mockQueryRunner: Record<string, any>;
  let mockDataSource: Record<string, any>;

  const userId = "user-1";
  const mockAction: Partial<ActionHistory> = {
    id: "action-1",
    userId,
    entityType: "tag",
    entityId: "entity-1",
    action: "create",
    beforeData: null,
    afterData: { id: "entity-1", name: "Test Tag" },
    relatedEntities: null,
    isUndone: false,
    description: 'Created tag "Test Tag"',
    createdAt: new Date(),
  };

  beforeEach(async () => {
    mockRepository = {
      create: jest.fn(),
      save: jest.fn(),
      find: jest.fn(),
      findOne: jest.fn(),
      delete: jest.fn(),
      count: jest.fn(),
      createQueryBuilder: jest.fn(),
    };

    mockQueryRunner = {
      connect: jest.fn(),
      startTransaction: jest.fn(),
      commitTransaction: jest.fn(),
      rollbackTransaction: jest.fn(),
      release: jest.fn(),
      query: jest.fn(),
      manager: {
        findOne: jest.fn(),
        update: jest.fn(),
        delete: jest.fn(),
        remove: jest.fn(),
        create: jest.fn(),
        save: jest.fn(),
      },
    };

    mockDataSource = {
      createQueryRunner: jest.fn().mockReturnValue(mockQueryRunner),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ActionHistoryService,
        {
          provide: getRepositoryToken(ActionHistory),
          useValue: mockRepository,
        },
        {
          provide: DataSource,
          useValue: mockDataSource,
        },
      ],
    }).compile();

    service = module.get<ActionHistoryService>(ActionHistoryService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe("record", () => {
    it("should record an action", async () => {
      mockRepository.delete.mockResolvedValue({ affected: 0 });
      mockRepository.create.mockReturnValue(mockAction);
      mockRepository.save.mockResolvedValue(mockAction);
      mockRepository.count.mockResolvedValue(1);

      const result = await service.record(userId, {
        entityType: "tag",
        entityId: "entity-1",
        action: "create",
        afterData: { id: "entity-1", name: "Test Tag" },
        description: 'Created tag "Test Tag"',
      });

      expect(result).toEqual(mockAction);
      expect(mockRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          userId,
          entityType: "tag",
          entityId: "entity-1",
          action: "create",
        }),
      );
      expect(mockRepository.save).toHaveBeenCalled();
    });

    it("should clear redo stack when recording new action", async () => {
      mockRepository.delete.mockResolvedValue({ affected: 2 });
      mockRepository.create.mockReturnValue(mockAction);
      mockRepository.save.mockResolvedValue(mockAction);
      mockRepository.count.mockResolvedValue(1);

      await service.record(userId, {
        entityType: "tag",
        entityId: "entity-1",
        action: "create",
        description: "test",
      });

      expect(mockRepository.delete).toHaveBeenCalledWith({
        userId,
        isUndone: true,
      });
    });

    it("should skip recording if JSONB payload exceeds size limit", async () => {
      const largeData = { data: "x".repeat(600 * 1024) };

      const result = await service.record(userId, {
        entityType: "tag",
        entityId: "entity-1",
        action: "create",
        afterData: largeData,
        description: "test",
      });

      expect(result).toBeNull();
      expect(mockRepository.save).not.toHaveBeenCalled();
    });

    it("should not throw if recording fails", async () => {
      mockRepository.delete.mockRejectedValue(new Error("DB error"));

      const result = await service.record(userId, {
        entityType: "tag",
        entityId: "entity-1",
        action: "create",
        description: "test",
      });

      expect(result).toBeNull();
    });
  });

  describe("getHistory", () => {
    it("should return history for user", async () => {
      const mockHistory = [mockAction];
      mockRepository.find.mockResolvedValue(mockHistory);

      const result = await service.getHistory(userId, 50);

      expect(result).toEqual(mockHistory);
      expect(mockRepository.find).toHaveBeenCalledWith({
        where: { userId },
        order: { createdAt: "DESC" },
        take: 50,
      });
    });
  });

  describe("undo", () => {
    it("should throw NotFoundException if nothing to undo", async () => {
      mockRepository.findOne.mockResolvedValue(null);

      await expect(service.undo(userId)).rejects.toThrow(NotFoundException);
    });

    it("should undo a simple entity create (tag)", async () => {
      const createAction = {
        ...mockAction,
        action: "create",
        entityType: "tag",
        entityId: "tag-1",
        afterData: { id: "tag-1", name: "Test Tag" },
      };
      mockRepository.findOne.mockResolvedValue(createAction);
      mockQueryRunner.manager.delete.mockResolvedValue({ affected: 1 });
      mockQueryRunner.manager.update.mockResolvedValue({ affected: 1 });

      const result = await service.undo(userId);

      expect(result.description).toContain("Undone");
      expect(mockQueryRunner.commitTransaction).toHaveBeenCalled();
      expect(mockQueryRunner.manager.delete).toHaveBeenCalled();
    });

    it("should undo a simple entity delete (tag)", async () => {
      const deleteAction = {
        ...mockAction,
        action: "delete",
        entityType: "tag",
        entityId: "tag-1",
        beforeData: { id: "tag-1", name: "Test Tag", userId },
        afterData: null,
      };
      mockRepository.findOne.mockResolvedValue(deleteAction);
      mockQueryRunner.query.mockResolvedValue([]);
      mockQueryRunner.manager.update.mockResolvedValue({ affected: 1 });

      const result = await service.undo(userId);

      expect(result.description).toContain("Undone");
      expect(mockQueryRunner.commitTransaction).toHaveBeenCalled();
      // Should have called query to re-insert
      expect(mockQueryRunner.query).toHaveBeenCalled();
    });

    it("should skip disallowed columns in beforeData during re-insert", async () => {
      const deleteAction = {
        ...mockAction,
        action: "delete",
        entityType: "tag",
        entityId: "tag-1",
        beforeData: {
          id: "tag-1",
          name: "Test Tag",
          userId,
          "'; DROP TABLE users; --": "evil",
        },
        afterData: null,
      };
      mockRepository.findOne.mockResolvedValue(deleteAction);
      mockQueryRunner.query.mockResolvedValue([]);
      mockQueryRunner.manager.update.mockResolvedValue({ affected: 1 });

      const result = await service.undo(userId);

      expect(result.description).toContain("Undone");
      expect(mockQueryRunner.commitTransaction).toHaveBeenCalled();
      // The INSERT query should not contain the malicious column
      const insertCall = mockQueryRunner.query.mock.calls.find(
        (call: any[]) =>
          typeof call[0] === "string" && call[0].includes("INSERT INTO"),
      );
      expect(insertCall).toBeDefined();
      expect(insertCall[0]).not.toContain("DROP TABLE");
    });

    it("should undo a simple entity create (custom_report)", async () => {
      const createAction = {
        ...mockAction,
        action: "create",
        entityType: "custom_report",
        entityId: "report-1",
        afterData: { id: "report-1", name: "Monthly Expenses" },
      };
      mockRepository.findOne.mockResolvedValue(createAction);
      mockQueryRunner.manager.delete.mockResolvedValue({ affected: 1 });
      mockQueryRunner.manager.update.mockResolvedValue({ affected: 1 });

      const result = await service.undo(userId);

      expect(result.description).toContain("Undone");
      expect(mockQueryRunner.commitTransaction).toHaveBeenCalled();
      expect(mockQueryRunner.manager.delete).toHaveBeenCalled();
    });

    it("should undo a simple entity delete (custom_report)", async () => {
      const deleteAction = {
        ...mockAction,
        action: "delete",
        entityType: "custom_report",
        entityId: "report-1",
        beforeData: {
          id: "report-1",
          name: "Monthly Expenses",
          userId,
          viewType: "BAR_CHART",
          timeframeType: "LAST_3_MONTHS",
          groupBy: "CATEGORY",
        },
        afterData: null,
      };
      mockRepository.findOne.mockResolvedValue(deleteAction);
      mockQueryRunner.query.mockResolvedValue([]);
      mockQueryRunner.manager.update.mockResolvedValue({ affected: 1 });

      const result = await service.undo(userId);

      expect(result.description).toContain("Undone");
      expect(mockQueryRunner.commitTransaction).toHaveBeenCalled();
      expect(mockQueryRunner.query).toHaveBeenCalledWith(
        expect.stringContaining("INSERT INTO \"custom_reports\""),
        expect.any(Array),
      );
    });

    it("should undo a simple entity update (custom_report)", async () => {
      const updateAction = {
        ...mockAction,
        action: "update",
        entityType: "custom_report",
        entityId: "report-1",
        beforeData: {
          id: "report-1",
          name: "Old Name",
          userId,
        },
        afterData: {
          id: "report-1",
          name: "New Name",
          userId,
        },
      };
      mockRepository.findOne.mockResolvedValue(updateAction);
      mockQueryRunner.manager.update.mockResolvedValue({ affected: 1 });

      const result = await service.undo(userId);

      expect(result.description).toContain("Undone");
      expect(mockQueryRunner.commitTransaction).toHaveBeenCalled();
      expect(mockQueryRunner.manager.update).toHaveBeenCalledWith(
        expect.any(Function),
        "report-1",
        expect.objectContaining({ name: "Old Name" }),
      );
    });

    it("should throw ConflictException for unsupported table in re-insert", async () => {
      const deleteAction = {
        ...mockAction,
        action: "delete",
        entityType: "unsupported_entity",
        entityId: "entity-1",
        beforeData: { id: "entity-1", name: "test" },
        afterData: null,
      };
      mockRepository.findOne.mockResolvedValue(deleteAction);

      await expect(service.undo(userId)).rejects.toThrow(ConflictException);
      expect(mockQueryRunner.rollbackTransaction).toHaveBeenCalled();
    });

    it("should rollback on error", async () => {
      const createAction = {
        ...mockAction,
        action: "create",
        entityType: "tag",
        entityId: "tag-1",
      };
      mockRepository.findOne.mockResolvedValue(createAction);
      mockQueryRunner.manager.delete.mockRejectedValue(
        new Error("DB error"),
      );

      await expect(service.undo(userId)).rejects.toThrow("DB error");
      expect(mockQueryRunner.rollbackTransaction).toHaveBeenCalled();
      expect(mockQueryRunner.release).toHaveBeenCalled();
    });
  });

  describe("redo", () => {
    it("should throw NotFoundException if nothing to redo", async () => {
      mockRepository.findOne.mockResolvedValue(null);

      await expect(service.redo(userId)).rejects.toThrow(NotFoundException);
    });

    it("should redo an undone action", async () => {
      const undoneAction = {
        ...mockAction,
        action: "delete",
        entityType: "tag",
        entityId: "tag-1",
        isUndone: true,
        beforeData: { id: "tag-1", name: "Test Tag", userId },
        afterData: null,
      };
      mockRepository.findOne.mockResolvedValue(undoneAction);
      mockQueryRunner.manager.delete.mockResolvedValue({ affected: 1 });
      mockQueryRunner.manager.update.mockResolvedValue({ affected: 1 });

      const result = await service.redo(userId);

      expect(result.description).toContain("Redone");
      expect(mockQueryRunner.commitTransaction).toHaveBeenCalled();
    });
  });

  describe("undo transaction create", () => {
    it("should delete the transaction and recalculate balance", async () => {
      const txAction = {
        ...mockAction,
        entityType: "transaction",
        action: "create",
        entityId: "tx-1",
        afterData: { id: "tx-1", accountId: "acc-1", amount: 100 },
      };
      mockRepository.findOne.mockResolvedValue(txAction);

      // Mock finding the transaction
      const mockTransaction = {
        id: "tx-1",
        userId,
        accountId: "acc-1",
        amount: 100,
        status: "UNRECONCILED",
        splits: [],
      };
      mockQueryRunner.manager.findOne.mockResolvedValue(mockTransaction);
      mockQueryRunner.manager.remove.mockResolvedValue(undefined);
      mockQueryRunner.manager.delete.mockResolvedValue({ affected: 0 });
      mockQueryRunner.manager.update.mockResolvedValue({ affected: 1 });
      mockQueryRunner.query.mockResolvedValue([
        { opening_balance: "0", tx_sum: "-100" },
      ]);

      const result = await service.undo(userId);

      expect(result.description).toContain("Undone");
      expect(mockQueryRunner.commitTransaction).toHaveBeenCalled();
    });

});

  describe("undo transaction delete", () => {
    it("should re-insert the transaction from snapshot", async () => {
      const deleteAction = {
        ...mockAction,
        entityType: "transaction",
        action: "delete",
        entityId: "tx-1",
        beforeData: {
          id: "tx-1",
          accountId: "acc-1",
          transactionDate: "2024-01-15",
          amount: -45.5,
          currencyCode: "USD",
          payeeName: "Grocery",
          status: "UNRECONCILED",
          isSplit: false,
          isTransfer: false,
          splits: [],
          tagIds: ["tag-1"],
        },
        afterData: null,
      };
      mockRepository.findOne.mockResolvedValue(deleteAction);

      // Mock account exists
      mockQueryRunner.manager.findOne.mockResolvedValue({
        id: "acc-1",
        userId,
      });
      mockQueryRunner.query.mockResolvedValue([
        { opening_balance: "0", tx_sum: "0" },
      ]);
      mockQueryRunner.manager.update.mockResolvedValue({ affected: 1 });

      const result = await service.undo(userId);

      expect(result.description).toContain("Undone");
      expect(mockQueryRunner.commitTransaction).toHaveBeenCalled();
      // Verify transaction was re-inserted via raw query
      expect(mockQueryRunner.query).toHaveBeenCalledWith(
        expect.stringContaining("INSERT INTO transactions"),
        expect.arrayContaining(["tx-1"]),
      );
      // Verify tags were re-inserted
      expect(mockQueryRunner.query).toHaveBeenCalledWith(
        expect.stringContaining("INSERT INTO transaction_tags"),
        ["tx-1", "tag-1"],
      );
    });
  });

  describe("undo transaction update", () => {
    it("should restore transaction fields from beforeData", async () => {
      const updateAction = {
        ...mockAction,
        entityType: "transaction",
        action: "update",
        entityId: "tx-1",
        beforeData: {
          accountId: "acc-1",
          amount: 50,
          transactionDate: "2024-01-10",
          payeeName: "Old Payee",
          status: "UNRECONCILED",
        },
        afterData: {
          accountId: "acc-1",
          amount: 100,
          transactionDate: "2024-01-15",
          payeeName: "New Payee",
        },
      };
      mockRepository.findOne.mockResolvedValue(updateAction);
      mockQueryRunner.manager.findOne.mockResolvedValue({
        id: "tx-1",
        userId,
        accountId: "acc-1",
      });
      mockQueryRunner.manager.update.mockResolvedValue({ affected: 1 });
      mockQueryRunner.query.mockResolvedValue([
        { opening_balance: "0", tx_sum: "50" },
      ]);

      const result = await service.undo(userId);

      expect(result.description).toContain("Undone");
      expect(mockQueryRunner.manager.update).toHaveBeenCalledWith(
        expect.any(Function),
        "tx-1",
        expect.objectContaining({ amount: 50, payeeName: "Old Payee" }),
      );
      expect(mockQueryRunner.commitTransaction).toHaveBeenCalled();
    });

    it("should restore splits when beforeData contains splits", async () => {
      const updateAction = {
        ...mockAction,
        entityType: "transaction",
        action: "update",
        entityId: "tx-1",
        beforeData: {
          accountId: "acc-1",
          splits: [
            { id: "s1", categoryId: "cat-1", amount: 25, memo: "Split 1" },
            { id: "s2", categoryId: "cat-2", amount: 75, memo: null },
          ],
        },
      };
      mockRepository.findOne.mockResolvedValue(updateAction);
      mockQueryRunner.manager.findOne.mockResolvedValue({
        id: "tx-1",
        userId,
        accountId: "acc-1",
      });
      mockQueryRunner.manager.delete.mockResolvedValue({ affected: 1 });
      mockQueryRunner.manager.create.mockImplementation((_, data) => data);
      mockQueryRunner.manager.save.mockResolvedValue({});
      mockQueryRunner.manager.update.mockResolvedValue({ affected: 1 });
      mockQueryRunner.query.mockResolvedValue([
        { opening_balance: "0", tx_sum: "100" },
      ]);

      const result = await service.undo(userId);

      expect(result.description).toContain("Undone");
      // Should delete existing splits first
      expect(mockQueryRunner.manager.delete).toHaveBeenCalled();
      // Should re-create two splits
      expect(mockQueryRunner.manager.save).toHaveBeenCalledTimes(2);
    });

    it("should restore tags when beforeData contains tagIds", async () => {
      const updateAction = {
        ...mockAction,
        entityType: "transaction",
        action: "update",
        entityId: "tx-1",
        beforeData: {
          accountId: "acc-1",
          tagIds: ["tag-1", "tag-2"],
        },
      };
      mockRepository.findOne.mockResolvedValue(updateAction);
      mockQueryRunner.manager.findOne.mockResolvedValue({
        id: "tx-1",
        userId,
        accountId: "acc-1",
      });
      mockQueryRunner.manager.update.mockResolvedValue({ affected: 1 });
      mockQueryRunner.query.mockResolvedValue([
        { opening_balance: "0", tx_sum: "0" },
      ]);

      await service.undo(userId);

      // Should delete existing tags
      expect(mockQueryRunner.query).toHaveBeenCalledWith(
        expect.stringContaining("DELETE FROM transaction_tags"),
        ["tx-1"],
      );
      // Should re-insert both tags
      expect(mockQueryRunner.query).toHaveBeenCalledWith(
        expect.stringContaining("INSERT INTO transaction_tags"),
        ["tx-1", "tag-1"],
      );
      expect(mockQueryRunner.query).toHaveBeenCalledWith(
        expect.stringContaining("INSERT INTO transaction_tags"),
        ["tx-1", "tag-2"],
      );
    });

    it("should throw ConflictException if transaction no longer exists", async () => {
      const updateAction = {
        ...mockAction,
        entityType: "transaction",
        action: "update",
        entityId: "tx-1",
        beforeData: { accountId: "acc-1", amount: 50 },
      };
      mockRepository.findOne.mockResolvedValue(updateAction);
      mockQueryRunner.manager.findOne.mockResolvedValue(null);

      await expect(service.undo(userId)).rejects.toThrow(ConflictException);
      expect(mockQueryRunner.rollbackTransaction).toHaveBeenCalled();
    });

    it("should return early if entityId is null", async () => {
      const updateAction = {
        ...mockAction,
        entityType: "transaction",
        action: "update",
        entityId: null,
        beforeData: { accountId: "acc-1" },
      };
      mockRepository.findOne.mockResolvedValue(updateAction);
      mockQueryRunner.manager.update.mockResolvedValue({ affected: 1 });

      const result = await service.undo(userId);

      expect(result.description).toContain("Undone");
      // Should not try to find or update transaction
      expect(mockQueryRunner.manager.findOne).not.toHaveBeenCalled();
    });

    it("should recalculate balance for both old and new accounts when account changed", async () => {
      const updateAction = {
        ...mockAction,
        entityType: "transaction",
        action: "update",
        entityId: "tx-1",
        beforeData: {
          accountId: "acc-old",
          amount: 50,
        },
      };
      mockRepository.findOne.mockResolvedValue(updateAction);
      mockQueryRunner.manager.findOne.mockResolvedValue({
        id: "tx-1",
        userId,
        accountId: "acc-new",
      });
      mockQueryRunner.manager.update.mockResolvedValue({ affected: 1 });
      mockQueryRunner.query.mockResolvedValue([
        { opening_balance: "0", tx_sum: "0" },
      ]);

      await service.undo(userId);

      // Should recalculate balance for both accounts
      const balanceQueries = mockQueryRunner.query.mock.calls.filter(
        (call: any[]) =>
          typeof call[0] === "string" && call[0].includes("UPDATE accounts SET current_balance"),
      );
      expect(balanceQueries.length).toBe(2);
    });

    it("should handle empty splits array in beforeData", async () => {
      const updateAction = {
        ...mockAction,
        entityType: "transaction",
        action: "update",
        entityId: "tx-1",
        beforeData: {
          accountId: "acc-1",
          splits: [],
        },
      };
      mockRepository.findOne.mockResolvedValue(updateAction);
      mockQueryRunner.manager.findOne.mockResolvedValue({
        id: "tx-1",
        userId,
        accountId: "acc-1",
      });
      mockQueryRunner.manager.delete.mockResolvedValue({ affected: 0 });
      mockQueryRunner.manager.update.mockResolvedValue({ affected: 1 });
      mockQueryRunner.query.mockResolvedValue([
        { opening_balance: "0", tx_sum: "0" },
      ]);

      const result = await service.undo(userId);

      expect(result.description).toContain("Undone");
      // Should delete existing splits but not create new ones
      expect(mockQueryRunner.manager.delete).toHaveBeenCalled();
      expect(mockQueryRunner.manager.save).not.toHaveBeenCalled();
    });
  });

  describe("undo transaction delete (account missing)", () => {
    it("should throw ConflictException if account no longer exists", async () => {
      const deleteAction = {
        ...mockAction,
        entityType: "transaction",
        action: "delete",
        entityId: "tx-1",
        beforeData: {
          id: "tx-1",
          accountId: "acc-1",
          transactionDate: "2024-01-15",
          amount: -45.5,
          currencyCode: "USD",
        },
        afterData: null,
      };
      mockRepository.findOne.mockResolvedValue(deleteAction);
      mockQueryRunner.manager.findOne.mockResolvedValue(null);

      await expect(service.undo(userId)).rejects.toThrow(ConflictException);
    });

    it("should re-insert transaction with splits", async () => {
      const deleteAction = {
        ...mockAction,
        entityType: "transaction",
        action: "delete",
        entityId: "tx-1",
        beforeData: {
          id: "tx-1",
          accountId: "acc-1",
          transactionDate: "2024-01-15",
          amount: -100,
          currencyCode: "USD",
          isSplit: true,
          splits: [
            { id: "s1", categoryId: "cat-1", amount: -60, memo: "Part 1" },
            { id: "s2", categoryId: "cat-2", amount: -40, memo: "Part 2" },
          ],
          tagIds: [],
        },
        afterData: null,
      };
      mockRepository.findOne.mockResolvedValue(deleteAction);
      mockQueryRunner.manager.findOne.mockResolvedValue({
        id: "acc-1",
        userId,
      });
      mockQueryRunner.query.mockResolvedValue([
        { opening_balance: "0", tx_sum: "-100" },
      ]);
      mockQueryRunner.manager.update.mockResolvedValue({ affected: 1 });

      const result = await service.undo(userId);

      expect(result.description).toContain("Undone");
      // Should insert transaction + 2 splits
      const insertCalls = mockQueryRunner.query.mock.calls.filter(
        (call: any[]) =>
          typeof call[0] === "string" && call[0].includes("INSERT INTO transaction_splits"),
      );
      expect(insertCalls.length).toBe(2);
    });

    it("should return early if beforeData is null", async () => {
      const deleteAction = {
        ...mockAction,
        entityType: "transaction",
        action: "delete",
        entityId: "tx-1",
        beforeData: null,
        afterData: null,
      };
      mockRepository.findOne.mockResolvedValue(deleteAction);
      mockQueryRunner.manager.update.mockResolvedValue({ affected: 1 });

      const result = await service.undo(userId);

      expect(result.description).toContain("Undone");
      expect(mockQueryRunner.manager.findOne).not.toHaveBeenCalled();
    });
  });

  describe("undo transfer", () => {
    it("should undo transfer create by deleting both transactions", async () => {
      const transferAction = {
        ...mockAction,
        entityType: "transfer",
        action: "create",
        entityId: "tx-from",
        afterData: {
          fromTransactionId: "tx-from",
          toTransactionId: "tx-to",
          fromAccountId: "acc-1",
          toAccountId: "acc-2",
        },
      };
      mockRepository.findOne.mockResolvedValue(transferAction);
      mockQueryRunner.manager.findOne.mockResolvedValue({
        id: "tx-from",
        userId,
        accountId: "acc-1",
      });
      mockQueryRunner.manager.update.mockResolvedValue({ affected: 1 });
      mockQueryRunner.manager.delete.mockResolvedValue({ affected: 1 });
      mockQueryRunner.query.mockResolvedValue([
        { opening_balance: "0", tx_sum: "0" },
      ]);

      const result = await service.undo(userId);

      expect(result.description).toContain("Undone");
      expect(mockQueryRunner.commitTransaction).toHaveBeenCalled();
    });

    it("should undo transfer delete by re-inserting both transactions", async () => {
      const transferAction = {
        ...mockAction,
        entityType: "transfer",
        action: "delete",
        entityId: "tx-from",
        beforeData: {
          fromTransaction: {
            id: "tx-from",
            accountId: "acc-1",
            transactionDate: "2024-01-15",
            amount: -100,
            currencyCode: "USD",
            isTransfer: true,
          },
          toTransaction: {
            id: "tx-to",
            accountId: "acc-2",
            transactionDate: "2024-01-15",
            amount: 100,
            currencyCode: "USD",
            isTransfer: true,
          },
        },
        afterData: null,
      };
      mockRepository.findOne.mockResolvedValue(transferAction);
      mockQueryRunner.manager.update.mockResolvedValue({ affected: 1 });
      mockQueryRunner.query.mockResolvedValue([
        { opening_balance: "0", tx_sum: "0" },
      ]);

      const result = await service.undo(userId);

      expect(result.description).toContain("Undone");
      // Should insert two transactions
      const insertCalls = mockQueryRunner.query.mock.calls.filter(
        (call: any[]) =>
          typeof call[0] === "string" && call[0].includes("INSERT INTO transactions"),
      );
      expect(insertCalls.length).toBe(2);
      // Should re-link them
      expect(mockQueryRunner.manager.update).toHaveBeenCalledWith(
        expect.any(Function),
        "tx-from",
        { linkedTransactionId: "tx-to" },
      );
    });

    it("should throw ConflictException for unsupported transfer action", async () => {
      const transferAction = {
        ...mockAction,
        entityType: "transfer",
        action: "update",
        entityId: "tx-from",
        beforeData: {},
      };
      mockRepository.findOne.mockResolvedValue(transferAction);

      await expect(service.undo(userId)).rejects.toThrow(ConflictException);
    });

    it("should return early if afterData is null for transfer create", async () => {
      const transferAction = {
        ...mockAction,
        entityType: "transfer",
        action: "create",
        entityId: "tx-from",
        afterData: null,
      };
      mockRepository.findOne.mockResolvedValue(transferAction);
      mockQueryRunner.manager.update.mockResolvedValue({ affected: 1 });

      const result = await service.undo(userId);

      expect(result.description).toContain("Undone");
      expect(mockQueryRunner.manager.findOne).not.toHaveBeenCalled();
    });

    it("should return early if beforeData is null for transfer delete", async () => {
      const transferAction = {
        ...mockAction,
        entityType: "transfer",
        action: "delete",
        entityId: "tx-from",
        beforeData: null,
        afterData: null,
      };
      mockRepository.findOne.mockResolvedValue(transferAction);
      mockQueryRunner.manager.update.mockResolvedValue({ affected: 1 });

      const result = await service.undo(userId);

      expect(result.description).toContain("Undone");
    });

    it("should return early if fromTransaction or toTransaction is missing", async () => {
      const transferAction = {
        ...mockAction,
        entityType: "transfer",
        action: "delete",
        entityId: "tx-from",
        beforeData: { fromTransaction: null, toTransaction: null },
        afterData: null,
      };
      mockRepository.findOne.mockResolvedValue(transferAction);
      mockQueryRunner.manager.update.mockResolvedValue({ affected: 1 });

      const result = await service.undo(userId);

      expect(result.description).toContain("Undone");
    });
  });

  describe("undo investment transaction", () => {
    it("should undo investment create by removing investment tx and cash tx", async () => {
      const invAction = {
        ...mockAction,
        entityType: "investment_transaction",
        action: "create",
        entityId: "inv-1",
        afterData: { id: "inv-1" },
      };
      mockRepository.findOne.mockResolvedValue(invAction);

      const mockInvTx = {
        id: "inv-1",
        userId,
        accountId: "acc-1",
        transactionId: "cash-tx-1",
      };
      const mockCashTx = {
        id: "cash-tx-1",
        accountId: "acc-2",
      };
      mockQueryRunner.manager.findOne
        .mockResolvedValueOnce(mockInvTx) // InvestmentTransaction
        .mockResolvedValueOnce(mockCashTx); // Cash Transaction
      mockQueryRunner.manager.remove.mockResolvedValue(undefined);
      mockQueryRunner.manager.update.mockResolvedValue({ affected: 1 });
      mockQueryRunner.query.mockResolvedValue([
        { opening_balance: "0", tx_sum: "0" },
      ]);

      const result = await service.undo(userId);

      expect(result.description).toContain("Undone");
      expect(mockQueryRunner.manager.remove).toHaveBeenCalledTimes(2);
    });

    it("should undo investment create without cash transaction", async () => {
      const invAction = {
        ...mockAction,
        entityType: "investment_transaction",
        action: "create",
        entityId: "inv-1",
        afterData: { id: "inv-1" },
      };
      mockRepository.findOne.mockResolvedValue(invAction);

      const mockInvTx = {
        id: "inv-1",
        userId,
        accountId: "acc-1",
        transactionId: null,
      };
      mockQueryRunner.manager.findOne.mockResolvedValueOnce(mockInvTx);
      mockQueryRunner.manager.remove.mockResolvedValue(undefined);
      mockQueryRunner.manager.update.mockResolvedValue({ affected: 1 });
      mockQueryRunner.query.mockResolvedValue([]);

      const result = await service.undo(userId);

      expect(result.description).toContain("Undone");
      // Should only remove inv tx, not cash tx
      expect(mockQueryRunner.manager.remove).toHaveBeenCalledTimes(1);
    });

    it("should undo investment delete by re-inserting with linked cash tx", async () => {
      const invAction = {
        ...mockAction,
        entityType: "investment_transaction",
        action: "delete",
        entityId: "inv-1",
        beforeData: {
          id: "inv-1",
          accountId: "acc-1",
          securityId: "sec-1",
          action: "BUY",
          transactionDate: "2024-01-15",
          quantity: 10,
          price: 100,
          commission: 5,
          totalAmount: 1005,
          linkedCashTransaction: {
            id: "cash-1",
            accountId: "acc-2",
            transactionDate: "2024-01-15",
            amount: -1005,
            currencyCode: "USD",
          },
        },
        afterData: null,
      };
      mockRepository.findOne.mockResolvedValue(invAction);
      mockQueryRunner.manager.update.mockResolvedValue({ affected: 1 });
      mockQueryRunner.query.mockResolvedValue([
        { opening_balance: "0", tx_sum: "0" },
      ]);

      const result = await service.undo(userId);

      expect(result.description).toContain("Undone");
      // Should insert investment transaction and cash transaction
      const insertCalls = mockQueryRunner.query.mock.calls.filter(
        (call: any[]) =>
          typeof call[0] === "string" && call[0].includes("INSERT INTO"),
      );
      expect(insertCalls.length).toBeGreaterThanOrEqual(2);
    });

    it("should undo investment delete without linked cash transaction", async () => {
      const invAction = {
        ...mockAction,
        entityType: "investment_transaction",
        action: "delete",
        entityId: "inv-1",
        beforeData: {
          id: "inv-1",
          accountId: "acc-1",
          securityId: "sec-1",
          action: "BUY",
          transactionDate: "2024-01-15",
          quantity: 10,
          price: 100,
        },
        afterData: null,
      };
      mockRepository.findOne.mockResolvedValue(invAction);
      mockQueryRunner.manager.update.mockResolvedValue({ affected: 1 });
      mockQueryRunner.query.mockResolvedValue([]);

      const result = await service.undo(userId);

      expect(result.description).toContain("Undone");
    });

    it("should throw ConflictException for unsupported investment action", async () => {
      const invAction = {
        ...mockAction,
        entityType: "investment_transaction",
        action: "update",
        entityId: "inv-1",
        beforeData: {},
      };
      mockRepository.findOne.mockResolvedValue(invAction);

      await expect(service.undo(userId)).rejects.toThrow(ConflictException);
    });

    it("should return early if entityId is null for investment create", async () => {
      const invAction = {
        ...mockAction,
        entityType: "investment_transaction",
        action: "create",
        entityId: null,
      };
      mockRepository.findOne.mockResolvedValue(invAction);
      mockQueryRunner.manager.update.mockResolvedValue({ affected: 1 });

      const result = await service.undo(userId);

      expect(result.description).toContain("Undone");
      expect(mockQueryRunner.manager.findOne).not.toHaveBeenCalled();
    });

    it("should undo investment delete with null transactionId when linkedCashTransaction is missing", async () => {
      // Older action history records may not have linkedCashTransaction captured.
      // The investment transaction should still be re-inserted with transaction_id = NULL
      // to avoid a FK violation on a deleted cash transaction.
      const invAction = {
        ...mockAction,
        entityType: "investment_transaction",
        action: "delete",
        entityId: "inv-1",
        beforeData: {
          id: "inv-1",
          accountId: "acc-1",
          securityId: "sec-1",
          transactionId: "deleted-cash-tx-1",
          action: "BUY",
          transactionDate: "2024-01-15",
          quantity: 10,
          price: 100,
          commission: 5,
          totalAmount: 1005,
        },
        afterData: null,
      };
      mockRepository.findOne.mockResolvedValue(invAction);
      mockQueryRunner.manager.update.mockResolvedValue({ affected: 1 });
      mockQueryRunner.query.mockResolvedValue([]);

      const result = await service.undo(userId);

      expect(result.description).toContain("Undone");
      // Should insert the investment transaction
      const insertCalls = mockQueryRunner.query.mock.calls.filter(
        (call: any[]) =>
          typeof call[0] === "string" &&
          call[0].includes("INSERT INTO investment_transactions"),
      );
      expect(insertCalls.length).toBe(1);
      // transaction_id parameter (index 3) should be null, not the stale FK
      expect(insertCalls[0][1][3]).toBeNull();
      // Should NOT insert a cash transaction
      const cashInsertCalls = mockQueryRunner.query.mock.calls.filter(
        (call: any[]) =>
          typeof call[0] === "string" &&
          call[0].includes("INSERT INTO transactions"),
      );
      expect(cashInsertCalls.length).toBe(0);
    });

    it("should insert cash transaction before investment transaction when undoing delete", async () => {
      const invAction = {
        ...mockAction,
        entityType: "investment_transaction",
        action: "delete",
        entityId: "inv-1",
        beforeData: {
          id: "inv-1",
          accountId: "acc-1",
          securityId: "sec-1",
          transactionId: "cash-1",
          action: "BUY",
          transactionDate: "2024-01-15",
          quantity: 10,
          price: 100,
          commission: 5,
          totalAmount: 1005,
          linkedCashTransaction: {
            id: "cash-1",
            accountId: "acc-2",
            transactionDate: "2024-01-15",
            amount: -1005,
            currencyCode: "USD",
          },
        },
        afterData: null,
      };
      mockRepository.findOne.mockResolvedValue(invAction);
      mockQueryRunner.manager.update.mockResolvedValue({ affected: 1 });
      mockQueryRunner.query.mockResolvedValue([
        { opening_balance: "0", tx_sum: "0" },
      ]);

      await service.undo(userId);

      // Verify ordering: cash transaction INSERT comes before investment transaction INSERT
      const insertCalls = mockQueryRunner.query.mock.calls
        .map((call: any[], idx: number) => ({ sql: call[0], idx }))
        .filter(
          (c: any) =>
            typeof c.sql === "string" && c.sql.includes("INSERT INTO"),
        );
      const cashInsertIdx = insertCalls.find((c: any) =>
        c.sql.includes("INSERT INTO transactions"),
      )?.idx;
      const invInsertIdx = insertCalls.find((c: any) =>
        c.sql.includes("INSERT INTO investment_transactions"),
      )?.idx;
      expect(cashInsertIdx).toBeDefined();
      expect(invInsertIdx).toBeDefined();
      expect(cashInsertIdx).toBeLessThan(invInsertIdx);
      // transaction_id should reference the restored cash tx
      const invInsertCall = mockQueryRunner.query.mock.calls.find(
        (call: any[]) =>
          typeof call[0] === "string" &&
          call[0].includes("INSERT INTO investment_transactions"),
      );
      expect(invInsertCall[1][3]).toBe("cash-1");
    });

    it("should use correct table name 'holdings' in rebuildHoldings", async () => {
      const invAction = {
        ...mockAction,
        entityType: "investment_transaction",
        action: "create",
        entityId: "inv-1",
        afterData: { id: "inv-1" },
      };
      mockRepository.findOne.mockResolvedValue(invAction);

      const mockInvTx = {
        id: "inv-1",
        userId,
        accountId: "acc-1",
        transactionId: null,
      };
      mockQueryRunner.manager.findOne.mockResolvedValueOnce(mockInvTx);
      mockQueryRunner.manager.remove.mockResolvedValue(undefined);
      mockQueryRunner.manager.update.mockResolvedValue({ affected: 1 });
      // rebuildHoldings: DELETE returns void, SELECT returns investment transactions
      mockQueryRunner.query
        .mockResolvedValueOnce(undefined) // DELETE FROM holdings
        .mockResolvedValueOnce([
          {
            security_id: "sec-1",
            action: "BUY",
            quantity: "10",
            price: "100",
          },
        ]) // SELECT investment_transactions
        .mockResolvedValueOnce(undefined); // INSERT INTO holdings

      await service.undo(userId);

      const deleteCalls = mockQueryRunner.query.mock.calls.filter(
        (call: any[]) =>
          typeof call[0] === "string" && call[0].includes("DELETE FROM holdings"),
      );
      expect(deleteCalls.length).toBe(1);
      const insertCalls = mockQueryRunner.query.mock.calls.filter(
        (call: any[]) =>
          typeof call[0] === "string" && call[0].includes("INSERT INTO holdings"),
      );
      expect(insertCalls.length).toBe(1);
      // Verify no references to the wrong table name
      const wrongTableCalls = mockQueryRunner.query.mock.calls.filter(
        (call: any[]) =>
          typeof call[0] === "string" &&
          call[0].includes("investment_holdings"),
      );
      expect(wrongTableCalls.length).toBe(0);
    });
  });

  describe("undo bulk transaction", () => {
    it("should undo bulk delete by re-inserting transactions", async () => {
      const bulkAction = {
        ...mockAction,
        entityType: "bulk_transaction",
        action: "bulk_delete",
        entityId: null,
        beforeData: {
          transactions: [
            {
              id: "tx-1",
              accountId: "acc-1",
              transactionDate: "2024-01-15",
              amount: -50,
              currencyCode: "USD",
            },
            {
              id: "tx-2",
              accountId: "acc-2",
              transactionDate: "2024-01-16",
              amount: -75,
              currencyCode: "USD",
            },
          ],
        },
      };
      mockRepository.findOne.mockResolvedValue(bulkAction);
      mockQueryRunner.manager.update.mockResolvedValue({ affected: 1 });
      mockQueryRunner.query.mockResolvedValue([
        { opening_balance: "0", tx_sum: "0" },
      ]);

      const result = await service.undo(userId);

      expect(result.description).toContain("Undone");
      const insertCalls = mockQueryRunner.query.mock.calls.filter(
        (call: any[]) =>
          typeof call[0] === "string" && call[0].includes("INSERT INTO transactions"),
      );
      expect(insertCalls.length).toBe(2);
    });

    it("should undo bulk update by restoring original field values", async () => {
      const bulkAction = {
        ...mockAction,
        entityType: "bulk_transaction",
        action: "bulk_update",
        entityId: null,
        beforeData: {
          transactions: [
            {
              id: "tx-1",
              accountId: "acc-1",
              categoryId: "cat-old",
              tagIds: ["tag-1"],
            },
            {
              id: "tx-2",
              accountId: "acc-1",
              amount: 50,
            },
          ],
        },
      };
      mockRepository.findOne.mockResolvedValue(bulkAction);
      mockQueryRunner.manager.update.mockResolvedValue({ affected: 1 });
      mockQueryRunner.query.mockResolvedValue([
        { opening_balance: "0", tx_sum: "0" },
      ]);

      const result = await service.undo(userId);

      expect(result.description).toContain("Undone");
      // Should update both transactions
      expect(mockQueryRunner.manager.update).toHaveBeenCalledWith(
        expect.any(Function),
        "tx-1",
        expect.objectContaining({ categoryId: "cat-old" }),
      );
      // Should restore tags for tx-1
      expect(mockQueryRunner.query).toHaveBeenCalledWith(
        expect.stringContaining("INSERT INTO transaction_tags"),
        ["tx-1", "tag-1"],
      );
    });

    it("should throw ConflictException for unsupported bulk action", async () => {
      const bulkAction = {
        ...mockAction,
        entityType: "bulk_transaction",
        action: "create",
        entityId: null,
      };
      mockRepository.findOne.mockResolvedValue(bulkAction);

      await expect(service.undo(userId)).rejects.toThrow(ConflictException);
    });

    it("should return early if beforeData has no transactions array", async () => {
      const bulkAction = {
        ...mockAction,
        entityType: "bulk_transaction",
        action: "bulk_delete",
        entityId: null,
        beforeData: null,
      };
      mockRepository.findOne.mockResolvedValue(bulkAction);
      mockQueryRunner.manager.update.mockResolvedValue({ affected: 1 });

      const result = await service.undo(userId);

      expect(result.description).toContain("Undone");
    });
  });

  describe("undo simple entity (additional entity types)", () => {
    it("should undo account create", async () => {
      const action = {
        ...mockAction,
        entityType: "account",
        action: "create",
        entityId: "acc-1",
        afterData: { id: "acc-1", name: "Chequing" },
      };
      mockRepository.findOne.mockResolvedValue(action);
      mockQueryRunner.manager.delete.mockResolvedValue({ affected: 1 });
      mockQueryRunner.manager.update.mockResolvedValue({ affected: 1 });

      const result = await service.undo(userId);

      expect(result.description).toContain("Undone");
      expect(mockQueryRunner.manager.delete).toHaveBeenCalled();
    });

    it("should undo scheduled_transaction delete", async () => {
      const action = {
        ...mockAction,
        entityType: "scheduled_transaction",
        action: "delete",
        entityId: "st-1",
        beforeData: {
          id: "st-1",
          name: "Rent",
          userId,
          accountId: "acc-1",
          amount: -1500,
          frequency: "MONTHLY",
        },
        afterData: null,
      };
      mockRepository.findOne.mockResolvedValue(action);
      mockQueryRunner.query.mockResolvedValue([]);
      mockQueryRunner.manager.update.mockResolvedValue({ affected: 1 });

      const result = await service.undo(userId);

      expect(result.description).toContain("Undone");
      expect(mockQueryRunner.query).toHaveBeenCalledWith(
        expect.stringContaining("INSERT INTO \"scheduled_transactions\""),
        expect.any(Array),
      );
    });

    it("should undo security update", async () => {
      const action = {
        ...mockAction,
        entityType: "security",
        action: "update",
        entityId: "sec-1",
        beforeData: {
          id: "sec-1",
          symbol: "AAPL",
          name: "Apple Inc.",
          userId,
        },
        afterData: {
          id: "sec-1",
          symbol: "AAPL",
          name: "Apple Inc. Updated",
        },
      };
      mockRepository.findOne.mockResolvedValue(action);
      mockQueryRunner.manager.update.mockResolvedValue({ affected: 1 });

      const result = await service.undo(userId);

      expect(result.description).toContain("Undone");
      expect(mockQueryRunner.manager.update).toHaveBeenCalledWith(
        expect.any(Function),
        "sec-1",
        expect.objectContaining({ symbol: "AAPL", name: "Apple Inc." }),
      );
    });

    it("should undo budget delete", async () => {
      const action = {
        ...mockAction,
        entityType: "budget",
        action: "delete",
        entityId: "bud-1",
        beforeData: {
          id: "bud-1",
          name: "Monthly Budget",
          userId,
          budgetType: "MONTHLY",
        },
        afterData: null,
      };
      mockRepository.findOne.mockResolvedValue(action);
      mockQueryRunner.query.mockResolvedValue([]);
      mockQueryRunner.manager.update.mockResolvedValue({ affected: 1 });

      const result = await service.undo(userId);

      expect(result.description).toContain("Undone");
      expect(mockQueryRunner.query).toHaveBeenCalledWith(
        expect.stringContaining("INSERT INTO \"budgets\""),
        expect.any(Array),
      );
    });

    it("should throw ConflictException for unsupported action in undoSimpleEntity", async () => {
      const action = {
        ...mockAction,
        entityType: "tag",
        action: "bulk_delete",
        entityId: "tag-1",
      };
      mockRepository.findOne.mockResolvedValue(action);

      await expect(service.undo(userId)).rejects.toThrow(ConflictException);
    });

    it("should filter out relation properties from update using ALLOWED_COLUMNS", async () => {
      const action = {
        ...mockAction,
        entityType: "tag",
        action: "update",
        entityId: "tag-1",
        beforeData: {
          id: "tag-1",
          name: "Old Name",
          userId,
          createdAt: "2024-01-01",
          updatedAt: "2024-01-01",
          // These should be filtered out (not in ALLOWED_COLUMNS for tags)
          transactions: [{ id: "tx-1" }],
          someRelation: { id: "rel-1" },
        },
      };
      mockRepository.findOne.mockResolvedValue(action);
      mockQueryRunner.manager.update.mockResolvedValue({ affected: 1 });

      const result = await service.undo(userId);

      expect(result.description).toContain("Undone");
      // The update should only include name (id, userId, createdAt, updatedAt are removed explicitly)
      expect(mockQueryRunner.manager.update).toHaveBeenCalledWith(
        expect.any(Function),
        "tag-1",
        expect.objectContaining({ name: "Old Name" }),
      );
      // The update should NOT include relation properties
      const updateCall = mockQueryRunner.manager.update.mock.calls.find(
        (call: any[]) => call[1] === "tag-1",
      );
      expect(updateCall[2]).not.toHaveProperty("transactions");
      expect(updateCall[2]).not.toHaveProperty("someRelation");
    });
  });

  describe("redo", () => {
    it("should redo a create action (which becomes delete)", async () => {
      const undoneCreateAction = {
        ...mockAction,
        action: "create",
        entityType: "tag",
        entityId: "tag-1",
        isUndone: true,
        beforeData: null,
        afterData: { id: "tag-1", name: "Test Tag", userId },
      };
      mockRepository.findOne.mockResolvedValue(undoneCreateAction);
      mockQueryRunner.query.mockResolvedValue([]);
      mockQueryRunner.manager.update.mockResolvedValue({ affected: 1 });

      const result = await service.redo(userId);

      expect(result.description).toContain("Redone");
      expect(mockQueryRunner.commitTransaction).toHaveBeenCalled();
    });

    it("should rollback on redo error", async () => {
      const undoneAction = {
        ...mockAction,
        action: "create",
        entityType: "tag",
        entityId: "tag-1",
        isUndone: true,
        afterData: { id: "tag-1", name: "Test", userId },
      };
      mockRepository.findOne.mockResolvedValue(undoneAction);
      mockQueryRunner.query.mockRejectedValue(new Error("DB error"));

      await expect(service.redo(userId)).rejects.toThrow("DB error");
      expect(mockQueryRunner.rollbackTransaction).toHaveBeenCalled();
      expect(mockQueryRunner.release).toHaveBeenCalled();
    });
  });

  describe("undo transaction create (edge cases)", () => {
    it("should return early if transaction not found", async () => {
      const txAction = {
        ...mockAction,
        entityType: "transaction",
        action: "create",
        entityId: "tx-1",
        afterData: { id: "tx-1" },
      };
      mockRepository.findOne.mockResolvedValue(txAction);
      mockQueryRunner.manager.findOne.mockResolvedValue(null);
      mockQueryRunner.manager.update.mockResolvedValue({ affected: 1 });

      const result = await service.undo(userId);

      expect(result.description).toContain("Undone");
      expect(mockQueryRunner.manager.remove).not.toHaveBeenCalled();
    });

    it("should delete splits when transaction has splits", async () => {
      const txAction = {
        ...mockAction,
        entityType: "transaction",
        action: "create",
        entityId: "tx-1",
        afterData: { id: "tx-1", accountId: "acc-1" },
      };
      mockRepository.findOne.mockResolvedValue(txAction);

      const mockTransaction = {
        id: "tx-1",
        userId,
        accountId: "acc-1",
        amount: 100,
        splits: [
          { id: "s1", amount: 60 },
          { id: "s2", amount: 40 },
        ],
      };
      mockQueryRunner.manager.findOne.mockResolvedValue(mockTransaction);
      mockQueryRunner.manager.delete.mockResolvedValue({ affected: 2 });
      mockQueryRunner.manager.remove.mockResolvedValue(undefined);
      mockQueryRunner.manager.update.mockResolvedValue({ affected: 1 });
      mockQueryRunner.query.mockResolvedValue([
        { opening_balance: "0", tx_sum: "0" },
      ]);

      const result = await service.undo(userId);

      expect(result.description).toContain("Undone");
      expect(mockQueryRunner.manager.delete).toHaveBeenCalled();
    });

    it("should return early if entityId is null", async () => {
      const txAction = {
        ...mockAction,
        entityType: "transaction",
        action: "create",
        entityId: null,
      };
      mockRepository.findOne.mockResolvedValue(txAction);
      mockQueryRunner.manager.update.mockResolvedValue({ affected: 1 });

      const result = await service.undo(userId);

      expect(result.description).toContain("Undone");
      expect(mockQueryRunner.manager.findOne).not.toHaveBeenCalled();
    });
  });

  describe("undo unsupported transaction action", () => {
    it("should throw ConflictException for unsupported transaction action", async () => {
      const txAction = {
        ...mockAction,
        entityType: "transaction",
        action: "bulk_delete",
        entityId: "tx-1",
      };
      mockRepository.findOne.mockResolvedValue(txAction);

      await expect(service.undo(userId)).rejects.toThrow(ConflictException);
    });
  });

  describe("recalculateBalance", () => {
    it("should handle empty result from balance query", async () => {
      const txAction = {
        ...mockAction,
        entityType: "transaction",
        action: "create",
        entityId: "tx-1",
        afterData: { id: "tx-1", accountId: "acc-1" },
      };
      mockRepository.findOne.mockResolvedValue(txAction);

      const mockTransaction = {
        id: "tx-1",
        userId,
        accountId: "acc-1",
        amount: 100,
        splits: [],
      };
      mockQueryRunner.manager.findOne.mockResolvedValue(mockTransaction);
      mockQueryRunner.manager.remove.mockResolvedValue(undefined);
      mockQueryRunner.manager.update.mockResolvedValue({ affected: 1 });
      // Return empty result for balance query
      mockQueryRunner.query.mockResolvedValue([]);

      const result = await service.undo(userId);

      expect(result.description).toContain("Undone");
      // Should NOT try to update balance when no result
      const balanceUpdateCalls = mockQueryRunner.query.mock.calls.filter(
        (call: any[]) =>
          typeof call[0] === "string" && call[0].includes("UPDATE accounts SET current_balance"),
      );
      expect(balanceUpdateCalls.length).toBe(0);
    });
  });

  describe("pruneUserHistory", () => {
    it("should prune when count exceeds limit", async () => {
      mockRepository.delete.mockResolvedValue({ affected: 0 });
      mockRepository.create.mockReturnValue(mockAction);
      mockRepository.save.mockResolvedValue(mockAction);
      mockRepository.count.mockResolvedValue(150);
      mockRepository.find.mockResolvedValue([
        { id: "old-1" },
        { id: "old-2" },
      ]);

      await service.record(userId, {
        entityType: "tag",
        entityId: "entity-1",
        action: "create",
        description: "test",
      });

      // Should have called find to get old records and delete to remove them
      expect(mockRepository.find).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { userId },
          order: { createdAt: "DESC" },
          skip: 100,
          select: ["id"],
        }),
      );
      expect(mockRepository.delete).toHaveBeenCalledWith(["old-1", "old-2"]);
    });

    it("should not prune when count is within limit", async () => {
      mockRepository.delete.mockResolvedValue({ affected: 0 });
      mockRepository.create.mockReturnValue(mockAction);
      mockRepository.save.mockResolvedValue(mockAction);
      mockRepository.count.mockResolvedValue(50);

      await service.record(userId, {
        entityType: "tag",
        entityId: "entity-1",
        action: "create",
        description: "test",
      });

      // Should not try to find old records
      expect(mockRepository.find).not.toHaveBeenCalled();
    });

    it("should handle prune errors gracefully", async () => {
      mockRepository.delete.mockResolvedValue({ affected: 0 });
      mockRepository.create.mockReturnValue(mockAction);
      mockRepository.save.mockResolvedValue(mockAction);
      mockRepository.count.mockRejectedValue(new Error("DB error"));

      const result = await service.record(userId, {
        entityType: "tag",
        entityId: "entity-1",
        action: "create",
        description: "test",
      });

      // Should still return the saved action even if prune fails
      expect(result).toEqual(mockAction);
    });
  });

  describe("cleanupExpiredHistory", () => {
    it("should delete records older than 30 days", async () => {
      const mockQb = {
        delete: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        execute: jest.fn().mockResolvedValue({ affected: 5 }),
      };
      mockRepository.createQueryBuilder.mockReturnValue(mockQb);

      await service.cleanupExpiredHistory();

      expect(mockQb.delete).toHaveBeenCalled();
      expect(mockQb.where).toHaveBeenCalledWith(
        "created_at < :cutoff",
        expect.objectContaining({ cutoff: expect.any(Date) }),
      );
      expect(mockQb.execute).toHaveBeenCalled();
    });

    it("should handle cleanup when no records affected", async () => {
      const mockQb = {
        delete: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        execute: jest.fn().mockResolvedValue({ affected: 0 }),
      };
      mockRepository.createQueryBuilder.mockReturnValue(mockQb);

      await service.cleanupExpiredHistory();

      expect(mockQb.execute).toHaveBeenCalled();
    });

    it("should handle cleanup errors gracefully", async () => {
      const mockQb = {
        delete: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        execute: jest.fn().mockRejectedValue(new Error("DB error")),
      };
      mockRepository.createQueryBuilder.mockReturnValue(mockQb);

      // Should not throw
      await expect(service.cleanupExpiredHistory()).resolves.not.toThrow();
    });
  });

  describe("reinsertEntity edge cases", () => {
    it("should skip re-insert when all keys are undefined or updatedAt", async () => {
      const deleteAction = {
        ...mockAction,
        entityType: "tag",
        action: "delete",
        entityId: "tag-1",
        beforeData: { updatedAt: "2024-01-01" },
        afterData: null,
      };
      mockRepository.findOne.mockResolvedValue(deleteAction);
      mockQueryRunner.manager.update.mockResolvedValue({ affected: 1 });

      const result = await service.undo(userId);

      expect(result.description).toContain("Undone");
      // Should not insert since only updatedAt + userId left after filtering
      // userId is added but updatedAt is filtered
    });
  });
});
