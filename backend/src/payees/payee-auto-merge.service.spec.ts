import { Test, TestingModule } from "@nestjs/testing";
import { DataSource } from "typeorm";
import { getRepositoryToken } from "@nestjs/typeorm";
import { BadRequestException } from "@nestjs/common";
import { PayeeAutoMergeService } from "./payee-auto-merge.service";
import { PayeesService } from "./payees.service";
import { Payee } from "./entities/payee.entity";
import { PayeeAlias } from "./entities/payee-alias.entity";
import { Category } from "../categories/entities/category.entity";
import { Transaction } from "../transactions/entities/transaction.entity";

const userId = "user-1";

function makePayee(
  id: string,
  name: string,
  transactionCount: number,
  defaultCategoryId: string | null = null,
  isActive = true,
): Partial<Payee> {
  return {
    id,
    name,
    transactionCount,
    defaultCategoryId,
    isActive,
  } as Partial<Payee>;
}

describe("PayeeAutoMergeService", () => {
  let service: PayeeAutoMergeService;
  let mockPayeesService: Record<string, jest.Mock>;
  let mockCategoriesRepository: Record<string, jest.Mock>;
  let mockTransactionsRepository: Record<string, jest.Mock>;
  // Rows returned by the dominant-category query; set per test.
  let dominantRows: Array<{ payeeId: string; categoryId: string; cnt: string }>;
  // Rows returned by the uncategorized-count query (manager builder); per test.
  let uncategorizedRows: Array<{ payeeId: string; cnt: string }>;
  let mockQueryRunner: any;
  let mockDataSource: { createQueryRunner: jest.Mock };

  beforeEach(async () => {
    mockPayeesService = { findAll: jest.fn() };
    mockCategoriesRepository = { find: jest.fn().mockResolvedValue([]) };
    dominantRows = [];
    uncategorizedRows = [];
    const txQueryBuilder: any = {
      select: jest.fn().mockReturnThis(),
      addSelect: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      groupBy: jest.fn().mockReturnThis(),
      addGroupBy: jest.fn().mockReturnThis(),
      getRawMany: jest
        .fn()
        .mockImplementation(() => Promise.resolve(dominantRows)),
    };
    // The uncategorized-count helper runs through the entity manager, so give
    // it its own builder returning uncategorizedRows.
    const uncatQueryBuilder: any = {
      select: jest.fn().mockReturnThis(),
      addSelect: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      groupBy: jest.fn().mockReturnThis(),
      getRawMany: jest
        .fn()
        .mockImplementation(() => Promise.resolve(uncategorizedRows)),
    };
    mockTransactionsRepository = {
      createQueryBuilder: jest.fn().mockReturnValue(txQueryBuilder),
      manager: {
        createQueryBuilder: jest.fn().mockReturnValue(uncatQueryBuilder),
      } as any,
    };

    mockQueryRunner = {
      connect: jest.fn(),
      startTransaction: jest.fn(),
      commitTransaction: jest.fn(),
      rollbackTransaction: jest.fn(),
      release: jest.fn(),
      query: jest.fn().mockResolvedValue(undefined),
      manager: {
        findOne: jest.fn(),
        find: jest.fn().mockResolvedValue([]),
        update: jest.fn().mockResolvedValue({ affected: 3 }),
        remove: jest.fn().mockResolvedValue(undefined),
        create: jest.fn().mockImplementation((_entity, data) => data),
        save: jest.fn().mockImplementation((data) => data),
        createQueryBuilder: jest.fn(),
      },
    };

    mockDataSource = {
      createQueryRunner: jest.fn().mockReturnValue(mockQueryRunner),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PayeeAutoMergeService,
        { provide: DataSource, useValue: mockDataSource },
        { provide: PayeesService, useValue: mockPayeesService },
        {
          provide: getRepositoryToken(Category),
          useValue: mockCategoriesRepository,
        },
        {
          provide: getRepositoryToken(Transaction),
          useValue: mockTransactionsRepository,
        },
      ],
    }).compile();

    service = module.get<PayeeAutoMergeService>(PayeeAutoMergeService);
  });

  describe("previewAutoMerge", () => {
    const opts = {
      minGroupSize: 2,
      similarityThreshold: 0.85,
      minTokenLength: 3,
      includeInactive: false,
      categoryMatch: "off" as const,
      ignoreCommonWords: false,
      commonWordMinVariants: 5,
    };

    it("clusters Lidl variants and picks the most-used canonical", async () => {
      mockPayeesService.findAll.mockResolvedValue([
        makePayee("p1", "Lidl", 10),
        makePayee("p2", "LIDL sp. z o.o.", 2),
        makePayee("p3", "LIDL WARSZAWA 0421", 5),
        makePayee("p4", "Tesco", 3),
      ]);

      const { groups } = await service.previewAutoMerge(userId, opts);

      expect(groups).toHaveLength(1);
      const group = groups[0];
      expect(group.groupKey).toBe("LIDL");
      expect(group.suggestedCanonicalPayeeId).toBe("p1");
      expect(group.suggestedName).toBe("Lidl");
      expect(group.suggestedAlias).toBe("*LIDL*");
      expect(group.members).toHaveLength(3);
      expect(group.totalTransactions).toBe(17);
      const canonical = group.members.find((m) => m.isCanonical);
      expect(canonical?.payeeId).toBe("p1");
      // No uncategorized rows configured, so nothing to backfill.
      expect(group.uncategorizedTransactionCount).toBe(0);
    });

    it("sums each member's uncategorized transactions for the group", async () => {
      mockPayeesService.findAll.mockResolvedValue([
        makePayee("p1", "Lidl", 10),
        makePayee("p2", "LIDL sp. z o.o.", 2),
        makePayee("p3", "LIDL WARSZAWA 0421", 5),
      ]);
      // p1 has 4 uncategorized, p3 has 2; p2 has none.
      uncategorizedRows = [
        { payeeId: "p1", cnt: "4" },
        { payeeId: "p3", cnt: "2" },
      ];

      const { groups } = await service.previewAutoMerge(userId, opts);

      expect(groups).toHaveLength(1);
      expect(groups[0].uncategorizedTransactionCount).toBe(6);
    });

    it("suggests the group's most-used transaction category", async () => {
      mockPayeesService.findAll.mockResolvedValue([
        makePayee("p1", "Lidl", 10),
        makePayee("p2", "LIDL sp. z o.o.", 2),
        makePayee("p3", "LIDL WARSZAWA 0421", 5),
      ]);
      // Aggregated across the group: groceries 10, dining 5 -> groceries wins.
      dominantRows = [
        { payeeId: "p1", categoryId: "cat-groceries", cnt: "8" },
        { payeeId: "p2", categoryId: "cat-groceries", cnt: "2" },
        { payeeId: "p3", categoryId: "cat-dining", cnt: "5" },
      ];

      const { groups } = await service.previewAutoMerge(userId, opts);

      expect(groups).toHaveLength(1);
      expect(groups[0].suggestedCategoryId).toBe("cat-groceries");
    });

    it("suggests no category when no member has categorized transactions", async () => {
      mockPayeesService.findAll.mockResolvedValue([
        makePayee("p1", "Lidl", 10),
        makePayee("p2", "LIDL sp. z o.o.", 2),
      ]);
      dominantRows = [];

      const { groups } = await service.previewAutoMerge(userId, opts);

      expect(groups).toHaveLength(1);
      expect(groups[0].suggestedCategoryId).toBeNull();
    });

    it("requests active-only payees by default", async () => {
      mockPayeesService.findAll.mockResolvedValue([]);
      await service.previewAutoMerge(userId, opts);
      expect(mockPayeesService.findAll).toHaveBeenCalledWith(userId, "active");
    });

    it("includes inactive payees when requested", async () => {
      mockPayeesService.findAll.mockResolvedValue([]);
      await service.previewAutoMerge(userId, {
        ...opts,
        includeInactive: true,
      });
      expect(mockPayeesService.findAll).toHaveBeenCalledWith(userId, "all");
    });

    it("drops groups below the minimum group size", async () => {
      mockPayeesService.findAll.mockResolvedValue([
        makePayee("p1", "Lidl", 10),
        makePayee("p2", "LIDL sp. z o.o.", 2),
        makePayee("p3", "LIDL WARSZAWA 0421", 5),
      ]);

      const { groups } = await service.previewAutoMerge(userId, {
        ...opts,
        minGroupSize: 4,
      });

      expect(groups).toHaveLength(0);
    });

    it("fuzzy-merges typo variants with different leading tokens", async () => {
      mockPayeesService.findAll.mockResolvedValue([
        makePayee("p1", "Walmart", 8),
        makePayee("p2", "Walmrt", 1),
      ]);

      const { groups } = await service.previewAutoMerge(userId, {
        ...opts,
        similarityThreshold: 0.8,
      });

      expect(groups).toHaveLength(1);
      expect(groups[0].members).toHaveLength(2);
      expect(groups[0].suggestedCanonicalPayeeId).toBe("p1");
    });

    it("groups near-token spelling variants when the threshold is lowered", async () => {
      mockPayeesService.findAll.mockResolvedValue([
        makePayee("p1", "Lidl", 10),
        makePayee("p2", "Lidi", 4),
      ]);

      // similarity("LIDL", "LIDI") === 0.75
      const { groups } = await service.previewAutoMerge(userId, {
        ...opts,
        similarityThreshold: 0.7,
      });

      expect(groups).toHaveLength(1);
      expect(groups[0].members).toHaveLength(2);
    });

    it("keeps near-token variants apart when the threshold is high", async () => {
      mockPayeesService.findAll.mockResolvedValue([
        makePayee("p1", "Lidl", 10),
        makePayee("p2", "Lidi", 4),
      ]);

      // 0.75 similarity falls below the 0.85 default, so no group forms.
      const { groups } = await service.previewAutoMerge(userId, {
        ...opts,
        similarityThreshold: 0.85,
      });

      expect(groups).toHaveLength(0);
    });

    it("only groups exact tokens at a threshold of 1", async () => {
      mockPayeesService.findAll.mockResolvedValue([
        makePayee("p1", "Lidl", 10),
        makePayee("p2", "Lidi", 4),
        makePayee("p3", "LIDL sp. z o.o.", 2),
      ]);

      const { groups } = await service.previewAutoMerge(userId, {
        ...opts,
        similarityThreshold: 1,
      });

      // p1 + p3 share the exact LIDL token; p2 (LIDI) stays out.
      expect(groups).toHaveLength(1);
      expect(groups[0].members.map((m) => m.payeeId).sort()).toEqual([
        "p1",
        "p3",
      ]);
    });

    it("ignores payees with no significant token", async () => {
      mockPayeesService.findAll.mockResolvedValue([
        makePayee("p1", "12345", 4),
        makePayee("p2", "67890", 4),
      ]);

      const { groups } = await service.previewAutoMerge(userId, opts);
      expect(groups).toHaveLength(0);
    });

    it("does not merge unrelated payees that only share a common word", async () => {
      mockPayeesService.findAll.mockResolvedValue([
        makePayee("p1", "Royal Electric", 23),
        makePayee("p2", "Royal & Sun Alliance Insurance", 15),
        makePayee("p3", "Royal City Nursery", 9),
        makePayee("p4", "Royal Cat Records", 5),
        makePayee("p5", "Royal Ontario Museum", 4),
        makePayee("p6", "Royal Sonesta Hotel", 3),
        makePayee("p7", "Royal City Pharmacy", 2),
        makePayee("p8", "Royal City Soccer Club", 2),
        makePayee("p9", "Royal Pavilion Hotel", 2),
        makePayee("p10", "Royal City Basketball Club", 1),
        makePayee("p11", "Royal City Brewing", 1),
        makePayee("p12", "Royal Distributing", 1),
        makePayee("p13", "Royal Leather Fashion", 1),
        makePayee("p14", "Royal York Hotel", 1),
      ]);

      const { groups } = await service.previewAutoMerge(userId, opts);

      // "Royal" is just a shared adjective; every payee diverges at the second
      // token, so none should be grouped together.
      expect(groups).toHaveLength(0);
    });

    it("merges true prefix elaborations even without a bare base payee", async () => {
      mockPayeesService.findAll.mockResolvedValue([
        makePayee("p1", "Royal City Nursery", 9),
        makePayee("p2", "Royal City Nursery Downtown", 3),
      ]);

      const { groups } = await service.previewAutoMerge(userId, opts);

      expect(groups).toHaveLength(1);
      expect(groups[0].members).toHaveLength(2);
      expect(groups[0].suggestedAlias).toBe("*ROYAL CITY NURSERY*");
      expect(groups[0].suggestedCanonicalPayeeId).toBe("p1");
    });

    describe("category matching", () => {
      it("keeps prefix variants apart when their subcategories differ", async () => {
        mockPayeesService.findAll.mockResolvedValue([
          makePayee("p1", "Amazon", 10, "cat-shopping"),
          makePayee("p2", "Amazon Prime", 5, "cat-digital"),
        ]);

        const { groups } = await service.previewAutoMerge(userId, {
          ...opts,
          categoryMatch: "subcategory",
        });

        expect(groups).toHaveLength(0);
      });

      it("still groups prefix variants that share a subcategory", async () => {
        mockPayeesService.findAll.mockResolvedValue([
          makePayee("p1", "Amazon", 10, "cat-shopping"),
          makePayee("p2", "Amazon Prime", 5, "cat-shopping"),
        ]);

        const { groups } = await service.previewAutoMerge(userId, {
          ...opts,
          categoryMatch: "subcategory",
        });

        expect(groups).toHaveLength(1);
        expect(groups[0].members).toHaveLength(2);
      });

      it("groups by top-level category, resolving subcategories to their root", async () => {
        // cat-books and cat-electronics are both children of cat-shopping.
        mockCategoriesRepository.find.mockResolvedValue([
          { id: "cat-shopping", parentId: null },
          { id: "cat-books", parentId: "cat-shopping" },
          { id: "cat-electronics", parentId: "cat-shopping" },
        ]);
        mockPayeesService.findAll.mockResolvedValue([
          makePayee("p1", "Amazon", 10, "cat-books"),
          makePayee("p2", "Amazon Prime", 5, "cat-electronics"),
        ]);

        const { groups } = await service.previewAutoMerge(userId, {
          ...opts,
          categoryMatch: "category",
        });

        expect(groups).toHaveLength(1);
        expect(groups[0].members).toHaveLength(2);
        expect(mockCategoriesRepository.find).toHaveBeenCalled();
      });

      it("does not load categories when matching by subcategory", async () => {
        mockPayeesService.findAll.mockResolvedValue([
          makePayee("p1", "Amazon", 10, "cat-shopping"),
          makePayee("p2", "Amazon Prime", 5, "cat-shopping"),
        ]);

        await service.previewAutoMerge(userId, {
          ...opts,
          categoryMatch: "subcategory",
        });

        expect(mockCategoriesRepository.find).not.toHaveBeenCalled();
      });

      it("does not group payees whose category is unknown (no default, no transactions)", async () => {
        mockPayeesService.findAll.mockResolvedValue([
          makePayee("p1", "Amazon", 10, null),
          makePayee("p2", "Amazon Prime", 5, null),
        ]);
        dominantRows = []; // neither payee has categorized transactions

        const { groups } = await service.previewAutoMerge(userId, {
          ...opts,
          categoryMatch: "subcategory",
        });

        // null category must not match another null category.
        expect(groups).toHaveLength(0);
      });

      it("falls back to the dominant transaction category when no default is set", async () => {
        mockPayeesService.findAll.mockResolvedValue([
          makePayee("p1", "Amazon", 10, null),
          makePayee("p2", "Amazon Prime", 5, null),
        ]);
        dominantRows = [
          { payeeId: "p1", categoryId: "cat-shopping", cnt: "8" },
          { payeeId: "p2", categoryId: "cat-shopping", cnt: "4" },
        ];

        const { groups } = await service.previewAutoMerge(userId, {
          ...opts,
          categoryMatch: "subcategory",
        });

        expect(groups).toHaveLength(1);
        expect(groups[0].members).toHaveLength(2);
      });

      it("keeps payees apart when their dominant transaction categories differ", async () => {
        mockPayeesService.findAll.mockResolvedValue([
          makePayee("p1", "Amazon", 10, null),
          makePayee("p2", "Amazon Prime", 5, null),
        ]);
        dominantRows = [
          { payeeId: "p1", categoryId: "cat-shopping", cnt: "8" },
          { payeeId: "p2", categoryId: "cat-digital", cnt: "4" },
        ];

        const { groups } = await service.previewAutoMerge(userId, {
          ...opts,
          categoryMatch: "subcategory",
        });

        expect(groups).toHaveLength(0);
      });
    });

    describe("ignore common words", () => {
      it("merges a generic-word base when the option is off", async () => {
        mockPayeesService.findAll.mockResolvedValue([
          makePayee("p1", "Cafe", 3),
          makePayee("p2", "Cafe Nero", 2),
          makePayee("p3", "Cafe Rouge", 2),
        ]);

        const { groups } = await service.previewAutoMerge(userId, opts);

        // Without the option, the bare "Cafe" anchors an over-broad group.
        expect(groups).toHaveLength(1);
        expect(groups[0].members).toHaveLength(3);
      });

      it("excludes payees anchored on a seed-list common word", async () => {
        mockPayeesService.findAll.mockResolvedValue([
          makePayee("p1", "Cafe", 3),
          makePayee("p2", "Cafe Nero", 2),
          makePayee("p3", "Cafe Rouge", 2),
        ]);

        const { groups } = await service.previewAutoMerge(userId, {
          ...opts,
          ignoreCommonWords: true,
        });

        expect(groups).toHaveLength(0);
      });

      it("auto-detects a common leading word from branching continuations", async () => {
        // "Plaza" is not in the seed list but five distinct payees branch off
        // it, so it is detected as common at the default sensitivity.
        mockPayeesService.findAll.mockResolvedValue([
          makePayee("p0", "Plaza", 9),
          makePayee("p1", "Plaza Tower", 3),
          makePayee("p2", "Plaza Heights", 3),
          makePayee("p3", "Plaza Gardens", 3),
          makePayee("p4", "Plaza Vista", 3),
          makePayee("p5", "Plaza Ridge", 3),
        ]);

        const merged = await service.previewAutoMerge(userId, opts);
        expect(merged.groups).toHaveLength(1); // off: bare Plaza over-merges

        const filtered = await service.previewAutoMerge(userId, {
          ...opts,
          ignoreCommonWords: true,
        });
        expect(filtered.groups).toHaveLength(0); // on: Plaza excluded
      });

      it("respects the sensitivity threshold for auto-detection", async () => {
        mockPayeesService.findAll.mockResolvedValue([
          makePayee("p0", "Plaza", 9),
          makePayee("p1", "Plaza Tower", 3),
          makePayee("p2", "Plaza Heights", 3),
          makePayee("p3", "Plaza Gardens", 3),
          makePayee("p4", "Plaza Vista", 3),
          makePayee("p5", "Plaza Ridge", 3),
        ]);

        // Five distinct continuations; a threshold of 6 leaves Plaza unflagged.
        const { groups } = await service.previewAutoMerge(userId, {
          ...opts,
          ignoreCommonWords: true,
          commonWordMinVariants: 6,
        });

        expect(groups).toHaveLength(1);
      });

      it("still merges a genuine brand that is not common", async () => {
        mockPayeesService.findAll.mockResolvedValue([
          makePayee("p1", "Lidl", 10),
          makePayee("p2", "LIDL sp. z o.o.", 2),
          makePayee("p3", "LIDL WARSZAWA 0421", 5),
        ]);

        const { groups } = await service.previewAutoMerge(userId, {
          ...opts,
          ignoreCommonWords: true,
        });

        expect(groups).toHaveLength(1);
        expect(groups[0].suggestedAlias).toBe("*LIDL*");
      });
    });
  });

  describe("applyAutoMerge", () => {
    beforeEach(() => {
      mockQueryRunner.manager.findOne.mockResolvedValue(
        makePayee("p1", "Lidl", 10),
      );
      mockQueryRunner.manager.find.mockImplementation((entity: unknown) => {
        if (entity === PayeeAlias) return Promise.resolve([]);
        if (entity === Payee)
          return Promise.resolve([makePayee("p2", "LIDL sp. z o.o.", 2)]);
        return Promise.resolve([]);
      });
    });

    it("merges a group and creates the wildcard alias", async () => {
      const result = await service.applyAutoMerge(userId, [
        {
          canonicalPayeeId: "p1",
          sourcePayeeIds: ["p2"],
          alias: "*LIDL*",
        },
      ]);

      expect(result).toEqual({
        groupsMerged: 1,
        payeesMerged: 1,
        transactionsMigrated: 3,
        aliasesCreated: 1,
        skippedAliases: 0,
        transactionsBackfilled: 0,
        failures: [],
      });
      expect(mockQueryRunner.commitTransaction).toHaveBeenCalled();
      expect(mockQueryRunner.manager.save).toHaveBeenCalled();
    });

    it("backfills the canonical's uncategorized transactions when requested", async () => {
      mockCategoriesRepository.find.mockResolvedValue([{ id: "cat-1" }]);

      const result = await service.applyAutoMerge(userId, [
        {
          canonicalPayeeId: "p1",
          sourcePayeeIds: ["p2"],
          alias: "*LIDL*",
          defaultCategoryId: "cat-1",
          backfillTransactions: true,
        },
      ]);

      // The mocked manager.update reports 3 affected rows for the backfill.
      expect(result.transactionsBackfilled).toBe(3);
      expect(mockQueryRunner.manager.update).toHaveBeenCalledWith(
        Transaction,
        expect.objectContaining({
          userId,
          payeeId: "p1",
          isTransfer: false,
          isSplit: false,
        }),
        { categoryId: "cat-1" },
      );
    });

    it("does not backfill when no default category is set even if requested", async () => {
      const result = await service.applyAutoMerge(userId, [
        {
          canonicalPayeeId: "p1",
          sourcePayeeIds: ["p2"],
          alias: "*LIDL*",
          backfillTransactions: true,
        },
      ]);

      expect(result.transactionsBackfilled).toBe(0);
      // No update targeting the Transaction entity with a categoryId payload.
      const backfillCalls = mockQueryRunner.manager.update.mock.calls.filter(
        (call: unknown[]) =>
          call[0] === Transaction &&
          (call[2] as { categoryId?: string }).categoryId !== undefined,
      );
      expect(backfillCalls).toHaveLength(0);
    });

    it("sets the chosen default category on the canonical", async () => {
      mockCategoriesRepository.find.mockResolvedValue([{ id: "cat-1" }]);

      await service.applyAutoMerge(userId, [
        {
          canonicalPayeeId: "p1",
          sourcePayeeIds: ["p2"],
          alias: "*LIDL*",
          defaultCategoryId: "cat-1",
        },
      ]);

      expect(mockQueryRunner.manager.update).toHaveBeenCalledWith(
        Payee,
        { id: "p1", userId },
        { defaultCategoryId: "cat-1" },
      );
    });

    it("rejects a default category not owned by the user", async () => {
      mockCategoriesRepository.find.mockResolvedValue([]); // none owned

      await expect(
        service.applyAutoMerge(userId, [
          {
            canonicalPayeeId: "p1",
            sourcePayeeIds: ["p2"],
            defaultCategoryId: "cat-not-owned",
          },
        ]),
      ).rejects.toThrow(BadRequestException);
      // Fails fast, before opening a transaction.
      expect(mockQueryRunner.startTransaction).not.toHaveBeenCalled();
    });

    it("renames the canonical and cascades the name", async () => {
      mockQueryRunner.manager.findOne.mockResolvedValue(
        makePayee("p1", "LIDL WARSZAWA 0421", 10),
      );
      mockQueryRunner.manager.createQueryBuilder.mockReturnValue({
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        getMany: jest.fn().mockResolvedValue([]),
      });

      await service.applyAutoMerge(userId, [
        {
          canonicalPayeeId: "p1",
          canonicalName: "Lidl",
          sourcePayeeIds: ["p2"],
          alias: "*LIDL*",
        },
      ]);

      expect(mockQueryRunner.manager.update).toHaveBeenCalledWith(
        Payee,
        { id: "p1", userId },
        { name: "Lidl" },
      );
    });

    it("records a rename collision as a group failure instead of aborting the batch", async () => {
      mockQueryRunner.manager.findOne.mockResolvedValue(
        makePayee("p1", "LIDL WARSZAWA 0421", 10),
      );
      mockQueryRunner.manager.createQueryBuilder.mockReturnValue({
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        getMany: jest.fn().mockResolvedValue([{ id: "other" }]),
      });

      const result = await service.applyAutoMerge(userId, [
        {
          canonicalPayeeId: "p1",
          canonicalName: "Lidl",
          sourcePayeeIds: ["p2"],
        },
      ]);

      expect(result.groupsMerged).toBe(0);
      expect(result.failures).toHaveLength(1);
      expect(result.failures[0]).toMatchObject({
        canonicalPayeeId: "p1",
        canonicalName: "Lidl",
      });
      expect(mockQueryRunner.rollbackTransaction).toHaveBeenCalled();
    });

    it("skips an alias that overlaps another payee's alias", async () => {
      mockQueryRunner.manager.find.mockImplementation((entity: unknown) => {
        if (entity === PayeeAlias)
          return Promise.resolve([
            { id: "a1", payeeId: "other-payee", alias: "*LIDL*" },
          ]);
        if (entity === Payee)
          return Promise.resolve([makePayee("p2", "LIDL sp. z o.o.", 2)]);
        return Promise.resolve([]);
      });

      const result = await service.applyAutoMerge(userId, [
        {
          canonicalPayeeId: "p1",
          sourcePayeeIds: ["p2"],
          alias: "*LIDL*",
        },
      ]);

      expect(result.aliasesCreated).toBe(0);
      expect(result.skippedAliases).toBe(1);
      expect(mockQueryRunner.commitTransaction).toHaveBeenCalled();
    });

    it("throws when a payee appears in more than one group", async () => {
      await expect(
        service.applyAutoMerge(userId, [
          { canonicalPayeeId: "p1", sourcePayeeIds: ["p2"] },
          { canonicalPayeeId: "p3", sourcePayeeIds: ["p2"] },
        ]),
      ).rejects.toThrow(BadRequestException);
    });

    it("throws when canonical is also listed as a source", async () => {
      await expect(
        service.applyAutoMerge(userId, [
          { canonicalPayeeId: "p1", sourcePayeeIds: ["p1"] },
        ]),
      ).rejects.toThrow(BadRequestException);
    });

    it("rolls back the group and records the failure when a database operation fails", async () => {
      mockQueryRunner.manager.update.mockRejectedValue(new Error("DB error"));

      const result = await service.applyAutoMerge(userId, [
        { canonicalPayeeId: "p1", sourcePayeeIds: ["p2"], alias: "*LIDL*" },
      ]);

      expect(result.groupsMerged).toBe(0);
      expect(result.failures).toHaveLength(1);
      expect(result.failures[0].reason).toContain("DB error");
      expect(mockQueryRunner.rollbackTransaction).toHaveBeenCalled();
    });

    it("continues merging the remaining groups when one group fails", async () => {
      // First group's update throws; the second must still be attempted and
      // succeed, and the failure of the first must be reported (not thrown).
      mockQueryRunner.manager.findOne
        .mockResolvedValueOnce(makePayee("p1", "Lidl", 10))
        .mockResolvedValueOnce(makePayee("p3", "Biedronka", 8));
      mockQueryRunner.manager.update
        .mockRejectedValueOnce(new Error("boom on group 1"))
        .mockResolvedValue({ affected: 3 });

      const result = await service.applyAutoMerge(userId, [
        { canonicalPayeeId: "p1", sourcePayeeIds: ["p2"], alias: "*LIDL*" },
        {
          canonicalPayeeId: "p3",
          sourcePayeeIds: ["p4"],
          alias: "*BIEDRONKA*",
        },
      ]);

      expect(result.groupsMerged).toBe(1);
      expect(result.failures).toHaveLength(1);
      expect(result.failures[0].canonicalPayeeId).toBe("p1");
    });
  });
});
