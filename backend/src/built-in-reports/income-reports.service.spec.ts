import { Test, TestingModule } from "@nestjs/testing";
import { getRepositoryToken } from "@nestjs/typeorm";
import { IncomeReportsService } from "./income-reports.service";
import { ReportCurrencyService } from "./report-currency.service";
import { Transaction } from "../transactions/entities/transaction.entity";
import { Category } from "../categories/entities/category.entity";
import { UserPreference } from "../users/entities/user-preference.entity";
import { ExchangeRateService } from "../currencies/exchange-rate.service";

describe("IncomeReportsService", () => {
  let service: IncomeReportsService;
  let transactionsRepository: Record<string, jest.Mock>;
  let categoriesRepository: Record<string, jest.Mock>;
  let userPreferenceRepository: Record<string, jest.Mock>;
  let exchangeRateService: Record<string, jest.Mock>;

  const mockUserId = "user-1";

  const mockIncomeCategory: Category = {
    id: "cat-income",
    userId: mockUserId,
    parentId: null,
    parent: null,
    children: [],
    name: "Salary",
    description: null,
    icon: null,
    color: "#5733FF",
    isIncome: true,
    isSystem: false,
    createdAt: new Date("2025-01-03"),
  };

  const mockParentCategory: Category = {
    id: "cat-parent",
    userId: mockUserId,
    parentId: null,
    parent: null,
    children: [],
    name: "Employment",
    description: null,
    icon: null,
    color: "#FF5733",
    isIncome: true,
    isSystem: false,
    createdAt: new Date("2025-01-01"),
  };

  const mockChildCategory: Category = {
    id: "cat-child",
    userId: mockUserId,
    parentId: "cat-parent",
    parent: null,
    children: [],
    name: "Bonuses",
    description: null,
    icon: null,
    color: "#33FF57",
    isIncome: true,
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

    userPreferenceRepository = {
      findOne: jest.fn().mockResolvedValue({ defaultCurrency: "USD" }),
    };

    exchangeRateService = {
      getLatestRates: jest.fn().mockResolvedValue(mockExchangeRates),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        IncomeReportsService,
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
          provide: getRepositoryToken(UserPreference),
          useValue: userPreferenceRepository,
        },
        {
          provide: ExchangeRateService,
          useValue: exchangeRateService,
        },
      ],
    }).compile();

    service = module.get<IncomeReportsService>(IncomeReportsService);
  });

  // ---------------------------------------------------------------------------
  // getIncomeBySource
  // ---------------------------------------------------------------------------
  describe("getIncomeBySource", () => {
    it("returns empty data when no income transactions exist", async () => {
      transactionsRepository.query.mockResolvedValue([]);
      categoriesRepository.find.mockResolvedValue([]);

      const result = await service.getIncomeBySource(
        mockUserId,
        "2025-01-01",
        "2025-12-31",
      );

      expect(result.data).toEqual([]);
      expect(result.totalIncome).toBe(0);
    });

    it("aggregates income by parent category with rollup", async () => {
      transactionsRepository.query.mockResolvedValue([
        { category_id: "cat-child", currency_code: "USD", total: "1000.00" },
        { category_id: "cat-parent", currency_code: "USD", total: "4000.00" },
      ]);
      categoriesRepository.find.mockResolvedValue([
        mockParentCategory,
        mockChildCategory,
      ]);

      const result = await service.getIncomeBySource(
        mockUserId,
        "2025-01-01",
        "2025-12-31",
      );

      expect(result.data).toHaveLength(1);
      expect(result.data[0].categoryId).toBe("cat-parent");
      expect(result.data[0].categoryName).toBe("Employment");
      expect(result.data[0].total).toBe(5000);
      expect(result.totalIncome).toBe(5000);
    });

    it("handles uncategorized income", async () => {
      transactionsRepository.query.mockResolvedValue([
        { category_id: null, currency_code: "USD", total: "200.00" },
      ]);
      categoriesRepository.find.mockResolvedValue([]);

      const result = await service.getIncomeBySource(
        mockUserId,
        "2025-01-01",
        "2025-12-31",
      );

      expect(result.data).toHaveLength(1);
      expect(result.data[0].categoryId).toBeNull();
      expect(result.data[0].categoryName).toBe("Uncategorized");
    });

    it("treats unknown category_id as uncategorized", async () => {
      transactionsRepository.query.mockResolvedValue([
        {
          category_id: "nonexistent-id",
          currency_code: "USD",
          total: "300.00",
        },
      ]);
      categoriesRepository.find.mockResolvedValue([mockIncomeCategory]);

      const result = await service.getIncomeBySource(
        mockUserId,
        "2025-01-01",
        "2025-12-31",
      );

      expect(result.data[0].categoryId).toBeNull();
      expect(result.data[0].categoryName).toBe("Uncategorized");
    });

    it("converts income amounts from foreign currencies", async () => {
      transactionsRepository.query.mockResolvedValue([
        { category_id: "cat-income", currency_code: "GBP", total: "1000.00" },
      ]);
      categoriesRepository.find.mockResolvedValue([mockIncomeCategory]);

      const result = await service.getIncomeBySource(
        mockUserId,
        "2025-01-01",
        "2025-12-31",
      );

      // GBP->USD rate is 1.27, so 1000 GBP = 1270 USD
      expect(result.data[0].total).toBe(1270);
    });

    it("limits results to top 15 sources", async () => {
      const rawResults = Array.from({ length: 20 }, (_, i) => ({
        category_id: `cat-inc-${i}`,
        currency_code: "USD",
        total: `${(20 - i) * 100}.00`,
      }));
      const categories: Category[] = Array.from({ length: 20 }, (_, i) => ({
        id: `cat-inc-${i}`,
        userId: mockUserId,
        parentId: null,
        parent: null,
        children: [],
        name: `Income Source ${i}`,
        description: null,
        icon: null,
        color: null,
        isIncome: true,
        isSystem: false,
        createdAt: new Date(),
      }));
      transactionsRepository.query.mockResolvedValue(rawResults);
      categoriesRepository.find.mockResolvedValue(categories);

      const result = await service.getIncomeBySource(
        mockUserId,
        "2025-01-01",
        "2025-12-31",
      );

      expect(result.data).toHaveLength(15);
    });

    it("passes startDate parameter when provided", async () => {
      transactionsRepository.query.mockResolvedValue([]);
      categoriesRepository.find.mockResolvedValue([]);

      await service.getIncomeBySource(mockUserId, "2025-06-01", "2025-12-31");

      const queryCall = transactionsRepository.query.mock.calls[0];
      expect(queryCall[1]).toEqual([mockUserId, "2025-12-31", "2025-06-01"]);
    });

    it("omits startDate filter when undefined", async () => {
      transactionsRepository.query.mockResolvedValue([]);
      categoriesRepository.find.mockResolvedValue([]);

      await service.getIncomeBySource(mockUserId, undefined, "2025-12-31");

      const queryCall = transactionsRepository.query.mock.calls[0];
      expect(queryCall[1]).toEqual([mockUserId, "2025-12-31"]);
      expect(queryCall[0]).not.toContain("$3");
    });

    it("returns color from parent category", async () => {
      transactionsRepository.query.mockResolvedValue([
        { category_id: "cat-child", currency_code: "USD", total: "500.00" },
      ]);
      categoriesRepository.find.mockResolvedValue([
        mockParentCategory,
        mockChildCategory,
      ]);

      const result = await service.getIncomeBySource(
        mockUserId,
        "2025-01-01",
        "2025-12-31",
      );

      expect(result.data[0].color).toBe("#FF5733");
    });

    it("merges multiple uncategorized rows", async () => {
      transactionsRepository.query.mockResolvedValue([
        { category_id: null, currency_code: "USD", total: "100.00" },
        { category_id: null, currency_code: "EUR", total: "200.00" },
      ]);
      categoriesRepository.find.mockResolvedValue([]);

      const result = await service.getIncomeBySource(
        mockUserId,
        "2025-01-01",
        "2025-12-31",
      );

      expect(result.data).toHaveLength(1);
      // 100 USD + 200 EUR * 1.1 = 320
      expect(result.data[0].total).toBe(320);
    });

    it("rounds totals to 2 decimal places", async () => {
      transactionsRepository.query.mockResolvedValue([
        { category_id: "cat-income", currency_code: "USD", total: "33.333" },
      ]);
      categoriesRepository.find.mockResolvedValue([mockIncomeCategory]);

      const result = await service.getIncomeBySource(
        mockUserId,
        "2025-01-01",
        "2025-12-31",
      );

      expect(result.data[0].total).toBe(33.33);
    });
  });

  // ---------------------------------------------------------------------------
  // getIncomeVsExpenses
  // ---------------------------------------------------------------------------
  describe("getIncomeVsExpenses", () => {
    it("returns empty data when no transactions exist", async () => {
      transactionsRepository.query.mockResolvedValue([]);

      const result = await service.getIncomeVsExpenses(
        mockUserId,
        "2025-01-01",
        "2025-12-31",
      );

      expect(result.data).toEqual([]);
      expect(result.totals).toEqual({ income: 0, expenses: 0, net: 0 });
    });

    it("calculates monthly income, expenses, and net correctly", async () => {
      transactionsRepository.query.mockResolvedValue([
        {
          month: "2025-01",
          currency_code: "USD",
          income: "5000.00",
          expenses: "3000.00",
        },
        {
          month: "2025-02",
          currency_code: "USD",
          income: "5000.00",
          expenses: "3500.00",
        },
      ]);

      const result = await service.getIncomeVsExpenses(
        mockUserId,
        "2025-01-01",
        "2025-12-31",
      );

      expect(result.data).toHaveLength(2);
      expect(result.data[0].month).toBe("2025-01");
      expect(result.data[0].income).toBe(5000);
      expect(result.data[0].expenses).toBe(3000);
      expect(result.data[0].net).toBe(2000);

      expect(result.totals.income).toBe(10000);
      expect(result.totals.expenses).toBe(6500);
      expect(result.totals.net).toBe(3500);
    });

    it("merges multiple currency rows for the same month", async () => {
      transactionsRepository.query.mockResolvedValue([
        {
          month: "2025-01",
          currency_code: "USD",
          income: "3000.00",
          expenses: "1000.00",
        },
        {
          month: "2025-01",
          currency_code: "EUR",
          income: "1000.00",
          expenses: "500.00",
        },
      ]);

      const result = await service.getIncomeVsExpenses(
        mockUserId,
        "2025-01-01",
        "2025-12-31",
      );

      expect(result.data).toHaveLength(1);
      // USD: 3000 income, 1000 expenses
      // EUR: 1000 * 1.1 = 1100 income, 500 * 1.1 = 550 expenses
      expect(result.data[0].income).toBe(4100);
      expect(result.data[0].expenses).toBe(1550);
      expect(result.data[0].net).toBe(2550);
    });

    it("sorts months in ascending order", async () => {
      transactionsRepository.query.mockResolvedValue([
        {
          month: "2025-03",
          currency_code: "USD",
          income: "100.00",
          expenses: "50.00",
        },
        {
          month: "2025-01",
          currency_code: "USD",
          income: "200.00",
          expenses: "100.00",
        },
        {
          month: "2025-02",
          currency_code: "USD",
          income: "150.00",
          expenses: "75.00",
        },
      ]);

      const result = await service.getIncomeVsExpenses(
        mockUserId,
        "2025-01-01",
        "2025-12-31",
      );

      expect(result.data[0].month).toBe("2025-01");
      expect(result.data[1].month).toBe("2025-02");
      expect(result.data[2].month).toBe("2025-03");
    });

    it("handles negative net (expenses exceed income)", async () => {
      transactionsRepository.query.mockResolvedValue([
        {
          month: "2025-01",
          currency_code: "USD",
          income: "2000.00",
          expenses: "5000.00",
        },
      ]);

      const result = await service.getIncomeVsExpenses(
        mockUserId,
        "2025-01-01",
        "2025-12-31",
      );

      expect(result.data[0].net).toBe(-3000);
      expect(result.totals.net).toBe(-3000);
    });

    it("rounds all monetary values to 2 decimal places", async () => {
      transactionsRepository.query.mockResolvedValue([
        {
          month: "2025-01",
          currency_code: "USD",
          income: "100.555",
          expenses: "50.444",
        },
      ]);

      const result = await service.getIncomeVsExpenses(
        mockUserId,
        "2025-01-01",
        "2025-12-31",
      );

      expect(result.data[0].income).toBe(100.56);
      expect(result.data[0].expenses).toBe(50.44);
    });

    it("passes startDate parameter when provided", async () => {
      transactionsRepository.query.mockResolvedValue([]);

      await service.getIncomeVsExpenses(mockUserId, "2025-06-01", "2025-12-31");

      const queryCall = transactionsRepository.query.mock.calls[0];
      expect(queryCall[1]).toEqual([mockUserId, "2025-12-31", "2025-06-01"]);
    });

    it("omits startDate filter when undefined", async () => {
      transactionsRepository.query.mockResolvedValue([]);

      await service.getIncomeVsExpenses(mockUserId, undefined, "2025-12-31");

      const queryCall = transactionsRepository.query.mock.calls[0];
      expect(queryCall[1]).toEqual([mockUserId, "2025-12-31"]);
    });

    it("handles month with zero income correctly", async () => {
      transactionsRepository.query.mockResolvedValue([
        {
          month: "2025-01",
          currency_code: "USD",
          income: "0",
          expenses: "500.00",
        },
      ]);

      const result = await service.getIncomeVsExpenses(
        mockUserId,
        "2025-01-01",
        "2025-12-31",
      );

      expect(result.data[0].income).toBe(0);
      expect(result.data[0].expenses).toBe(500);
      expect(result.data[0].net).toBe(-500);
    });
  });
});
