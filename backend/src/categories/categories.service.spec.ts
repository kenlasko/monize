import { Test, TestingModule } from "@nestjs/testing";
import { NotFoundException, BadRequestException } from "@nestjs/common";
import { DataSource } from "typeorm";
import { CategoriesService } from "./categories.service";
import { ActionHistoryService } from "../action-history/action-history.service";
import { Category } from "./entities/category.entity";
import { Transaction } from "../transactions/entities/transaction.entity";
import { TransactionSplit } from "../transactions/entities/transaction-split.entity";
import { Payee } from "../payees/entities/payee.entity";
import { ScheduledTransaction } from "../scheduled-transactions/entities/scheduled-transaction.entity";
import { ScheduledTransactionSplit } from "../scheduled-transactions/entities/scheduled-transaction-split.entity";
import { UserPreference } from "../users/entities/user-preference.entity";
import { I18nService } from "nestjs-i18n";
import {
  createScopedDbMocks,
  ManagerMock,
  DataSourceMock,
} from "../test-helpers/scoped-db-testing";

jest.mock("../common/db/scoped-db", () =>
  jest.requireActual("../test-helpers/scoped-db-testing").scopedDbMockModule(),
);

describe("CategoriesService", () => {
  let service: CategoriesService;
  let categoriesRepository: Record<string, jest.Mock>;
  let transactionsRepository: Record<string, jest.Mock>;
  let splitsRepository: Record<string, jest.Mock>;
  let payeesRepository: Record<string, jest.Mock>;
  let scheduledTransactionsRepository: Record<string, jest.Mock>;
  let scheduledSplitsRepository: Record<string, jest.Mock>;
  let preferencesRepository: Record<string, jest.Mock>;
  let mockDataSource: DataSourceMock;
  let txManager: ManagerMock;

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
    autoSign: null,
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
    autoSign: null,
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

    preferencesRepository = {
      findOne: jest.fn().mockResolvedValue(null),
    };

    ({ manager: txManager, dataSource: mockDataSource } = createScopedDbMocks([
      [Category, categoriesRepository],
      [Transaction, transactionsRepository],
      [TransactionSplit, splitsRepository],
      [Payee, payeesRepository],
      [ScheduledTransaction, scheduledTransactionsRepository],
      [ScheduledTransactionSplit, scheduledSplitsRepository],
      [UserPreference, preferencesRepository],
    ]));
    txManager.update.mockResolvedValue({ affected: 0 });
    txManager.find.mockResolvedValue([]);
    // Mirror real TypeORM: save/remove require an explicit entity target
    // when the value is a plain object (as findOne returns here). Return
    // the data arg (2nd) so a single-arg call yields undefined and fails
    // loudly, matching production's CannotDetermineEntityError.
    txManager.remove.mockImplementation(
      (_target: unknown, entity: unknown) => entity,
    );
    txManager.save.mockImplementation(
      (_target: unknown, data: unknown) => data,
    );
    txManager.createQueryBuilder.mockImplementation((..._args: unknown[]) =>
      createMockQueryBuilder(),
    );

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CategoriesService,
        { provide: DataSource, useValue: mockDataSource },
        {
          provide: ActionHistoryService,
          useValue: { record: jest.fn().mockResolvedValue(null) },
        },
        {
          provide: I18nService,
          useValue: {
            translate: jest.fn(
              (_key: string, opts?: { defaultValue?: string }) =>
                opts?.defaultValue,
            ),
          },
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
        categoryType: "expense",
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
        where: { id: "cat-1", userId: "user-1" },
        relations: ["children"],
      });
      expect(categoriesRepository.create).toHaveBeenCalledWith({
        ...dto,
        categoryType: "expense",
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

    it("keeps an explicit autoSign on a subcategory instead of inheriting it like isIncome", async () => {
      // Contrast with the test above: isIncome is forced to the parent's
      // value, autoSign is the subcategory's own choice and is never forced.
      const incomeParent = {
        ...mockCategory,
        id: "income-parent",
        isIncome: true,
        autoSign: true,
      };
      categoriesRepository.findOne.mockResolvedValue(incomeParent);
      categoriesRepository.save.mockImplementation((data) => data);

      const result = await service.create("user-1", {
        name: "Refunds",
        parentId: "income-parent",
        isIncome: false,
        autoSign: false,
      });

      expect(categoriesRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({ isIncome: true, autoSign: false }),
      );
      expect(result.autoSign).toBe(false);
    });

    it("throws NotFoundException when parent category does not exist", async () => {
      const dto = { name: "Organic", parentId: "nonexistent" };
      categoriesRepository.findOne.mockResolvedValue(null);

      await expect(service.create("user-1", dto)).rejects.toThrow(
        NotFoundException,
      );
    });

    it("throws NotFoundException when parent belongs to different user", async () => {
      const dto = { name: "Organic", parentId: "cat-1" };
      categoriesRepository.findOne.mockResolvedValue(null);

      await expect(service.create("user-1", dto)).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe("category type", () => {
    it("creates a Transfer category from `type`, with the legacy flag false", async () => {
      categoriesRepository.save.mockImplementation((data) => data);

      await service.create("user-1", { name: "Savings", type: "transfer" });

      expect(categoriesRepository.create).toHaveBeenCalledWith({
        name: "Savings",
        categoryType: "transfer",
        isIncome: false,
        userId: "user-1",
      });
    });

    it("lets `type` win over the legacy isIncome flag", async () => {
      categoriesRepository.save.mockImplementation((data) => data);

      await service.create("user-1", {
        name: "Savings",
        type: "transfer",
        isIncome: true,
      });

      expect(categoriesRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({ categoryType: "transfer", isIncome: false }),
      );
    });

    it("reads isIncome: true as an income category when no type is sent", async () => {
      categoriesRepository.save.mockImplementation((data) => data);

      await service.create("user-1", { name: "Salary", isIncome: true });

      expect(categoriesRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({ categoryType: "income", isIncome: true }),
      );
    });

    it("gives a subcategory its parent's type, Transfer included", async () => {
      categoriesRepository.findOne.mockResolvedValue({
        ...mockCategory,
        categoryType: "transfer",
      });
      categoriesRepository.save.mockImplementation((data) => data);

      await service.create("user-1", { name: "Brokerage", parentId: "cat-1" });

      expect(categoriesRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({ categoryType: "transfer", isIncome: false }),
      );
    });

    it("refuses a subcategory whose request names another type than its parent's", async () => {
      categoriesRepository.findOne.mockResolvedValue({
        ...mockCategory,
        categoryType: "expense",
      });

      await expect(
        service.create("user-1", {
          name: "Brokerage",
          parentId: "cat-1",
          type: "transfer",
        }),
      ).rejects.toThrow(BadRequestException);
      expect(categoriesRepository.save).not.toHaveBeenCalled();
    });

    it("takes the category-owner lock exclusive before a type change, then writes the type and the flag", async () => {
      categoriesRepository.findOne.mockResolvedValue({ ...mockCategory });
      txManager.find.mockResolvedValue([]);
      txManager.query.mockResolvedValue([]);
      categoriesRepository.find.mockResolvedValue([
        { ...mockCategory, categoryType: "expense", parentId: null },
      ]);

      const result = await service.update("user-1", "cat-1", {
        type: "transfer",
      });

      expect(txManager.query.mock.calls[0]).toEqual([
        "SELECT pg_advisory_xact_lock($1::int, hashtext($2))",
        [10, "user-1"],
      ]);
      expect(txManager.save).toHaveBeenCalledWith(
        Category,
        expect.objectContaining({ categoryType: "transfer", isIncome: false }),
      );
      expect(result.categoryType).toBe("transfer");
    });

    it("takes no lock for an edit that cannot change the type", async () => {
      categoriesRepository.findOne.mockResolvedValue({ ...mockCategory });

      await service.update("user-1", "cat-1", { name: "Renamed" });

      expect(txManager.query).not.toHaveBeenCalled();
    });

    it("refuses a change to Transfer while a category row holds the category or a descendant", async () => {
      categoriesRepository.findOne.mockResolvedValue({ ...mockCategory });
      categoriesRepository.find.mockResolvedValue([
        { id: "cat-1", parentId: null, name: "Groceries" },
        { id: "cat-2", parentId: "cat-1", name: "Organic" },
      ]);
      txManager.query.mockImplementation(async (sql: string) =>
        sql.includes("category_held_by_category_row") ? [{ id: "cat-2" }] : [],
      );

      await expect(
        service.update("user-1", "cat-1", { type: "transfer" }),
      ).rejects.toThrow(BadRequestException);
      expect(txManager.save).not.toHaveBeenCalled();
    });

    it("allows a Transfer category to become Income or Expense without asking for holders", async () => {
      categoriesRepository.findOne.mockResolvedValue({
        ...mockCategory,
        categoryType: "transfer",
      });
      txManager.find.mockResolvedValue([]);

      await service.update("user-1", "cat-1", { type: "expense" });

      expect(
        txManager.query.mock.calls.some(([sql]) =>
          String(sql).includes("category_held_by_category_row"),
        ),
      ).toBe(false);
      expect(txManager.save).toHaveBeenCalledWith(
        Category,
        expect.objectContaining({ categoryType: "expense", isIncome: false }),
      );
    });

    it("leaves a Transfer category alone when the legacy flag says false", async () => {
      categoriesRepository.findOne.mockResolvedValue({
        ...mockCategory,
        categoryType: "transfer",
      });

      await service.update("user-1", "cat-1", { isIncome: false });

      expect(txManager.save).toHaveBeenCalledWith(
        Category,
        expect.objectContaining({ categoryType: "transfer", isIncome: false }),
      );
    });

    it("cascades a type change to every descendant, writing the type and the flag", async () => {
      categoriesRepository.findOne.mockResolvedValue({ ...mockCategory });
      txManager.find
        .mockResolvedValueOnce([{ id: "child-1" }])
        .mockResolvedValueOnce([]);

      await service.update("user-1", "cat-1", { type: "income" });

      expect(txManager.update).toHaveBeenCalledWith(
        Category,
        { id: "child-1", userId: "user-1" },
        { categoryType: "income", isIncome: true },
      );
    });

    it("keeps an existing child's own type when only its name changes", async () => {
      // The child, then its parent for the colour and icon walk.
      categoriesRepository.findOne
        .mockResolvedValueOnce({
          ...mockChildCategory,
          categoryType: "income",
          isIncome: true,
        })
        .mockResolvedValueOnce({
          ...mockCategory,
          color: "#112233",
          icon: "x",
        });

      await service.update("user-1", "cat-2", { name: "Renamed" });

      expect(txManager.save).toHaveBeenCalledWith(
        Category,
        expect.objectContaining({ categoryType: "income", isIncome: true }),
      );
    });

    it("lists the transfer categories and counts them in the stats", async () => {
      categoriesRepository.find.mockResolvedValue([]);
      await service.findByCategoryType("user-1", "transfer");
      expect(categoriesRepository.find).toHaveBeenCalledWith({
        where: { userId: "user-1", categoryType: "transfer" },
        order: { name: "ASC" },
      });

      jest.spyOn(service, "findAll").mockResolvedValue([
        { ...mockCategory, categoryType: "income", isIncome: true },
        { ...mockCategory, categoryType: "expense" },
        { ...mockCategory, categoryType: "transfer" },
      ] as never);
      const stats = await service.getStats("user-1");
      expect(stats).toMatchObject({
        incomeCategories: 1,
        expenseCategories: 1,
        transferCategories: 1,
      });
    });

    it("filters the assistant listing by type and names it on every entry", async () => {
      jest.spyOn(service, "findAll").mockResolvedValue([
        { ...mockCategory, id: "e", name: "Food", transactionCount: 1 },
        {
          ...mockCategory,
          id: "t",
          name: "Savings",
          categoryType: "transfer",
          transactionCount: 2,
        },
      ] as never);

      const result = await service.getLlmCategories("user-1", {
        type: "transfer",
      });

      expect(result.categories).toEqual([
        expect.objectContaining({
          id: "t",
          type: "transfer",
          isIncome: false,
        }),
      ]);
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
      // Parent chain lookups must include userId for user isolation
      expect(categoriesRepository.findOne).toHaveBeenNthCalledWith(2, {
        where: { id: "p", userId: "user-1" },
        select: ["id", "color", "icon", "autoSign", "parentId"],
      });
      expect(categoriesRepository.findOne).toHaveBeenNthCalledWith(3, {
        where: { id: "gp", userId: "user-1" },
        select: ["id", "color", "icon", "autoSign", "parentId"],
      });
    });
  });

  describe("effective auto-sign resolution", () => {
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

    it("treats a root with no explicit value as on", async () => {
      setupFindAll([{ ...mockCategory, id: "r", autoSign: null }]);

      const result = await service.findAll("user-1");

      expect((result[0] as any).effectiveAutoSign).toBe(true);
      expect(result[0].autoSign).toBeNull();
    });

    it("inherits an explicit off from the parent when the child has none", async () => {
      setupFindAll([
        { ...mockCategory, id: "r", parentId: null, autoSign: false },
        { ...mockChildCategory, id: "c", parentId: "r", autoSign: null },
      ]);

      const result = await service.findAll("user-1");
      const child = result.find((c) => c.id === "c");

      expect((child as any).effectiveAutoSign).toBe(false);
      // The stored value is untouched; only the computed one is inherited.
      expect(child!.autoSign).toBeNull();
    });

    it("lets a child's explicit on win over its parent's off", async () => {
      setupFindAll([
        { ...mockCategory, id: "r", parentId: null, autoSign: false },
        { ...mockChildCategory, id: "c", parentId: "r", autoSign: true },
      ]);

      const result = await service.findAll("user-1");
      const child = result.find((c) => c.id === "c");

      expect((child as any).effectiveAutoSign).toBe(true);
      expect(child!.autoSign).toBe(true);
    });

    it("inherits through several levels with no explicit value", async () => {
      setupFindAll([
        { ...mockCategory, id: "r", parentId: null, autoSign: false },
        { ...mockCategory, id: "p", parentId: "r", autoSign: null },
        { ...mockCategory, id: "g", parentId: "p", autoSign: null },
      ]);

      const result = await service.findAll("user-1");

      expect((result.find((c) => c.id === "p") as any).effectiveAutoSign).toBe(
        false,
      );
      expect((result.find((c) => c.id === "g") as any).effectiveAutoSign).toBe(
        false,
      );
    });

    it("stops at the nearest explicit value", async () => {
      setupFindAll([
        { ...mockCategory, id: "r", parentId: null, autoSign: false },
        { ...mockCategory, id: "p", parentId: "r", autoSign: null },
        { ...mockCategory, id: "g", parentId: "p", autoSign: true },
      ]);

      const result = await service.findAll("user-1");

      expect((result.find((c) => c.id === "g") as any).effectiveAutoSign).toBe(
        true,
      );
      expect((result.find((c) => c.id === "p") as any).effectiveAutoSign).toBe(
        false,
      );
    });

    it("treats an orphaned child with no explicit value as on", async () => {
      setupFindAll([
        { ...mockCategory, id: "o", parentId: "missing", autoSign: null },
      ]);

      const result = await service.findAll("user-1");

      expect((result[0] as any).effectiveAutoSign).toBe(true);
    });
  });

  describe("findOne effectiveAutoSign", () => {
    it("resolves effectiveAutoSign from parent via DB lookup", async () => {
      const child = { ...mockChildCategory, id: "c1", parentId: "p1" };
      const parent = {
        ...mockCategory,
        id: "p1",
        parentId: null,
        autoSign: false,
      };
      categoriesRepository.findOne
        .mockResolvedValueOnce(child) // findOne: load child
        .mockResolvedValueOnce(parent); // findOne: parent chain lookup

      const result = await service.findOne("user-1", "c1");

      expect(result.effectiveAutoSign).toBe(false);
      expect(result.autoSign).toBeNull();
    });

    it("keeps walking for autoSign after colour and icon are resolved", async () => {
      const child = {
        ...mockChildCategory,
        id: "c1",
        parentId: "p1",
        color: "#ef4444",
        icon: "cart",
        autoSign: null,
      };
      const parent = {
        ...mockCategory,
        id: "p1",
        parentId: null,
        autoSign: false,
      };
      categoriesRepository.findOne
        .mockResolvedValueOnce(child)
        .mockResolvedValueOnce(parent);

      const result = await service.findOne("user-1", "c1");

      expect(result.effectiveAutoSign).toBe(false);
      expect(categoriesRepository.findOne).toHaveBeenNthCalledWith(2, {
        where: { id: "p1", userId: "user-1" },
        select: ["id", "color", "icon", "autoSign", "parentId"],
      });
    });

    it("returns the category's own explicit value without walking up", async () => {
      const child = {
        ...mockChildCategory,
        id: "c1",
        parentId: "p1",
        color: "#ef4444",
        icon: "cart",
        autoSign: false,
      };
      categoriesRepository.findOne.mockResolvedValueOnce(child);

      const result = await service.findOne("user-1", "c1");

      expect(result.effectiveAutoSign).toBe(false);
      expect(categoriesRepository.findOne).toHaveBeenCalledTimes(1);
    });

    it("defaults to on for a root with no explicit value", async () => {
      categoriesRepository.findOne.mockResolvedValue(mockCategory);

      const result = await service.findOne("user-1", "cat-1");

      expect(result.effectiveAutoSign).toBe(true);
    });

    it("defaults to on when no ancestor sets a value", async () => {
      categoriesRepository.findOne
        .mockResolvedValueOnce({ ...mockChildCategory, id: "c1" })
        .mockResolvedValueOnce({ ...mockCategory, id: "cat-1" });

      const result = await service.findOne("user-1", "c1");

      expect(result.effectiveAutoSign).toBe(true);
    });
  });

  describe("inherited icons", () => {
    it("carries a parent's icon down to a child that sets none", async () => {
      const child = { ...mockCategory, id: "c1", parentId: "p1", icon: null };
      const parent = {
        ...mockCategory,
        id: "p1",
        parentId: null,
        icon: "shopping-cart",
      };
      categoriesRepository.findOne
        .mockResolvedValueOnce(child)
        .mockResolvedValueOnce(parent);

      const result = await service.findOne("user-1", "c1");

      expect(result.effectiveIcon).toBe("shopping-cart");
      // The child's own column is untouched -- inheritance is a read-time
      // resolution, not a write.
      expect(result.icon).toBeNull();
    });

    it("lets a child's own icon win over its parent's", async () => {
      const child = { ...mockCategory, id: "c1", parentId: "p1", icon: "home" };
      categoriesRepository.findOne.mockResolvedValueOnce(child);

      const result = await service.findOne("user-1", "c1");

      expect(result.effectiveIcon).toBe("home");
    });

    it("resolves icon and colour in a single walk up the ancestry", async () => {
      // The two attributes can come from different ancestors, and the walk
      // stops only once neither is still outstanding.
      const grandchild = {
        ...mockCategory,
        id: "gc",
        parentId: "p",
        color: null,
        icon: null,
      };
      const parent = {
        ...mockCategory,
        id: "p",
        parentId: "gp",
        color: null,
        icon: "tag",
      };
      const grandparent = {
        ...mockCategory,
        id: "gp",
        parentId: null,
        color: "#8b5cf6",
        icon: null,
      };
      categoriesRepository.findOne
        .mockResolvedValueOnce(grandchild)
        .mockResolvedValueOnce(parent)
        .mockResolvedValueOnce(grandparent);

      const result = await service.findOne("user-1", "gc");

      expect(result.effectiveIcon).toBe("tag");
      expect(result.effectiveColor).toBe("#8b5cf6");
    });

    it("inherits icons down a list in one pass", async () => {
      const parent = {
        ...mockCategory,
        id: "p1",
        parentId: null,
        icon: "home",
        color: null,
      };
      const child = {
        ...mockCategory,
        id: "c1",
        parentId: "p1",
        icon: null,
        color: null,
      };
      const ownIcon = {
        ...mockCategory,
        id: "c2",
        parentId: "p1",
        icon: "car",
        color: null,
      };
      categoriesRepository.find.mockResolvedValue([parent, child, ownIcon]);

      const result = await service.findByType("user-1", false);

      expect(result.map((c) => c.effectiveIcon)).toEqual([
        "home",
        "home",
        "car",
      ]);
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
        where: { userId: "user-1", categoryType: "income" },
        order: { name: "ASC" },
      });
      expect(result).toEqual(
        incomeCategories.map((c) => ({
          ...c,
          effectiveColor: null,
          effectiveIcon: null,
        })),
      );
    });

    it("returns expense categories", async () => {
      categoriesRepository.find.mockResolvedValue([mockCategory]);

      const result = await service.findByType("user-1", false);

      expect(categoriesRepository.find).toHaveBeenCalledWith({
        where: { userId: "user-1", categoryType: "expense" },
        order: { name: "ASC" },
      });
      expect(result).toEqual([
        { ...mockCategory, effectiveColor: null, effectiveIcon: null },
      ]);
    });
  });

  describe("getLlmCategories", () => {
    const expense1 = {
      ...mockCategory,
      id: "c1",
      name: "Food",
      parentId: null,
      transactionCount: 5,
    } as any;
    const expense2 = {
      ...mockCategory,
      id: "c2",
      name: "Groceries",
      parentId: "c1",
      transactionCount: 3,
    } as any;
    const expense3 = {
      ...mockCategory,
      id: "c3",
      name: "Rent",
      parentId: null,
      transactionCount: 1,
    } as any;
    const income1 = {
      ...mockCategory,
      id: "c4",
      name: "Salary",
      parentId: null,
      isIncome: true,
      transactionCount: 2,
    } as any;

    const allCategories = [expense1, expense2, expense3, income1];

    const stubFindAll = () => {
      jest.spyOn(service, "findAll").mockResolvedValue(allCategories as any);
    };

    it("defaults to type='all' and no search", async () => {
      stubFindAll();

      const result = await service.getLlmCategories("user-1");

      expect(result.totalCount).toBe(4);
      const names = result.categories.map((c) => c.name);
      expect(names).toContain("Food");
      expect(names).toContain("Groceries");
      expect(names).toContain("Rent");
      expect(names).toContain("Salary");
    });

    it("includes parentName for subcategories", async () => {
      stubFindAll();

      const result = await service.getLlmCategories("user-1");

      const groceries = result.categories.find((c) => c.name === "Groceries");
      expect(groceries?.parentName).toBe("Food");
      const food = result.categories.find((c) => c.name === "Food");
      expect(food?.parentName).toBeNull();
    });

    it("gives each category the qualified name other tools accept", async () => {
      // `name` alone is ambiguous the moment two parents share a child name,
      // and this list is where the model learns what to type.
      stubFindAll();

      const result = await service.getLlmCategories("user-1");

      const groceries = result.categories.find((c) => c.name === "Groceries");
      expect(groceries?.qualifiedName).toBe("Food: Groceries");
      const food = result.categories.find((c) => c.name === "Food");
      expect(food?.qualifiedName).toBe("Food");
    });

    it("filters by expense type", async () => {
      stubFindAll();

      const result = await service.getLlmCategories("user-1", {
        type: "expense",
      });

      expect(result.totalCount).toBe(3);
      expect(result.categories.every((c) => !c.isIncome)).toBe(true);
    });

    it("filters by income type", async () => {
      stubFindAll();

      const result = await service.getLlmCategories("user-1", {
        type: "income",
      });

      expect(result.totalCount).toBe(1);
      expect(result.categories[0].name).toBe("Salary");
    });

    it("search includes matched subcategory's parent", async () => {
      stubFindAll();

      const result = await service.getLlmCategories("user-1", {
        search: "groceries",
      });

      const names = result.categories.map((c) => c.name);
      expect(names).toEqual(expect.arrayContaining(["Food", "Groceries"]));
      expect(names).not.toContain("Rent");
    });

    it("search ignores punctuation in the query", async () => {
      stubFindAll();

      const result = await service.getLlmCategories("user-1", {
        search: "r.e.n.t",
      });

      expect(result.categories.map((c) => c.name)).toEqual(["Rent"]);
    });

    it("search is case-insensitive", async () => {
      stubFindAll();

      const result = await service.getLlmCategories("user-1", {
        search: "RENT",
      });

      expect(result.categories.map((c) => c.name)).toEqual(["Rent"]);
    });
  });

  describe("findOne", () => {
    it("returns category when found and belongs to user", async () => {
      categoriesRepository.findOne.mockResolvedValue(mockCategory);

      const result = await service.findOne("user-1", "cat-1");

      expect(result).toEqual({
        ...mockCategory,
        effectiveColor: null,
        effectiveIcon: null,
        effectiveAutoSign: true,
      });
      expect(categoriesRepository.findOne).toHaveBeenCalledWith({
        where: { id: "cat-1", userId: "user-1" },
        relations: ["children"],
      });
    });

    it("throws NotFoundException when category not found", async () => {
      categoriesRepository.findOne.mockResolvedValue(null);

      await expect(service.findOne("user-1", "nonexistent")).rejects.toThrow(
        NotFoundException,
      );
    });

    it("throws NotFoundException when category belongs to different user", async () => {
      categoriesRepository.findOne.mockResolvedValue(null);

      await expect(service.findOne("user-1", "cat-1")).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe("update", () => {
    it("updates category fields", async () => {
      categoriesRepository.findOne.mockResolvedValue({ ...mockCategory });
      categoriesRepository.save.mockImplementation((data) => data);
      categoriesRepository.find.mockResolvedValue([]); // no children to cascade

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
      categoriesRepository.find.mockResolvedValue([
        { id: "cat-1", parentId: null },
        { id: "parent-1", parentId: null },
      ]);
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
      categoriesRepository.find.mockResolvedValue([
        { id: "cat-1", parentId: null },
        { id: "income-parent", parentId: null },
      ]);
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

    it("throws BadRequestException for circular parent reference", async () => {
      // Setup: cat-1 -> cat-2 -> cat-3, and we try to set cat-1's parent to cat-3
      // This would create: cat-1 -> cat-3 -> cat-2 -> cat-1 (cycle)
      const cat3 = { ...mockCategory, id: "cat-3" };
      categoriesRepository.findOne
        .mockResolvedValueOnce({ ...mockCategory, id: "cat-1" }) // findOne: load cat-1
        .mockResolvedValueOnce(cat3); // findOne: validate cat-3 exists
      categoriesRepository.find.mockResolvedValue([
        { id: "cat-1", parentId: null },
        { id: "cat-2", parentId: "cat-1" },
        { id: "cat-3", parentId: "cat-2" },
      ]);

      await expect(
        service.update("user-1", "cat-1", { parentId: "cat-3" }),
      ).rejects.toThrow("Circular parent reference detected");
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

    it("cascades isIncome change to descendant subcategories", async () => {
      // Parent category changing from Expense to Income
      categoriesRepository.findOne.mockResolvedValue({
        ...mockCategory,
        isIncome: false,
      });
      categoriesRepository.save.mockImplementation((data) => data);

      // The cascade runs inside the update transaction via the transaction
      // manager. First call: direct children of cat-1; subsequent calls:
      // grandchildren (none).
      const manager = txManager;
      manager.find
        .mockResolvedValueOnce([{ id: "child-1" }, { id: "child-2" }])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([]);

      await service.update("user-1", "cat-1", { isIncome: true });

      expect(manager.update).toHaveBeenCalledWith(
        Category,
        { id: "child-1", userId: "user-1" },
        { categoryType: "income", isIncome: true },
      );
      expect(manager.update).toHaveBeenCalledWith(
        Category,
        { id: "child-2", userId: "user-1" },
        { categoryType: "income", isIncome: true },
      );
    });

    it("does not cascade when isIncome is not changed", async () => {
      categoriesRepository.findOne.mockResolvedValue({
        ...mockCategory,
        isIncome: false,
      });

      await service.update("user-1", "cat-1", { name: "Renamed" });

      // update should not be called for children
      expect(txManager.update).not.toHaveBeenCalled();
    });

    it("stores a child's explicit autoSign instead of forcing it like isIncome", async () => {
      const parentCat = {
        ...mockCategory,
        id: "cat-1",
        isIncome: false,
        autoSign: false,
      };
      categoriesRepository.findOne
        .mockResolvedValueOnce({ ...mockChildCategory, autoSign: null }) // load child
        .mockResolvedValueOnce(parentCat) // child's ancestor walk
        .mockResolvedValueOnce(parentCat); // update: load parent for isIncome
      categoriesRepository.save.mockImplementation((data) => data);

      const result = await service.update("user-1", "cat-2", {
        autoSign: true,
      });

      expect(result.autoSign).toBe(true);
      expect(txManager.save).toHaveBeenCalledWith(
        Category,
        expect.objectContaining({ id: "cat-2", autoSign: true }),
      );
    });

    it("does not cascade an autoSign change to descendants", async () => {
      categoriesRepository.findOne.mockResolvedValue({
        ...mockCategory,
        autoSign: null,
      });

      const result = await service.update("user-1", "cat-1", {
        autoSign: false,
      });

      expect(result.autoSign).toBe(false);
      // The isIncome cascade reads children through manager.find and writes
      // them through manager.update; neither runs for autoSign.
      expect(txManager.find).not.toHaveBeenCalled();
      expect(txManager.update).not.toHaveBeenCalled();
    });

    it("clears autoSign when the dto sets it to null", async () => {
      categoriesRepository.findOne.mockResolvedValue({
        ...mockCategory,
        autoSign: false,
      });

      const result = await service.update("user-1", "cat-1", {
        autoSign: null,
      });

      expect(result.autoSign).toBeNull();
      expect(txManager.save).toHaveBeenCalledWith(
        Category,
        expect.objectContaining({ autoSign: null }),
      );
    });

    it("leaves autoSign alone when the dto omits it", async () => {
      categoriesRepository.findOne.mockResolvedValue({
        ...mockCategory,
        autoSign: false,
      });

      const result = await service.update("user-1", "cat-1", {
        name: "Renamed",
      });

      expect(result.autoSign).toBe(false);
    });
  });

  describe("remove", () => {
    it("removes category and clears payee defaults", async () => {
      categoriesRepository.findOne.mockResolvedValue({ ...mockCategory });
      categoriesRepository.count.mockResolvedValue(0);

      // Mock getTransactionCount to return 0 so remove() proceeds
      transactionsRepository.count.mockResolvedValue(0);
      splitsRepository.createQueryBuilder.mockReturnValue(
        createMockQueryBuilder({
          getCount: jest.fn().mockResolvedValue(0),
        }),
      );
      scheduledTransactionsRepository.count.mockResolvedValue(0);
      scheduledTransactionsRepository.createQueryBuilder.mockReturnValue(
        createMockQueryBuilder({
          getMany: jest.fn().mockResolvedValue([]),
        }),
      );

      await service.remove("user-1", "cat-1");

      const manager = txManager;
      expect(manager.update).toHaveBeenCalledWith(
        Payee,
        { userId: "user-1", defaultCategoryId: "cat-1" },
        { defaultCategoryId: null },
      );
      // Must pass the explicit entity target: findOne returns a plain object
      // (spread with effectiveColor), so the single-arg form throws
      // CannotDetermineEntityError against real TypeORM.
      expect(manager.remove).toHaveBeenCalledWith(
        Category,
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
      expect(categoriesRepository.count).toHaveBeenCalledWith({
        where: { parentId: "cat-1", userId: "user-1" },
      });
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
      splitsRepository.createQueryBuilder.mockReturnValue(
        createMockQueryBuilder({
          getCount: jest.fn().mockResolvedValue(3),
        }),
      );
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

      const txQb = createMockQueryBuilder({
        getMany: jest.fn().mockResolvedValue([{ id: "tx-1" }, { id: "tx-2" }]),
      });
      const splitQb = createMockQueryBuilder({
        execute: jest.fn().mockResolvedValue({ affected: 2 }),
      });
      const stQb = createMockQueryBuilder({
        getMany: jest.fn().mockResolvedValue([{ id: "st-1" }]),
      });
      const ssQb = createMockQueryBuilder();

      let createQbCallCount = 0;
      const mockManager = {
        // findOne() runs through the same re-mocked transaction, so route
        // getRepository at the shared Category repo mock.
        getRepository: jest.fn(() => categoriesRepository),
        update: jest
          .fn()
          .mockResolvedValueOnce({ affected: 5 }) // Transaction update
          .mockResolvedValueOnce({ affected: 1 }), // ScheduledTransaction update
        createQueryBuilder: jest
          .fn()
          .mockImplementation((..._args: unknown[]) => {
            createQbCallCount++;
            // Call 1: get user transaction IDs (with entity arg)
            if (createQbCallCount === 1) return txQb;
            // Call 2: update splits (no entity arg)
            if (createQbCallCount === 2) return splitQb;
            // Call 3: get user scheduled transaction IDs (with entity arg)
            if (createQbCallCount === 3) return stQb;
            // Call 4: update scheduled splits (no entity arg)
            return ssQb;
          }),
        save: jest.fn(),
      };
      mockDataSource.transaction.mockImplementation(
        async (fn: (m: unknown) => unknown) => fn(mockManager),
      );

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

      const txQb = createMockQueryBuilder({
        getMany: jest.fn().mockResolvedValue([]),
      });
      const stQb = createMockQueryBuilder({
        getMany: jest.fn().mockResolvedValue([]),
      });

      let createQbCallCount = 0;
      const mockManager = {
        // findOne() runs through the same re-mocked transaction, so route
        // getRepository at the shared Category repo mock.
        getRepository: jest.fn(() => categoriesRepository),
        update: jest
          .fn()
          .mockResolvedValueOnce({ affected: 3 }) // Transaction update
          .mockResolvedValueOnce({ affected: 0 }), // ScheduledTransaction update
        createQueryBuilder: jest
          .fn()
          .mockImplementation((..._args: unknown[]) => {
            createQbCallCount++;
            if (createQbCallCount === 1) return txQb;
            return stQb;
          }),
        save: jest.fn(),
      };
      mockDataSource.transaction.mockImplementation(
        async (fn: (m: unknown) => unknown) => fn(mockManager),
      );

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

      const txQb = createMockQueryBuilder({
        getMany: jest.fn().mockResolvedValue([]),
      });
      const stQb = createMockQueryBuilder({
        getMany: jest.fn().mockResolvedValue([]),
      });

      let createQbCallCount = 0;
      const mockManager = {
        // findOne() runs through the same re-mocked transaction, so route
        // getRepository at the shared Category repo mock.
        getRepository: jest.fn(() => categoriesRepository),
        update: jest
          .fn()
          .mockResolvedValueOnce({ affected: 0 }) // Transaction update
          .mockResolvedValueOnce({ affected: 0 }), // ScheduledTransaction update
        createQueryBuilder: jest
          .fn()
          .mockImplementation((..._args: unknown[]) => {
            createQbCallCount++;
            if (createQbCallCount === 1) return txQb;
            return stQb;
          }),
        save: jest.fn(),
      };
      mockDataSource.transaction.mockImplementation(
        async (fn: (m: unknown) => unknown) => fn(mockManager),
      );

      const result = await service.reassignTransactions(
        "user-1",
        "cat-1",
        "cat-target",
      );

      expect(result.splitsUpdated).toBe(0);
      // createQueryBuilder is called twice (txIds + scheduledTxIds) but never for splits
      expect(mockManager.createQueryBuilder).toHaveBeenCalledTimes(2);
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
        transferCategories: 0,
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

  describe("importDefaults", () => {
    it("imports default categories when user has none", async () => {
      categoriesRepository.count.mockResolvedValue(0);
      let idCounter = 0;
      const qrRepo = categoriesRepository;
      qrRepo.create.mockImplementation((data: unknown) => ({
        ...(data as Record<string, unknown>),
        id: `gen-${++idCounter}`,
      }));
      qrRepo.save.mockImplementation((data: unknown) => Promise.resolve(data));

      const result = await service.importDefaults("user-1");

      expect(result.categoriesCreated).toBeGreaterThan(100);
      expect(qrRepo.create).toHaveBeenCalled();
      expect(qrRepo.save).toHaveBeenCalled();
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
      const qrRepo = categoriesRepository;
      qrRepo.create.mockImplementation((data: unknown) => ({
        ...(data as Record<string, unknown>),
        id: `gen-${++idCounter}`,
      }));
      qrRepo.save.mockImplementation((data: unknown) => Promise.resolve(data));

      await service.importDefaults("user-1");

      const createCalls = qrRepo.create.mock.calls.map((c: unknown[]) => c[0]);
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
      const qrRepo = categoriesRepository;
      qrRepo.create.mockImplementation((data: unknown) => ({
        ...(data as Record<string, unknown>),
        id: `gen-${++idCounter}`,
      }));
      qrRepo.save.mockImplementation((data: unknown) => Promise.resolve(data));

      await service.importDefaults("user-1");

      const createCalls = qrRepo.create.mock.calls.map((c: unknown[]) => c[0]);
      const subcategories = createCalls.filter(
        (c: Record<string, unknown>) => c.parentId,
      );

      expect(subcategories.length).toBeGreaterThan(0);
      subcategories.forEach((sub: Record<string, unknown>) => {
        expect(sub.parentId).toMatch(/^gen-/);
      });
    });

    const importedNames = async (options?: {
      country?: string;
      language?: string;
    }): Promise<string[]> => {
      categoriesRepository.count.mockResolvedValue(0);
      let idCounter = 0;
      const qrRepo = categoriesRepository;
      qrRepo.create.mockImplementation((data: unknown) => ({
        ...(data as Record<string, unknown>),
        id: `gen-${++idCounter}`,
      }));
      qrRepo.save.mockImplementation((data: unknown) => Promise.resolve(data));

      await service.importDefaults("user-1", options);

      return qrRepo.create.mock.calls.map(
        (c: unknown[]) => (c[0] as { name: string }).name,
      );
    };

    it("imports the country-neutral catalog when no country is given", async () => {
      const names = await importedNames();

      expect(names).toContain("Income Tax");
      expect(names).not.toContain("CPP/QPP Contributions");
      expect(names).not.toContain("Council Tax");
    });

    it("layers the selected country's additions over the baseline", async () => {
      const names = await importedNames({ country: "CA" });

      expect(names).toContain("CPP/QPP Contributions");
      expect(names).toContain("EI Premiums");
      expect(names).not.toContain("Income Tax");
    });

    it("falls back to the generic catalog for an unknown country", async () => {
      const names = await importedNames({ country: "ZZ" });

      expect(names).toContain("Income Tax");
      expect(names).not.toContain("Council Tax");
    });

    it("seeds names in the requested language", async () => {
      const i18n = (service as unknown as { i18n: { translate: jest.Mock } })
        .i18n;

      await importedNames({ language: "fr" });

      expect(i18n.translate).toHaveBeenCalledWith(
        "categories.defaults.taxes.name",
        expect.objectContaining({ lang: "fr" }),
      );
      // The stored preference is not consulted when a language is supplied.
      expect(preferencesRepository.findOne).not.toHaveBeenCalled();
    });

    it("falls back to the stored preference language when none is requested", async () => {
      preferencesRepository.findOne.mockResolvedValue({ language: "de" });
      const i18n = (service as unknown as { i18n: { translate: jest.Mock } })
        .i18n;

      await importedNames({ country: "US" });

      expect(preferencesRepository.findOne).toHaveBeenCalledWith({
        where: { userId: "user-1" },
      });
      expect(i18n.translate).toHaveBeenCalledWith(
        "categories.defaults.taxes.name",
        expect.objectContaining({ lang: "de" }),
      );
    });

    it("ignores an unsupported language and uses the stored preference", async () => {
      preferencesRepository.findOne.mockResolvedValue({ language: "es" });
      const i18n = (service as unknown as { i18n: { translate: jest.Mock } })
        .i18n;

      await importedNames({ language: "klingon" });

      expect(i18n.translate).toHaveBeenCalledWith(
        "categories.defaults.taxes.name",
        expect.objectContaining({ lang: "es" }),
      );
    });
  });

  describe("cross-user data isolation", () => {
    it("getTransactionCount split count query joins through transaction to filter by userId", async () => {
      categoriesRepository.findOne.mockResolvedValue(mockCategory);
      transactionsRepository.count.mockResolvedValue(0);

      const splitQb = createMockQueryBuilder({
        getCount: jest.fn().mockResolvedValue(0),
      });
      splitsRepository.createQueryBuilder.mockReturnValue(splitQb);

      const scheduledQb = createMockQueryBuilder({
        getMany: jest.fn().mockResolvedValue([]),
      });
      scheduledTransactionsRepository.count.mockResolvedValue(0);
      scheduledTransactionsRepository.createQueryBuilder.mockReturnValue(
        scheduledQb,
      );

      await service.getTransactionCount("user-1", "cat-1");

      // Verify split count joins through transaction table to filter by userId
      expect(splitQb.innerJoin).toHaveBeenCalledWith(
        "split.transaction",
        "transaction",
      );
      expect(splitQb.andWhere).toHaveBeenCalledWith(
        "transaction.userId = :userId",
        { userId: "user-1" },
      );
    });

    it("findAll split count query joins through transaction to filter by userId", async () => {
      const categories = [{ ...mockCategory, id: "cat-1" }];
      const catQb = createMockQueryBuilder({
        getMany: jest.fn().mockResolvedValue(categories),
      });
      categoriesRepository.createQueryBuilder.mockReturnValue(catQb);

      const directCountsQb = createMockQueryBuilder({
        getRawMany: jest.fn().mockResolvedValue([]),
      });
      transactionsRepository.createQueryBuilder.mockReturnValue(directCountsQb);

      const splitCountsQb = createMockQueryBuilder({
        getRawMany: jest.fn().mockResolvedValue([]),
      });
      splitsRepository.createQueryBuilder.mockReturnValue(splitCountsQb);

      await service.findAll("user-1");

      // Verify split count in findAll joins through transaction for user isolation
      expect(splitCountsQb.innerJoin).toHaveBeenCalledWith(
        "s.transaction",
        "t",
      );
      expect(splitCountsQb.where).toHaveBeenCalledWith("t.user_id = :userId", {
        userId: "user-1",
      });
    });
  });
});
