import { Test, TestingModule } from "@nestjs/testing";
import { getRepositoryToken } from "@nestjs/typeorm";
import {
  NotFoundException,
  ForbiddenException,
  BadRequestException,
} from "@nestjs/common";
import { CategoriesService } from "./categories.service";
import { Category } from "./entities/category.entity";
import { Transaction } from "../transactions/entities/transaction.entity";
import { TransactionSplit } from "../transactions/entities/transaction-split.entity";
import { Payee } from "../payees/entities/payee.entity";
import { ScheduledTransaction } from "../scheduled-transactions/entities/scheduled-transaction.entity";
import { ScheduledTransactionSplit } from "../scheduled-transactions/entities/scheduled-transaction-split.entity";

describe("CategoriesService", () => {
  let service: CategoriesService;
  let categoriesRepository: Record<string, jest.Mock>;
  let transactionsRepository: Record<string, jest.Mock>;
  let splitsRepository: Record<string, jest.Mock>;
  let payeesRepository: Record<string, jest.Mock>;
  let scheduledTransactionsRepository: Record<string, jest.Mock>;
  let scheduledSplitsRepository: Record<string, jest.Mock>;

  const mockCategory: Category = {
    id: "cat-1",
    userId: "user-1",
    parentId: null,
    parent: null,
    children: [],
    name: "Groceries",
    description: null,
    icon: null,
    color: null,
    isIncome: false,
    isSystem: false,
    createdAt: new Date("2025-01-01"),
  };

  const mockChildCategory: Category = {
    id: "cat-2",
    userId: "user-1",
    parentId: "cat-1",
    parent: null,
    children: [],
    name: "Organic",
    description: null,
    icon: null,
    color: null,
    isIncome: false,
    isSystem: false,
    createdAt: new Date("2025-01-02"),
  };

  const mockSystemCategory: Category = {
    ...mockCategory,
    id: "cat-sys",
    name: "System Category",
    isSystem: true,
  };

  const createMockQueryBuilder = (
    overrides: Record<string, jest.Mock> = {},
  ) => ({
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    leftJoin: jest.fn().mockReturnThis(),
    innerJoin: jest.fn().mockReturnThis(),
    select: jest.fn().mockReturnThis(),
    addSelect: jest.fn().mockReturnThis(),
    groupBy: jest.fn().mockReturnThis(),
    getMany: jest.fn().mockResolvedValue([]),
    getRawMany: jest.fn().mockResolvedValue([]),
    getCount: jest.fn().mockResolvedValue(0),
    update: jest.fn().mockReturnThis(),
    set: jest.fn().mockReturnThis(),
    execute: jest.fn().mockResolvedValue({ affected: 0 }),
    ...overrides,
  });

  beforeEach(async () => {
    categoriesRepository = {
      create: jest
        .fn()
        .mockImplementation((data) => ({ ...data, id: "new-cat" })),
      save: jest
        .fn()
        .mockImplementation((data) => ({ ...data, id: data.id || "new-cat" })),
      findOne: jest.fn(),
      find: jest.fn(),
      remove: jest.fn(),
      count: jest.fn().mockResolvedValue(0),
      update: jest.fn(),
      createQueryBuilder: jest.fn(() => createMockQueryBuilder()),
    };

    transactionsRepository = {
      count: jest.fn().mockResolvedValue(0),
      update: jest.fn().mockResolvedValue({ affected: 0 }),
      createQueryBuilder: jest.fn(() => createMockQueryBuilder()),
    };

    splitsRepository = {
      count: jest.fn().mockResolvedValue(0),
      createQueryBuilder: jest.fn(() => createMockQueryBuilder()),
    };

    payeesRepository = {
      update: jest.fn(),
    };

    scheduledTransactionsRepository = {
      count: jest.fn().mockResolvedValue(0),
      update: jest.fn().mockResolvedValue({ affected: 0 }),
      createQueryBuilder: jest.fn(() => createMockQueryBuilder()),
    };

    scheduledSplitsRepository = {
      createQueryBuilder: jest.fn(() => createMockQueryBuilder()),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CategoriesService,
        {
          provide: getRepositoryToken(Category),
          useValue: categoriesRepository,
        },
        {
          provide: getRepositoryToken(Transaction),
          useValue: transactionsRepository,
        },
        {
          provide: getRepositoryToken(TransactionSplit),
          useValue: splitsRepository,
        },
        { provide: getRepositoryToken(Payee), useValue: payeesRepository },
        {
          provide: getRepositoryToken(ScheduledTransaction),
          useValue: scheduledTransactionsRepository,
        },
        {
          provide: getRepositoryToken(ScheduledTransactionSplit),
          useValue: scheduledSplitsRepository,
        },
      ],
    }).compile();

    service = module.get<CategoriesService>(CategoriesService);
  });

  describe("create", () => {
    it("creates a category without parent", async () => {
      const dto = { name: "Food", isIncome: false };
      categoriesRepository.save.mockResolvedValue({
        ...dto,
        id: "new-cat",
        userId: "user-1",
      });

      const result = await service.create("user-1", dto);

      expect(categoriesRepository.create).toHaveBeenCalledWith({
        ...dto,
        userId: "user-1",
      });
      expect(categoriesRepository.save).toHaveBeenCalled();
      expect(result.name).toBe("Food");
    });

    it("creates a subcategory when parentId is specified and parent exists", async () => {
      const dto = { name: "Organic", parentId: "cat-1" };
      categoriesRepository.findOne.mockResolvedValue(mockCategory);
      categoriesRepository.save.mockResolvedValue({
        ...dto,
        id: "new-cat",
        userId: "user-1",
        isIncome: false,
      });

      await service.create("user-1", dto);

      expect(categoriesRepository.findOne).toHaveBeenCalledWith({
        where: { id: "cat-1" },
        relations: ["children"],
      });
      expect(categoriesRepository.create).toHaveBeenCalledWith({
        ...dto,
        isIncome: false,
        userId: "user-1",
      });
    });

    it("inherits isIncome from parent category, ignoring provided value", async () => {
      const incomeParent = {
        ...mockCategory,
        id: "income-parent",
        isIncome: true,
      };
      categoriesRepository.findOne.mockResolvedValue(incomeParent);
      categoriesRepository.save.mockImplementation((data) => data);

      await service.create("user-1", {
        name: "Bonus",
        parentId: "income-parent",
        isIncome: false,
      });

      expect(categoriesRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({ isIncome: true }),
      );
    });

    it("throws NotFoundException when parent category does not exist", async () => {
      const dto = { name: "Organic", parentId: "nonexistent" };
      categoriesRepository.findOne.mockResolvedValue(null);

      await expect(service.create("user-1", dto)).rejects.toThrow(
        NotFoundException,
      );
    });

    it("throws ForbiddenException when parent belongs to different user", async () => {
      const dto = { name: "Organic", parentId: "cat-1" };
      categoriesRepository.findOne.mockResolvedValue({
        ...mockCategory,
        userId: "other-user",
      });

      await expect(service.create("user-1", dto)).rejects.toThrow(
        ForbiddenException,
      );
    });
  });

  describe("findAll", () => {
    it("returns empty array when user has no categories", async () => {
      const qb = createMockQueryBuilder({
        getMany: jest.fn().mockResolvedValue([]),
      });
      categoriesRepository.createQueryBuilder.mockReturnValue(qb);

      const result = await service.findAll("user-1");

      expect(result).toEqual([]);
    });

    it("returns categories with transaction counts merged", async () => {
      const categories = [
        { ...mockCategory, id: "cat-1" },
        { ...mockChildCategory, id: "cat-2" },
      ];
      const catQb = createMockQueryBuilder({
        getMany: jest.fn().mockResolvedValue(categories),
      });
      categoriesRepository.createQueryBuilder.mockReturnValue(catQb);

      const directCountsQb = createMockQueryBuilder({
        getRawMany: jest
          .fn()
          .mockResolvedValue([{ categoryId: "cat-1", count: "3" }]),
      });
      const splitCountsQb = createMockQueryBuilder({
        getRawMany: jest
          .fn()
          .mockResolvedValue([{ categoryId: "cat-1", count: "2" }]),
      });
      transactionsRepository.createQueryBuilder.mockReturnValue(directCountsQb);
      splitsRepository.createQueryBuilder.mockReturnValue(splitCountsQb);

      const result = await service.findAll("user-1");

      expect(result).toHaveLength(2);
      expect(result[0].transactionCount).toBe(5);
      expect(result[1].transactionCount).toBe(0);
    });

    it("filters out system categories by default", async () => {
      const qb = createMockQueryBuilder({
        getMany: jest.fn().mockResolvedValue([]),
      });
      categoriesRepository.createQueryBuilder.mockReturnValue(qb);

      await service.findAll("user-1");

      expect(qb.andWhere).toHaveBeenCalledWith(
        "category.isSystem = :isSystem",
        { isSystem: false },
      );
    });

    it("includes system categories when includeSystem is true", async () => {
      const qb = createMockQueryBuilder({
        getMany: jest.fn().mockResolvedValue([]),
      });
      categoriesRepository.createQueryBuilder.mockReturnValue(qb);

      await service.findAll("user-1", true);

      expect(qb.andWhere).not.toHaveBeenCalled();
    });
  });

  describe("effectiveColor resolution", () => {
    const setupFindAll = (categories: Category[]) => {
      const catQb = createMockQueryBuilder({
        getMany: jest.fn().mockResolvedValue(categories),
      });
      categoriesRepository.createQueryBuilder.mockReturnValue(catQb);
      transactionsRepository.createQueryBuilder.mockReturnValue(
        createMockQueryBuilder(),
      );
      splitsRepository.createQueryBuilder.mockReturnValue(
        createMockQueryBuilder(),
      );
    };

    it("returns own color as effectiveColor when category has explicit color", async () => {
      setupFindAll([{ ...mockCategory, id: "c1", color: "#ef4444" }]);

      const result = await service.findAll("user-1");

      expect((result[0] as any).effectiveColor).toBe("#ef4444");
    });

    it("inherits effectiveColor from parent when child color is null", async () => {
      setupFindAll([
        { ...mockCategory, id: "p1", parentId: null, color: "#3b82f6" },
        { ...mockChildCategory, id: "c1", parentId: "p1", color: null },
      ]);

      const result = await service.findAll("user-1");
      const child = result.find((c) => c.id === "c1");

      expect((child as any).effectiveColor).toBe("#3b82f6");
    });

    it("returns null effectiveColor for top-level category without color", async () => {
      setupFindAll([{ ...mockCategory, id: "c1", color: null }]);

      const result = await service.findAll("user-1");

      expect((result[0] as any).effectiveColor).toBeNull();
    });

    it("child with explicit color overrides parent color", async () => {
      setupFindAll([
        { ...mockCategory, id: "p1", parentId: null, color: "#ef4444" },
        {
          ...mockChildCategory,
          id: "c1",
          parentId: "p1",
          color: "#3b82f6",
        },
      ]);

      const result = await service.findAll("user-1");
      const child = result.find((c) => c.id === "c1");

      expect((child as any).effectiveColor).toBe("#3b82f6");
    });

    it("grandchild inherits color through parent chain", async () => {
      setupFindAll([
        { ...mockCategory, id: "gp", parentId: null, color: "#22c55e" },
        { ...mockCategory, id: "p", parentId: "gp", color: null },
        { ...mockCategory, id: "c", parentId: "p", color: null },
      ]);

      const result = await service.findAll("user-1");
      const grandchild = result.find((c) => c.id === "c");
      const parent = result.find((c) => c.id === "p");

      expect((grandchild as any).effectiveColor).toBe("#22c55e");
      expect((parent as any).effectiveColor).toBe("#22c55e");
    });

    it("grandchild stops at nearest ancestor with explicit color", async () => {
      setupFindAll([
        { ...mockCategory, id: "gp", parentId: null, color: "#ef4444" },
        { ...mockCategory, id: "p", parentId: "gp", color: "#3b82f6" },
        { ...mockCategory, id: "c", parentId: "p", color: null },
      ]);

      const result = await service.findAll("user-1");
      const grandchild = result.find((c) => c.id === "c");

      expect((grandchild as any).effectiveColor).toBe("#3b82f6");
    });

    it("orphaned child returns null effectiveColor when parent not in set", async () => {
      setupFindAll([
        { ...mockCategory, id: "o1", parentId: "missing", color: null },
      ]);

      const result = await service.findAll("user-1");

      expect((result[0] as any).effectiveColor).toBeNull();
    });
  });

  describe("findOne effectiveColor", () => {
    it("resolves effectiveColor from parent via DB lookup", async () => {
      const child = {
        ...mockChildCategory,
        id: "c1",
        parentId: "p1",
        color: null,
      };
      const parent = {
        ...mockCategory,
        id: "p1",
        color: "#ef4444",
        parentId: null,
      };

      categoriesRepository.findOne
        .mockResolvedValueOnce(child) // findOne: load child
        .mockResolvedValueOnce(parent); // findOne: parent chain lookup

      const result = await service.findOne("user-1", "c1");

      expect(result.effectiveColor).toBe("#ef4444");
    });

    it("returns own color as effectiveColor for category with explicit color", async () => {
      const cat = { ...mockCategory, id: "c1", color: "#22c55e" };
      categoriesRepository.findOne.mockResolvedValue(cat);

      const result = await service.findOne("user-1", "c1");

      expect(result.effectiveColor).toBe("#22c55e");
    });

    it("returns null effectiveColor for top-level category without color", async () => {
      categoriesRepository.findOne.mockResolvedValue(mockCategory);

      const result = await service.findOne("user-1", "cat-1");

      expect(result.effectiveColor).toBeNull();
    });

    it("walks multiple parents to find color", async () => {
      const grandchild = {
        ...mockCategory,
        id: "gc",
        parentId: "p",
        color: null,
      };
      const parent = { ...mockCategory, id: "p", parentId: "gp", color: null };
      const grandparent = {
        ...mockCategory,
        id: "gp",
        parentId: null,
        color: "#8b5cf6",
      };

      categoriesRepository.findOne
        .mockResolvedValueOnce(grandchild) // findOne: load grandchild
        .mockResolvedValueOnce(parent) // parent chain: first hop
        .mockResolvedValueOnce(grandparent); // parent chain: second hop

      const result = await service.findOne("user-1", "gc");

      expect(result.effectiveColor).toBe("#8b5cf6");
    });
  });

  describe("getTree", () => {
    it("builds hierarchical tree from flat categories", async () => {
      const parent = { ...mockCategory, id: "p1", parentId: null };
      const child = { ...mockChildCategory, id: "c1", parentId: "p1" };
      const catQb = createMockQueryBuilder({
        getMany: jest.fn().mockResolvedValue([parent, child]),
      });
      categoriesRepository.createQueryBuilder.mockReturnValue(catQb);
      transactionsRepository.createQueryBuilder.mockReturnValue(
        createMockQueryBuilder(),
      );
      splitsRepository.createQueryBuilder.mockReturnValue(
        createMockQueryBuilder(),
      );

      const result = await service.getTree("user-1");

      expect(result).toHaveLength(1);
      expect(result[0].id).toBe("p1");
      expect(result[0].children).toHaveLength(1);
      expect(result[0].children[0].id).toBe("c1");
    });

    it("treats orphaned children as roots", async () => {
      const orphan = {
        ...mockChildCategory,
        id: "o1",
        parentId: "missing-parent",
      };
      const catQb = createMockQueryBuilder({
        getMany: jest.fn().mockResolvedValue([orphan]),
      });
      categoriesRepository.createQueryBuilder.mockReturnValue(catQb);
      transactionsRepository.createQueryBuilder.mockReturnValue(
        createMockQueryBuilder(),
      );
      splitsRepository.createQueryBuilder.mockReturnValue(
        createMockQueryBuilder(),
      );

      const result = await service.getTree("user-1");

      expect(result).toHaveLength(1);
      expect(result[0].id).toBe("o1");
    });

    it("returns empty array when no categories exist", async () => {
      const catQb = createMockQueryBuilder({
        getMany: jest.fn().mockResolvedValue([]),
      });
      categoriesRepository.createQueryBuilder.mockReturnValue(catQb);

      const result = await service.getTree("user-1");

      expect(result).toEqual([]);
    });
  });

  describe("findByType", () => {
    it("returns income categories", async () => {
      const incomeCategories = [
        { ...mockCategory, isIncome: true, name: "Salary" },
      ];
      categoriesRepository.find.mockResolvedValue(incomeCategories);

      const result = await service.findByType("user-1", true);

      expect(categoriesRepository.find).toHaveBeenCalledWith({
        where: { userId: "user-1", isIncome: true },
        order: { name: "ASC" },
      });
      expect(result).toEqual(
        incomeCategories.map((c) => ({ ...c, effectiveColor: null })),
      );
    });

    it("returns expense categories", async () => {
      categoriesRepository.find.mockResolvedValue([mockCategory]);

      const result = await service.findByType("user-1", false);

      expect(categoriesRepository.find).toHaveBeenCalledWith({
        where: { userId: "user-1", isIncome: false },
        order: { name: "ASC" },
      });
      expect(result).toEqual([{ ...mockCategory, effectiveColor: null }]);
    });
  });

  describe("findOne", () => {
    it("returns category when found and belongs to user", async () => {
      categoriesRepository.findOne.mockResolvedValue(mockCategory);

      const result = await service.findOne("user-1", "cat-1");

      expect(result).toEqual({ ...mockCategory, effectiveColor: null });
      expect(categoriesRepository.findOne).toHaveBeenCalledWith({
        where: { id: "cat-1" },
        relations: ["children"],
      });
    });

    it("throws NotFoundException when category not found", async () => {
      categoriesRepository.findOne.mockResolvedValue(null);

      await expect(service.findOne("user-1", "nonexistent")).rejects.toThrow(
        NotFoundException,
      );
    });

    it("throws ForbiddenException when category belongs to different user", async () => {
      categoriesRepository.findOne.mockResolvedValue({
        ...mockCategory,
        userId: "other-user",
      });

      await expect(service.findOne("user-1", "cat-1")).rejects.toThrow(
        ForbiddenException,
      );
    });
  });

  describe("update", () => {
    it("updates category fields", async () => {
      categoriesRepository.findOne.mockResolvedValue({ ...mockCategory });
      categoriesRepository.save.mockImplementation((data) => data);

      const result = await service.update("user-1", "cat-1", {
        name: "Updated Name",
        description: "New desc",
        icon: "cart",
        color: "#FF5733",
        isIncome: true,
      });

      expect(result.name).toBe("Updated Name");
      expect(result.description).toBe("New desc");
      expect(result.icon).toBe("cart");
      expect(result.color).toBe("#FF5733");
      expect(result.isIncome).toBe(true);
    });

    it("updates parentId when provided", async () => {
      const parentCat = { ...mockCategory, id: "parent-1", isIncome: false };
      categoriesRepository.findOne
        .mockResolvedValueOnce({ ...mockCategory })
        .mockResolvedValueOnce(parentCat)
        .mockResolvedValueOnce(parentCat);
      categoriesRepository.save.mockImplementation((data) => data);

      const result = await service.update("user-1", "cat-1", {
        parentId: "parent-1",
      });

      expect(result.parentId).toBe("parent-1");
    });

    it("inherits isIncome from parent when parentId is set on update", async () => {
      const incomeParent = {
        ...mockCategory,
        id: "income-parent",
        isIncome: true,
      };
      categoriesRepository.findOne
        .mockResolvedValueOnce({ ...mockCategory, isIncome: false })
        .mockResolvedValueOnce(incomeParent)
        .mockResolvedValueOnce(incomeParent);
      categoriesRepository.save.mockImplementation((data) => data);

      const result = await service.update("user-1", "cat-1", {
        parentId: "income-parent",
        isIncome: false,
      });

      expect(result.isIncome).toBe(true);
    });

    it("ignores isIncome in dto for existing child category", async () => {
      const parentCat = { ...mockCategory, id: "parent-1", isIncome: false };
      categoriesRepository.findOne
        .mockResolvedValueOnce({ ...mockChildCategory, isIncome: false }) // findOne: load child
        .mockResolvedValueOnce(parentCat) // findOne: parent chain color resolution
        .mockResolvedValueOnce(parentCat) // update: load parent for isIncome inheritance
        .mockResolvedValueOnce(parentCat); // update findOne: parent chain color resolution
      categoriesRepository.save.mockImplementation((data) => data);

      const result = await service.update("user-1", "cat-2", {
        isIncome: true,
      });

      expect(result.isIncome).toBe(false);
    });

    it("throws BadRequestException for system categories", async () => {
      categoriesRepository.findOne.mockResolvedValue({ ...mockSystemCategory });

      await expect(
        service.update("user-1", "cat-sys", { name: "Renamed" }),
      ).rejects.toThrow(BadRequestException);
    });

    it("throws BadRequestException when setting parentId to self", async () => {
      categoriesRepository.findOne.mockResolvedValue({ ...mockCategory });

      await expect(
        service.update("user-1", "cat-1", { parentId: "cat-1" }),
      ).rejects.toThrow(BadRequestException);
    });

    it("throws NotFoundException when category does not exist", async () => {
      categoriesRepository.findOne.mockResolvedValue(null);

      await expect(
        service.update("user-1", "cat-1", { name: "New" }),
      ).rejects.toThrow(NotFoundException);
    });

    it("does not overwrite fields that are not in the dto", async () => {
      const original = {
        ...mockCategory,
        name: "Original",
        description: "Keep me",
      };
      categoriesRepository.findOne.mockResolvedValue(original);
      categoriesRepository.save.mockImplementation((data) => data);

      const result = await service.update("user-1", "cat-1", {
        name: "Changed",
      });

      expect(result.name).toBe("Changed");
      expect(result.description).toBe("Keep me");
    });
  });

  describe("remove", () => {
    it("removes category and clears payee defaults", async () => {
      categoriesRepository.findOne.mockResolvedValue({ ...mockCategory });
      categoriesRepository.count.mockResolvedValue(0);

      await service.remove("user-1", "cat-1");

      expect(payeesRepository.update).toHaveBeenCalledWith(
        { userId: "user-1", defaultCategoryId: "cat-1" },
        { defaultCategoryId: null },
      );
      expect(categoriesRepository.remove).toHaveBeenCalledWith(
        expect.objectContaining({ id: "cat-1" }),
      );
    });

    it("throws BadRequestException for system categories", async () => {
      categoriesRepository.findOne.mockResolvedValue({ ...mockSystemCategory });

      await expect(service.remove("user-1", "cat-sys")).rejects.toThrow(
        BadRequestException,
      );
    });

    it("throws BadRequestException when category has children", async () => {
      categoriesRepository.findOne.mockResolvedValue({ ...mockCategory });
      categoriesRepository.count.mockResolvedValue(3);

      await expect(service.remove("user-1", "cat-1")).rejects.toThrow(
        BadRequestException,
      );
    });

    it("throws NotFoundException when category does not exist", async () => {
      categoriesRepository.findOne.mockResolvedValue(null);

      await expect(service.remove("user-1", "nonexistent")).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe("getTransactionCount", () => {
    it("returns sum of all transaction types", async () => {
      categoriesRepository.findOne.mockResolvedValue(mockCategory);
      transactionsRepository.count.mockResolvedValue(5);
      splitsRepository.count.mockResolvedValue(3);
      scheduledTransactionsRepository.count.mockResolvedValue(2);

      const scheduledQb = createMockQueryBuilder({
        getMany: jest.fn().mockResolvedValue([{ id: "st-1" }, { id: "st-2" }]),
      });
      scheduledTransactionsRepository.createQueryBuilder.mockReturnValue(
        scheduledQb,
      );

      const splitCountQb = createMockQueryBuilder({
        getCount: jest.fn().mockResolvedValue(1),
      });
      scheduledSplitsRepository.createQueryBuilder.mockReturnValue(
        splitCountQb,
      );

      const result = await service.getTransactionCount("user-1", "cat-1");

      expect(result).toBe(11);
    });

    it("skips scheduled split count when no scheduled transactions exist", async () => {
      categoriesRepository.findOne.mockResolvedValue(mockCategory);
      transactionsRepository.count.mockResolvedValue(2);
      splitsRepository.count.mockResolvedValue(0);
      scheduledTransactionsRepository.count.mockResolvedValue(0);

      const scheduledQb = createMockQueryBuilder({
        getMany: jest.fn().mockResolvedValue([]),
      });
      scheduledTransactionsRepository.createQueryBuilder.mockReturnValue(
        scheduledQb,
      );

      const result = await service.getTransactionCount("user-1", "cat-1");

      expect(result).toBe(2);
      expect(
        scheduledSplitsRepository.createQueryBuilder,
      ).not.toHaveBeenCalled();
    });

    it("throws NotFoundException for nonexistent category", async () => {
      categoriesRepository.findOne.mockResolvedValue(null);

      await expect(
        service.getTransactionCount("user-1", "nope"),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe("reassignTransactions", () => {
    it("reassigns transactions from one category to another", async () => {
      categoriesRepository.findOne
        .mockResolvedValueOnce(mockCategory)
        .mockResolvedValueOnce({ ...mockCategory, id: "cat-target" });
      transactionsRepository.update.mockResolvedValue({ affected: 5 });

      const txQb = createMockQueryBuilder({
        getMany: jest.fn().mockResolvedValue([{ id: "tx-1" }, { id: "tx-2" }]),
      });
      transactionsRepository.createQueryBuilder.mockReturnValue(txQb);

      const splitQb = createMockQueryBuilder({
        execute: jest.fn().mockResolvedValue({ affected: 2 }),
      });
      splitsRepository.createQueryBuilder.mockReturnValue(splitQb);

      scheduledTransactionsRepository.update.mockResolvedValue({ affected: 1 });

      const stQb = createMockQueryBuilder({
        getMany: jest.fn().mockResolvedValue([{ id: "st-1" }]),
      });
      scheduledTransactionsRepository.createQueryBuilder.mockReturnValue(stQb);

      const ssQb = createMockQueryBuilder();
      scheduledSplitsRepository.createQueryBuilder.mockReturnValue(ssQb);

      const result = await service.reassignTransactions(
        "user-1",
        "cat-1",
        "cat-target",
      );

      expect(result.transactionsUpdated).toBe(5);
      expect(result.splitsUpdated).toBe(2);
      expect(result.scheduledUpdated).toBe(1);
    });

    it("reassigns to null category", async () => {
      categoriesRepository.findOne.mockResolvedValue(mockCategory);
      transactionsRepository.update.mockResolvedValue({ affected: 3 });

      const txQb = createMockQueryBuilder({
        getMany: jest.fn().mockResolvedValue([]),
      });
      transactionsRepository.createQueryBuilder.mockReturnValue(txQb);

      scheduledTransactionsRepository.update.mockResolvedValue({ affected: 0 });

      const stQb = createMockQueryBuilder({
        getMany: jest.fn().mockResolvedValue([]),
      });
      scheduledTransactionsRepository.createQueryBuilder.mockReturnValue(stQb);

      const result = await service.reassignTransactions(
        "user-1",
        "cat-1",
        null,
      );

      expect(result.transactionsUpdated).toBe(3);
      expect(result.splitsUpdated).toBe(0);
      expect(result.scheduledUpdated).toBe(0);
    });

    it("skips split update when user has no transactions", async () => {
      categoriesRepository.findOne
        .mockResolvedValueOnce(mockCategory)
        .mockResolvedValueOnce({ ...mockCategory, id: "cat-target" });
      transactionsRepository.update.mockResolvedValue({ affected: 0 });

      const txQb = createMockQueryBuilder({
        getMany: jest.fn().mockResolvedValue([]),
      });
      transactionsRepository.createQueryBuilder.mockReturnValue(txQb);

      scheduledTransactionsRepository.update.mockResolvedValue({ affected: 0 });

      const stQb = createMockQueryBuilder({
        getMany: jest.fn().mockResolvedValue([]),
      });
      scheduledTransactionsRepository.createQueryBuilder.mockReturnValue(stQb);

      const result = await service.reassignTransactions(
        "user-1",
        "cat-1",
        "cat-target",
      );

      expect(result.splitsUpdated).toBe(0);
      expect(splitsRepository.createQueryBuilder).not.toHaveBeenCalled();
    });

    it("throws NotFoundException when source category does not exist", async () => {
      categoriesRepository.findOne.mockResolvedValue(null);

      await expect(
        service.reassignTransactions("user-1", "nonexistent", "cat-target"),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe("getStats", () => {
    it("calculates category statistics", async () => {
      const categories = [
        { ...mockCategory, id: "c1", isIncome: false, parentId: null },
        { ...mockCategory, id: "c2", isIncome: true, parentId: null },
        { ...mockCategory, id: "c3", isIncome: false, parentId: "c1" },
        { ...mockCategory, id: "c4", isIncome: true, parentId: "c2" },
        { ...mockCategory, id: "c5", isIncome: false, parentId: "c1" },
      ];
      const catQb = createMockQueryBuilder({
        getMany: jest.fn().mockResolvedValue(categories),
      });
      categoriesRepository.createQueryBuilder.mockReturnValue(catQb);
      transactionsRepository.createQueryBuilder.mockReturnValue(
        createMockQueryBuilder(),
      );
      splitsRepository.createQueryBuilder.mockReturnValue(
        createMockQueryBuilder(),
      );

      const result = await service.getStats("user-1");

      expect(result.totalCategories).toBe(5);
      expect(result.incomeCategories).toBe(2);
      expect(result.expenseCategories).toBe(3);
      expect(result.subcategories).toBe(3);
    });

    it("returns zeroes when no categories exist", async () => {
      const catQb = createMockQueryBuilder({
        getMany: jest.fn().mockResolvedValue([]),
      });
      categoriesRepository.createQueryBuilder.mockReturnValue(catQb);

      const result = await service.getStats("user-1");

      expect(result).toEqual({
        totalCategories: 0,
        incomeCategories: 0,
        expenseCategories: 0,
        subcategories: 0,
      });
    });
  });

  describe("findByName", () => {
    it("finds a top-level category by name", async () => {
      categoriesRepository.findOne.mockResolvedValue(mockCategory);

      const result = await service.findByName("user-1", "Groceries");

      expect(categoriesRepository.findOne).toHaveBeenCalledWith({
        where: { userId: "user-1", name: "Groceries" },
      });
      expect(result).toEqual(mockCategory);
    });

    it("returns null when category is not found", async () => {
      categoriesRepository.findOne.mockResolvedValue(null);

      const result = await service.findByName("user-1", "Nonexistent");

      expect(result).toBeNull();
    });

    it("finds a child category under a specific parent", async () => {
      const parent = { ...mockCategory, id: "parent-1", name: "Food" };
      categoriesRepository.findOne
        .mockResolvedValueOnce(parent)
        .mockResolvedValueOnce(mockChildCategory);

      const result = await service.findByName("user-1", "Organic", "Food");

      expect(categoriesRepository.findOne).toHaveBeenNthCalledWith(1, {
        where: { userId: "user-1", name: "Food", parentId: expect.anything() },
      });
      expect(categoriesRepository.findOne).toHaveBeenNthCalledWith(2, {
        where: { userId: "user-1", name: "Organic", parentId: "parent-1" },
      });
      expect(result).toEqual(mockChildCategory);
    });

    it("returns null when parent name is not found", async () => {
      categoriesRepository.findOne.mockResolvedValue(null);

      const result = await service.findByName("user-1", "Organic", "NoParent");

      expect(result).toBeNull();
      expect(categoriesRepository.findOne).toHaveBeenCalledTimes(1);
    });
  });

  describe("findLoanCategories", () => {
    it("returns loan principal and interest categories", async () => {
      const loanParent = { ...mockCategory, id: "loan-parent", name: "Loan" };
      const principal = {
        ...mockCategory,
        id: "loan-p",
        name: "Loan Principal",
        parentId: "loan-parent",
      };
      const interest = {
        ...mockCategory,
        id: "loan-i",
        name: "Loan Interest",
        parentId: "loan-parent",
      };

      categoriesRepository.findOne
        .mockResolvedValueOnce(loanParent)
        .mockResolvedValueOnce(principal)
        .mockResolvedValueOnce(interest);

      const result = await service.findLoanCategories("user-1");

      expect(result.principalCategory).toEqual(principal);
      expect(result.interestCategory).toEqual(interest);
    });

    it("returns nulls when Loan parent does not exist", async () => {
      categoriesRepository.findOne.mockResolvedValue(null);

      const result = await service.findLoanCategories("user-1");

      expect(result.principalCategory).toBeNull();
      expect(result.interestCategory).toBeNull();
    });

    it("returns null for missing child categories under existing Loan parent", async () => {
      const loanParent = { ...mockCategory, id: "loan-parent", name: "Loan" };
      categoriesRepository.findOne
        .mockResolvedValueOnce(loanParent)
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(null);

      const result = await service.findLoanCategories("user-1");

      expect(result.principalCategory).toBeNull();
      expect(result.interestCategory).toBeNull();
    });
  });

  describe("importDefaults", () => {
    it("imports default categories when user has none", async () => {
      categoriesRepository.count.mockResolvedValue(0);
      let idCounter = 0;
      categoriesRepository.create.mockImplementation((data) => ({
        ...data,
        id: `gen-${++idCounter}`,
      }));
      categoriesRepository.save.mockImplementation((data) =>
        Promise.resolve(data),
      );

      const result = await service.importDefaults("user-1");

      expect(result.categoriesCreated).toBeGreaterThan(100);
      expect(categoriesRepository.create).toHaveBeenCalled();
      expect(categoriesRepository.save).toHaveBeenCalled();
    });

    it("throws BadRequestException when user already has categories", async () => {
      categoriesRepository.count.mockResolvedValue(5);

      await expect(service.importDefaults("user-1")).rejects.toThrow(
        BadRequestException,
      );
    });

    it("creates both income and expense parent categories", async () => {
      categoriesRepository.count.mockResolvedValue(0);
      let idCounter = 0;
      categoriesRepository.create.mockImplementation((data) => ({
        ...data,
        id: `gen-${++idCounter}`,
      }));
      categoriesRepository.save.mockImplementation((data) =>
        Promise.resolve(data),
      );

      await service.importDefaults("user-1");

      const createCalls = categoriesRepository.create.mock.calls.map(
        (c: unknown[]) => c[0],
      );
      const incomeParents = createCalls.filter(
        (c: Record<string, unknown>) => c.isIncome === true && !c.parentId,
      );
      const expenseParents = createCalls.filter(
        (c: Record<string, unknown>) => c.isIncome === false && !c.parentId,
      );

      expect(incomeParents.length).toBeGreaterThan(0);
      expect(expenseParents.length).toBeGreaterThan(0);
    });

    it("sets correct parentId on subcategories", async () => {
      categoriesRepository.count.mockResolvedValue(0);
      let idCounter = 0;
      categoriesRepository.create.mockImplementation((data) => ({
        ...data,
        id: `gen-${++idCounter}`,
      }));
      categoriesRepository.save.mockImplementation((data) =>
        Promise.resolve(data),
      );

      await service.importDefaults("user-1");

      const createCalls = categoriesRepository.create.mock.calls.map(
        (c: unknown[]) => c[0],
      );
      const subcategories = createCalls.filter(
        (c: Record<string, unknown>) => c.parentId,
      );

      expect(subcategories.length).toBeGreaterThan(0);
      subcategories.forEach((sub: Record<string, unknown>) => {
        expect(sub.parentId).toMatch(/^gen-/);
      });
    });
  });
});
