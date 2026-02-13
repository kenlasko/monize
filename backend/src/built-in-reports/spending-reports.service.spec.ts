import { Test, TestingModule } from "@nestjs/testing";
import { getRepositoryToken } from "@nestjs/typeorm";
import { SpendingReportsService } from "./spending-reports.service";
import { ReportCurrencyService } from "./report-currency.service";
import { Transaction } from "../transactions/entities/transaction.entity";
import { Category } from "../categories/entities/category.entity";
import { Payee } from "../payees/entities/payee.entity";
import { UserPreference } from "../users/entities/user-preference.entity";
import { ExchangeRateService } from "../currencies/exchange-rate.service";

describe("SpendingReportsService", () => {
  let service: SpendingReportsService;
  let transactionsRepository: Record<string, jest.Mock>;
  let categoriesRepository: Record<string, jest.Mock>;
  let payeesRepository: Record<string, jest.Mock>;
  let userPreferenceRepository: Record<string, jest.Mock>;
  let exchangeRateService: Record<string, jest.Mock>;

  const mockUserId = "user-1";

  const mockParentCategory: Category = {
    id: "cat-parent",
    userId: mockUserId,
    parentId: null,
    parent: null,
    children: [],
    name: "Food & Dining",
    description: null,
    icon: null,
    color: "#FF5733",
    isIncome: false,
    isSystem: false,
    createdAt: new Date("2025-01-01"),
  };

  const mockChildCategory: Category = {
    id: "cat-child",
    userId: mockUserId,
    parentId: "cat-parent",
    parent: null,
    children: [],
    name: "Groceries",
    description: null,
    icon: null,
    color: "#33FF57",
    isIncome: false,
    isSystem: false,
    createdAt: new Date("2025-01-02"),
  };

  const mockExchangeRates = [
    { fromCurrency: "EUR", toCurrency: "USD", rate: 1.1 },
    { fromCurrency: "GBP", toCurrency: "USD", rate: 1.27 },
    { fromCurrency: "USD", toCurrency: "CAD", rate: 1.36 },
  ];

  beforeEach(async () => {
    transactionsRepository = {
      query: jest.fn().mockResolvedValue([]),
    };

    categoriesRepository = {
      find: jest.fn().mockResolvedValue([]),
    };

    payeesRepository = {
      findByIds: jest.fn().mockResolvedValue([]),
    };

    userPreferenceRepository = {
      findOne: jest.fn().mockResolvedValue({ defaultCurrency: "USD" }),
    };

    exchangeRateService = {
      getLatestRates: jest.fn().mockResolvedValue(mockExchangeRates),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SpendingReportsService,
        ReportCurrencyService,
        {
          provide: getRepositoryToken(Transaction),
          useValue: transactionsRepository,
        },
        {
          provide: getRepositoryToken(Category),
          useValue: categoriesRepository,
        },
        {
          provide: getRepositoryToken(Payee),
          useValue: payeesRepository,
        },
        {
          provide: getRepositoryToken(UserPreference),
          useValue: userPreferenceRepository,
        },
        {
          provide: ExchangeRateService,
          useValue: exchangeRateService,
        },
      ],
    }).compile();

    service = module.get<SpendingReportsService>(SpendingReportsService);
  });

  // ---------------------------------------------------------------------------
  // getSpendingByCategory
  // ---------------------------------------------------------------------------
  describe("getSpendingByCategory", () => {
    it("returns empty data when no transactions exist", async () => {
      transactionsRepository.query.mockResolvedValue([]);
      categoriesRepository.find.mockResolvedValue([]);

      const result = await service.getSpendingByCategory(
        mockUserId,
        "2025-01-01",
        "2025-12-31",
      );

      expect(result.data).toEqual([]);
      expect(result.totalSpending).toBe(0);
    });

    it("aggregates spending by parent category with rollup", async () => {
      transactionsRepository.query.mockResolvedValue([
        { category_id: "cat-child", currency_code: "USD", total: "150.00" },
        { category_id: "cat-parent", currency_code: "USD", total: "50.00" },
      ]);
      categoriesRepository.find.mockResolvedValue([
        mockParentCategory,
        mockChildCategory,
      ]);

      const result = await service.getSpendingByCategory(
        mockUserId,
        "2025-01-01",
        "2025-12-31",
      );

      expect(result.data).toHaveLength(1);
      expect(result.data[0].categoryId).toBe("cat-parent");
      expect(result.data[0].categoryName).toBe("Food & Dining");
      expect(result.data[0].total).toBe(200);
      expect(result.totalSpending).toBe(200);
    });

    it("handles uncategorized transactions (null category_id)", async () => {
      transactionsRepository.query.mockResolvedValue([
        { category_id: null, currency_code: "USD", total: "75.50" },
      ]);
      categoriesRepository.find.mockResolvedValue([]);

      const result = await service.getSpendingByCategory(
        mockUserId,
        "2025-01-01",
        "2025-12-31",
      );

      expect(result.data).toHaveLength(1);
      expect(result.data[0].categoryId).toBeNull();
      expect(result.data[0].categoryName).toBe("Uncategorized");
      expect(result.data[0].total).toBe(75.5);
    });

    it("treats unknown category_id as uncategorized", async () => {
      transactionsRepository.query.mockResolvedValue([
        { category_id: "unknown-cat", currency_code: "USD", total: "30.00" },
      ]);
      categoriesRepository.find.mockResolvedValue([mockParentCategory]);

      const result = await service.getSpendingByCategory(
        mockUserId,
        "2025-01-01",
        "2025-12-31",
      );

      expect(result.data).toHaveLength(1);
      expect(result.data[0].categoryId).toBeNull();
      expect(result.data[0].categoryName).toBe("Uncategorized");
    });

    it("converts foreign currency amounts to default currency", async () => {
      transactionsRepository.query.mockResolvedValue([
        { category_id: "cat-parent", currency_code: "EUR", total: "100.00" },
      ]);
      categoriesRepository.find.mockResolvedValue([mockParentCategory]);

      const result = await service.getSpendingByCategory(
        mockUserId,
        "2025-01-01",
        "2025-12-31",
      );

      expect(result.data[0].total).toBe(110);
    });

    it("sorts results by total descending and limits to top 15", async () => {
      const rawResults = Array.from({ length: 20 }, (_, i) => ({
        category_id: `cat-gen-${i}`,
        currency_code: "USD",
        total: `${(20 - i) * 10}.00`,
      }));
      const categories: Category[] = Array.from({ length: 20 }, (_, i) => ({
        id: `cat-gen-${i}`,
        userId: mockUserId,
        parentId: null,
        parent: null,
        children: [],
        name: `Category ${i}`,
        description: null,
        icon: null,
        color: null,
        isIncome: false,
        isSystem: false,
        createdAt: new Date(),
      }));
      transactionsRepository.query.mockResolvedValue(rawResults);
      categoriesRepository.find.mockResolvedValue(categories);

      const result = await service.getSpendingByCategory(
        mockUserId,
        "2025-01-01",
        "2025-12-31",
      );

      expect(result.data).toHaveLength(15);
      expect(result.data[0].total).toBeGreaterThanOrEqual(result.data[1].total);
    });

    it("uses default currency USD when user preference not found", async () => {
      userPreferenceRepository.findOne.mockResolvedValue(null);
      transactionsRepository.query.mockResolvedValue([
        { category_id: "cat-parent", currency_code: "USD", total: "100.00" },
      ]);
      categoriesRepository.find.mockResolvedValue([mockParentCategory]);

      const result = await service.getSpendingByCategory(
        mockUserId,
        "2025-01-01",
        "2025-12-31",
      );

      expect(result.data[0].total).toBe(100);
    });

    it("passes startDate parameter when provided", async () => {
      transactionsRepository.query.mockResolvedValue([]);
      categoriesRepository.find.mockResolvedValue([]);

      await service.getSpendingByCategory(
        mockUserId,
        "2025-01-01",
        "2025-12-31",
      );

      const queryCall = transactionsRepository.query.mock.calls[0];
      expect(queryCall[1]).toEqual([mockUserId, "2025-12-31", "2025-01-01"]);
    });

    it("omits startDate filter when startDate is undefined", async () => {
      transactionsRepository.query.mockResolvedValue([]);
      categoriesRepository.find.mockResolvedValue([]);

      await service.getSpendingByCategory(mockUserId, undefined, "2025-12-31");

      const queryCall = transactionsRepository.query.mock.calls[0];
      expect(queryCall[1]).toEqual([mockUserId, "2025-12-31"]);
      expect(queryCall[0]).not.toContain("$3");
    });

    it("returns color from parent category in response", async () => {
      transactionsRepository.query.mockResolvedValue([
        { category_id: "cat-child", currency_code: "USD", total: "100.00" },
      ]);
      categoriesRepository.find.mockResolvedValue([
        mockParentCategory,
        mockChildCategory,
      ]);

      const result = await service.getSpendingByCategory(
        mockUserId,
        "2025-01-01",
        "2025-12-31",
      );

      expect(result.data[0].color).toBe("#FF5733");
    });

    it("merges multiple uncategorized rows", async () => {
      transactionsRepository.query.mockResolvedValue([
        { category_id: null, currency_code: "USD", total: "50.00" },
        { category_id: null, currency_code: "EUR", total: "100.00" },
      ]);
      categoriesRepository.find.mockResolvedValue([]);

      const result = await service.getSpendingByCategory(
        mockUserId,
        "2025-01-01",
        "2025-12-31",
      );

      expect(result.data).toHaveLength(1);
      expect(result.data[0].categoryId).toBeNull();
      // 50 USD + 100 EUR * 1.1 = 160
      expect(result.data[0].total).toBe(160);
    });

    it("uses inverse rate for currency conversion when direct not available", async () => {
      transactionsRepository.query.mockResolvedValue([
        { category_id: "cat-parent", currency_code: "CAD", total: "136.00" },
      ]);
      categoriesRepository.find.mockResolvedValue([mockParentCategory]);

      const result = await service.getSpendingByCategory(
        mockUserId,
        "2025-01-01",
        "2025-12-31",
      );

      // 136 CAD / 1.36 = 100 USD
      expect(result.data[0].total).toBe(100);
    });
  });

  // ---------------------------------------------------------------------------
  // getSpendingByPayee
  // ---------------------------------------------------------------------------
  describe("getSpendingByPayee", () => {
    it("returns empty data when no transactions exist", async () => {
      transactionsRepository.query.mockResolvedValue([]);

      const result = await service.getSpendingByPayee(
        mockUserId,
        "2025-01-01",
        "2025-12-31",
      );

      expect(result.data).toEqual([]);
      expect(result.totalSpending).toBe(0);
    });

    it("aggregates spending by payee and merges multi-currency rows", async () => {
      transactionsRepository.query.mockResolvedValue([
        {
          payee_id: "payee-1",
          payee_name: "Starbucks",
          currency_code: "USD",
          total: "50.00",
        },
        {
          payee_id: "payee-1",
          payee_name: "Starbucks",
          currency_code: "EUR",
          total: "20.00",
        },
      ]);
      payeesRepository.findByIds.mockResolvedValue([
        { id: "payee-1", name: "Starbucks" },
      ]);

      const result = await service.getSpendingByPayee(
        mockUserId,
        "2025-01-01",
        "2025-12-31",
      );

      expect(result.data).toHaveLength(1);
      expect(result.data[0].payeeName).toBe("Starbucks");
      // 50 USD + 20 EUR * 1.1 = 50 + 22 = 72
      expect(result.data[0].total).toBe(72);
    });

    it("handles transactions without payee_id using payee_name", async () => {
      transactionsRepository.query.mockResolvedValue([
        {
          payee_id: null,
          payee_name: "Corner Store",
          currency_code: "USD",
          total: "25.00",
        },
      ]);

      const result = await service.getSpendingByPayee(
        mockUserId,
        "2025-01-01",
        "2025-12-31",
      );

      expect(result.data).toHaveLength(1);
      expect(result.data[0].payeeName).toBe("Corner Store");
      expect(result.data[0].payeeId).toBeNull();
      expect(result.data[0].total).toBe(25);
    });

    it("sorts by total descending and limits to top 20", async () => {
      const rawResults = Array.from({ length: 25 }, (_, i) => ({
        payee_id: `payee-${i}`,
        payee_name: `Payee ${i}`,
        currency_code: "USD",
        total: `${(25 - i) * 10}.00`,
      }));
      payeesRepository.findByIds.mockResolvedValue(
        Array.from({ length: 25 }, (_, i) => ({
          id: `payee-${i}`,
          name: `Payee ${i}`,
        })),
      );
      transactionsRepository.query.mockResolvedValue(rawResults);

      const result = await service.getSpendingByPayee(
        mockUserId,
        "2025-01-01",
        "2025-12-31",
      );

      expect(result.data).toHaveLength(20);
      expect(result.data[0].total).toBeGreaterThanOrEqual(result.data[1].total);
    });

    it("skips payee lookup when no payee_ids in results", async () => {
      transactionsRepository.query.mockResolvedValue([
        {
          payee_id: null,
          payee_name: "Cash Payment",
          currency_code: "USD",
          total: "10.00",
        },
      ]);

      await service.getSpendingByPayee(mockUserId, "2025-01-01", "2025-12-31");

      expect(payeesRepository.findByIds).not.toHaveBeenCalled();
    });

    it("displays 'Unknown' for payee with neither payee_id nor payee_name", async () => {
      transactionsRepository.query.mockResolvedValue([
        {
          payee_id: null,
          payee_name: null,
          currency_code: "USD",
          total: "15.00",
        },
      ]);

      const result = await service.getSpendingByPayee(
        mockUserId,
        "2025-01-01",
        "2025-12-31",
      );

      expect(result.data).toHaveLength(1);
      expect(result.data[0].payeeName).toBe("Unknown");
    });

    it("passes startDate when provided", async () => {
      transactionsRepository.query.mockResolvedValue([]);

      await service.getSpendingByPayee(mockUserId, "2025-06-01", "2025-12-31");

      const queryCall = transactionsRepository.query.mock.calls[0];
      expect(queryCall[1]).toEqual([mockUserId, "2025-12-31", "2025-06-01"]);
    });

    it("omits startDate filter when undefined", async () => {
      transactionsRepository.query.mockResolvedValue([]);

      await service.getSpendingByPayee(mockUserId, undefined, "2025-12-31");

      const queryCall = transactionsRepository.query.mock.calls[0];
      expect(queryCall[1]).toEqual([mockUserId, "2025-12-31"]);
    });

    it("calculates totalSpending from the top 20 results", async () => {
      transactionsRepository.query.mockResolvedValue([
        {
          payee_id: "payee-1",
          payee_name: "Store A",
          currency_code: "USD",
          total: "100.00",
        },
        {
          payee_id: "payee-2",
          payee_name: "Store B",
          currency_code: "USD",
          total: "200.00",
        },
      ]);
      payeesRepository.findByIds.mockResolvedValue([
        { id: "payee-1", name: "Store A" },
        { id: "payee-2", name: "Store B" },
      ]);

      const result = await service.getSpendingByPayee(
        mockUserId,
        "2025-01-01",
        "2025-12-31",
      );

      expect(result.totalSpending).toBe(300);
    });
  });

  // ---------------------------------------------------------------------------
  // getMonthlySpendingTrend
  // ---------------------------------------------------------------------------
  describe("getMonthlySpendingTrend", () => {
    it("returns empty data when no transactions exist", async () => {
      transactionsRepository.query.mockResolvedValue([]);
      categoriesRepository.find.mockResolvedValue([]);

      const result = await service.getMonthlySpendingTrend(
        mockUserId,
        "2025-01-01",
        "2025-12-31",
      );

      expect(result.data).toEqual([]);
    });

    it("groups spending by month and category with parent rollup", async () => {
      transactionsRepository.query.mockResolvedValue([
        {
          month: "2025-01",
          category_id: "cat-child",
          currency_code: "USD",
          total: "100.00",
        },
        {
          month: "2025-01",
          category_id: "cat-parent",
          currency_code: "USD",
          total: "50.00",
        },
        {
          month: "2025-02",
          category_id: "cat-child",
          currency_code: "USD",
          total: "120.00",
        },
      ]);
      categoriesRepository.find.mockResolvedValue([
        mockParentCategory,
        mockChildCategory,
      ]);

      const result = await service.getMonthlySpendingTrend(
        mockUserId,
        "2025-01-01",
        "2025-12-31",
      );

      expect(result.data).toHaveLength(2);
      expect(result.data[0].month).toBe("2025-01");
      expect(result.data[0].totalSpending).toBe(150);
      expect(result.data[1].month).toBe("2025-02");
      expect(result.data[1].totalSpending).toBe(120);
    });

    it("limits categories to top 10 across all months", async () => {
      const manyCategories: Category[] = Array.from({ length: 12 }, (_, i) => ({
        id: `cat-${i}`,
        userId: mockUserId,
        parentId: null,
        parent: null,
        children: [],
        name: `Category ${i}`,
        description: null,
        icon: null,
        color: null,
        isIncome: false,
        isSystem: false,
        createdAt: new Date(),
      }));

      const rawResults = manyCategories.map((c, i) => ({
        month: "2025-01",
        category_id: c.id,
        currency_code: "USD",
        total: `${(12 - i) * 10}.00`,
      }));

      transactionsRepository.query.mockResolvedValue(rawResults);
      categoriesRepository.find.mockResolvedValue(manyCategories);

      const result = await service.getMonthlySpendingTrend(
        mockUserId,
        "2025-01-01",
        "2025-12-31",
      );

      expect(result.data[0].categories).toHaveLength(10);
    });

    it("sorts months in ascending order", async () => {
      transactionsRepository.query.mockResolvedValue([
        {
          month: "2025-03",
          category_id: "cat-parent",
          currency_code: "USD",
          total: "100.00",
        },
        {
          month: "2025-01",
          category_id: "cat-parent",
          currency_code: "USD",
          total: "200.00",
        },
      ]);
      categoriesRepository.find.mockResolvedValue([mockParentCategory]);

      const result = await service.getMonthlySpendingTrend(
        mockUserId,
        "2025-01-01",
        "2025-12-31",
      );

      expect(result.data[0].month).toBe("2025-01");
      expect(result.data[1].month).toBe("2025-03");
    });

    it("handles uncategorized spending in trend data", async () => {
      transactionsRepository.query.mockResolvedValue([
        {
          month: "2025-01",
          category_id: null,
          currency_code: "USD",
          total: "80.00",
        },
      ]);
      categoriesRepository.find.mockResolvedValue([]);

      const result = await service.getMonthlySpendingTrend(
        mockUserId,
        "2025-01-01",
        "2025-12-31",
      );

      expect(result.data).toHaveLength(1);
      const uncatEntry = result.data[0].categories.find(
        (c) => c.categoryId === null,
      );
      expect(uncatEntry).toBeDefined();
      expect(uncatEntry!.categoryName).toBe("Uncategorized");
      expect(uncatEntry!.total).toBe(80);
    });

    it("converts foreign currency amounts in trend", async () => {
      transactionsRepository.query.mockResolvedValue([
        {
          month: "2025-01",
          category_id: "cat-parent",
          currency_code: "EUR",
          total: "100.00",
        },
      ]);
      categoriesRepository.find.mockResolvedValue([mockParentCategory]);

      const result = await service.getMonthlySpendingTrend(
        mockUserId,
        "2025-01-01",
        "2025-12-31",
      );

      // EUR->USD at 1.1 = 110
      expect(result.data[0].totalSpending).toBe(110);
    });

    it("fills zero for months where a category has no spending", async () => {
      transactionsRepository.query.mockResolvedValue([
        {
          month: "2025-01",
          category_id: "cat-parent",
          currency_code: "USD",
          total: "100.00",
        },
        {
          month: "2025-02",
          category_id: null,
          currency_code: "USD",
          total: "50.00",
        },
      ]);
      categoriesRepository.find.mockResolvedValue([mockParentCategory]);

      const result = await service.getMonthlySpendingTrend(
        mockUserId,
        "2025-01-01",
        "2025-12-31",
      );

      // Feb should have cat-parent with 0 total since it only has uncategorized
      const febParent = result.data[1].categories.find(
        (c) => c.categoryId === "cat-parent",
      );
      expect(febParent).toBeDefined();
      expect(febParent!.total).toBe(0);
    });
  });
});
