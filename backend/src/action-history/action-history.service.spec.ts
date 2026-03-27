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

    it("should reject undo for reconciled transactions", async () => {
      const txAction = {
        ...mockAction,
        entityType: "transaction",
        action: "create",
        entityId: "tx-1",
      };
      mockRepository.findOne.mockResolvedValue(txAction);

      const reconciledTx = {
        id: "tx-1",
        userId,
        accountId: "acc-1",
        status: "RECONCILED",
        splits: [],
      };
      mockQueryRunner.manager.findOne.mockResolvedValue(reconciledTx);

      await expect(service.undo(userId)).rejects.toThrow(ConflictException);
      expect(mockQueryRunner.rollbackTransaction).toHaveBeenCalled();
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
  });
});
