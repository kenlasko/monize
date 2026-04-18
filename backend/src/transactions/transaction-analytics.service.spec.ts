import { Test, TestingModule } from "@nestjs/testing";
import { getRepositoryToken } from "@nestjs/typeorm";
import { Brackets } from "typeorm";
import { TransactionAnalyticsService } from "./transaction-analytics.service";
import { Transaction } from "./entities/transaction.entity";
import { Category } from "../categories/entities/category.entity";

describe("TransactionAnalyticsService", () => {
  let service: TransactionAnalyticsService;
  let transactionsRepository: Record<string, jest.Mock>;
  let categoriesRepository: Record<string, jest.Mock>;

  const userId = "user-1";

  let mockQueryBuilder: Record<string, jest.Mock>;

  beforeEach(async () => {
    mockQueryBuilder = {} as Record<string, jest.Mock>;
    const executeBrackets = (condition: unknown) => {
      if (condition instanceof Brackets) {
        (condition as any).whereFactory(mockQueryBuilder);
      }
    };
    Object.assign(mockQueryBuilder, {
      select: jest.fn().mockReturnValue(mockQueryBuilder),
      addSelect: jest.fn().mockReturnValue(mockQueryBuilder),
      where: jest.fn().mockImplementation((condition: unknown) => {
        executeBrackets(condition);
        return mockQueryBuilder;
      }),
      andWhere: jest.fn().mockImplementation((condition: unknown) => {
        executeBrackets(condition);
        return mockQueryBuilder;
      }),
      orWhere: jest.fn().mockImplementation((condition: unknown) => {
        executeBrackets(condition);
        return mockQueryBuilder;
      }),
      leftJoin: jest.fn().mockReturnValue(mockQueryBuilder),
      groupBy: jest.fn().mockReturnValue(mockQueryBuilder),
      addGroupBy: jest.fn().mockReturnValue(mockQueryBuilder),
      orderBy: jest.fn().mockReturnValue(mockQueryBuilder),
      setParameter: jest.fn().mockReturnValue(mockQueryBuilder),
      getRawMany: jest.fn().mockResolvedValue([]),
    });

    transactionsRepository = {
      createQueryBuilder: jest.fn().mockReturnValue(mockQueryBuilder),
    };

    categoriesRepository = {
      find: jest.fn().mockResolvedValue([]),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TransactionAnalyticsService,
        {
          provide: getRepositoryToken(Transaction),
          useValue: transactionsRepository,
        },
        {
          provide: getRepositoryToken(Category),
          useValue: categoriesRepository,
        },
      ],
    }).compile();

    service = module.get<TransactionAnalyticsService>(
      TransactionAnalyticsService,
    );
  });

  describe("getSummary", () => {
    it("returns zeroed summary when no transactions exist", async () => {
      mockQueryBuilder.getRawMany.mockResolvedValue([]);

      const result = await service.getSummary(userId);

      expect(result).toEqual({
        totalIncome: 0,
        totalExpenses: 0,
        netCashFlow: 0,
        transactionCount: 0,
        byCurrency: {},
      });
    });

    it("aggregates single currency data correctly", async () => {
      mockQueryBuilder.getRawMany.mockResolvedValue([
        {
          currencyCode: "USD",
          totalIncome: "1500.00",
          totalExpenses: "800.50",
          transactionCount: "25",
        },
      ]);

      const result = await service.getSummary(userId);

      expect(result.totalIncome).toBe(1500);
      expect(result.totalExpenses).toBe(800.5);
      expect(result.netCashFlow).toBe(699.5);
      expect(result.transactionCount).toBe(25);
      expect(result.byCurrency).toEqual({
        USD: {
          totalIncome: 1500,
          totalExpenses: 800.5,
          netCashFlow: 699.5,
          transactionCount: 25,
        },
      });
    });

    it("aggregates multiple currencies correctly", async () => {
      mockQueryBuilder.getRawMany.mockResolvedValue([
        {
          currencyCode: "USD",
          totalIncome: "1000",
          totalExpenses: "500",
          transactionCount: "10",
        },
        {
          currencyCode: "EUR",
          totalIncome: "2000",
          totalExpenses: "1200",
          transactionCount: "15",
        },
      ]);

      const result = await service.getSummary(userId);

      expect(result.totalIncome).toBe(3000);
      expect(result.totalExpenses).toBe(1700);
      expect(result.netCashFlow).toBe(1300);
      expect(result.transactionCount).toBe(25);

      expect(result.byCurrency.USD).toEqual({
        totalIncome: 1000,
        totalExpenses: 500,
        netCashFlow: 500,
        transactionCount: 10,
      });
      expect(result.byCurrency.EUR).toEqual({
        totalIncome: 2000,
        totalExpenses: 1200,
        netCashFlow: 800,
        transactionCount: 15,
      });
    });

    it("handles null values in raw query results", async () => {
      mockQueryBuilder.getRawMany.mockResolvedValue([
        {
          currencyCode: "USD",
          totalIncome: null,
          totalExpenses: null,
          transactionCount: null,
        },
      ]);

      const result = await service.getSummary(userId);

      expect(result.totalIncome).toBe(0);
      expect(result.totalExpenses).toBe(0);
      expect(result.netCashFlow).toBe(0);
      expect(result.transactionCount).toBe(0);
      expect(result.byCurrency.USD).toEqual({
        totalIncome: 0,
        totalExpenses: 0,
        netCashFlow: 0,
        transactionCount: 0,
      });
    });

    it("skips rows with null currencyCode in byCurrency map", async () => {
      mockQueryBuilder.getRawMany.mockResolvedValue([
        {
          currencyCode: null,
          totalIncome: "100",
          totalExpenses: "50",
          transactionCount: "3",
        },
      ]);

      const result = await service.getSummary(userId);

      // Totals should still be aggregated
      expect(result.totalIncome).toBe(100);
      expect(result.totalExpenses).toBe(50);
      expect(result.transactionCount).toBe(3);
      // But byCurrency should not have a null key
      expect(result.byCurrency).toEqual({});
    });

    it("always filters by userId", async () => {
      await service.getSummary(userId);

      expect(mockQueryBuilder.where).toHaveBeenCalledWith(
        "transaction.userId = :userId",
        { userId },
      );
    });

    it("always joins account table", async () => {
      await service.getSummary(userId);

      expect(mockQueryBuilder.leftJoin).toHaveBeenCalledWith(
        "transaction.account",
        "summaryAccount",
      );
    });

    it("groups results by currencyCode", async () => {
      await service.getSummary(userId);

      expect(mockQueryBuilder.groupBy).toHaveBeenCalledWith(
        "transaction.currencyCode",
      );
    });

    describe("account exclusion", () => {
      it("excludes investment brokerage accounts", async () => {
        await service.getSummary(userId);

        expect(mockQueryBuilder.andWhere).toHaveBeenCalledWith(
          "(summaryAccount.accountSubType IS NULL OR summaryAccount.accountSubType != 'INVESTMENT_BROKERAGE')",
        );
      });

      it("does not exclude transfers by default", async () => {
        await service.getSummary(userId);

        expect(mockQueryBuilder.andWhere).not.toHaveBeenCalledWith(
          "transaction.isTransfer = false",
        );
      });
    });

    describe("excludeTransfers flag", () => {
      const TRANSFER_EXCLUSION = "transaction.isTransfer = false";

      it("does not apply the transfer exclusion by default", async () => {
        await service.getSummary(userId);

        expect(mockQueryBuilder.andWhere).not.toHaveBeenCalledWith(
          TRANSFER_EXCLUSION,
        );
      });

      it("applies the transfer exclusion when the flag is true", async () => {
        await service.getSummary(
          userId,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          true,
        );

        expect(mockQueryBuilder.andWhere).toHaveBeenCalledWith(
          TRANSFER_EXCLUSION,
        );
      });

      it("does not apply the exclusion when the flag is explicitly false", async () => {
        await service.getSummary(
          userId,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          false,
        );

        expect(mockQueryBuilder.andWhere).not.toHaveBeenCalledWith(
          TRANSFER_EXCLUSION,
        );
      });
    });

    describe("excludeInvestmentLinked flag", () => {
      const INVESTMENT_EXCLUSION =
        "NOT EXISTS (SELECT 1 FROM investment_transactions it WHERE it.transaction_id = transaction.id)";

      it("does not apply the investment-linked exclusion by default", async () => {
        await service.getSummary(userId);

        expect(mockQueryBuilder.andWhere).not.toHaveBeenCalledWith(
          INVESTMENT_EXCLUSION,
        );
      });

      it("applies the investment-linked exclusion when the flag is true", async () => {
        await service.getSummary(
          userId,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          true,
        );

        expect(mockQueryBuilder.andWhere).toHaveBeenCalledWith(
          INVESTMENT_EXCLUSION,
        );
      });

      it("does not apply the exclusion when the flag is explicitly false", async () => {
        await service.getSummary(
          userId,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          false,
        );

        expect(mockQueryBuilder.andWhere).not.toHaveBeenCalledWith(
          INVESTMENT_EXCLUSION,
        );
      });
    });

    describe("accountIds filter", () => {
      it("applies accountIds filter when provided", async () => {
        await service.getSummary(userId, ["acc-1", "acc-2"]);

        expect(mockQueryBuilder.andWhere).toHaveBeenCalledWith(
          "transaction.accountId IN (:...accountIds)",
          { accountIds: ["acc-1", "acc-2"] },
        );
      });

      it("does not apply accountIds filter when array is empty", async () => {
        await service.getSummary(userId, []);

        expect(mockQueryBuilder.andWhere).not.toHaveBeenCalledWith(
          "transaction.accountId IN (:...accountIds)",
          expect.anything(),
        );
      });

      it("does not apply accountIds filter when undefined", async () => {
        await service.getSummary(userId, undefined);

        expect(mockQueryBuilder.andWhere).not.toHaveBeenCalledWith(
          "transaction.accountId IN (:...accountIds)",
          expect.anything(),
        );
      });
    });

    describe("date range filter", () => {
      it("applies startDate filter when provided", async () => {
        await service.getSummary(userId, undefined, "2026-01-01");

        expect(mockQueryBuilder.andWhere).toHaveBeenCalledWith(
          "transaction.transactionDate >= :startDate",
          { startDate: "2026-01-01" },
        );
      });

      it("applies endDate filter when provided", async () => {
        await service.getSummary(userId, undefined, undefined, "2026-12-31");

        expect(mockQueryBuilder.andWhere).toHaveBeenCalledWith(
          "transaction.transactionDate <= :endDate",
          { endDate: "2026-12-31" },
        );
      });

      it("applies both startDate and endDate when provided", async () => {
        await service.getSummary(userId, undefined, "2026-01-01", "2026-06-30");

        expect(mockQueryBuilder.andWhere).toHaveBeenCalledWith(
          "transaction.transactionDate >= :startDate",
          { startDate: "2026-01-01" },
        );
        expect(mockQueryBuilder.andWhere).toHaveBeenCalledWith(
          "transaction.transactionDate <= :endDate",
          { endDate: "2026-06-30" },
        );
      });

      it("does not apply date filters when not provided", async () => {
        await service.getSummary(userId);

        expect(mockQueryBuilder.andWhere).not.toHaveBeenCalledWith(
          "transaction.transactionDate >= :startDate",
          expect.anything(),
        );
        expect(mockQueryBuilder.andWhere).not.toHaveBeenCalledWith(
          "transaction.transactionDate <= :endDate",
          expect.anything(),
        );
      });
    });

    describe("categoryIds filter", () => {
      it("applies regular category filter with child categories", async () => {
        categoriesRepository.find.mockResolvedValue([
          { id: "cat-1", parentId: null },
          { id: "cat-1-child", parentId: "cat-1" },
          { id: "cat-1-grandchild", parentId: "cat-1-child" },
          { id: "cat-2", parentId: null },
        ]);

        await service.getSummary(userId, undefined, undefined, undefined, [
          "cat-1",
        ]);

        expect(categoriesRepository.find).toHaveBeenCalledWith({
          where: { userId },
          select: ["id", "parentId"],
        });

        // Should pass category IDs inline via Brackets
        expect(mockQueryBuilder.where).toHaveBeenCalledWith(
          "transaction.categoryId IN (:...summaryCategoryIds)",
          {
            summaryCategoryIds: expect.arrayContaining([
              "cat-1",
              "cat-1-child",
              "cat-1-grandchild",
            ]),
          },
        );

        // Should join splits for category matching
        expect(mockQueryBuilder.leftJoin).toHaveBeenCalledWith(
          "transaction.splits",
          "splits",
        );
      });

      it("handles uncategorized filter", async () => {
        await service.getSummary(userId, undefined, undefined, undefined, [
          "uncategorized",
        ]);

        expect(mockQueryBuilder.leftJoin).toHaveBeenCalledWith(
          "transaction.account",
          "summaryAccount",
        );

        // Uncategorized condition is now inside a Brackets callback
        expect(mockQueryBuilder.andWhere).toHaveBeenCalledWith(
          expect.any(Brackets),
        );
        expect(mockQueryBuilder.where).toHaveBeenCalledWith(
          expect.stringContaining("transaction.categoryId IS NULL"),
        );
      });

      it("handles transfer filter", async () => {
        await service.getSummary(userId, undefined, undefined, undefined, [
          "transfer",
        ]);

        // Transfer condition is now inside a Brackets callback
        expect(mockQueryBuilder.andWhere).toHaveBeenCalledWith(
          expect.any(Brackets),
        );
        expect(mockQueryBuilder.where).toHaveBeenCalledWith(
          "transaction.isTransfer = true",
        );
      });

      it("handles combined uncategorized, transfer, and regular category filters", async () => {
        categoriesRepository.find.mockResolvedValue([
          { id: "cat-1", parentId: null },
        ]);

        await service.getSummary(userId, undefined, undefined, undefined, [
          "uncategorized",
          "transfer",
          "cat-1",
        ]);

        // All three conditions should be OR-ed together via Brackets
        expect(mockQueryBuilder.andWhere).toHaveBeenCalledWith(
          expect.any(Brackets),
        );
        // Uncategorized is the first condition (uses where)
        expect(mockQueryBuilder.where).toHaveBeenCalledWith(
          expect.stringContaining("transaction.categoryId IS NULL"),
        );
        // Transfer and category conditions use orWhere
        expect(mockQueryBuilder.orWhere).toHaveBeenCalledWith(
          "transaction.isTransfer = true",
        );

        // Splits join for regular categories
        expect(mockQueryBuilder.leftJoin).toHaveBeenCalledWith(
          "transaction.splits",
          "splits",
        );
      });

      it("does not apply category filter when array is empty", async () => {
        await service.getSummary(userId, undefined, undefined, undefined, []);

        expect(categoriesRepository.find).not.toHaveBeenCalled();
      });

      it("does not apply category filter when undefined", async () => {
        await service.getSummary(userId);

        expect(categoriesRepository.find).not.toHaveBeenCalled();
      });

      it("uses split-aware amounts when category filter joins splits", async () => {
        categoriesRepository.find.mockResolvedValue([
          { id: "cat-1", parentId: null },
        ]);

        await service.getSummary(userId, undefined, undefined, undefined, [
          "cat-1",
        ]);

        // Should use COALESCE(splits.amount, transaction.amount) in aggregations
        expect(mockQueryBuilder.addSelect).toHaveBeenCalledWith(
          expect.stringContaining(
            "COALESCE(splits.amount, transaction.amount)",
          ),
          "totalIncome",
        );
        expect(mockQueryBuilder.addSelect).toHaveBeenCalledWith(
          expect.stringContaining(
            "COALESCE(splits.amount, transaction.amount)",
          ),
          "totalExpenses",
        );
        // Should count distinct transactions to avoid double-counting
        expect(mockQueryBuilder.addSelect).toHaveBeenCalledWith(
          "COUNT(DISTINCT transaction.id)",
          "transactionCount",
        );
      });

      it("always uses split-aware amounts even with no category filter", async () => {
        await service.getSummary(userId);

        // Summary must expand split parents so mixed-sign splits are
        // bucketed into the correct income/expense direction per split.
        expect(mockQueryBuilder.addSelect).toHaveBeenCalledWith(
          expect.stringContaining(
            "COALESCE(splits.amount, transaction.amount)",
          ),
          "totalIncome",
        );
        expect(mockQueryBuilder.addSelect).toHaveBeenCalledWith(
          expect.stringContaining(
            "COALESCE(splits.amount, transaction.amount)",
          ),
          "totalExpenses",
        );
        expect(mockQueryBuilder.addSelect).toHaveBeenCalledWith(
          "COUNT(DISTINCT transaction.id)",
          "transactionCount",
        );
      });

      it("uses split-aware amounts with uncategorized/transfer filters", async () => {
        await service.getSummary(userId, undefined, undefined, undefined, [
          "uncategorized",
          "transfer",
        ]);

        expect(mockQueryBuilder.addSelect).toHaveBeenCalledWith(
          expect.stringContaining(
            "COALESCE(splits.amount, transaction.amount)",
          ),
          "totalIncome",
        );
        expect(mockQueryBuilder.addSelect).toHaveBeenCalledWith(
          expect.stringContaining(
            "COALESCE(splits.amount, transaction.amount)",
          ),
          "totalExpenses",
        );
      });

      it("always joins splits table for split-aware aggregation", async () => {
        await service.getSummary(userId);

        expect(mockQueryBuilder.leftJoin).toHaveBeenCalledWith(
          "transaction.splits",
          "splits",
        );
      });

      it("filters out transfer splits to exclude them from totals", async () => {
        await service.getSummary(userId);

        expect(mockQueryBuilder.andWhere).toHaveBeenCalledWith(
          "(splits.transferAccountId IS NULL OR splits.id IS NULL)",
        );
      });

      it("deduplicates category IDs including children", async () => {
        categoriesRepository.find.mockResolvedValue([
          { id: "cat-1", parentId: null },
          { id: "cat-child", parentId: "cat-1" },
        ]);

        // Pass cat-1 and cat-child separately -- cat-child is a child of cat-1
        // so it should appear in the resolved set from cat-1 already
        await service.getSummary(userId, undefined, undefined, undefined, [
          "cat-1",
          "cat-child",
        ]);

        // Find the where call that passes summaryCategoryIds inline
        const whereCall = mockQueryBuilder.where.mock.calls.find(
          (call: unknown[]) =>
            typeof call[0] === "string" &&
            (call[0] as string).includes("summaryCategoryIds"),
        );
        expect(whereCall).toBeDefined();
        const ids = (whereCall[1] as { summaryCategoryIds: string[] })
          .summaryCategoryIds;
        // Should be deduplicated (cat-child appears only once)
        const uniqueIds = [...new Set(ids)];
        expect(ids.length).toBe(uniqueIds.length);
      });
    });

    describe("payeeIds filter", () => {
      it("applies payeeIds filter when provided", async () => {
        await service.getSummary(
          userId,
          undefined,
          undefined,
          undefined,
          undefined,
          ["payee-1", "payee-2"],
        );

        expect(mockQueryBuilder.andWhere).toHaveBeenCalledWith(
          "transaction.payeeId IN (:...payeeIds)",
          { payeeIds: ["payee-1", "payee-2"] },
        );
      });

      it("does not apply payeeIds filter when empty", async () => {
        await service.getSummary(
          userId,
          undefined,
          undefined,
          undefined,
          undefined,
          [],
        );

        expect(mockQueryBuilder.andWhere).not.toHaveBeenCalledWith(
          "transaction.payeeId IN (:...payeeIds)",
          expect.anything(),
        );
      });
    });

    describe("search filter", () => {
      it("applies search filter with ILIKE pattern", async () => {
        await service.getSummary(
          userId,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          "grocery",
        );

        expect(mockQueryBuilder.andWhere).toHaveBeenCalledWith(
          "(transaction.description ILIKE :search OR transaction.payeeName ILIKE :search OR splits.memo ILIKE :search)",
          { search: "%grocery%" },
        );
      });

      it("trims whitespace from search term", async () => {
        await service.getSummary(
          userId,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          "  coffee  ",
        );

        expect(mockQueryBuilder.andWhere).toHaveBeenCalledWith(
          "(transaction.description ILIKE :search OR transaction.payeeName ILIKE :search OR splits.memo ILIKE :search)",
          { search: "%coffee%" },
        );
      });

      it("joins splits table for search when no categoryIds filter", async () => {
        await service.getSummary(
          userId,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          "test",
        );

        expect(mockQueryBuilder.leftJoin).toHaveBeenCalledWith(
          "transaction.splits",
          "splits",
        );
      });

      it("does not re-join splits when categoryIds already caused a join", async () => {
        categoriesRepository.find.mockResolvedValue([
          { id: "cat-1", parentId: null },
        ]);

        await service.getSummary(
          userId,
          undefined,
          undefined,
          undefined,
          ["cat-1"],
          undefined,
          "test",
        );

        // splits join should only be called once (from the categoryIds handling)
        const splitsJoinCalls = mockQueryBuilder.leftJoin.mock.calls.filter(
          (call: unknown[]) =>
            call[0] === "transaction.splits" && call[1] === "splits",
        );
        expect(splitsJoinCalls.length).toBe(1);
      });

      it("does not apply search filter for empty string", async () => {
        await service.getSummary(
          userId,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          "",
        );

        expect(mockQueryBuilder.andWhere).not.toHaveBeenCalledWith(
          expect.stringContaining("ILIKE"),
          expect.anything(),
        );
      });

      it("does not apply search filter for whitespace-only string", async () => {
        await service.getSummary(
          userId,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          "   ",
        );

        expect(mockQueryBuilder.andWhere).not.toHaveBeenCalledWith(
          expect.stringContaining("ILIKE"),
          expect.anything(),
        );
      });
    });

    describe("combined filters", () => {
      it("applies all filters simultaneously", async () => {
        categoriesRepository.find.mockResolvedValue([
          { id: "cat-1", parentId: null },
        ]);

        await service.getSummary(
          userId,
          ["acc-1"],
          "2026-01-01",
          "2026-12-31",
          ["cat-1"],
          ["payee-1"],
          "rent",
        );

        expect(mockQueryBuilder.where).toHaveBeenCalledWith(
          "transaction.userId = :userId",
          { userId },
        );
        expect(mockQueryBuilder.andWhere).toHaveBeenCalledWith(
          "transaction.accountId IN (:...accountIds)",
          { accountIds: ["acc-1"] },
        );
        expect(mockQueryBuilder.andWhere).toHaveBeenCalledWith(
          "transaction.transactionDate >= :startDate",
          { startDate: "2026-01-01" },
        );
        expect(mockQueryBuilder.andWhere).toHaveBeenCalledWith(
          "transaction.transactionDate <= :endDate",
          { endDate: "2026-12-31" },
        );
        expect(mockQueryBuilder.andWhere).toHaveBeenCalledWith(
          "transaction.payeeId IN (:...payeeIds)",
          { payeeIds: ["payee-1"] },
        );
        expect(mockQueryBuilder.andWhere).toHaveBeenCalledWith(
          expect.stringContaining("ILIKE"),
          { search: "%rent%" },
        );
      });

      it("handles only accountIds and date filters without categories", async () => {
        mockQueryBuilder.getRawMany.mockResolvedValue([
          {
            currencyCode: "CAD",
            totalIncome: "3000",
            totalExpenses: "2000",
            transactionCount: "40",
          },
        ]);

        const result = await service.getSummary(
          userId,
          ["acc-1", "acc-2"],
          "2026-06-01",
          "2026-06-30",
        );

        expect(result.totalIncome).toBe(3000);
        expect(result.totalExpenses).toBe(2000);
        expect(result.netCashFlow).toBe(1000);
        expect(result.transactionCount).toBe(40);
        expect(result.byCurrency.CAD.totalIncome).toBe(3000);
      });
    });

    describe("getCategoryIdsWithChildren (via getSummary)", () => {
      it("resolves a flat category with no children", async () => {
        categoriesRepository.find.mockResolvedValue([
          { id: "cat-1", parentId: null },
          { id: "cat-2", parentId: null },
        ]);

        await service.getSummary(userId, undefined, undefined, undefined, [
          "cat-1",
        ]);

        expect(mockQueryBuilder.where).toHaveBeenCalledWith(
          "transaction.categoryId IN (:...summaryCategoryIds)",
          { summaryCategoryIds: ["cat-1"] },
        );
      });

      it("resolves a category with deeply nested children", async () => {
        categoriesRepository.find.mockResolvedValue([
          { id: "root", parentId: null },
          { id: "child-1", parentId: "root" },
          { id: "child-2", parentId: "root" },
          { id: "grandchild-1", parentId: "child-1" },
          { id: "great-grandchild", parentId: "grandchild-1" },
        ]);

        await service.getSummary(userId, undefined, undefined, undefined, [
          "root",
        ]);

        expect(mockQueryBuilder.where).toHaveBeenCalledWith(
          "transaction.categoryId IN (:...summaryCategoryIds)",
          {
            summaryCategoryIds: expect.arrayContaining([
              "root",
              "child-1",
              "child-2",
              "grandchild-1",
              "great-grandchild",
            ]),
          },
        );
      });

      it("resolves multiple independent categories with their children", async () => {
        categoriesRepository.find.mockResolvedValue([
          { id: "cat-a", parentId: null },
          { id: "cat-a-child", parentId: "cat-a" },
          { id: "cat-b", parentId: null },
          { id: "cat-b-child", parentId: "cat-b" },
        ]);

        await service.getSummary(userId, undefined, undefined, undefined, [
          "cat-a",
          "cat-b",
        ]);

        expect(mockQueryBuilder.where).toHaveBeenCalledWith(
          "transaction.categoryId IN (:...summaryCategoryIds)",
          {
            summaryCategoryIds: expect.arrayContaining([
              "cat-a",
              "cat-a-child",
              "cat-b",
              "cat-b-child",
            ]),
          },
        );
      });

      it("does not include unrelated categories in resolution", async () => {
        categoriesRepository.find.mockResolvedValue([
          { id: "cat-1", parentId: null },
          { id: "cat-1-child", parentId: "cat-1" },
          { id: "cat-2", parentId: null },
          { id: "cat-2-child", parentId: "cat-2" },
        ]);

        await service.getSummary(userId, undefined, undefined, undefined, [
          "cat-1",
        ]);

        const whereCall = mockQueryBuilder.where.mock.calls.find(
          (call: unknown[]) =>
            typeof call[0] === "string" &&
            (call[0] as string).includes("summaryCategoryIds"),
        );
        const ids = (whereCall[1] as { summaryCategoryIds: string[] })
          .summaryCategoryIds;
        expect(ids).toContain("cat-1");
        expect(ids).toContain("cat-1-child");
        expect(ids).not.toContain("cat-2");
        expect(ids).not.toContain("cat-2-child");
      });
    });
  });

  describe("getTransfersByAccount", () => {
    it("filters to transfer rows in the requested date range", async () => {
      mockQueryBuilder.getRawMany.mockResolvedValue([]);

      await service.getTransfersByAccount(userId, "2026-01-01", "2026-01-31");

      expect(mockQueryBuilder.andWhere).toHaveBeenCalledWith(
        "t.isTransfer = true",
      );
      expect(mockQueryBuilder.andWhere).toHaveBeenCalledWith(
        "t.transactionDate >= :startDate",
        { startDate: "2026-01-01" },
      );
      expect(mockQueryBuilder.andWhere).toHaveBeenCalledWith(
        "t.transactionDate <= :endDate",
        { endDate: "2026-01-31" },
      );
      expect(mockQueryBuilder.andWhere).toHaveBeenCalledWith(
        "t.status != 'VOID'",
      );
    });

    it("aggregates inbound, outbound, net, and count per account", async () => {
      mockQueryBuilder.getRawMany.mockResolvedValue([
        {
          accountName: "Chequing",
          currencyCode: "USD",
          inbound: "0",
          outbound: "1500",
          count: "3",
        },
        {
          accountName: "Savings",
          currencyCode: "USD",
          inbound: "1500",
          outbound: "0",
          count: "3",
        },
      ]);

      const result = await service.getTransfersByAccount(
        userId,
        "2026-01-01",
        "2026-01-31",
      );

      expect(result.accounts).toHaveLength(2);
      expect(result.accounts[0]).toMatchObject({
        accountName: "Chequing",
        currency: "USD",
        inbound: 0,
        outbound: 1500,
        net: -1500,
        transferCount: 3,
      });
      expect(result.totalInbound).toBe(1500);
      expect(result.totalOutbound).toBe(1500);
      expect(result.transferCount).toBe(6);
    });

    it("applies accountIds filter when provided", async () => {
      mockQueryBuilder.getRawMany.mockResolvedValue([]);

      await service.getTransfersByAccount(userId, "2026-01-01", "2026-01-31", [
        "acc-1",
        "acc-2",
      ]);

      expect(mockQueryBuilder.andWhere).toHaveBeenCalledWith(
        "t.accountId IN (:...accountIds)",
        { accountIds: ["acc-1", "acc-2"] },
      );
    });

    it("returns zeroed totals when there are no transfers", async () => {
      mockQueryBuilder.getRawMany.mockResolvedValue([]);

      const result = await service.getTransfersByAccount(
        userId,
        "2026-01-01",
        "2026-01-31",
      );

      expect(result.accounts).toEqual([]);
      expect(result.totalInbound).toBe(0);
      expect(result.totalOutbound).toBe(0);
      expect(result.transferCount).toBe(0);
    });
  });

  describe("getMonthlyTotals", () => {
    it("returns empty array when no transactions exist", async () => {
      mockQueryBuilder.getRawMany.mockResolvedValue([]);

      const result = await service.getMonthlyTotals(userId);

      expect(result).toEqual([]);
    });

    it("returns monthly totals sorted by month", async () => {
      mockQueryBuilder.getRawMany.mockResolvedValue([
        { month: "2025-01", total: "-500.50", count: "10" },
        { month: "2025-02", total: "-300.25", count: "8" },
        { month: "2025-03", total: "200.00", count: "5" },
      ]);

      const result = await service.getMonthlyTotals(userId);

      expect(result).toEqual([
        { month: "2025-01", total: -500.5, count: 10 },
        { month: "2025-02", total: -300.25, count: 8 },
        { month: "2025-03", total: 200, count: 5 },
      ]);
    });

    it("rounds totals to two decimal places", async () => {
      mockQueryBuilder.getRawMany.mockResolvedValue([
        { month: "2025-01", total: "-123.456", count: "3" },
      ]);

      const result = await service.getMonthlyTotals(userId);

      expect(result[0].total).toBe(-123.46);
    });

    it("handles null values in raw query results", async () => {
      mockQueryBuilder.getRawMany.mockResolvedValue([
        { month: "2025-01", total: null, count: null },
      ]);

      const result = await service.getMonthlyTotals(userId);

      expect(result[0]).toEqual({ month: "2025-01", total: 0, count: 0 });
    });

    it("always filters by userId", async () => {
      await service.getMonthlyTotals(userId);

      expect(mockQueryBuilder.where).toHaveBeenCalledWith(
        "transaction.userId = :userId",
        { userId },
      );
    });

    it("groups by month and orders ascending", async () => {
      await service.getMonthlyTotals(userId);

      expect(mockQueryBuilder.groupBy).toHaveBeenCalledWith("month");
      expect(mockQueryBuilder.orderBy).toHaveBeenCalledWith("month", "ASC");
    });

    it("excludes investment brokerage accounts", async () => {
      await service.getMonthlyTotals(userId);

      expect(mockQueryBuilder.andWhere).toHaveBeenCalledWith(
        "(summaryAccount.accountSubType IS NULL OR summaryAccount.accountSubType != 'INVESTMENT_BROKERAGE')",
      );
    });

    it("does not exclude transfers", async () => {
      await service.getMonthlyTotals(userId);

      expect(mockQueryBuilder.andWhere).not.toHaveBeenCalledWith(
        "transaction.isTransfer = false",
      );
    });

    it("applies accountIds filter when provided", async () => {
      await service.getMonthlyTotals(userId, ["acc-1", "acc-2"]);

      expect(mockQueryBuilder.andWhere).toHaveBeenCalledWith(
        "transaction.accountId IN (:...accountIds)",
        { accountIds: ["acc-1", "acc-2"] },
      );
    });

    it("applies date range filters when provided", async () => {
      await service.getMonthlyTotals(
        userId,
        undefined,
        "2025-01-01",
        "2025-12-31",
      );

      expect(mockQueryBuilder.andWhere).toHaveBeenCalledWith(
        "transaction.transactionDate >= :startDate",
        { startDate: "2025-01-01" },
      );
      expect(mockQueryBuilder.andWhere).toHaveBeenCalledWith(
        "transaction.transactionDate <= :endDate",
        { endDate: "2025-12-31" },
      );
    });

    it("applies categoryIds filter with child resolution", async () => {
      categoriesRepository.find.mockResolvedValue([
        { id: "cat-1", parentId: null },
        { id: "cat-child", parentId: "cat-1" },
      ]);

      await service.getMonthlyTotals(userId, undefined, undefined, undefined, [
        "cat-1",
      ]);

      expect(mockQueryBuilder.where).toHaveBeenCalledWith(
        "transaction.categoryId IN (:...monthlyCategoryIds)",
        {
          monthlyCategoryIds: expect.arrayContaining(["cat-1", "cat-child"]),
        },
      );
    });

    it("uses split-aware amounts when category filter joins splits", async () => {
      categoriesRepository.find.mockResolvedValue([
        { id: "cat-1", parentId: null },
      ]);

      await service.getMonthlyTotals(userId, undefined, undefined, undefined, [
        "cat-1",
      ]);

      // Should use COALESCE(splits.amount, transaction.amount)
      expect(mockQueryBuilder.addSelect).toHaveBeenCalledWith(
        expect.stringContaining("COALESCE(splits.amount, transaction.amount)"),
        "total",
      );
      // Should count distinct transactions
      expect(mockQueryBuilder.addSelect).toHaveBeenCalledWith(
        "COUNT(DISTINCT transaction.id)",
        "count",
      );
    });

    it("uses transaction.amount when no category filter is active", async () => {
      await service.getMonthlyTotals(userId);

      // Should NOT use COALESCE
      const addSelectCalls = mockQueryBuilder.addSelect.mock.calls;
      const coalesceUsed = addSelectCalls.some(
        (call: unknown[]) =>
          typeof call[0] === "string" && call[0].includes("COALESCE"),
      );
      expect(coalesceUsed).toBe(false);
    });

    it("applies payeeIds filter when provided", async () => {
      await service.getMonthlyTotals(
        userId,
        undefined,
        undefined,
        undefined,
        undefined,
        ["payee-1"],
      );

      expect(mockQueryBuilder.andWhere).toHaveBeenCalledWith(
        "transaction.payeeId IN (:...payeeIds)",
        { payeeIds: ["payee-1"] },
      );
    });

    it("applies search filter with ILIKE pattern", async () => {
      await service.getMonthlyTotals(
        userId,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        "grocery",
      );

      expect(mockQueryBuilder.andWhere).toHaveBeenCalledWith(
        "(transaction.description ILIKE :search OR transaction.payeeName ILIKE :search OR splits.memo ILIKE :search)",
        { search: "%grocery%" },
      );
    });

    describe("tagIds filter", () => {
      it("joins both transaction tags and split tags when tagIds provided", async () => {
        await service.getMonthlyTotals(
          userId,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          ["tag-1"],
        );

        expect(mockQueryBuilder.leftJoin).toHaveBeenCalledWith(
          "transaction.splits",
          "splits",
        );
        expect(mockQueryBuilder.leftJoin).toHaveBeenCalledWith(
          "transaction.tags",
          "filterTags",
        );
        expect(mockQueryBuilder.leftJoin).toHaveBeenCalledWith(
          "splits.tags",
          "filterSplitTags",
        );
      });

      it("filters by tag on both transaction and split tags using OR", async () => {
        await service.getMonthlyTotals(
          userId,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          ["tag-1", "tag-2"],
        );

        expect(mockQueryBuilder.andWhere).toHaveBeenCalledWith(
          expect.any(Brackets),
        );
        expect(mockQueryBuilder.where).toHaveBeenCalledWith(
          "filterTags.id IN (:...monthlyTagIds)",
          { monthlyTagIds: ["tag-1", "tag-2"] },
        );
        expect(mockQueryBuilder.orWhere).toHaveBeenCalledWith(
          "filterSplitTags.id IN (:...monthlyTagIds)",
          { monthlyTagIds: ["tag-1", "tag-2"] },
        );
      });

      it("uses split-aware amounts when tag filter is active", async () => {
        await service.getMonthlyTotals(
          userId,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          ["tag-1"],
        );

        expect(mockQueryBuilder.addSelect).toHaveBeenCalledWith(
          expect.stringContaining(
            "COALESCE(splits.amount, transaction.amount)",
          ),
          "total",
        );
        expect(mockQueryBuilder.addSelect).toHaveBeenCalledWith(
          "COUNT(DISTINCT transaction.id)",
          "count",
        );
      });

      it("does not duplicate splits join when category filter already joined splits", async () => {
        categoriesRepository.find.mockResolvedValue([
          { id: "cat-1", parentId: null },
        ]);

        await service.getMonthlyTotals(
          userId,
          undefined,
          undefined,
          undefined,
          ["cat-1"],
          undefined,
          undefined,
          undefined,
          undefined,
          ["tag-1"],
        );

        const splitsJoinCalls = mockQueryBuilder.leftJoin.mock.calls.filter(
          (call: unknown[]) =>
            call[0] === "transaction.splits" && call[1] === "splits",
        );
        expect(splitsJoinCalls.length).toBe(1);
      });

      it("does not duplicate splits join when search filter already joined splits", async () => {
        await service.getMonthlyTotals(
          userId,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          "test",
          undefined,
          undefined,
          ["tag-1"],
        );

        const splitsJoinCalls = mockQueryBuilder.leftJoin.mock.calls.filter(
          (call: unknown[]) =>
            call[0] === "transaction.splits" && call[1] === "splits",
        );
        expect(splitsJoinCalls.length).toBe(1);
      });

      it("does not apply tag filter when tagIds is empty", async () => {
        await service.getMonthlyTotals(
          userId,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          [],
        );

        expect(mockQueryBuilder.leftJoin).not.toHaveBeenCalledWith(
          "transaction.tags",
          "filterTags",
        );
      });

      it("does not apply tag filter when tagIds is undefined", async () => {
        await service.getMonthlyTotals(userId);

        expect(mockQueryBuilder.leftJoin).not.toHaveBeenCalledWith(
          "transaction.tags",
          "filterTags",
        );
      });
    });
  });

  describe("amount range filter", () => {
    describe("getSummary", () => {
      it("applies amountFrom filter when provided", async () => {
        await service.getSummary(
          userId,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          -100.5,
        );

        expect(mockQueryBuilder.andWhere).toHaveBeenCalledWith(
          "transaction.amount >= :amountFrom",
          { amountFrom: -100.5 },
        );
      });

      it("applies amountTo filter when provided", async () => {
        await service.getSummary(
          userId,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          500.25,
        );

        expect(mockQueryBuilder.andWhere).toHaveBeenCalledWith(
          "transaction.amount <= :amountTo",
          { amountTo: 500.25 },
        );
      });

      it("applies both amountFrom and amountTo when provided", async () => {
        await service.getSummary(
          userId,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          10,
          200,
        );

        expect(mockQueryBuilder.andWhere).toHaveBeenCalledWith(
          "transaction.amount >= :amountFrom",
          { amountFrom: 10 },
        );
        expect(mockQueryBuilder.andWhere).toHaveBeenCalledWith(
          "transaction.amount <= :amountTo",
          { amountTo: 200 },
        );
      });

      it("does not apply amount filters when not provided", async () => {
        await service.getSummary(userId);

        expect(mockQueryBuilder.andWhere).not.toHaveBeenCalledWith(
          "transaction.amount >= :amountFrom",
          expect.anything(),
        );
        expect(mockQueryBuilder.andWhere).not.toHaveBeenCalledWith(
          "transaction.amount <= :amountTo",
          expect.anything(),
        );
      });
    });

    describe("getMonthlyTotals", () => {
      it("applies amountFrom filter when provided", async () => {
        await service.getMonthlyTotals(
          userId,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          -50,
        );

        expect(mockQueryBuilder.andWhere).toHaveBeenCalledWith(
          "transaction.amount >= :amountFrom",
          { amountFrom: -50 },
        );
      });

      it("applies amountTo filter when provided", async () => {
        await service.getMonthlyTotals(
          userId,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          1000,
        );

        expect(mockQueryBuilder.andWhere).toHaveBeenCalledWith(
          "transaction.amount <= :amountTo",
          { amountTo: 1000 },
        );
      });

      it("applies both amount filters together", async () => {
        await service.getMonthlyTotals(
          userId,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          -100,
          500,
        );

        expect(mockQueryBuilder.andWhere).toHaveBeenCalledWith(
          "transaction.amount >= :amountFrom",
          { amountFrom: -100 },
        );
        expect(mockQueryBuilder.andWhere).toHaveBeenCalledWith(
          "transaction.amount <= :amountTo",
          { amountTo: 500 },
        );
      });

      it("does not apply amount filters when not provided", async () => {
        await service.getMonthlyTotals(userId);

        expect(mockQueryBuilder.andWhere).not.toHaveBeenCalledWith(
          "transaction.amount >= :amountFrom",
          expect.anything(),
        );
        expect(mockQueryBuilder.andWhere).not.toHaveBeenCalledWith(
          "transaction.amount <= :amountTo",
          expect.anything(),
        );
      });
    });
  });
});
