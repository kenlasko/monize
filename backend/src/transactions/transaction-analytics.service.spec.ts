import { Test, TestingModule } from "@nestjs/testing";
import { getRepositoryToken } from "@nestjs/typeorm";
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
    mockQueryBuilder = {
      select: jest.fn().mockReturnThis(),
      addSelect: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      leftJoin: jest.fn().mockReturnThis(),
      groupBy: jest.fn().mockReturnThis(),
      setParameter: jest.fn().mockReturnThis(),
      getRawMany: jest.fn().mockResolvedValue([]),
    };

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

    it("groups results by currencyCode", async () => {
      await service.getSummary(userId);

      expect(mockQueryBuilder.groupBy).toHaveBeenCalledWith(
        "transaction.currencyCode",
      );
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

        // Should set parameter with parent + all descendants
        expect(mockQueryBuilder.setParameter).toHaveBeenCalledWith(
          "summaryCategoryIds",
          expect.arrayContaining(["cat-1", "cat-1-child", "cat-1-grandchild"]),
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

        expect(mockQueryBuilder.andWhere).toHaveBeenCalledWith(
          expect.stringContaining("transaction.categoryId IS NULL"),
        );
      });

      it("handles transfer filter", async () => {
        await service.getSummary(userId, undefined, undefined, undefined, [
          "transfer",
        ]);

        expect(mockQueryBuilder.andWhere).toHaveBeenCalledWith(
          expect.stringContaining("transaction.isTransfer = true"),
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

        // All three conditions should be OR-ed together
        expect(mockQueryBuilder.andWhere).toHaveBeenCalledWith(
          expect.stringContaining(" OR "),
        );

        // Account join for uncategorized
        expect(mockQueryBuilder.leftJoin).toHaveBeenCalledWith(
          "transaction.account",
          "summaryAccount",
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

        const setParameterCall = mockQueryBuilder.setParameter.mock.calls.find(
          (call: unknown[]) => call[0] === "summaryCategoryIds",
        );
        expect(setParameterCall).toBeDefined();
        const ids = setParameterCall[1] as string[];
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

        expect(mockQueryBuilder.setParameter).toHaveBeenCalledWith(
          "summaryCategoryIds",
          ["cat-1"],
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

        expect(mockQueryBuilder.setParameter).toHaveBeenCalledWith(
          "summaryCategoryIds",
          expect.arrayContaining([
            "root",
            "child-1",
            "child-2",
            "grandchild-1",
            "great-grandchild",
          ]),
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

        expect(mockQueryBuilder.setParameter).toHaveBeenCalledWith(
          "summaryCategoryIds",
          expect.arrayContaining([
            "cat-a",
            "cat-a-child",
            "cat-b",
            "cat-b-child",
          ]),
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

        const setParameterCall = mockQueryBuilder.setParameter.mock.calls.find(
          (call: unknown[]) => call[0] === "summaryCategoryIds",
        );
        const ids = setParameterCall[1] as string[];
        expect(ids).toContain("cat-1");
        expect(ids).toContain("cat-1-child");
        expect(ids).not.toContain("cat-2");
        expect(ids).not.toContain("cat-2-child");
      });
    });
  });
});
