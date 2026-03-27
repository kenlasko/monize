import { Test, TestingModule } from "@nestjs/testing";
import { getRepositoryToken } from "@nestjs/typeorm";
import {
  ConflictException,
  NotFoundException,
  BadRequestException,
} from "@nestjs/common";
import { DataSource } from "typeorm";
import { PayeesService } from "./payees.service";
import { Payee } from "./entities/payee.entity";
import { PayeeAlias } from "./entities/payee-alias.entity";
import { Transaction } from "../transactions/entities/transaction.entity";
import { ScheduledTransaction } from "../scheduled-transactions/entities/scheduled-transaction.entity";
import { Category } from "../categories/entities/category.entity";
import { ActionHistoryService } from "../action-history/action-history.service";

describe("PayeesService", () => {
  let service: PayeesService;
  let payeesRepository: Record<string, jest.Mock>;
  let aliasRepository: Record<string, any>;
  let transactionsRepository: Record<string, jest.Mock>;
  let scheduledTransactionsRepository: Record<string, jest.Mock>;
  let categoriesRepository: Record<string, jest.Mock>;
  let mockDataSource: Record<string, jest.Mock>;

  const userId = "user-1";

  const mockPayee: Payee = {
    id: "payee-1",
    userId,
    name: "Starbucks",
    defaultCategoryId: "cat-1",
    notes: "Coffee shop",
    defaultCategory: { id: "cat-1", name: "Food & Drink" } as any,
    isActive: true,
    createdAt: new Date("2025-01-01"),
  };

  const mockPayeeNoCategory: Payee = {
    id: "payee-2",
    userId,
    name: "Amazon",
    defaultCategoryId: null,
    notes: "" as any,
    defaultCategory: null as any,
    isActive: true,
    createdAt: new Date("2025-01-02"),
  };

  let queryBuilderMock: Record<string, jest.Mock>;

  beforeEach(async () => {
    queryBuilderMock = {
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      leftJoin: jest.fn().mockReturnThis(),
      leftJoinAndSelect: jest.fn().mockReturnThis(),
      select: jest.fn().mockReturnThis(),
      addSelect: jest.fn().mockReturnThis(),
      groupBy: jest.fn().mockReturnThis(),
      addGroupBy: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      having: jest.fn().mockReturnThis(),
      limit: jest.fn().mockReturnThis(),
      take: jest.fn().mockReturnThis(),
      getRawMany: jest.fn().mockResolvedValue([]),
      getMany: jest.fn().mockResolvedValue([]),
    };

    payeesRepository = {
      findOne: jest.fn(),
      find: jest.fn(),
      save: jest.fn().mockImplementation((data) => data),
      create: jest
        .fn()
        .mockImplementation((data) => ({ ...data, id: "new-payee" })),
      remove: jest.fn(),
      count: jest.fn(),
      update: jest.fn(),
      createQueryBuilder: jest.fn(() => ({ ...queryBuilderMock })),
    };

    transactionsRepository = {
      update: jest.fn(),
      count: jest.fn().mockResolvedValue(0),
    };

    scheduledTransactionsRepository = {
      update: jest.fn(),
    };

    categoriesRepository = {
      find: jest.fn().mockResolvedValue([]),
      findOne: jest.fn(),
    };

    const aliasQueryBuilderMock = {
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      leftJoinAndSelect: jest.fn().mockReturnThis(),
      getOne: jest.fn().mockResolvedValue(null),
      select: jest.fn().mockReturnThis(),
      groupBy: jest.fn().mockReturnThis(),
      getRawMany: jest.fn().mockResolvedValue([]),
    };

    aliasRepository = {
      find: jest.fn().mockResolvedValue([]),
      findOne: jest.fn(),
      count: jest.fn().mockResolvedValue(0),
      save: jest.fn().mockImplementation((data) => ({
        id: "alias-new",
        ...data,
      })),
      create: jest
        .fn()
        .mockImplementation((data) => ({ id: "alias-new", ...data })),
      remove: jest.fn(),
      createQueryBuilder: jest.fn(() => ({ ...aliasQueryBuilderMock })),
      manager: {
        find: jest.fn().mockResolvedValue([]),
      },
    };

    const mockQueryRunner = {
      connect: jest.fn(),
      startTransaction: jest.fn(),
      commitTransaction: jest.fn(),
      rollbackTransaction: jest.fn(),
      release: jest.fn(),
      manager: {
        update: jest.fn().mockResolvedValue({ affected: 0 }),
        create: jest.fn().mockImplementation((_, data) => data),
        save: jest.fn().mockImplementation((data) => data),
        remove: jest.fn(),
        createQueryBuilder: jest.fn(() => ({
          where: jest.fn().mockReturnThis(),
          andWhere: jest.fn().mockReturnThis(),
          getOne: jest.fn().mockResolvedValue(null),
        })),
      },
    };

    mockDataSource = {
      createQueryRunner: jest.fn().mockReturnValue(mockQueryRunner),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PayeesService,
        { provide: getRepositoryToken(Payee), useValue: payeesRepository },
        {
          provide: getRepositoryToken(PayeeAlias),
          useValue: aliasRepository,
        },
        {
          provide: getRepositoryToken(Transaction),
          useValue: transactionsRepository,
        },
        {
          provide: getRepositoryToken(ScheduledTransaction),
          useValue: scheduledTransactionsRepository,
        },
        {
          provide: getRepositoryToken(Category),
          useValue: categoriesRepository,
        },
        { provide: DataSource, useValue: mockDataSource },
        { provide: ActionHistoryService, useValue: { record: jest.fn().mockResolvedValue(null) } },
      ],
    }).compile();

    service = module.get<PayeesService>(PayeesService);
  });

  it("should be defined", () => {
    expect(service).toBeDefined();
  });

  // ─── create ──────────────────────────────────────────────────────────

  describe("create", () => {
    it("should create a payee successfully", async () => {
      payeesRepository.findOne.mockResolvedValue(null);
      const dto = { name: "NewPayee", defaultCategoryId: "cat-1" };
      const result = await service.create(userId, dto);

      expect(payeesRepository.findOne).toHaveBeenCalledWith({
        where: { userId, name: "NewPayee" },
      });
      expect(payeesRepository.create).toHaveBeenCalledWith({ ...dto, userId });
      expect(payeesRepository.save).toHaveBeenCalled();
      expect(result).toMatchObject({ name: "NewPayee", userId });
    });

    it("should throw ConflictException when payee name already exists", async () => {
      payeesRepository.findOne.mockResolvedValue(mockPayee);

      await expect(
        service.create(userId, { name: "Starbucks" }),
      ).rejects.toThrow(ConflictException);
    });

    it("should create a payee without optional fields", async () => {
      payeesRepository.findOne.mockResolvedValue(null);
      const dto = { name: "MinimalPayee" };
      await service.create(userId, dto);

      expect(payeesRepository.create).toHaveBeenCalledWith({
        name: "MinimalPayee",
        userId,
      });
    });
  });

  // ─── findAll ─────────────────────────────────────────────────────────

  describe("findAll", () => {
    it("should return payees with transaction counts", async () => {
      payeesRepository.find.mockResolvedValue([mockPayee, mockPayeeNoCategory]);
      const qb = {
        ...queryBuilderMock,
        getRawMany: jest.fn().mockResolvedValue([
          { id: "payee-1", count: "5" },
          { id: "payee-2", count: "3" },
        ]),
      };
      payeesRepository.createQueryBuilder.mockReturnValue(qb);

      const result = await service.findAll(userId);

      expect(result).toHaveLength(2);
      expect(result[0]).toMatchObject({ id: "payee-1", transactionCount: 5 });
      expect(result[1]).toMatchObject({ id: "payee-2", transactionCount: 3 });
    });

    it("should return empty array when no payees exist", async () => {
      payeesRepository.find.mockResolvedValue([]);

      const result = await service.findAll(userId);

      expect(result).toEqual([]);
      expect(payeesRepository.createQueryBuilder).not.toHaveBeenCalled();
    });

    it("should default transactionCount to 0 for payees without transactions", async () => {
      payeesRepository.find.mockResolvedValue([mockPayee]);
      const qb = {
        ...queryBuilderMock,
        getRawMany: jest.fn().mockResolvedValue([]),
      };
      payeesRepository.createQueryBuilder.mockReturnValue(qb);

      const result = await service.findAll(userId);

      expect(result[0].transactionCount).toBe(0);
    });
  });

  // ─── findOne ─────────────────────────────────────────────────────────

  describe("findOne", () => {
    it("should return a payee with defaultCategory", async () => {
      payeesRepository.findOne.mockResolvedValue(mockPayee);

      const result = await service.findOne(userId, "payee-1");

      expect(result).toEqual(mockPayee);
      expect(payeesRepository.findOne).toHaveBeenCalledWith({
        where: { id: "payee-1", userId },
        relations: ["defaultCategory"],
      });
    });

    it("should throw NotFoundException when payee does not exist", async () => {
      payeesRepository.findOne.mockResolvedValue(null);

      await expect(service.findOne(userId, "nonexistent")).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  // ─── search ──────────────────────────────────────────────────────────

  describe("search", () => {
    it("should search payees with ILIKE pattern", async () => {
      payeesRepository.find.mockResolvedValue([mockPayee]);

      const result = await service.search(userId, "star");

      expect(result).toEqual([mockPayee]);
      expect(payeesRepository.find).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ userId }),
          take: 10,
        }),
      );
    });

    it("should respect custom limit", async () => {
      payeesRepository.find.mockResolvedValue([]);

      await service.search(userId, "test", 5);

      expect(payeesRepository.find).toHaveBeenCalledWith(
        expect.objectContaining({ take: 5 }),
      );
    });

    it("should return empty array when no matches found", async () => {
      payeesRepository.find.mockResolvedValue([]);

      const result = await service.search(userId, "zzz");

      expect(result).toEqual([]);
    });
  });

  // ─── autocomplete ────────────────────────────────────────────────────

  describe("autocomplete", () => {
    it("should return payees matching prefix", async () => {
      payeesRepository.find.mockResolvedValue([mockPayee]);

      const result = await service.autocomplete(userId, "Star");

      expect(result).toEqual([mockPayee]);
      expect(payeesRepository.find).toHaveBeenCalledWith(
        expect.objectContaining({
          take: 10,
          relations: ["defaultCategory"],
          order: { name: "ASC" },
        }),
      );
    });

    it("should return empty array when no prefix matches", async () => {
      payeesRepository.find.mockResolvedValue([]);

      const result = await service.autocomplete(userId, "zzz");

      expect(result).toEqual([]);
    });
  });

  // ─── findByName ──────────────────────────────────────────────────────

  describe("findByName", () => {
    it("should return a payee by exact name match", async () => {
      payeesRepository.findOne.mockResolvedValue(mockPayee);

      const result = await service.findByName(userId, "Starbucks");

      expect(result).toEqual(mockPayee);
      expect(payeesRepository.findOne).toHaveBeenCalledWith({
        where: { userId, name: "Starbucks" },
        relations: ["defaultCategory"],
      });
    });

    it("should return null when payee not found", async () => {
      payeesRepository.findOne.mockResolvedValue(null);

      const result = await service.findByName(userId, "Unknown");

      expect(result).toBeNull();
    });
  });

  // ─── findOrCreate ────────────────────────────────────────────────────

  describe("findOrCreate", () => {
    it("should return existing payee if found by name", async () => {
      payeesRepository.findOne.mockResolvedValue(mockPayee);

      const result = await service.findOrCreate(userId, "Starbucks");

      expect(result).toEqual(mockPayee);
      // Should not call create when found
      expect(payeesRepository.create).not.toHaveBeenCalled();
    });

    it("should create a new payee if not found", async () => {
      // First call: findByName returns null; second call: duplicate check returns null
      payeesRepository.findOne.mockResolvedValue(null);

      await service.findOrCreate(userId, "NewPlace", "cat-2");

      expect(payeesRepository.create).toHaveBeenCalledWith({
        name: "NewPlace",
        defaultCategoryId: "cat-2",
        userId,
      });
      expect(payeesRepository.save).toHaveBeenCalled();
    });

    it("should create without defaultCategoryId when not provided", async () => {
      payeesRepository.findOne.mockResolvedValue(null);

      await service.findOrCreate(userId, "NewPlace");

      expect(payeesRepository.create).toHaveBeenCalledWith({
        name: "NewPlace",
        defaultCategoryId: undefined,
        userId,
      });
    });
  });

  // ─── update ──────────────────────────────────────────────────────────

  describe("update", () => {
    it("should update payee properties", async () => {
      const existingPayee = { ...mockPayee };
      const refreshedPayee = {
        ...mockPayee,
        name: "New Name",
        notes: "Updated notes",
      };
      // First findOne: ownership check; second: name conflict check; third: re-fetch after save
      payeesRepository.findOne
        .mockResolvedValueOnce(existingPayee)
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(refreshedPayee);

      const result = await service.update(userId, "payee-1", {
        name: "New Name",
        notes: "Updated notes",
      });

      expect(result.name).toBe("New Name");
      expect(result.notes).toBe("Updated notes");
      expect(payeesRepository.save).toHaveBeenCalled();
    });

    it("should throw NotFoundException when payee not found", async () => {
      payeesRepository.findOne.mockResolvedValue(null);

      await expect(
        service.update(userId, "nonexistent", { name: "Test" }),
      ).rejects.toThrow(NotFoundException);
    });

    it("should throw ConflictException when new name already exists", async () => {
      payeesRepository.findOne
        .mockResolvedValueOnce(mockPayee)
        .mockResolvedValueOnce({ id: "payee-other", name: "Taken Name" });

      await expect(
        service.update(userId, "payee-1", { name: "Taken Name" }),
      ).rejects.toThrow(ConflictException);
    });

    it("should cascade name change to transactions and scheduled transactions", async () => {
      const existingPayee = { ...mockPayee, name: "OldName" };
      const refreshedPayee = { ...mockPayee, name: "NewName" };
      payeesRepository.findOne
        .mockResolvedValueOnce(existingPayee)
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(refreshedPayee);

      await service.update(userId, "payee-1", { name: "NewName" });

      expect(transactionsRepository.update).toHaveBeenCalledWith(
        { payeeId: "payee-1", userId },
        { payeeName: "NewName" },
      );
      expect(scheduledTransactionsRepository.update).toHaveBeenCalledWith(
        { payeeId: "payee-1", userId },
        { payeeName: "NewName" },
      );
    });

    it("should not cascade when name is not changed", async () => {
      const existingPayee = { ...mockPayee };
      payeesRepository.findOne
        .mockResolvedValueOnce(existingPayee)
        .mockResolvedValueOnce(existingPayee);

      await service.update(userId, "payee-1", { notes: "Just updating notes" });

      expect(transactionsRepository.update).not.toHaveBeenCalled();
      expect(scheduledTransactionsRepository.update).not.toHaveBeenCalled();
    });

    it("should skip name conflict check when name is unchanged", async () => {
      const existingPayee = { ...mockPayee };
      payeesRepository.findOne
        .mockResolvedValueOnce(existingPayee)
        .mockResolvedValueOnce(existingPayee);

      await service.update(userId, "payee-1", { name: "Starbucks" });

      // findOne called twice: once for ownership check, once for re-fetch; no conflict check
      expect(payeesRepository.findOne).toHaveBeenCalledTimes(2);
    });

    it("should update defaultCategoryId via explicit mapping", async () => {
      const existingPayee = { ...mockPayee };
      const refreshedPayee = { ...mockPayee, defaultCategoryId: "cat-99" };
      payeesRepository.findOne
        .mockResolvedValueOnce(existingPayee)
        .mockResolvedValueOnce(refreshedPayee);

      const result = await service.update(userId, "payee-1", {
        defaultCategoryId: "cat-99",
      });

      expect(result.defaultCategoryId).toBe("cat-99");
      expect(payeesRepository.save).toHaveBeenCalled();
    });

    it("should clear defaultCategoryId when set to null", async () => {
      const existingPayee = {
        ...mockPayee,
        defaultCategory: { id: "cat-1", name: "Food" },
      };
      const refreshedPayee = {
        ...mockPayee,
        defaultCategoryId: null,
        defaultCategory: null,
      };
      payeesRepository.findOne
        .mockResolvedValueOnce(existingPayee)
        .mockResolvedValueOnce(refreshedPayee);

      const result = await service.update(userId, "payee-1", {
        defaultCategoryId: null,
      });

      expect(result.defaultCategoryId).toBeNull();
      // Verify the relation object is also nulled so TypeORM save() doesn't
      // re-derive the FK from the stale loaded relation entity
      const savedPayee = payeesRepository.save.mock.calls[0][0];
      expect(savedPayee.defaultCategoryId).toBeNull();
      expect(savedPayee.defaultCategory).toBeNull();
    });
  });

  // ─── remove ──────────────────────────────────────────────────────────

  describe("remove", () => {
    it("should remove a payee after ownership verification", async () => {
      payeesRepository.findOne.mockResolvedValue(mockPayee);

      await service.remove(userId, "payee-1");

      expect(payeesRepository.remove).toHaveBeenCalledWith(mockPayee);
    });

    it("should throw NotFoundException when payee does not exist", async () => {
      payeesRepository.findOne.mockResolvedValue(null);

      await expect(service.remove(userId, "nonexistent")).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  // ─── getMostUsed ─────────────────────────────────────────────────────

  describe("getMostUsed", () => {
    it("should return most used payees ordered by transaction count", async () => {
      queryBuilderMock.getMany.mockResolvedValue([mockPayee]);
      payeesRepository.createQueryBuilder.mockReturnValue(queryBuilderMock);

      const result = await service.getMostUsed(userId);

      expect(result).toEqual([mockPayee]);
      expect(queryBuilderMock.leftJoinAndSelect).toHaveBeenCalled();
      expect(queryBuilderMock.leftJoin).toHaveBeenCalled();
      expect(queryBuilderMock.where).toHaveBeenCalled();
      expect(queryBuilderMock.groupBy).toHaveBeenCalled();
      expect(queryBuilderMock.orderBy).toHaveBeenCalled();
      expect(queryBuilderMock.limit).toHaveBeenCalledWith(10);
    });

    it("should respect custom limit parameter", async () => {
      queryBuilderMock.getMany.mockResolvedValue([]);
      payeesRepository.createQueryBuilder.mockReturnValue(queryBuilderMock);

      await service.getMostUsed(userId, 5);

      expect(queryBuilderMock.limit).toHaveBeenCalledWith(5);
    });
  });

  // ─── getRecentlyUsed ────────────────────────────────────────────────

  describe("getRecentlyUsed", () => {
    it("should return recently used payees ordered by most recent transaction date", async () => {
      queryBuilderMock.getMany.mockResolvedValue([mockPayee]);
      payeesRepository.createQueryBuilder.mockReturnValue(queryBuilderMock);

      const result = await service.getRecentlyUsed(userId);

      expect(result).toEqual([mockPayee]);
      expect(queryBuilderMock.orderBy).toHaveBeenCalled();
      expect(queryBuilderMock.limit).toHaveBeenCalledWith(10);
    });

    it("should respect custom limit parameter", async () => {
      queryBuilderMock.getMany.mockResolvedValue([]);
      payeesRepository.createQueryBuilder.mockReturnValue(queryBuilderMock);

      await service.getRecentlyUsed(userId, 3);

      expect(queryBuilderMock.limit).toHaveBeenCalledWith(3);
    });
  });

  // ─── getSummary ──────────────────────────────────────────────────────

  describe("getSummary", () => {
    it("should return counts of total, with category, without category, active, and inactive", async () => {
      payeesRepository.count
        .mockResolvedValueOnce(10) // totalPayees
        .mockResolvedValueOnce(6) // payeesWithCategory
        .mockResolvedValueOnce(8); // activePayees

      const result = await service.getSummary(userId);

      expect(result).toEqual({
        totalPayees: 10,
        payeesWithCategory: 6,
        payeesWithoutCategory: 4,
        activePayees: 8,
        inactivePayees: 2,
      });
    });

    it("should return all zeros when no payees exist", async () => {
      payeesRepository.count
        .mockResolvedValueOnce(0)
        .mockResolvedValueOnce(0)
        .mockResolvedValueOnce(0);

      const result = await service.getSummary(userId);

      expect(result).toEqual({
        totalPayees: 0,
        payeesWithCategory: 0,
        payeesWithoutCategory: 0,
        activePayees: 0,
        inactivePayees: 0,
      });
    });

    it("should handle all payees having categories", async () => {
      payeesRepository.count
        .mockResolvedValueOnce(5)
        .mockResolvedValueOnce(5)
        .mockResolvedValueOnce(5);

      const result = await service.getSummary(userId);

      expect(result).toEqual({
        totalPayees: 5,
        payeesWithCategory: 5,
        payeesWithoutCategory: 0,
        activePayees: 5,
        inactivePayees: 0,
      });
    });
  });

  // ─── findByCategory ──────────────────────────────────────────────────

  describe("findByCategory", () => {
    it("should return payees with the given default category", async () => {
      payeesRepository.find.mockResolvedValue([mockPayee]);

      const result = await service.findByCategory(userId, "cat-1");

      expect(result).toEqual([mockPayee]);
      expect(payeesRepository.find).toHaveBeenCalledWith({
        where: { userId, defaultCategoryId: "cat-1" },
        relations: ["defaultCategory"],
        order: { name: "ASC" },
      });
    });

    it("should return empty array when no payees match category", async () => {
      payeesRepository.find.mockResolvedValue([]);

      const result = await service.findByCategory(userId, "cat-unknown");

      expect(result).toEqual([]);
    });
  });

  // ─── calculateCategorySuggestions ────────────────────────────────────

  describe("calculateCategorySuggestions", () => {
    it("should return suggestions for payees meeting thresholds", async () => {
      // Query 1: category usage per payee
      const qb1 = {
        ...queryBuilderMock,
        getRawMany: jest.fn().mockResolvedValue([
          {
            payee_id: "payee-2",
            payee_name: "Amazon",
            current_category_id: null,
            category_id: "cat-shopping",
            category_name: "Shopping",
            category_count: "8",
          },
          {
            payee_id: "payee-2",
            payee_name: "Amazon",
            current_category_id: null,
            category_id: "cat-electronics",
            category_name: "Electronics",
            category_count: "2",
          },
        ]),
      };

      // Query 2: total counts per payee
      const qb2 = {
        ...queryBuilderMock,
        getRawMany: jest
          .fn()
          .mockResolvedValue([{ payee_id: "payee-2", total_count: "10" }]),
      };

      payeesRepository.createQueryBuilder
        .mockReturnValueOnce(qb1)
        .mockReturnValueOnce(qb2);

      // Query 3: payees with categories (for current category map)
      payeesRepository.find.mockResolvedValue([mockPayeeNoCategory]);

      const result = await service.calculateCategorySuggestions(userId, 5, 50);

      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({
        payeeId: "payee-2",
        payeeName: "Amazon",
        suggestedCategoryId: "cat-shopping",
        suggestedCategoryName: "Shopping",
        transactionCount: 10,
        categoryCount: 8,
        percentage: 80,
      });
    });

    it("should skip payees below minimum transaction threshold", async () => {
      const qb1 = {
        ...queryBuilderMock,
        getRawMany: jest.fn().mockResolvedValue([
          {
            payee_id: "payee-2",
            payee_name: "Amazon",
            current_category_id: null,
            category_id: "cat-1",
            category_name: "Shopping",
            category_count: "3",
          },
        ]),
      };

      // Total count is below minTransactions threshold
      const qb2 = {
        ...queryBuilderMock,
        getRawMany: jest.fn().mockResolvedValue([]),
      };

      payeesRepository.createQueryBuilder
        .mockReturnValueOnce(qb1)
        .mockReturnValueOnce(qb2);
      payeesRepository.find.mockResolvedValue([]);

      const result = await service.calculateCategorySuggestions(userId, 10, 50);

      expect(result).toHaveLength(0);
    });

    it("should skip payees below minimum percentage threshold", async () => {
      const qb1 = {
        ...queryBuilderMock,
        getRawMany: jest.fn().mockResolvedValue([
          {
            payee_id: "payee-2",
            payee_name: "Amazon",
            current_category_id: null,
            category_id: "cat-1",
            category_name: "Shopping",
            category_count: "3",
          },
          {
            payee_id: "payee-2",
            payee_name: "Amazon",
            current_category_id: null,
            category_id: "cat-2",
            category_name: "Electronics",
            category_count: "7",
          },
        ]),
      };

      const qb2 = {
        ...queryBuilderMock,
        getRawMany: jest
          .fn()
          .mockResolvedValue([{ payee_id: "payee-2", total_count: "10" }]),
      };

      payeesRepository.createQueryBuilder
        .mockReturnValueOnce(qb1)
        .mockReturnValueOnce(qb2);
      payeesRepository.find.mockResolvedValue([]);

      // minPercentage = 80, but top category is 70% (7/10)
      const result = await service.calculateCategorySuggestions(userId, 5, 80);

      expect(result).toHaveLength(0);
    });

    it("should skip payees that already have the suggested category assigned", async () => {
      const qb1 = {
        ...queryBuilderMock,
        getRawMany: jest.fn().mockResolvedValue([
          {
            payee_id: "payee-1",
            payee_name: "Starbucks",
            current_category_id: "cat-1",
            category_id: "cat-1",
            category_name: "Food & Drink",
            category_count: "10",
          },
        ]),
      };

      const qb2 = {
        ...queryBuilderMock,
        getRawMany: jest
          .fn()
          .mockResolvedValue([{ payee_id: "payee-1", total_count: "10" }]),
      };

      payeesRepository.createQueryBuilder
        .mockReturnValueOnce(qb1)
        .mockReturnValueOnce(qb2);
      payeesRepository.find.mockResolvedValue([
        {
          ...mockPayee,
          defaultCategoryId: "cat-1",
          defaultCategory: { id: "cat-1", name: "Food & Drink" },
        },
      ]);

      const result = await service.calculateCategorySuggestions(
        userId,
        5,
        50,
        false,
      );

      expect(result).toHaveLength(0);
    });

    it("should include current category info for payees that have one", async () => {
      const qb1 = {
        ...queryBuilderMock,
        getRawMany: jest.fn().mockResolvedValue([
          {
            payee_id: "payee-1",
            payee_name: "Starbucks",
            current_category_id: "cat-1",
            category_id: "cat-new",
            category_name: "Coffee",
            category_count: "15",
          },
        ]),
      };

      const qb2 = {
        ...queryBuilderMock,
        getRawMany: jest
          .fn()
          .mockResolvedValue([{ payee_id: "payee-1", total_count: "15" }]),
      };

      payeesRepository.createQueryBuilder
        .mockReturnValueOnce(qb1)
        .mockReturnValueOnce(qb2);
      payeesRepository.find.mockResolvedValue([
        {
          ...mockPayee,
          defaultCategoryId: "cat-1",
          defaultCategory: { id: "cat-1", name: "Food & Drink" },
        },
      ]);

      const result = await service.calculateCategorySuggestions(
        userId,
        5,
        50,
        false,
      );

      expect(result).toHaveLength(1);
      expect(result[0].currentCategoryId).toBe("cat-1");
      expect(result[0].currentCategoryName).toBe("Food & Drink");
      expect(result[0].suggestedCategoryId).toBe("cat-new");
    });

    it("should return empty array when no category usage data exists", async () => {
      const qb1 = {
        ...queryBuilderMock,
        getRawMany: jest.fn().mockResolvedValue([]),
      };
      const qb2 = {
        ...queryBuilderMock,
        getRawMany: jest.fn().mockResolvedValue([]),
      };

      payeesRepository.createQueryBuilder
        .mockReturnValueOnce(qb1)
        .mockReturnValueOnce(qb2);
      payeesRepository.find.mockResolvedValue([]);

      const result = await service.calculateCategorySuggestions(userId, 5, 50);

      expect(result).toEqual([]);
    });

    it("should sort suggestions by payee name", async () => {
      const qb1 = {
        ...queryBuilderMock,
        getRawMany: jest.fn().mockResolvedValue([
          {
            payee_id: "payee-z",
            payee_name: "Zebra Store",
            current_category_id: null,
            category_id: "cat-1",
            category_name: "Shopping",
            category_count: "10",
          },
          {
            payee_id: "payee-a",
            payee_name: "Apple Store",
            current_category_id: null,
            category_id: "cat-2",
            category_name: "Tech",
            category_count: "8",
          },
        ]),
      };

      const qb2 = {
        ...queryBuilderMock,
        getRawMany: jest.fn().mockResolvedValue([
          { payee_id: "payee-z", total_count: "10" },
          { payee_id: "payee-a", total_count: "8" },
        ]),
      };

      payeesRepository.createQueryBuilder
        .mockReturnValueOnce(qb1)
        .mockReturnValueOnce(qb2);
      payeesRepository.find.mockResolvedValue([]);

      const result = await service.calculateCategorySuggestions(userId, 5, 50);

      expect(result).toHaveLength(2);
      expect(result[0].payeeName).toBe("Apple Store");
      expect(result[1].payeeName).toBe("Zebra Store");
    });

    it("should add onlyWithoutCategory filter when flag is true", async () => {
      const qb1: Record<string, jest.Mock> = {
        ...queryBuilderMock,
        getRawMany: jest.fn().mockResolvedValue([]),
      };
      const qb2: Record<string, jest.Mock> = {
        ...queryBuilderMock,
        getRawMany: jest.fn().mockResolvedValue([]),
      };

      payeesRepository.createQueryBuilder
        .mockReturnValueOnce(qb1)
        .mockReturnValueOnce(qb2);
      payeesRepository.find.mockResolvedValue([]);

      await service.calculateCategorySuggestions(userId, 5, 50, true);

      // Both query builders should have andWhere called with the null check
      expect(qb1.andWhere).toHaveBeenCalledWith(
        "payee.default_category_id IS NULL",
      );
      expect(qb2.andWhere).toHaveBeenCalledWith(
        "payee.default_category_id IS NULL",
      );
    });
  });

  // ─── applyCategorySuggestions ────────────────────────────────────────

  describe("applyCategorySuggestions", () => {
    it("should bulk update payee categories and return count", async () => {
      payeesRepository.find.mockResolvedValue([
        { ...mockPayeeNoCategory },
        { ...mockPayee },
      ]);
      categoriesRepository.find.mockResolvedValue([
        { id: "cat-food" },
        { id: "cat-coffee" },
      ]);

      const assignments = [
        { payeeId: "payee-2", categoryId: "cat-food" },
        { payeeId: "payee-1", categoryId: "cat-coffee" },
      ];

      const result = await service.applyCategorySuggestions(
        userId,
        assignments,
      );

      expect(result).toEqual({ updated: 2 });
      expect(payeesRepository.save).toHaveBeenCalledTimes(1);
      expect(payeesRepository.save).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.objectContaining({
            id: "payee-2",
            defaultCategoryId: "cat-food",
          }),
          expect.objectContaining({
            id: "payee-1",
            defaultCategoryId: "cat-coffee",
          }),
        ]),
      );
    });

    it("should skip assignments for payees not belonging to user", async () => {
      // Batch find only returns payees belonging to the user (not "other-user-payee")
      payeesRepository.find.mockResolvedValue([{ ...mockPayee }]);
      categoriesRepository.find.mockResolvedValue([
        { id: "cat-1" },
        { id: "cat-2" },
      ]);

      const assignments = [
        { payeeId: "other-user-payee", categoryId: "cat-1" },
        { payeeId: "payee-1", categoryId: "cat-2" },
      ];

      const result = await service.applyCategorySuggestions(
        userId,
        assignments,
      );

      expect(result).toEqual({ updated: 1 });
      expect(payeesRepository.save).toHaveBeenCalledTimes(1);
      expect(payeesRepository.save).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.objectContaining({
            id: "payee-1",
            defaultCategoryId: "cat-2",
          }),
        ]),
      );
    });

    it("should return zero updated when no valid assignments", async () => {
      // Batch find returns empty: no payees match the requested IDs for this user
      payeesRepository.find.mockResolvedValue([]);
      categoriesRepository.find.mockResolvedValue([{ id: "cat-1" }]);

      const result = await service.applyCategorySuggestions(userId, [
        { payeeId: "bad-1", categoryId: "cat-1" },
      ]);

      expect(result).toEqual({ updated: 0 });
      expect(payeesRepository.save).not.toHaveBeenCalled();
    });

    it("should handle empty assignments array", async () => {
      payeesRepository.find.mockResolvedValue([]);

      const result = await service.applyCategorySuggestions(userId, []);

      expect(result).toEqual({ updated: 0 });
      expect(payeesRepository.save).not.toHaveBeenCalled();
    });

    it("should set defaultCategoryId on the payee entity before saving", async () => {
      const payee = { ...mockPayeeNoCategory, defaultCategoryId: null };
      payeesRepository.find.mockResolvedValue([payee]);
      categoriesRepository.find.mockResolvedValue([{ id: "cat-new" }]);

      await service.applyCategorySuggestions(userId, [
        { payeeId: "payee-2", categoryId: "cat-new" },
      ]);

      expect(payee.defaultCategoryId).toBe("cat-new");
      expect(payeesRepository.save).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.objectContaining({ defaultCategoryId: "cat-new" }),
        ]),
      );
    });
  });

  // ─── findAll with status filter ───────────────────────────────────

  describe("findAll with status filter", () => {
    it("should filter by active status when status is 'active'", async () => {
      payeesRepository.find.mockResolvedValue([mockPayee]);
      const qb = {
        ...queryBuilderMock,
        getRawMany: jest
          .fn()
          .mockResolvedValue([
            { id: "payee-1", count: "5", last_used_date: "2025-01-15" },
          ]),
      };
      payeesRepository.createQueryBuilder.mockReturnValue(qb);

      await service.findAll(userId, "active");

      expect(payeesRepository.find).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { userId, isActive: true },
        }),
      );
    });

    it("should filter by inactive status when status is 'inactive'", async () => {
      payeesRepository.find.mockResolvedValue([]);

      await service.findAll(userId, "inactive");

      expect(payeesRepository.find).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { userId, isActive: false },
        }),
      );
    });

    it("should not filter by isActive when status is 'all'", async () => {
      payeesRepository.find.mockResolvedValue([]);

      await service.findAll(userId, "all");

      expect(payeesRepository.find).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { userId },
        }),
      );
    });

    it("should include lastUsedDate in results", async () => {
      payeesRepository.find.mockResolvedValue([mockPayee]);
      const qb = {
        ...queryBuilderMock,
        getRawMany: jest
          .fn()
          .mockResolvedValue([
            { id: "payee-1", count: "5", last_used_date: "2025-06-15" },
          ]),
      };
      payeesRepository.createQueryBuilder.mockReturnValue(qb);

      const result = await service.findAll(userId);

      expect(result[0]).toMatchObject({
        id: "payee-1",
        transactionCount: 5,
        lastUsedDate: "2025-06-15",
      });
    });

    it("should return null lastUsedDate for payees without transactions", async () => {
      payeesRepository.find.mockResolvedValue([mockPayee]);
      const qb = {
        ...queryBuilderMock,
        getRawMany: jest
          .fn()
          .mockResolvedValue([
            { id: "payee-1", count: "0", last_used_date: null },
          ]),
      };
      payeesRepository.createQueryBuilder.mockReturnValue(qb);

      const result = await service.findAll(userId);

      expect(result[0].lastUsedDate).toBeNull();
    });
  });

  // ─── findInactiveByName ────────────────────────────────────────────

  describe("findInactiveByName", () => {
    it("should find an inactive payee by case-insensitive name", async () => {
      const inactivePayee = { ...mockPayee, isActive: false };
      queryBuilderMock.getOne = jest.fn().mockResolvedValue(inactivePayee);
      payeesRepository.createQueryBuilder.mockReturnValue(queryBuilderMock);

      const result = await service.findInactiveByName(userId, "starbucks");

      expect(result).toEqual(inactivePayee);
      expect(queryBuilderMock.where).toHaveBeenCalledWith(
        "payee.user_id = :userId",
        { userId },
      );
      expect(queryBuilderMock.andWhere).toHaveBeenCalledWith(
        "payee.is_active = false",
      );
      expect(queryBuilderMock.andWhere).toHaveBeenCalledWith(
        "LOWER(payee.name) = LOWER(:name)",
        { name: "starbucks" },
      );
    });

    it("should return null when no inactive match found", async () => {
      queryBuilderMock.getOne = jest.fn().mockResolvedValue(null);
      payeesRepository.createQueryBuilder.mockReturnValue(queryBuilderMock);

      const result = await service.findInactiveByName(userId, "Unknown");

      expect(result).toBeNull();
    });
  });

  // ─── previewDeactivation ──────────────────────────────────────────

  describe("previewDeactivation", () => {
    it("should return payees matching deactivation criteria", async () => {
      queryBuilderMock.andHaving = jest.fn().mockReturnThis();
      queryBuilderMock.getRawMany = jest.fn().mockResolvedValue([
        {
          payee_id: "payee-1",
          payee_name: "Old Store",
          transaction_count: "2",
          last_used_date: "2024-01-01",
          default_category_name: "Shopping",
        },
      ]);
      payeesRepository.createQueryBuilder.mockReturnValue(queryBuilderMock);

      const result = await service.previewDeactivation(userId, 5, 12);

      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({
        payeeId: "payee-1",
        payeeName: "Old Store",
        transactionCount: 2,
        lastUsedDate: "2024-01-01",
        defaultCategoryName: "Shopping",
      });
    });

    it("should return payees that were never used", async () => {
      queryBuilderMock.andHaving = jest.fn().mockReturnThis();
      queryBuilderMock.getRawMany = jest.fn().mockResolvedValue([
        {
          payee_id: "payee-2",
          payee_name: "Never Used",
          transaction_count: "0",
          last_used_date: null,
          default_category_name: null,
        },
      ]);
      payeesRepository.createQueryBuilder.mockReturnValue(queryBuilderMock);

      const result = await service.previewDeactivation(userId, 3, 6);

      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({
        transactionCount: 0,
        lastUsedDate: null,
        defaultCategoryName: null,
      });
    });

    it("should return empty array when no payees match criteria", async () => {
      queryBuilderMock.andHaving = jest.fn().mockReturnThis();
      queryBuilderMock.getRawMany = jest.fn().mockResolvedValue([]);
      payeesRepository.createQueryBuilder.mockReturnValue(queryBuilderMock);

      const result = await service.previewDeactivation(userId, 0, 1);

      expect(result).toEqual([]);
    });

    it("should only consider active payees", async () => {
      queryBuilderMock.andHaving = jest.fn().mockReturnThis();
      queryBuilderMock.getRawMany = jest.fn().mockResolvedValue([]);
      payeesRepository.createQueryBuilder.mockReturnValue(queryBuilderMock);

      await service.previewDeactivation(userId, 5, 12);

      expect(queryBuilderMock.andWhere).toHaveBeenCalledWith(
        "payee.is_active = true",
      );
    });
  });

  // ─── deactivatePayees ─────────────────────────────────────────────

  describe("deactivatePayees", () => {
    it("should bulk deactivate payees and return count", async () => {
      const payee1 = { ...mockPayee, isActive: true };
      const payee2 = { ...mockPayeeNoCategory, isActive: true };
      payeesRepository.find.mockResolvedValue([payee1, payee2]);

      const result = await service.deactivatePayees(userId, [
        "payee-1",
        "payee-2",
      ]);

      expect(result).toEqual({ deactivated: 2 });
      expect(payee1.isActive).toBe(false);
      expect(payee2.isActive).toBe(false);
      expect(payeesRepository.save).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.objectContaining({ id: "payee-1", isActive: false }),
          expect.objectContaining({ id: "payee-2", isActive: false }),
        ]),
      );
    });

    it("should handle empty payeeIds array", async () => {
      const result = await service.deactivatePayees(userId, []);

      expect(result).toEqual({ deactivated: 0 });
      expect(payeesRepository.find).not.toHaveBeenCalled();
      expect(payeesRepository.save).not.toHaveBeenCalled();
    });

    it("should skip payees not belonging to user", async () => {
      payeesRepository.find.mockResolvedValue([{ ...mockPayee }]);

      const result = await service.deactivatePayees(userId, [
        "payee-1",
        "other-user-payee",
      ]);

      expect(result).toEqual({ deactivated: 1 });
    });

    it("should only deactivate currently active payees", async () => {
      payeesRepository.find.mockResolvedValue([]);

      const result = await service.deactivatePayees(userId, [
        "already-inactive",
      ]);

      expect(result).toEqual({ deactivated: 0 });
      expect(payeesRepository.find).toHaveBeenCalledWith({
        where: expect.objectContaining({ isActive: true }),
      });
    });

    it("should deduplicate payee IDs", async () => {
      payeesRepository.find.mockResolvedValue([{ ...mockPayee }]);

      await service.deactivatePayees(userId, ["payee-1", "payee-1", "payee-1"]);

      // Should only query for unique IDs
      const findCall = payeesRepository.find.mock.calls[0][0];
      expect(findCall.where.id).toBeDefined();
    });
  });

  // ─── reactivatePayee ──────────────────────────────────────────────

  describe("reactivatePayee", () => {
    it("should reactivate an inactive payee", async () => {
      const inactivePayee = { ...mockPayee, isActive: false };
      payeesRepository.findOne.mockResolvedValue(inactivePayee);

      const result = await service.reactivatePayee(userId, "payee-1");

      expect(inactivePayee.isActive).toBe(true);
      expect(payeesRepository.save).toHaveBeenCalledWith(
        expect.objectContaining({ id: "payee-1", isActive: true }),
      );
      expect(result.isActive).toBe(true);
    });

    it("should return payee unchanged if already active", async () => {
      const activePayee = { ...mockPayee, isActive: true };
      payeesRepository.findOne.mockResolvedValue(activePayee);

      const result = await service.reactivatePayee(userId, "payee-1");

      expect(result.isActive).toBe(true);
      expect(payeesRepository.save).not.toHaveBeenCalled();
    });

    it("should throw NotFoundException for non-existent payee", async () => {
      payeesRepository.findOne.mockResolvedValue(null);

      await expect(
        service.reactivatePayee(userId, "nonexistent"),
      ).rejects.toThrow(NotFoundException);
    });
  });

  // ─── update with isActive ─────────────────────────────────────────

  describe("update with isActive", () => {
    it("should update isActive field via update DTO", async () => {
      const existingPayee = { ...mockPayee, isActive: true };
      const refreshedPayee = { ...mockPayee, isActive: false };
      payeesRepository.findOne
        .mockResolvedValueOnce(existingPayee)
        .mockResolvedValueOnce(refreshedPayee);

      const result = await service.update(userId, "payee-1", {
        isActive: false,
      });

      expect(result.isActive).toBe(false);
      expect(payeesRepository.save).toHaveBeenCalled();
    });

    it("should not modify isActive when not included in DTO", async () => {
      const existingPayee = { ...mockPayee, isActive: true };
      payeesRepository.findOne
        .mockResolvedValueOnce(existingPayee)
        .mockResolvedValueOnce(existingPayee);

      const result = await service.update(userId, "payee-1", {
        notes: "Updated",
      });

      expect(result.isActive).toBe(true);
    });
  });

  // ─── search and autocomplete filter active ────────────────────────

  describe("search filters active payees", () => {
    it("should include isActive: true in search query", async () => {
      payeesRepository.find.mockResolvedValue([]);

      await service.search(userId, "test");

      expect(payeesRepository.find).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ isActive: true }),
        }),
      );
    });
  });

  describe("autocomplete filters active payees", () => {
    it("should include isActive: true in autocomplete query", async () => {
      payeesRepository.find.mockResolvedValue([]);

      await service.autocomplete(userId, "test");

      expect(payeesRepository.find).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ isActive: true }),
        }),
      );
    });
  });

  describe("getMostUsed filters active payees", () => {
    it("should include is_active = true filter", async () => {
      queryBuilderMock.getMany.mockResolvedValue([]);
      payeesRepository.createQueryBuilder.mockReturnValue(queryBuilderMock);

      await service.getMostUsed(userId);

      expect(queryBuilderMock.andWhere).toHaveBeenCalledWith(
        "payee.is_active = true",
      );
    });
  });

  describe("getRecentlyUsed filters active payees", () => {
    it("should include is_active = true filter", async () => {
      queryBuilderMock.getMany.mockResolvedValue([]);
      payeesRepository.createQueryBuilder.mockReturnValue(queryBuilderMock);

      await service.getRecentlyUsed(userId);

      expect(queryBuilderMock.andWhere).toHaveBeenCalledWith(
        "payee.is_active = true",
      );
    });
  });

  // ─── Alias Methods ─────────────────────────────────────────────────

  describe("getAliases", () => {
    it("should return aliases for a specific payee", async () => {
      payeesRepository.findOne.mockResolvedValue(mockPayee);
      const mockAliases = [
        { id: "a1", payeeId: "payee-1", userId, alias: "STARBUCKS*" },
      ];
      aliasRepository.find.mockResolvedValue(mockAliases);

      const result = await service.getAliases(userId, "payee-1");

      expect(result).toEqual(mockAliases);
      expect(aliasRepository.find).toHaveBeenCalledWith({
        where: { payeeId: "payee-1", userId },
        order: { alias: "ASC" },
      });
    });

    it("should throw NotFoundException if payee does not exist", async () => {
      payeesRepository.findOne.mockResolvedValue(null);

      await expect(service.getAliases(userId, "nonexistent")).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe("getAllAliases", () => {
    it("should return all aliases for the user", async () => {
      const mockAliases = [
        { id: "a1", payeeId: "payee-1", userId, alias: "STARBUCKS*" },
        { id: "a2", payeeId: "payee-2", userId, alias: "AMZN*" },
      ];
      aliasRepository.find.mockResolvedValue(mockAliases);

      const result = await service.getAllAliases(userId);

      expect(result).toEqual(mockAliases);
      expect(aliasRepository.find).toHaveBeenCalledWith({
        where: { userId },
        relations: ["payee"],
        order: { alias: "ASC" },
      });
    });
  });

  describe("createAlias", () => {
    it("should create an alias successfully", async () => {
      payeesRepository.findOne.mockResolvedValue(mockPayee);
      aliasRepository.find.mockResolvedValue([]);

      await service.createAlias(userId, {
        payeeId: "payee-1",
        alias: "STARBUCKS #*",
      });

      expect(aliasRepository.create).toHaveBeenCalledWith({
        payeeId: "payee-1",
        userId,
        alias: "STARBUCKS #*",
      });
      expect(aliasRepository.save).toHaveBeenCalled();
    });

    it("should throw BadRequestException for empty alias", async () => {
      payeesRepository.findOne.mockResolvedValue(mockPayee);

      await expect(
        service.createAlias(userId, { payeeId: "payee-1", alias: "   " }),
      ).rejects.toThrow(BadRequestException);
    });

    it("should throw ConflictException for exact duplicate alias", async () => {
      payeesRepository.findOne.mockResolvedValue(mockPayee);

      const qbMock = {
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        leftJoinAndSelect: jest.fn().mockReturnThis(),
        getOne: jest.fn().mockResolvedValue({
          id: "a1",
          alias: "STARBUCKS",
          payee: { name: "Starbucks" },
        }),
      };
      aliasRepository.createQueryBuilder.mockReturnValue(qbMock);

      await expect(
        service.createAlias(userId, {
          payeeId: "payee-1",
          alias: "starbucks",
        }),
      ).rejects.toThrow(ConflictException);
    });

    it("should throw ConflictException for overlapping wildcard patterns", async () => {
      payeesRepository.findOne.mockResolvedValue(mockPayee);

      // No exact match
      const qbMock = {
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        leftJoinAndSelect: jest.fn().mockReturnThis(),
        getOne: jest.fn().mockResolvedValue(null),
      };
      aliasRepository.createQueryBuilder.mockReturnValue(qbMock);

      // Return existing alias with overlapping wildcard
      aliasRepository.find.mockResolvedValue([
        {
          id: "a1",
          alias: "STAR*",
          payee: { name: "Starbucks" },
        },
      ]);

      await expect(
        service.createAlias(userId, {
          payeeId: "payee-2",
          alias: "STARBUCKS #123",
        }),
      ).rejects.toThrow(ConflictException);
    });

    it("should throw NotFoundException if payee does not exist", async () => {
      payeesRepository.findOne.mockResolvedValue(null);

      await expect(
        service.createAlias(userId, {
          payeeId: "nonexistent",
          alias: "TEST",
        }),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe("removeAlias", () => {
    it("should remove an alias successfully", async () => {
      const mockAlias = { id: "a1", payeeId: "payee-1", userId, alias: "TEST" };
      aliasRepository.findOne.mockResolvedValue(mockAlias);

      await service.removeAlias(userId, "a1");

      expect(aliasRepository.remove).toHaveBeenCalledWith(mockAlias);
    });

    it("should throw NotFoundException if alias does not exist", async () => {
      aliasRepository.findOne.mockResolvedValue(null);

      await expect(service.removeAlias(userId, "nonexistent")).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe("findPayeeByAlias", () => {
    it("should find a payee by matching alias pattern", async () => {
      const matchedPayee = { ...mockPayee };
      aliasRepository.manager.find.mockResolvedValue([
        {
          id: "a1",
          alias: "STARBUCKS*",
          payee: matchedPayee,
        },
      ]);

      const result = await service.findPayeeByAlias(userId, "STARBUCKS #12345");

      expect(result).toEqual(matchedPayee);
    });

    it("should return null when no alias matches", async () => {
      aliasRepository.manager.find.mockResolvedValue([
        {
          id: "a1",
          alias: "STARBUCKS*",
          payee: mockPayee,
        },
      ]);

      const result = await service.findPayeeByAlias(userId, "WALMART");

      expect(result).toBeNull();
    });

    it("should match case-insensitively", async () => {
      aliasRepository.manager.find.mockResolvedValue([
        {
          id: "a1",
          alias: "starbucks*",
          payee: mockPayee,
        },
      ]);

      const result = await service.findPayeeByAlias(userId, "STARBUCKS #999");

      expect(result).toEqual(mockPayee);
    });
  });

  // ─── Merge ──────────────────────────────────────────────────────────

  describe("mergePayees", () => {
    it("should merge payees successfully", async () => {
      const sourcePayee = {
        ...mockPayeeNoCategory,
        id: "payee-2",
        name: "Amazon",
      };
      const targetPayee = { ...mockPayee, id: "payee-1", name: "Starbucks" };

      // findOne will be called twice: once for target, once for source
      payeesRepository.findOne
        .mockResolvedValueOnce(targetPayee)
        .mockResolvedValueOnce(sourcePayee);

      const queryRunner = mockDataSource.createQueryRunner();
      queryRunner.manager.update.mockResolvedValue({ affected: 3 });

      const result = await service.mergePayees(userId, {
        targetPayeeId: "payee-1",
        sourcePayeeId: "payee-2",
        addAsAlias: true,
      });

      expect(result.transactionsMigrated).toBe(3);
      expect(result.aliasAdded).toBe(true);
      expect(result.sourcePayeeDeleted).toBe(true);
      expect(queryRunner.commitTransaction).toHaveBeenCalled();
      expect(queryRunner.release).toHaveBeenCalled();
    });

    it("should throw BadRequestException when merging payee into itself", async () => {
      await expect(
        service.mergePayees(userId, {
          targetPayeeId: "payee-1",
          sourcePayeeId: "payee-1",
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it("should rollback transaction on error", async () => {
      payeesRepository.findOne
        .mockResolvedValueOnce(mockPayee)
        .mockResolvedValueOnce(mockPayeeNoCategory);

      const queryRunner = mockDataSource.createQueryRunner();
      queryRunner.manager.update.mockRejectedValue(new Error("DB error"));

      await expect(
        service.mergePayees(userId, {
          targetPayeeId: "payee-1",
          sourcePayeeId: "payee-2",
        }),
      ).rejects.toThrow("DB error");

      expect(queryRunner.rollbackTransaction).toHaveBeenCalled();
      expect(queryRunner.release).toHaveBeenCalled();
    });

    it("should skip alias creation when addAsAlias is false", async () => {
      payeesRepository.findOne
        .mockResolvedValueOnce(mockPayee)
        .mockResolvedValueOnce(mockPayeeNoCategory);

      const queryRunner = mockDataSource.createQueryRunner();
      queryRunner.manager.update.mockResolvedValue({ affected: 0 });

      const result = await service.mergePayees(userId, {
        targetPayeeId: "payee-1",
        sourcePayeeId: "payee-2",
        addAsAlias: false,
      });

      expect(result.aliasAdded).toBe(false);
    });
  });
});
