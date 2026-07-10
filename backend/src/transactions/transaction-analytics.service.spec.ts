import { Test, TestingModule } from "@nestjs/testing";
import { getRepositoryToken } from "@nestjs/typeorm";
import { Brackets } from "typeorm";
import { TransactionAnalyticsService } from "./transaction-analytics.service";
import { Transaction } from "./entities/transaction.entity";
import { Category } from "../categories/entities/category.entity";
import { UserPreference } from "../users/entities/user-preference.entity";
import { buildTransactionSearchClause } from "./transaction-search.util";

describe("TransactionAnalyticsService", () => {
  let service: TransactionAnalyticsService;
  let transactionsRepository: Record<string, jest.Mock>;
  let categoriesRepository: Record<string, jest.Mock>;
  let userPreferenceRepository: Record<string, jest.Mock>;

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
      innerJoin: jest.fn().mockReturnValue(mockQueryBuilder),
      groupBy: jest.fn().mockReturnValue(mockQueryBuilder),
      addGroupBy: jest.fn().mockReturnValue(mockQueryBuilder),
      having: jest.fn().mockReturnValue(mockQueryBuilder),
      orderBy: jest.fn().mockReturnValue(mockQueryBuilder),
      limit: jest.fn().mockReturnValue(mockQueryBuilder),
      setParameter: jest.fn().mockReturnValue(mockQueryBuilder),
      setParameters: jest.fn().mockReturnValue(mockQueryBuilder),
      getRawMany: jest.fn().mockResolvedValue([]),
    });

    transactionsRepository = {
      createQueryBuilder: jest.fn().mockReturnValue(mockQueryBuilder),
    };

    categoriesRepository = {
      find: jest.fn().mockResolvedValue([]),
    };

    userPreferenceRepository = {
      findOne: jest.fn().mockResolvedValue(null),
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
        {
          provide: getRepositoryToken(UserPreference),
          useValue: userPreferenceRepository,
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
        firstTransactionDate: null,
        lastTransactionDate: null,
        byCurrency: {},
      });
    });

    it("reduces first/last transaction dates across currency rows", async () => {
      mockQueryBuilder.getRawMany.mockResolvedValue([
        {
          currencyCode: "USD",
          totalIncome: "100",
          totalExpenses: "50",
          transactionCount: "3",
          firstDate: "2026-02-01",
          lastDate: "2026-05-20",
        },
        {
          currencyCode: "CAD",
          totalIncome: "200",
          totalExpenses: "80",
          transactionCount: "4",
          firstDate: "2026-01-15",
          lastDate: "2026-04-30",
        },
      ]);

      const result = await service.getSummary(userId);

      expect(result.firstTransactionDate).toBe("2026-01-15");
      expect(result.lastTransactionDate).toBe("2026-05-20");
    });

    it("filters by tagIds via transaction and split tag joins", async () => {
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
        undefined,
        ["tag-1"],
      );

      expect(mockQueryBuilder.leftJoin).toHaveBeenCalledWith(
        "transaction.tags",
        "filterTags",
      );
      expect(mockQueryBuilder.leftJoin).toHaveBeenCalledWith(
        "splits.tags",
        "filterSplitTags",
      );
      expect(mockQueryBuilder.where).toHaveBeenCalledWith(
        "filterTags.id IN (:...summaryTagIds)",
        { summaryTagIds: ["tag-1"] },
      );
      expect(mockQueryBuilder.orWhere).toHaveBeenCalledWith(
        "filterSplitTags.id IN (:...summaryTagIds)",
        { summaryTagIds: ["tag-1"] },
      );
    });

    it("treats split lines without a category as uncategorised", async () => {
      await service.getSummary(userId, undefined, undefined, undefined, [
        "uncategorized",
      ]);

      // Non-split uncategorised transactions...
      expect(mockQueryBuilder.where).toHaveBeenCalledWith(
        expect.stringContaining(
          "transaction.categoryId IS NULL AND transaction.isSplit = false",
        ),
      );
      // ...plus split transactions whose split line has no category, matching
      // the account-detail category breakdown.
      expect(mockQueryBuilder.orWhere).toHaveBeenCalledWith(
        expect.stringContaining(
          "transaction.isSplit = true AND transaction.isTransfer = false AND summaryAccount.accountType != 'INVESTMENT' AND splits.categoryId IS NULL",
        ),
      );
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
          buildTransactionSearchClause({
            transaction: "transaction",
            splits: "splits",
          }),
          { search: "%grocery%", searchAmount: null, searchDate: null },
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
          buildTransactionSearchClause({
            transaction: "transaction",
            splits: "splits",
          }),
          { search: "%coffee%", searchAmount: null, searchDate: null },
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
          { search: "%rent%", searchAmount: null, searchDate: null },
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
          accountId: "acc-chequing",
          accountName: "Chequing",
          currencyCode: "USD",
          inbound: "0",
          outbound: "1500",
          count: "3",
        },
        {
          accountId: "acc-savings",
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
        accountId: "acc-chequing",
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

    it("selects the account id for deep-links and maps a missing id to null", async () => {
      mockQueryBuilder.getRawMany.mockResolvedValue([
        {
          accountName: "Orphaned",
          currencyCode: "USD",
          inbound: "100",
          outbound: "0",
          count: "4",
        },
      ]);

      const result = await service.getTransfersByAccount(
        userId,
        "2026-01-01",
        "2026-01-31",
      );

      expect(mockQueryBuilder.addSelect).toHaveBeenCalledWith(
        "transferAccount.id",
        "accountId",
      );
      expect(result.accounts[0].accountId).toBeNull();
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

    it("rounds totals to storage precision (four decimal places)", async () => {
      mockQueryBuilder.getRawMany.mockResolvedValue([
        { month: "2025-01", total: "-123.456", count: "3" },
      ]);

      const result = await service.getMonthlyTotals(userId);

      expect(result[0].total).toBe(-123.456);
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
        buildTransactionSearchClause({
          transaction: "transaction",
          splits: "splits",
        }),
        { search: "%grocery%", searchAmount: null, searchDate: null },
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

  describe("resolveLlmCategoryIds", () => {
    const food = { id: "id-food", name: "Food", parentId: null };
    const dining = { id: "id-dining", name: "Dining Out", parentId: "id-food" };
    const groceries = {
      id: "id-groceries",
      name: "Groceries",
      parentId: "id-food",
    };
    const rent = { id: "id-rent", name: "Rent", parentId: null };
    const allCategories = [food, dining, groceries, rent];

    beforeEach(() => {
      // resolveLlmCategoryIds calls categoriesRepository.find twice:
      // once for the lookup index, once via getAllCategoryIdsWithChildren.
      categoriesRepository.find.mockResolvedValue(allCategories);
    });

    it("returns empty result for empty input", async () => {
      const result = await service.resolveLlmCategoryIds(userId, []);
      expect(result).toEqual({
        categoryIds: [],
        unresolved: [],
        suggestions: [],
      });
    });

    it("matches an exact category name and expands to descendants", async () => {
      const result = await service.resolveLlmCategoryIds(userId, ["Food"]);
      expect(result.unresolved).toEqual([]);
      // Food expands to itself + Dining Out + Groceries
      expect(result.categoryIds).toEqual(
        expect.arrayContaining(["id-food", "id-dining", "id-groceries"]),
      );
      expect(result.categoryIds).not.toContain("id-rent");
    });

    it("matches Parent: Child notation for a subcategory", async () => {
      const result = await service.resolveLlmCategoryIds(userId, [
        "Food: Dining Out",
      ]);
      expect(result.unresolved).toEqual([]);
      expect(result.categoryIds).toContain("id-dining");
      // Should not include sibling subcategories of Food
      expect(result.categoryIds).not.toContain("id-groceries");
    });

    it("accepts alternate separators (/, >, ->)", async () => {
      for (const input of [
        "Food / Dining Out",
        "Food > Dining Out",
        "Food -> Dining Out",
      ]) {
        const result = await service.resolveLlmCategoryIds(userId, [input]);
        expect(result.unresolved).toEqual([]);
        expect(result.categoryIds).toContain("id-dining");
      }
    });

    it("is case-insensitive and tolerates extra whitespace", async () => {
      const result = await service.resolveLlmCategoryIds(userId, [
        "  food   :   DINING  out  ",
      ]);
      expect(result.unresolved).toEqual([]);
      expect(result.categoryIds).toContain("id-dining");
    });

    it("falls back to last segment when full Parent: Child key misses", async () => {
      // "Mystery: Dining Out" — parent doesn't exist but child does
      const result = await service.resolveLlmCategoryIds(userId, [
        "Mystery: Dining Out",
      ]);
      expect(result.unresolved).toEqual([]);
      expect(result.categoryIds).toContain("id-dining");
    });

    it("reports unknown categories in unresolved", async () => {
      const result = await service.resolveLlmCategoryIds(userId, [
        "Bogus",
        "Food",
      ]);
      expect(result.unresolved).toEqual(["Bogus"]);
      expect(result.categoryIds).toContain("id-food");
    });

    it("returns no IDs when nothing resolves", async () => {
      const result = await service.resolveLlmCategoryIds(userId, [
        "Bogus",
        "AlsoBogus",
      ]);
      expect(result.categoryIds).toEqual([]);
      expect(result.unresolved).toEqual(["Bogus", "AlsoBogus"]);
    });

    it("suggests the closest valid name for a near-miss", async () => {
      const result = await service.resolveLlmCategoryIds(userId, ["Grocries"]);
      expect(result.unresolved).toEqual(["Grocries"]);
      expect(result.suggestions).toContain("Groceries");
    });

    it("returns no suggestions when every name resolves", async () => {
      const result = await service.resolveLlmCategoryIds(userId, ["Food"]);
      expect(result.suggestions).toEqual([]);
    });
  });

  describe("getLlmQueryTransactions", () => {
    it("returns summary fields without breakdown when groupBy is not set", async () => {
      mockQueryBuilder.getRawMany.mockResolvedValue([
        {
          currencyCode: "USD",
          totalIncome: "1000",
          totalExpenses: "200",
          transactionCount: "5",
        },
      ]);

      const result = await service.getLlmQueryTransactions(userId, {
        startDate: "2026-01-01",
        endDate: "2026-01-31",
      });

      expect(result.totalIncome).toBe(1000);
      expect(result.totalExpenses).toBe(200);
      expect(result.netCashFlow).toBe(800);
      expect(result.transactionCount).toBe(5);
      expect(result.byCurrency).toBeUndefined();
      expect(result.breakdown).toBeUndefined();
    });

    it("includes byCurrency breakdown when multiple currencies are present", async () => {
      mockQueryBuilder.getRawMany.mockResolvedValue([
        {
          currencyCode: "USD",
          totalIncome: "1000",
          totalExpenses: "200",
          transactionCount: "5",
        },
        {
          currencyCode: "EUR",
          totalIncome: "500",
          totalExpenses: "100",
          transactionCount: "3",
        },
      ]);

      const result = await service.getLlmQueryTransactions(userId, {
        startDate: "2026-01-01",
        endDate: "2026-01-31",
      });

      expect(result.byCurrency).toBeDefined();
      expect(Object.keys(result.byCurrency || {})).toEqual(
        expect.arrayContaining(["USD", "EUR"]),
      );
    });

    it("includes breakdown when groupBy is provided", async () => {
      mockQueryBuilder.getRawMany
        .mockResolvedValueOnce([
          {
            currencyCode: "USD",
            totalIncome: "1000",
            totalExpenses: "200",
            transactionCount: "5",
          },
        ])
        .mockResolvedValueOnce([{ label: "Food", total: "150", count: "10" }]);

      const result = await service.getLlmQueryTransactions(userId, {
        startDate: "2026-01-01",
        endDate: "2026-01-31",
        groupBy: "category",
      });

      expect(result.breakdown).toBeDefined();
    });

    it("forwards filters and search to the breakdown query", async () => {
      mockQueryBuilder.getRawMany
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([]);

      await service.getLlmQueryTransactions(userId, {
        startDate: "2026-01-01",
        endDate: "2026-01-31",
        groupBy: "month",
        direction: "expenses",
        accountIds: ["acc-1"],
        categoryIds: ["cat-1"],
        searchText: "starbucks",
      });

      const allWhereCalls = (mockQueryBuilder.andWhere.mock.calls as any[][])
        .map((c) => c[0])
        .join(" | ");
      expect(allWhereCalls).toContain("ILIKE");
    });
  });

  describe("getLlmListTransactions", () => {
    it("returns totals and groupedBy 'none' without a breakdown when groupBy is omitted", async () => {
      mockQueryBuilder.getRawMany.mockResolvedValue([
        {
          currencyCode: "USD",
          totalIncome: "1000",
          totalExpenses: "200",
          transactionCount: "5",
        },
      ]);

      const result = await service.getLlmListTransactions(userId, {
        startDate: "2026-01-01",
        endDate: "2026-01-31",
      });

      expect(result.totalIncome).toBe(1000);
      expect(result.totalExpenses).toBe(200);
      expect(result.netCashFlow).toBe(800);
      expect(result.transactionCount).toBe(5);
      expect(result.groupedBy).toBe("none");
      expect(result.breakdown).toBeUndefined();
      expect(result.transfers).toBeUndefined();
      expect(result.byCurrency).toBeUndefined();
    });

    it("does not compute a breakdown when groupBy is explicitly 'none'", async () => {
      mockQueryBuilder.getRawMany.mockResolvedValue([]);

      const result = await service.getLlmListTransactions(userId, {
        startDate: "2026-01-01",
        endDate: "2026-01-31",
        groupBy: "none",
      });

      expect(result.groupedBy).toBe("none");
      expect(result.breakdown).toBeUndefined();
      // Only the summary query runs, not a second breakdown query.
      expect(transactionsRepository.createQueryBuilder).toHaveBeenCalledTimes(
        1,
      );
    });

    it("includes a breakdown when groupBy is a real grouping", async () => {
      mockQueryBuilder.getRawMany
        .mockResolvedValueOnce([
          {
            currencyCode: "USD",
            totalIncome: "1000",
            totalExpenses: "200",
            transactionCount: "5",
          },
        ])
        .mockResolvedValueOnce([{ label: "Food", total: "150", count: "10" }]);

      const result = await service.getLlmListTransactions(userId, {
        startDate: "2026-01-01",
        endDate: "2026-01-31",
        groupBy: "category",
      });

      expect(result.groupedBy).toBe("category");
      expect(result.breakdown).toBeDefined();
    });

    it("includes the transfer rollup when transfersOnly is true", async () => {
      mockQueryBuilder.getRawMany
        .mockResolvedValueOnce([]) // summary
        .mockResolvedValueOnce([
          {
            accountName: "Savings",
            currencyCode: "USD",
            inbound: "1500",
            outbound: "0",
            count: "3",
          },
        ]); // transfers

      const result = await service.getLlmListTransactions(userId, {
        startDate: "2026-01-01",
        endDate: "2026-01-31",
        transfersOnly: true,
      });

      expect(result.transfers).toBeDefined();
      expect(result.transfers?.totalInbound).toBe(1500);
      expect(result.transfers?.accounts).toHaveLength(1);
    });

    it("omits the transfer rollup when transfersOnly is false", async () => {
      mockQueryBuilder.getRawMany.mockResolvedValue([]);

      const result = await service.getLlmListTransactions(userId, {
        startDate: "2026-01-01",
        endDate: "2026-01-31",
        transfersOnly: false,
      });

      expect(result.transfers).toBeUndefined();
    });

    it("computes both a breakdown and the transfer rollup together", async () => {
      mockQueryBuilder.getRawMany
        .mockResolvedValueOnce([]) // summary
        .mockResolvedValueOnce([{ label: "Food", total: "100", count: "5" }]) // breakdown
        .mockResolvedValueOnce([]); // transfers

      const result = await service.getLlmListTransactions(userId, {
        startDate: "2026-01-01",
        endDate: "2026-01-31",
        groupBy: "category",
        transfersOnly: true,
      });

      expect(result.breakdown).toBeDefined();
      expect(result.transfers).toBeDefined();
    });

    it("exposes byCurrency when multiple currencies are present", async () => {
      mockQueryBuilder.getRawMany.mockResolvedValue([
        {
          currencyCode: "USD",
          totalIncome: "1000",
          totalExpenses: "200",
          transactionCount: "5",
        },
        {
          currencyCode: "EUR",
          totalIncome: "500",
          totalExpenses: "100",
          transactionCount: "3",
        },
      ]);

      const result = await service.getLlmListTransactions(userId, {
        startDate: "2026-01-01",
        endDate: "2026-01-31",
      });

      expect(result.byCurrency).toBeDefined();
      expect(Object.keys(result.byCurrency || {})).toEqual(
        expect.arrayContaining(["USD", "EUR"]),
      );
    });

    it("forwards payee, amount, and search filters to the summary query", async () => {
      mockQueryBuilder.getRawMany.mockResolvedValue([]);

      await service.getLlmListTransactions(userId, {
        startDate: "2026-01-01",
        endDate: "2026-01-31",
        payeeIds: ["payee-1"],
        minAmount: -100,
        maxAmount: -10,
        searchText: "coffee",
      });

      expect(mockQueryBuilder.andWhere).toHaveBeenCalledWith(
        "transaction.payeeId IN (:...payeeIds)",
        { payeeIds: ["payee-1"] },
      );
      expect(mockQueryBuilder.andWhere).toHaveBeenCalledWith(
        "transaction.amount >= :amountFrom",
        { amountFrom: -100 },
      );
      expect(mockQueryBuilder.andWhere).toHaveBeenCalledWith(
        "transaction.amount <= :amountTo",
        { amountTo: -10 },
      );
      expect(mockQueryBuilder.andWhere).toHaveBeenCalledWith(
        buildTransactionSearchClause({
          transaction: "transaction",
          splits: "splits",
        }),
        { search: "%coffee%", searchAmount: null, searchDate: null },
      );
    });

    it("forwards payee/amount filters into the grouped breakdown query", async () => {
      mockQueryBuilder.getRawMany
        .mockResolvedValueOnce([]) // summary
        .mockResolvedValueOnce([]); // breakdown

      await service.getLlmListTransactions(userId, {
        startDate: "2026-01-01",
        endDate: "2026-01-31",
        groupBy: "month",
        payeeIds: ["payee-1"],
        minAmount: -200,
        maxAmount: -5,
      });

      const calls = (mockQueryBuilder.andWhere.mock.calls as any[][]).map(
        (c) => c[0],
      );
      expect(calls).toContain("t.payeeId IN (:...payeeIds)");
      expect(
        calls.some((c) => typeof c === "string" && c.includes(":minAmount")),
      ).toBe(true);
      expect(
        calls.some((c) => typeof c === "string" && c.includes(":maxAmount")),
      ).toBe(true);
    });

    it("applies the expenses direction to the breakdown query", async () => {
      mockQueryBuilder.getRawMany
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([]);

      await service.getLlmListTransactions(userId, {
        startDate: "2026-01-01",
        endDate: "2026-01-31",
        groupBy: "category",
        direction: "expenses",
      });

      const calls = (mockQueryBuilder.andWhere.mock.calls as any[][])
        .map((c) => c[0])
        .join(" | ");
      expect(calls).toMatch(/< 0/);
    });

    it("applies the income direction to the breakdown query", async () => {
      mockQueryBuilder.getRawMany
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([]);

      await service.getLlmListTransactions(userId, {
        startDate: "2026-01-01",
        endDate: "2026-01-31",
        groupBy: "category",
        direction: "income",
      });

      const calls = (mockQueryBuilder.andWhere.mock.calls as any[][])
        .map((c) => c[0])
        .join(" | ");
      expect(calls).toMatch(/> 0/);
    });
  });

  describe("getLlmGroupedBreakdown (via getLlmQueryTransactions)", () => {
    async function runWithGroupBy(groupBy: string, rows: any[]) {
      mockQueryBuilder.getRawMany
        .mockResolvedValueOnce([]) // summary
        .mockResolvedValueOnce(rows); // breakdown
      const result = await service.getLlmQueryTransactions(userId, {
        startDate: "2026-01-01",
        endDate: "2026-01-31",
        groupBy: groupBy as any,
      });
      return result.breakdown as any[];
    }

    it("groups by category and sorts by total descending", async () => {
      const rows = await runWithGroupBy("category", [
        { label: "Food", categoryId: "cat-food", total: "100", count: "5" },
        { label: "Travel", categoryId: "cat-travel", total: "300", count: "2" },
      ]);

      expect(rows[0].category).toBe("Travel");
      expect(rows[0].categoryId).toBe("cat-travel");
      expect(rows[1].category).toBe("Food");
      expect(rows[1].categoryId).toBe("cat-food");
    });

    it("maps a missing category id (Uncategorized bucket) to null", async () => {
      const rows = await runWithGroupBy("category", [
        { label: "Uncategorized", categoryId: null, total: "50", count: "3" },
      ]);

      expect(rows[0].category).toBe("Uncategorized");
      expect(rows[0].categoryId).toBeNull();
    });

    it("groups by payee and aggregates small payees into Other (aggregated)", async () => {
      const rows = await runWithGroupBy("payee", [
        { label: "Costco", payeeId: "payee-costco", total: "500", count: "10" },
        { label: "Tiny", payeeId: "payee-tiny", total: "5", count: "1" },
      ]);

      const labels = rows.map((r) => r.payee);
      expect(labels).toContain("Costco");
      expect(labels).toContain("Other (aggregated)");
      const costco = rows.find((r) => r.payee === "Costco");
      expect(costco.payeeId).toBe("payee-costco");
      // The synthetic bucket must never expose a folded payee's id.
      const other = rows.find((r) => r.payee === "Other (aggregated)");
      expect(other.payeeId).toBeNull();
    });

    it("maps free-text payee groups (no payee record) to a null payeeId", async () => {
      const rows = await runWithGroupBy("payee", [
        { label: "Cash lunch", payeeId: null, total: "90", count: "4" },
      ]);

      expect(rows[0].payee).toBe("Cash lunch");
      expect(rows[0].payeeId).toBeNull();
    });

    it("groups by year and returns one row per year", async () => {
      const rows = await runWithGroupBy("year", [
        { year: "2024", total: "100", count: "5" },
        { year: "2025", total: "200", count: "10" },
      ]);

      expect(rows).toHaveLength(2);
      expect(rows[0].year).toBe("2024");
    });

    it("groups by month and returns one row per month", async () => {
      const rows = await runWithGroupBy("month", [
        { month: "2026-01", total: "100", count: "5" },
      ]);

      expect(rows[0].month).toBe("2026-01");
    });

    it("groups by week", async () => {
      const rows = await runWithGroupBy("week", [
        { week: "2026-01-05", total: "50", count: "2" },
      ]);

      expect(rows[0].week).toBe("2026-01-05");
    });

    it("applies expenses direction filter", async () => {
      mockQueryBuilder.getRawMany
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([]);

      await service.getLlmQueryTransactions(userId, {
        startDate: "2026-01-01",
        endDate: "2026-01-31",
        groupBy: "category",
        direction: "expenses",
      });

      const calls = (mockQueryBuilder.andWhere.mock.calls as any[][])
        .map((c) => c[0])
        .join(" | ");
      expect(calls).toMatch(/< 0/);
    });

    it("applies income direction filter", async () => {
      mockQueryBuilder.getRawMany
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([]);

      await service.getLlmQueryTransactions(userId, {
        startDate: "2026-01-01",
        endDate: "2026-01-31",
        groupBy: "category",
        direction: "income",
      });

      const calls = (mockQueryBuilder.andWhere.mock.calls as any[][])
        .map((c) => c[0])
        .join(" | ");
      expect(calls).toMatch(/> 0/);
    });
  });

  describe("getLlmPeriodComparison", () => {
    it("compares two periods grouped by category by default", async () => {
      mockQueryBuilder.getRawMany
        .mockResolvedValueOnce([{ label: "Food", total: "100", count: "5" }])
        .mockResolvedValueOnce([{ label: "Food", total: "150", count: "8" }]);

      const result = await service.getLlmPeriodComparison(userId, {
        period1Start: "2026-01-01",
        period1End: "2026-01-31",
        period2Start: "2026-02-01",
        period2End: "2026-02-28",
      });

      expect(result.period1.total).toBe(100);
      expect(result.period2.total).toBe(150);
      expect(result.totalChange).toBe(50);
      expect(result.totalChangePercent).toBe(50);
      expect(result.comparison[0].label).toBe("Food");
      expect(result.comparison[0].change).toBe(50);
    });

    it("returns 100% change when period1 is zero but period2 is non-zero", async () => {
      mockQueryBuilder.getRawMany
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ label: "New", total: "50", count: "3" }]);

      const result = await service.getLlmPeriodComparison(userId, {
        period1Start: "2026-01-01",
        period1End: "2026-01-31",
        period2Start: "2026-02-01",
        period2End: "2026-02-28",
      });

      const newRow = result.comparison.find((c) => c.label === "New");
      expect(newRow?.changePercent).toBe(100);
    });

    it("returns 0% change when both periods are zero", async () => {
      mockQueryBuilder.getRawMany
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([]);

      const result = await service.getLlmPeriodComparison(userId, {
        period1Start: "2026-01-01",
        period1End: "2026-01-31",
        period2Start: "2026-02-01",
        period2End: "2026-02-28",
      });

      expect(result.totalChange).toBe(0);
      expect(result.totalChangePercent).toBe(0);
    });

    it("supports payee groupBy with aggregation threshold", async () => {
      mockQueryBuilder.getRawMany
        .mockResolvedValueOnce([
          { label: "Costco", total: "500", count: "10" },
          { label: "Small", total: "10", count: "1" },
        ])
        .mockResolvedValueOnce([
          { label: "Costco", total: "600", count: "12" },
        ]);

      const result = await service.getLlmPeriodComparison(userId, {
        period1Start: "2026-01-01",
        period1End: "2026-01-31",
        period2Start: "2026-02-01",
        period2End: "2026-02-28",
        groupBy: "payee",
        direction: "expenses",
      });

      const labels = result.comparison.map((c) => c.label);
      expect(labels).toContain("Costco");
      expect(labels).toContain("Other (aggregated)");
    });

    it("supports income direction", async () => {
      mockQueryBuilder.getRawMany
        .mockResolvedValueOnce([{ label: "Salary", total: "1000", count: "1" }])
        .mockResolvedValueOnce([
          { label: "Salary", total: "1100", count: "1" },
        ]);

      const result = await service.getLlmPeriodComparison(userId, {
        period1Start: "2026-01-01",
        period1End: "2026-01-31",
        period2Start: "2026-02-01",
        period2End: "2026-02-28",
        direction: "income",
      });

      expect(result.totalChange).toBe(100);
    });

    it("supports 'both' direction (no direction filter applied)", async () => {
      mockQueryBuilder.getRawMany
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([]);

      await service.getLlmPeriodComparison(userId, {
        period1Start: "2026-01-01",
        period1End: "2026-01-31",
        period2Start: "2026-02-01",
        period2End: "2026-02-28",
        direction: "both",
      });

      // direction "both" means no extra direction filter clause
      const calls = (mockQueryBuilder.andWhere.mock.calls as any[][]).map(
        (c) => c[0],
      );
      const directionCalls = calls.filter(
        (c) => typeof c === "string" && /[<>] 0/.test(c),
      );
      expect(directionCalls).toHaveLength(0);
    });
  });

  describe("getRecurringCharges", () => {
    const start = "2025-01-01";
    const end = "2025-12-31";

    it("detects a recurring charge with consistent monthly timing", async () => {
      mockQueryBuilder.getRawMany.mockResolvedValue([
        {
          payeeName: "Netflix",
          payeeId: "payee-1",
          categoryName: "Entertainment",
          categoryId: "cat-1",
          amounts: [15.99, 15.99, 15.99, 17.99],
          dates: ["2025-09-01", "2025-10-01", "2025-11-01", "2025-12-01"],
          txnCount: "4",
        },
      ]);

      const result = await service.getRecurringCharges(userId, start, end);

      expect(result).toHaveLength(1);
      expect(result[0].payeeName).toBe("Netflix");
      expect(result[0].payeeId).toBe("payee-1");
      expect(result[0].frequency).toBe("monthly");
      expect(result[0].currentAmount).toBe(17.99);
      expect(result[0].previousAmount).toBe(15.99);
      expect(result[0].categoryName).toBe("Entertainment");
      expect(result[0].categoryId).toBe("cat-1");
    });

    it("returns null payeeId and categoryId for free-text charges", async () => {
      mockQueryBuilder.getRawMany.mockResolvedValue([
        {
          payeeName: "Corner Shop",
          categoryName: null,
          amounts: [12.5, 12.5, 12.5],
          dates: ["2025-10-01", "2025-11-01", "2025-12-01"],
          txnCount: "3",
        },
      ]);

      const result = await service.getRecurringCharges(userId, start, end);

      expect(result).toHaveLength(1);
      expect(result[0].payeeId).toBeNull();
      expect(result[0].categoryId).toBeNull();
    });

    it("treats a single repeated amount as both current and previous", async () => {
      mockQueryBuilder.getRawMany.mockResolvedValue([
        {
          payeeName: "Service",
          categoryName: "Utilities",
          amounts: [29.99, 29.99, 29.99],
          dates: ["2025-10-15", "2025-11-15", "2025-12-15"],
          txnCount: "3",
        },
      ]);

      const result = await service.getRecurringCharges(userId, start, end);

      expect(result).toHaveLength(1);
      expect(result[0].currentAmount).toBe(29.99);
      expect(result[0].previousAmount).toBe(29.99);
    });

    it("filters out charges with irregular timing", async () => {
      mockQueryBuilder.getRawMany.mockResolvedValue([
        {
          payeeName: "Random Store",
          categoryName: "Shopping",
          amounts: [50, 20, 150],
          dates: ["2025-08-10", "2025-09-25", "2025-12-01"],
          txnCount: "3",
        },
      ]);

      const result = await service.getRecurringCharges(userId, start, end);

      expect(result).toHaveLength(0);
    });

    it("excludes investment-linked cash debits from the query", async () => {
      await service.getRecurringCharges(userId, start, end);

      const andWhereClauses = (
        mockQueryBuilder.andWhere.mock.calls as any[][]
      ).map((c) => c[0] as string);
      expect(andWhereClauses).toContain(
        "NOT EXISTS (SELECT 1 FROM investment_transactions it WHERE it.transaction_id = t.id)",
      );
      expect(andWhereClauses).toContain("t.status != 'VOID'");
      expect(andWhereClauses).toContain("t.isTransfer = false");
      expect(andWhereClauses).toContain("t.parentTransactionId IS NULL");
    });

    it("selects a bare category name by default", async () => {
      await service.getRecurringCharges(userId, start, end);

      const addSelectClauses = (
        mockQueryBuilder.addSelect.mock.calls as any[][]
      ).map((c) => c[0] as string);
      expect(addSelectClauses).toContain("cat.name");
      expect(mockQueryBuilder.setParameters).toHaveBeenCalledWith({});
    });

    it("substitutes an uncategorized label when requested", async () => {
      await service.getRecurringCharges(userId, start, end, {
        uncategorizedLabel: "Uncategorized",
      });

      const addSelectClauses = (
        mockQueryBuilder.addSelect.mock.calls as any[][]
      ).map((c) => c[0] as string);
      expect(addSelectClauses).toContain(
        "COALESCE(cat.name, :uncategorizedLabel)",
      );
      expect(mockQueryBuilder.setParameters).toHaveBeenCalledWith({
        uncategorizedLabel: "Uncategorized",
      });
    });

    it("resolves names through the payee relation so id-linked payees are included", async () => {
      await service.getRecurringCharges(userId, start, end);

      expect(mockQueryBuilder.leftJoin).toHaveBeenCalledWith(
        "t.payee",
        "chargePayee",
      );
      expect(mockQueryBuilder.select).toHaveBeenCalledWith(
        "COALESCE(chargePayee.name, t.payeeName)",
        "payeeName",
      );
      // Rows linked by payeeId carry a NULL payeeName, so the filter must
      // accept either identifier.
      const andWhereClauses = (
        mockQueryBuilder.andWhere.mock.calls as any[][]
      ).map((c) => c[0] as string);
      expect(andWhereClauses).toContain(
        "(t.payeeId IS NOT NULL OR t.payeeName IS NOT NULL)",
      );
    });

    it("filters by payeeIds only when provided", async () => {
      await service.getRecurringCharges(userId, start, end);
      expect(mockQueryBuilder.andWhere).not.toHaveBeenCalledWith(
        "t.payeeId IN (:...payeeIds)",
        expect.anything(),
      );

      await service.getRecurringCharges(userId, start, end, {
        payeeIds: ["payee-1"],
      });
      expect(mockQueryBuilder.andWhere).toHaveBeenCalledWith(
        "t.payeeId IN (:...payeeIds)",
        { payeeIds: ["payee-1"] },
      );
    });
  });

  describe("getGroupedTotals", () => {
    it("groups by category with split-aware id and name expressions", async () => {
      mockQueryBuilder.getRawMany.mockResolvedValue([
        {
          id: "cat-1",
          name: "Groceries",
          currencyCode: "CAD",
          total: "-450.7512",
          count: "12",
        },
        {
          id: null,
          name: null,
          currencyCode: "CAD",
          total: "-25.25",
          count: "2",
        },
      ]);

      const result = await service.getGroupedTotals(userId, {
        groupBy: "category",
      });

      expect(mockQueryBuilder.leftJoin).toHaveBeenCalledWith(
        "transaction.category",
        "groupCat",
      );
      expect(mockQueryBuilder.leftJoin).toHaveBeenCalledWith(
        "splits.category",
        "groupSplitCat",
      );
      expect(mockQueryBuilder.select).toHaveBeenCalledWith(
        "COALESCE(splits.categoryId, transaction.categoryId)",
        "id",
      );
      // Transfers with no category are excluded from the Uncategorized bucket:
      // keep rows with a resolved category, or that are not transfers.
      expect(mockQueryBuilder.where).toHaveBeenCalledWith(
        "COALESCE(splits.categoryId, transaction.categoryId) IS NOT NULL",
      );
      expect(mockQueryBuilder.orWhere).toHaveBeenCalledWith(
        "transaction.isTransfer = false",
      );
      expect(result).toEqual([
        {
          id: "cat-1",
          name: "Groceries",
          currencyCode: "CAD",
          total: -450.7512,
          count: 12,
        },
        { id: null, name: null, currencyCode: "CAD", total: -25.25, count: 2 },
      ]);
    });

    it("groups by payee falling back to the free-text payee name", async () => {
      await service.getGroupedTotals(userId, {
        groupBy: "payee",
        payeeIds: undefined,
        categoryIds: ["cat-9"],
      });

      expect(mockQueryBuilder.leftJoin).toHaveBeenCalledWith(
        "transaction.payee",
        "groupPayee",
      );
      expect(mockQueryBuilder.select).toHaveBeenCalledWith(
        "transaction.payeeId",
        "id",
      );
      expect(mockQueryBuilder.addSelect).toHaveBeenCalledWith(
        "COALESCE(groupPayee.name, transaction.payeeName)",
        "name",
      );
      // Category filter flows through the shared filtered query.
      expect(categoriesRepository.find).toHaveBeenCalled();
    });

    it("orders by absolute total and clamps the limit", async () => {
      await service.getGroupedTotals(userId, {
        groupBy: "payee",
        limit: 9999,
      });

      expect(mockQueryBuilder.orderBy).toHaveBeenCalledWith(
        "SUM(ABS(COALESCE(splits.amount, transaction.amount)))",
        "DESC",
      );
      expect(mockQueryBuilder.limit).toHaveBeenCalledWith(500);

      await service.getGroupedTotals(userId, { groupBy: "payee" });
      expect(mockQueryBuilder.limit).toHaveBeenCalledWith(100);
    });

    it("returns an empty array when nothing matches", async () => {
      mockQueryBuilder.getRawMany.mockResolvedValue([]);

      const result = await service.getGroupedTotals(userId, {
        groupBy: "category",
        startDate: "2026-01-01",
        endDate: "2026-06-30",
      });

      expect(result).toEqual([]);
      expect(mockQueryBuilder.andWhere).toHaveBeenCalledWith(
        "transaction.transactionDate >= :startDate",
        { startDate: "2026-01-01" },
      );
    });
  });

  describe("getTransactionBreakdownByTagKey", () => {
    it("maps per-currency rows keyed by the parsed tag value", async () => {
      mockQueryBuilder.getRawMany.mockResolvedValue([
        { value: "usa", currencyCode: "CAD", total: "200", count: "2" },
        { value: "poland", currencyCode: "CAD", total: "100", count: "1" },
      ]);

      const result = await service.getTransactionBreakdownByTagKey(
        "user-1",
        "country",
        { accountIds: ["a1"] },
      );

      expect(result).toEqual([
        { id: "usa", name: "usa", currencyCode: "CAD", total: 200, count: 2 },
        {
          id: "poland",
          name: "poland",
          currencyCode: "CAD",
          total: 100,
          count: 1,
        },
      ]);
      // Joins the transaction's tags and groups by value + currency.
      expect(mockQueryBuilder.innerJoin).toHaveBeenCalledWith(
        "transaction.tags",
        "brkTag",
      );
      expect(mockQueryBuilder.addGroupBy).toHaveBeenCalledWith(
        "transaction.currencyCode",
      );
    });

    it("binds the key (never interpolates it)", async () => {
      mockQueryBuilder.getRawMany.mockResolvedValue([]);

      await service.getTransactionBreakdownByTagKey("user-1", "Country", {});

      expect(mockQueryBuilder.andWhere).toHaveBeenCalledWith(
        "LOWER(TRIM(SPLIT_PART(brkTag.name, ':', 1))) = LOWER(:brkKey)",
        { brkKey: "Country" },
      );
    });
  });
});
