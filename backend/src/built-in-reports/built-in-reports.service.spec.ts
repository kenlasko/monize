import { Test, TestingModule } from "@nestjs/testing";
import { getRepositoryToken } from "@nestjs/typeorm";
import { BuiltInReportsService } from "./built-in-reports.service";
import { Transaction } from "../transactions/entities/transaction.entity";
import { Category } from "../categories/entities/category.entity";
import { Payee } from "../payees/entities/payee.entity";
import { UserPreference } from "../users/entities/user-preference.entity";
import { ExchangeRateService } from "../currencies/exchange-rate.service";
import { ReportCurrencyService } from "./report-currency.service";
import { SpendingReportsService } from "./spending-reports.service";
import { IncomeReportsService } from "./income-reports.service";
import { ComparisonReportsService } from "./comparison-reports.service";
import { AnomalyReportsService } from "./anomaly-reports.service";
import { TaxRecurringReportsService } from "./tax-recurring-reports.service";
import { DataQualityReportsService } from "./data-quality-reports.service";

describe("BuiltInReportsService", () => {
  let service: BuiltInReportsService;
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

  const mockMedicalCategory: Category = {
    id: "cat-medical",
    userId: mockUserId,
    parentId: null,
    parent: null,
    children: [],
    name: "Medical Expenses",
    description: null,
    icon: null,
    color: "#FF0000",
    isIncome: false,
    isSystem: false,
    createdAt: new Date("2025-01-04"),
  };

  const mockUserPreference = {
    userId: mockUserId,
    defaultCurrency: "USD",
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
      findOne: jest.fn().mockResolvedValue(mockUserPreference),
    };

    exchangeRateService = {
      getLatestRates: jest.fn().mockResolvedValue(mockExchangeRates),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        BuiltInReportsService,
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
        ReportCurrencyService,
        SpendingReportsService,
        IncomeReportsService,
        ComparisonReportsService,
        AnomalyReportsService,
        TaxRecurringReportsService,
        DataQualityReportsService,
      ],
    }).compile();

    service = module.get<BuiltInReportsService>(BuiltInReportsService);
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

      // EUR->USD rate is 1.1, so 100 EUR = 110 USD
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

      // USD to USD = no conversion, still 100
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

      // Child rolls up to parent, parent has color #FF5733
      expect(result.data[0].color).toBe("#FF5733");
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
        { category_id: "cat-income", currency_code: "USD", total: "5000.00" },
      ]);
      categoriesRepository.find.mockResolvedValue([mockIncomeCategory]);

      const result = await service.getIncomeBySource(
        mockUserId,
        "2025-01-01",
        "2025-12-31",
      );

      expect(result.data).toHaveLength(1);
      expect(result.data[0].categoryName).toBe("Salary");
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
      // Create 12 categories so only top 10 appear in results
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
  });

  // ---------------------------------------------------------------------------
  // getYearOverYear
  // ---------------------------------------------------------------------------
  describe("getYearOverYear", () => {
    it("returns data for the requested number of years with zero-filled months", async () => {
      transactionsRepository.query.mockResolvedValue([]);

      const result = await service.getYearOverYear(mockUserId, 3);

      expect(result.data).toHaveLength(3);
      result.data.forEach((yearData) => {
        expect(yearData.months).toHaveLength(12);
        yearData.months.forEach((m) => {
          expect(m.income).toBe(0);
          expect(m.expenses).toBe(0);
          expect(m.savings).toBe(0);
        });
        expect(yearData.totals).toEqual({
          income: 0,
          expenses: 0,
          savings: 0,
        });
      });
    });

    it("populates monthly data for matching year/month from raw results", async () => {
      const currentYear = new Date().getFullYear();
      transactionsRepository.query.mockResolvedValue([
        {
          year: currentYear,
          month: 1,
          currency_code: "USD",
          income: "5000.00",
          expenses: "3000.00",
        },
        {
          year: currentYear,
          month: 6,
          currency_code: "USD",
          income: "5500.00",
          expenses: "2500.00",
        },
      ]);

      const result = await service.getYearOverYear(mockUserId, 1);

      expect(result.data).toHaveLength(1);
      const yearData = result.data[0];
      expect(yearData.year).toBe(currentYear);

      // January (index 0)
      expect(yearData.months[0].income).toBe(5000);
      expect(yearData.months[0].expenses).toBe(3000);
      expect(yearData.months[0].savings).toBe(2000);

      // June (index 5)
      expect(yearData.months[5].income).toBe(5500);
      expect(yearData.months[5].expenses).toBe(2500);
      expect(yearData.months[5].savings).toBe(3000);

      // Unused month should be zero
      expect(yearData.months[2].income).toBe(0);
    });

    it("converts multi-currency amounts and accumulates totals", async () => {
      const currentYear = new Date().getFullYear();
      transactionsRepository.query.mockResolvedValue([
        {
          year: currentYear,
          month: 3,
          currency_code: "USD",
          income: "1000.00",
          expenses: "500.00",
        },
        {
          year: currentYear,
          month: 3,
          currency_code: "EUR",
          income: "1000.00",
          expenses: "200.00",
        },
      ]);

      const result = await service.getYearOverYear(mockUserId, 1);

      const march = result.data[0].months[2];
      // USD: 1000 income, 500 expenses
      // EUR: 1000 * 1.1 = 1100 income, 200 * 1.1 = 220 expenses
      expect(march.income).toBe(2100);
      expect(march.expenses).toBe(720);
      expect(march.savings).toBe(1380);
    });

    it("rounds totals to 2 decimal places", async () => {
      const currentYear = new Date().getFullYear();
      transactionsRepository.query.mockResolvedValue([
        {
          year: currentYear,
          month: 1,
          currency_code: "USD",
          income: "100.333",
          expenses: "50.666",
        },
      ]);

      const result = await service.getYearOverYear(mockUserId, 1);

      expect(yearData(result, currentYear).totals.income).toBe(100.33);
      expect(yearData(result, currentYear).totals.expenses).toBe(50.67);
    });

    it("sorts year data in ascending order", async () => {
      transactionsRepository.query.mockResolvedValue([]);

      const result = await service.getYearOverYear(mockUserId, 3);

      for (let i = 1; i < result.data.length; i++) {
        expect(result.data[i].year).toBeGreaterThan(result.data[i - 1].year);
      }
    });

    it("passes correct year range parameters to the query", async () => {
      transactionsRepository.query.mockResolvedValue([]);
      const currentYear = new Date().getFullYear();

      await service.getYearOverYear(mockUserId, 3);

      const queryCall = transactionsRepository.query.mock.calls[0];
      expect(queryCall[1]).toEqual([mockUserId, currentYear - 2, currentYear]);
    });
  });

  // ---------------------------------------------------------------------------
  // getWeekendVsWeekday
  // ---------------------------------------------------------------------------
  describe("getWeekendVsWeekday", () => {
    it("returns zero totals when no transactions exist", async () => {
      transactionsRepository.query.mockResolvedValue([]);
      categoriesRepository.find.mockResolvedValue([]);

      const result = await service.getWeekendVsWeekday(
        mockUserId,
        "2025-01-01",
        "2025-12-31",
      );

      expect(result.summary.weekendTotal).toBe(0);
      expect(result.summary.weekdayTotal).toBe(0);
      expect(result.summary.weekendCount).toBe(0);
      expect(result.summary.weekdayCount).toBe(0);
      expect(result.byDay).toHaveLength(7);
      expect(result.byCategory).toHaveLength(0);
    });

    it("separates weekend (0=Sun, 6=Sat) from weekday spending", async () => {
      transactionsRepository.query.mockResolvedValue([
        {
          day_of_week: 0,
          category_id: "cat-parent",
          currency_code: "USD",
          tx_count: 3,
          total: "150.00",
        },
        {
          day_of_week: 6,
          category_id: "cat-parent",
          currency_code: "USD",
          tx_count: 2,
          total: "100.00",
        },
        {
          day_of_week: 1,
          category_id: "cat-parent",
          currency_code: "USD",
          tx_count: 5,
          total: "200.00",
        },
        {
          day_of_week: 3,
          category_id: "cat-parent",
          currency_code: "USD",
          tx_count: 4,
          total: "180.00",
        },
      ]);
      categoriesRepository.find.mockResolvedValue([mockParentCategory]);

      const result = await service.getWeekendVsWeekday(
        mockUserId,
        "2025-01-01",
        "2025-12-31",
      );

      expect(result.summary.weekendTotal).toBe(250);
      expect(result.summary.weekdayTotal).toBe(380);
      expect(result.summary.weekendCount).toBe(5);
      expect(result.summary.weekdayCount).toBe(9);
    });

    it("builds byDay array with 7 entries for each day of the week", async () => {
      transactionsRepository.query.mockResolvedValue([
        {
          day_of_week: 2,
          category_id: null,
          currency_code: "USD",
          tx_count: 1,
          total: "50.00",
        },
      ]);
      categoriesRepository.find.mockResolvedValue([]);

      const result = await service.getWeekendVsWeekday(
        mockUserId,
        "2025-01-01",
        "2025-12-31",
      );

      expect(result.byDay).toHaveLength(7);
      expect(result.byDay[2].total).toBe(50);
      expect(result.byDay[2].count).toBe(1);
      expect(result.byDay[0].total).toBe(0);
    });

    it("builds byCategory with parent rollup and limits to top 10", async () => {
      const manyCategories: Category[] = Array.from({ length: 12 }, (_, i) => ({
        id: `cat-wk-${i}`,
        userId: mockUserId,
        parentId: null,
        parent: null,
        children: [],
        name: `Cat ${i}`,
        description: null,
        icon: null,
        color: null,
        isIncome: false,
        isSystem: false,
        createdAt: new Date(),
      }));

      const rawResults = manyCategories.map((c, i) => ({
        day_of_week: i % 7,
        category_id: c.id,
        currency_code: "USD",
        tx_count: 1,
        total: `${(12 - i) * 10}.00`,
      }));

      transactionsRepository.query.mockResolvedValue(rawResults);
      categoriesRepository.find.mockResolvedValue(manyCategories);

      const result = await service.getWeekendVsWeekday(
        mockUserId,
        "2025-01-01",
        "2025-12-31",
      );

      expect(result.byCategory.length).toBeLessThanOrEqual(10);
    });
  });

  // ---------------------------------------------------------------------------
  // getSpendingAnomalies
  // ---------------------------------------------------------------------------
  describe("getSpendingAnomalies", () => {
    it("returns empty anomalies when fewer than 10 transactions exist", async () => {
      transactionsRepository.query.mockResolvedValue(
        Array.from({ length: 5 }, (_, i) => ({
          id: `tx-${i}`,
          transaction_date: new Date("2025-06-01"),
          payee_id: null,
          payee_name: "Store",
          currency_code: "USD",
          category_id: null,
          amount: "50.00",
        })),
      );

      const result = await service.getSpendingAnomalies(mockUserId);

      expect(result.anomalies).toEqual([]);
      expect(result.statistics).toEqual({ mean: 0, stdDev: 0 });
      expect(result.counts).toEqual({ high: 0, medium: 0, low: 0 });
    });

    it("detects large transaction anomalies based on z-score", async () => {
      // Create 20 normal transactions and 1 large outlier
      const now = new Date();
      const normalTxs = Array.from({ length: 20 }, (_, i) => ({
        id: `tx-${i}`,
        transaction_date: new Date(
          now.getFullYear(),
          now.getMonth(),
          now.getDate() - i - 1,
        ),
        payee_id: null,
        payee_name: "Normal Store",
        currency_code: "USD",
        category_id: null,
        amount: "50.00",
      }));
      const outlier = {
        id: "tx-outlier",
        transaction_date: new Date(
          now.getFullYear(),
          now.getMonth(),
          now.getDate(),
        ),
        payee_id: null,
        payee_name: "Big Purchase",
        currency_code: "USD",
        category_id: null,
        amount: "5000.00",
      };

      transactionsRepository.query.mockResolvedValue([...normalTxs, outlier]);
      categoriesRepository.find.mockResolvedValue([]);

      const result = await service.getSpendingAnomalies(mockUserId, 2);

      const largeTxAnomalies = result.anomalies.filter(
        (a) => a.type === "large_transaction",
      );
      expect(largeTxAnomalies.length).toBeGreaterThan(0);
      expect(largeTxAnomalies[0].amount).toBe(5000);
    });

    it("calculates mean and standard deviation correctly", async () => {
      const now = new Date();
      // All transactions with same amount = 100, so stdDev = 0
      const txs = Array.from({ length: 15 }, (_, i) => ({
        id: `tx-${i}`,
        transaction_date: new Date(
          now.getFullYear(),
          now.getMonth(),
          now.getDate() - i,
        ),
        payee_id: null,
        payee_name: "Store",
        currency_code: "USD",
        category_id: null,
        amount: "100.00",
      }));

      transactionsRepository.query.mockResolvedValue(txs);
      categoriesRepository.find.mockResolvedValue([]);

      const result = await service.getSpendingAnomalies(mockUserId);

      expect(result.statistics.mean).toBe(100);
      expect(result.statistics.stdDev).toBe(0);
    });

    it("sorts anomalies by severity (high > medium > low) then by amount", async () => {
      const now = new Date();
      // Many small transactions with a few different sized outliers
      const txs = Array.from({ length: 20 }, (_, i) => ({
        id: `tx-${i}`,
        transaction_date: new Date(
          now.getFullYear(),
          now.getMonth(),
          now.getDate() - i - 1,
        ),
        payee_id: null,
        payee_name: "Normal Store",
        currency_code: "USD",
        category_id: null,
        amount: "10.00",
      }));
      // Two big outliers
      txs.push({
        id: "tx-big-1",
        transaction_date: new Date(
          now.getFullYear(),
          now.getMonth(),
          now.getDate(),
        ),
        payee_id: null,
        payee_name: "Outlier 1",
        currency_code: "USD",
        category_id: null,
        amount: "500.00",
      });
      txs.push({
        id: "tx-big-2",
        transaction_date: new Date(
          now.getFullYear(),
          now.getMonth(),
          now.getDate(),
        ),
        payee_id: null,
        payee_name: "Outlier 2",
        currency_code: "USD",
        category_id: null,
        amount: "1000.00",
      });

      transactionsRepository.query.mockResolvedValue(txs);
      categoriesRepository.find.mockResolvedValue([]);

      const result = await service.getSpendingAnomalies(mockUserId, 2);

      if (result.anomalies.length > 1) {
        const severityOrder: Record<string, number> = {
          high: 0,
          medium: 1,
          low: 2,
        };
        for (let i = 1; i < result.anomalies.length; i++) {
          const prevSev = severityOrder[result.anomalies[i - 1].severity];
          const currSev = severityOrder[result.anomalies[i].severity];
          expect(currSev).toBeGreaterThanOrEqual(prevSev);
        }
      }
    });
  });

  // ---------------------------------------------------------------------------
  // getTaxSummary
  // ---------------------------------------------------------------------------
  describe("getTaxSummary", () => {
    it("returns zero totals when no transactions exist", async () => {
      transactionsRepository.query.mockResolvedValue([]);
      categoriesRepository.find.mockResolvedValue([]);

      const result = await service.getTaxSummary(mockUserId, 2025);

      expect(result.totals).toEqual({
        income: 0,
        expenses: 0,
        deductible: 0,
      });
      expect(result.incomeBySource).toEqual([]);
      expect(result.deductibleExpenses).toEqual([]);
      expect(result.allExpenses).toEqual([]);
    });

    it("separates income and expenses by category", async () => {
      transactionsRepository.query.mockResolvedValue([
        {
          category_id: "cat-income",
          currency_code: "USD",
          amount: "5000.00",
        },
        {
          category_id: "cat-parent",
          currency_code: "USD",
          amount: "-1200.00",
        },
      ]);
      categoriesRepository.find.mockResolvedValue([
        mockIncomeCategory,
        mockParentCategory,
      ]);

      const result = await service.getTaxSummary(mockUserId, 2025);

      expect(result.totals.income).toBe(5000);
      expect(result.totals.expenses).toBe(1200);
      expect(result.incomeBySource).toHaveLength(1);
      expect(result.incomeBySource[0].name).toBe("Salary");
      expect(result.allExpenses).toHaveLength(1);
      expect(result.allExpenses[0].name).toBe("Food & Dining");
    });

    it("identifies tax-deductible expenses based on category name keywords", async () => {
      transactionsRepository.query.mockResolvedValue([
        {
          category_id: "cat-medical",
          currency_code: "USD",
          amount: "-500.00",
        },
        {
          category_id: "cat-parent",
          currency_code: "USD",
          amount: "-300.00",
        },
      ]);
      categoriesRepository.find.mockResolvedValue([
        mockMedicalCategory,
        mockParentCategory,
      ]);

      const result = await service.getTaxSummary(mockUserId, 2025);

      expect(result.deductibleExpenses).toHaveLength(1);
      expect(result.deductibleExpenses[0].name).toBe("Medical Expenses");
      expect(result.deductibleExpenses[0].total).toBe(500);
      expect(result.totals.deductible).toBe(500);
    });

    it("passes correct year date range to the query", async () => {
      transactionsRepository.query.mockResolvedValue([]);
      categoriesRepository.find.mockResolvedValue([]);

      await service.getTaxSummary(mockUserId, 2025);

      const queryCall = transactionsRepository.query.mock.calls[0];
      expect(queryCall[1]).toEqual([mockUserId, "2025-01-01", "2025-12-31"]);
    });

    it("converts foreign currency amounts for tax calculations", async () => {
      transactionsRepository.query.mockResolvedValue([
        {
          category_id: "cat-income",
          currency_code: "EUR",
          amount: "1000.00",
        },
      ]);
      categoriesRepository.find.mockResolvedValue([mockIncomeCategory]);

      const result = await service.getTaxSummary(mockUserId, 2025);

      // EUR->USD rate is 1.1
      expect(result.totals.income).toBe(1100);
    });

    it("uses parent category name for display when child has a parent", async () => {
      transactionsRepository.query.mockResolvedValue([
        {
          category_id: "cat-child",
          currency_code: "USD",
          amount: "-100.00",
        },
      ]);
      categoriesRepository.find.mockResolvedValue([
        mockParentCategory,
        mockChildCategory,
      ]);

      const result = await service.getTaxSummary(mockUserId, 2025);

      expect(result.allExpenses[0].name).toBe("Food & Dining");
    });
  });

  // ---------------------------------------------------------------------------
  // getRecurringExpenses
  // ---------------------------------------------------------------------------
  describe("getRecurringExpenses", () => {
    it("returns empty data when no recurring expenses found", async () => {
      transactionsRepository.query.mockResolvedValue([]);

      const result = await service.getRecurringExpenses(mockUserId);

      expect(result.data).toEqual([]);
      expect(result.summary).toEqual({
        totalRecurring: 0,
        monthlyEstimate: 0,
        uniquePayees: 0,
      });
    });

    it("returns recurring expenses with frequency estimation", async () => {
      transactionsRepository.query.mockResolvedValue([
        {
          payee_id: "payee-1",
          payee_name_normalized: "netflix",
          payee_name: "Netflix",
          category_name: "Entertainment",
          currency_code: "USD",
          occurrences: 6,
          total_amount: "90.00",
          last_transaction_date: new Date("2025-06-15"),
        },
      ]);

      const result = await service.getRecurringExpenses(mockUserId);

      expect(result.data).toHaveLength(1);
      expect(result.data[0].payeeName).toBe("Netflix");
      expect(result.data[0].frequency).toBe("Monthly");
      expect(result.data[0].totalAmount).toBe(90);
      expect(result.data[0].averageAmount).toBe(15);
      expect(result.data[0].occurrences).toBe(6);
    });

    it("estimates frequency based on occurrences over 6 months", async () => {
      transactionsRepository.query.mockResolvedValue([
        {
          payee_id: "p1",
          payee_name_normalized: "weekly sub",
          payee_name: "Weekly Sub",
          category_name: null,
          currency_code: "USD",
          occurrences: 24,
          total_amount: "120.00",
          last_transaction_date: new Date("2025-06-01"),
        },
        {
          payee_id: "p2",
          payee_name_normalized: "biweekly",
          payee_name: "Biweekly",
          category_name: null,
          currency_code: "USD",
          occurrences: 12,
          total_amount: "240.00",
          last_transaction_date: new Date("2025-06-01"),
        },
        {
          payee_id: "p3",
          payee_name_normalized: "occasional",
          payee_name: "Occasional",
          category_name: null,
          currency_code: "USD",
          occurrences: 3,
          total_amount: "150.00",
          last_transaction_date: new Date("2025-06-01"),
        },
      ]);

      const result = await service.getRecurringExpenses(mockUserId);

      const weekly = result.data.find((d) => d.payeeName === "Weekly Sub");
      const biweekly = result.data.find((d) => d.payeeName === "Biweekly");
      const occasional = result.data.find((d) => d.payeeName === "Occasional");

      expect(weekly?.frequency).toBe("Weekly");
      expect(biweekly?.frequency).toBe("Bi-weekly");
      expect(occasional?.frequency).toBe("Occasional");
    });

    it("merges multi-currency rows for the same payee", async () => {
      transactionsRepository.query.mockResolvedValue([
        {
          payee_id: "p1",
          payee_name_normalized: "global shop",
          payee_name: "Global Shop",
          category_name: "Shopping",
          currency_code: "USD",
          occurrences: 3,
          total_amount: "100.00",
          last_transaction_date: new Date("2025-05-01"),
        },
        {
          payee_id: "p1",
          payee_name_normalized: "global shop",
          payee_name: "Global Shop",
          category_name: "Shopping",
          currency_code: "EUR",
          occurrences: 3,
          total_amount: "50.00",
          last_transaction_date: new Date("2025-06-01"),
        },
      ]);

      const result = await service.getRecurringExpenses(mockUserId);

      expect(result.data).toHaveLength(1);
      // USD: 100 + EUR: 50 * 1.1 = 155
      expect(result.data[0].totalAmount).toBe(155);
      expect(result.data[0].occurrences).toBe(6);
      // Average: 155 / 6 = 25.83
      expect(result.data[0].averageAmount).toBe(25.83);
    });

    it("calculates summary correctly", async () => {
      transactionsRepository.query.mockResolvedValue([
        {
          payee_id: "p1",
          payee_name_normalized: "sub1",
          payee_name: "Sub1",
          category_name: null,
          currency_code: "USD",
          occurrences: 6,
          total_amount: "600.00",
          last_transaction_date: new Date("2025-06-01"),
        },
        {
          payee_id: "p2",
          payee_name_normalized: "sub2",
          payee_name: "Sub2",
          category_name: null,
          currency_code: "USD",
          occurrences: 6,
          total_amount: "300.00",
          last_transaction_date: new Date("2025-06-01"),
        },
      ]);

      const result = await service.getRecurringExpenses(mockUserId);

      expect(result.summary.totalRecurring).toBe(900);
      // Monthly estimate = totalRecurring / 6
      expect(result.summary.monthlyEstimate).toBe(150);
      expect(result.summary.uniquePayees).toBe(2);
    });

    it("passes minOccurrences parameter to query", async () => {
      transactionsRepository.query.mockResolvedValue([]);

      await service.getRecurringExpenses(mockUserId, 5);

      const queryCall = transactionsRepository.query.mock.calls[0];
      expect(queryCall[1][3]).toBe(5);
    });
  });

  // ---------------------------------------------------------------------------
  // getBillPaymentHistory
  // ---------------------------------------------------------------------------
  describe("getBillPaymentHistory", () => {
    it("returns empty result when no scheduled transactions exist", async () => {
      // First query returns scheduled transactions, second returns actual transactions
      transactionsRepository.query.mockResolvedValueOnce([]);

      const result = await service.getBillPaymentHistory(
        mockUserId,
        "2025-01-01",
        "2025-12-31",
      );

      expect(result.billPayments).toEqual([]);
      expect(result.monthlyTotals).toEqual([]);
      expect(result.summary).toEqual({
        totalPaid: 0,
        totalPayments: 0,
        uniqueBills: 0,
        monthlyAverage: 0,
      });
    });

    it("matches actual transactions to scheduled bills by payee name and amount tolerance", async () => {
      // First query: scheduled transactions
      transactionsRepository.query.mockResolvedValueOnce([
        {
          id: "sched-1",
          name: "Rent Payment",
          amount: "-1500.00",
          payee_name: "Landlord LLC",
        },
      ]);

      // Second query: actual transactions
      transactionsRepository.query.mockResolvedValueOnce([
        {
          id: "tx-1",
          transaction_date: new Date("2025-01-15"),
          currency_code: "USD",
          amount: "1480.00",
          payee_name_normalized: "landlord llc",
        },
        {
          id: "tx-2",
          transaction_date: new Date("2025-02-15"),
          currency_code: "USD",
          amount: "1500.00",
          payee_name_normalized: "landlord llc",
        },
      ]);

      const result = await service.getBillPaymentHistory(
        mockUserId,
        "2025-01-01",
        "2025-12-31",
      );

      expect(result.billPayments).toHaveLength(1);
      expect(result.billPayments[0].scheduledTransactionName).toBe(
        "Rent Payment",
      );
      expect(result.billPayments[0].paymentCount).toBe(2);
    });

    it("rejects transactions outside 20% amount tolerance", async () => {
      transactionsRepository.query.mockResolvedValueOnce([
        {
          id: "sched-1",
          name: "Internet",
          amount: "-100.00",
          payee_name: "ISP Corp",
        },
      ]);

      transactionsRepository.query.mockResolvedValueOnce([
        {
          id: "tx-1",
          transaction_date: new Date("2025-01-15"),
          currency_code: "USD",
          amount: "50.00", // 50% of expected, outside 20% tolerance
          payee_name_normalized: "isp corp",
        },
      ]);

      const result = await service.getBillPaymentHistory(
        mockUserId,
        "2025-01-01",
        "2025-12-31",
      );

      expect(result.billPayments).toHaveLength(0);
    });

    it("calculates summary statistics correctly", async () => {
      transactionsRepository.query.mockResolvedValueOnce([
        {
          id: "sched-1",
          name: "Rent",
          amount: "-1500.00",
          payee_name: "Landlord",
        },
        {
          id: "sched-2",
          name: "Internet",
          amount: "-100.00",
          payee_name: "ISP",
        },
      ]);

      transactionsRepository.query.mockResolvedValueOnce([
        {
          id: "tx-1",
          transaction_date: new Date("2025-01-15"),
          currency_code: "USD",
          amount: "1500.00",
          payee_name_normalized: "landlord",
        },
        {
          id: "tx-2",
          transaction_date: new Date("2025-02-15"),
          currency_code: "USD",
          amount: "1500.00",
          payee_name_normalized: "landlord",
        },
        {
          id: "tx-3",
          transaction_date: new Date("2025-01-20"),
          currency_code: "USD",
          amount: "100.00",
          payee_name_normalized: "isp",
        },
      ]);

      const result = await service.getBillPaymentHistory(
        mockUserId,
        "2025-01-01",
        "2025-12-31",
      );

      expect(result.summary.totalPaid).toBe(3100);
      expect(result.summary.totalPayments).toBe(3);
      expect(result.summary.uniqueBills).toBe(2);
    });
  });

  // ---------------------------------------------------------------------------
  // getUncategorizedTransactions
  // ---------------------------------------------------------------------------
  describe("getUncategorizedTransactions", () => {
    it("returns empty result when no uncategorized transactions exist", async () => {
      // First query: transactions, second query: summary
      transactionsRepository.query
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([]);

      const result = await service.getUncategorizedTransactions(
        mockUserId,
        "2025-01-01",
        "2025-12-31",
      );

      expect(result.transactions).toEqual([]);
      expect(result.summary.totalCount).toBe(0);
    });

    it("returns uncategorized transactions with converted amounts", async () => {
      transactionsRepository.query
        .mockResolvedValueOnce([
          {
            id: "tx-1",
            transaction_date: "2025-06-15",
            currency_code: "EUR",
            amount: "-50.00",
            payee_name: "Unknown Shop",
            description: "Misc purchase",
            account_name: "Checking",
          },
        ])
        .mockResolvedValueOnce([
          {
            currency_code: "EUR",
            total_count: "1",
            expense_count: "1",
            expense_total: "50.00",
            income_count: "0",
            income_total: "0",
          },
        ]);

      const result = await service.getUncategorizedTransactions(
        mockUserId,
        "2025-01-01",
        "2025-12-31",
      );

      expect(result.transactions).toHaveLength(1);
      // EUR->USD rate 1.1, so -50 EUR = -55 USD
      expect(result.transactions[0].amount).toBeCloseTo(-55, 5);
      expect(result.transactions[0].payeeName).toBe("Unknown Shop");
    });

    it("calculates summary totals across multiple currencies", async () => {
      transactionsRepository.query
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([
          {
            currency_code: "USD",
            total_count: "5",
            expense_count: "3",
            expense_total: "300.00",
            income_count: "2",
            income_total: "500.00",
          },
          {
            currency_code: "EUR",
            total_count: "2",
            expense_count: "1",
            expense_total: "100.00",
            income_count: "1",
            income_total: "200.00",
          },
        ]);

      const result = await service.getUncategorizedTransactions(
        mockUserId,
        "2025-01-01",
        "2025-12-31",
      );

      expect(result.summary.totalCount).toBe(7);
      expect(result.summary.expenseCount).toBe(4);
      // USD: 300 + EUR: 100 * 1.1 = 410
      expect(result.summary.expenseTotal).toBe(410);
      expect(result.summary.incomeCount).toBe(3);
      // USD: 500 + EUR: 200 * 1.1 = 720
      expect(result.summary.incomeTotal).toBe(720);
    });

    it("passes limit parameter to the query", async () => {
      transactionsRepository.query
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([]);

      await service.getUncategorizedTransactions(
        mockUserId,
        "2025-01-01",
        "2025-12-31",
        100,
      );

      const firstQueryParams = transactionsRepository.query.mock.calls[0][1];
      expect(firstQueryParams).toContain(100);
    });

    it("handles undefined startDate by omitting date lower bound", async () => {
      transactionsRepository.query
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([]);

      await service.getUncategorizedTransactions(
        mockUserId,
        undefined,
        "2025-12-31",
        500,
      );

      // First query params should only have userId, endDate, and limit
      const firstQueryParams = transactionsRepository.query.mock.calls[0][1];
      expect(firstQueryParams).toEqual([mockUserId, "2025-12-31", 500]);
    });
  });

  // ---------------------------------------------------------------------------
  // getDuplicateTransactions
  // ---------------------------------------------------------------------------
  describe("getDuplicateTransactions", () => {
    it("returns empty result when no transactions exist", async () => {
      transactionsRepository.query.mockResolvedValue([]);

      const result = await service.getDuplicateTransactions(
        mockUserId,
        "2025-01-01",
        "2025-12-31",
      );

      expect(result.groups).toEqual([]);
      expect(result.summary.totalGroups).toBe(0);
      expect(result.summary.potentialSavings).toBe(0);
    });

    it("detects duplicate transactions with same date, amount, and payee", async () => {
      transactionsRepository.query.mockResolvedValue([
        {
          id: "tx-1",
          transaction_date: "2025-06-15",
          amount: "-50.00",
          payee_name: "Starbucks",
          description: "Coffee",
          account_name: "Checking",
        },
        {
          id: "tx-2",
          transaction_date: "2025-06-15",
          amount: "-50.00",
          payee_name: "Starbucks",
          description: "Coffee",
          account_name: "Credit Card",
        },
      ]);

      const result = await service.getDuplicateTransactions(
        mockUserId,
        "2025-01-01",
        "2025-12-31",
      );

      expect(result.groups).toHaveLength(1);
      expect(result.groups[0].confidence).toBe("high");
      expect(result.groups[0].reason).toBe("Same date, amount, and payee");
      expect(result.groups[0].transactions).toHaveLength(2);
    });

    it("does not flag transactions with different amounts as duplicates", async () => {
      transactionsRepository.query.mockResolvedValue([
        {
          id: "tx-1",
          transaction_date: "2025-06-15",
          amount: "-50.00",
          payee_name: "Starbucks",
          description: null,
          account_name: "Checking",
        },
        {
          id: "tx-2",
          transaction_date: "2025-06-15",
          amount: "-75.00",
          payee_name: "Starbucks",
          description: null,
          account_name: "Checking",
        },
      ]);

      const result = await service.getDuplicateTransactions(
        mockUserId,
        "2025-01-01",
        "2025-12-31",
      );

      expect(result.groups).toHaveLength(0);
    });

    it("assigns medium confidence when same date and amount but one payee missing", async () => {
      // When one payee is present and the other is null, the check
      // `payee1 && payee2 && payee1 !== payee2` short-circuits (one is falsy)
      // so they still match. But allSamePayee is false ("store a" !== ""),
      // resulting in medium confidence.
      transactionsRepository.query.mockResolvedValue([
        {
          id: "tx-1",
          transaction_date: "2025-06-15",
          amount: "-50.00",
          payee_name: "Store A",
          description: null,
          account_name: "Checking",
        },
        {
          id: "tx-2",
          transaction_date: "2025-06-15",
          amount: "-50.00",
          payee_name: null,
          description: null,
          account_name: "Credit Card",
        },
      ]);

      const result = await service.getDuplicateTransactions(
        mockUserId,
        "2025-01-01",
        "2025-12-31",
      );

      expect(result.groups).toHaveLength(1);
      expect(result.groups[0].confidence).toBe("medium");
      expect(result.groups[0].reason).toBe("Same date and amount");
    });

    it("respects sensitivity level for day range", async () => {
      transactionsRepository.query.mockResolvedValue([
        {
          id: "tx-1",
          transaction_date: "2025-06-15",
          amount: "-50.00",
          payee_name: "Store",
          description: null,
          account_name: "Checking",
        },
        {
          id: "tx-2",
          transaction_date: "2025-06-17",
          amount: "-50.00",
          payee_name: "Store",
          description: null,
          account_name: "Checking",
        },
      ]);

      // High sensitivity allows 3-day window
      const highResult = await service.getDuplicateTransactions(
        mockUserId,
        "2025-01-01",
        "2025-12-31",
        "high",
      );
      expect(highResult.groups).toHaveLength(1);

      // Medium sensitivity allows 1-day window
      const medResult = await service.getDuplicateTransactions(
        mockUserId,
        "2025-01-01",
        "2025-12-31",
        "medium",
      );
      expect(medResult.groups).toHaveLength(0);
    });

    it("calculates potential savings from duplicate groups", async () => {
      transactionsRepository.query.mockResolvedValue([
        {
          id: "tx-1",
          transaction_date: "2025-06-15",
          amount: "-100.00",
          payee_name: "Store",
          description: null,
          account_name: "Checking",
        },
        {
          id: "tx-2",
          transaction_date: "2025-06-15",
          amount: "-100.00",
          payee_name: "Store",
          description: null,
          account_name: "Credit Card",
        },
        {
          id: "tx-3",
          transaction_date: "2025-06-15",
          amount: "-100.00",
          payee_name: "Store",
          description: null,
          account_name: "Other",
        },
      ]);

      const result = await service.getDuplicateTransactions(
        mockUserId,
        "2025-01-01",
        "2025-12-31",
      );

      // 3 transactions in group, 2 are duplicates, potential savings = 100 * 2 = 200
      expect(result.summary.potentialSavings).toBe(200);
    });

    it("sorts groups by confidence (high first) then by amount", async () => {
      transactionsRepository.query.mockResolvedValue([
        // High confidence pair (same date, payee, amount)
        {
          id: "tx-a1",
          transaction_date: "2025-06-15",
          amount: "-50.00",
          payee_name: "Store A",
          description: null,
          account_name: "Checking",
        },
        {
          id: "tx-a2",
          transaction_date: "2025-06-15",
          amount: "-50.00",
          payee_name: "Store A",
          description: null,
          account_name: "Credit",
        },
        // Medium confidence pair (same date, amount, one payee missing)
        {
          id: "tx-b1",
          transaction_date: "2025-06-20",
          amount: "-200.00",
          payee_name: "Store X",
          description: null,
          account_name: "Checking",
        },
        {
          id: "tx-b2",
          transaction_date: "2025-06-20",
          amount: "-200.00",
          payee_name: null,
          description: null,
          account_name: "Credit",
        },
      ]);

      const result = await service.getDuplicateTransactions(
        mockUserId,
        "2025-01-01",
        "2025-12-31",
      );

      expect(result.groups.length).toBeGreaterThanOrEqual(2);
      expect(result.groups[0].confidence).toBe("high");
      expect(result.groups[1].confidence).toBe("medium");
    });
  });

  // ---------------------------------------------------------------------------
  // Currency conversion (private helper, tested through public methods)
  // ---------------------------------------------------------------------------
  describe("currency conversion", () => {
    it("uses inverse rate when direct rate is not available", async () => {
      // CAD->USD: no direct rate exists, but USD->CAD = 1.36 does
      transactionsRepository.query.mockResolvedValue([
        { category_id: "cat-parent", currency_code: "CAD", total: "136.00" },
      ]);
      categoriesRepository.find.mockResolvedValue([mockParentCategory]);

      const result = await service.getSpendingByCategory(
        mockUserId,
        "2025-01-01",
        "2025-12-31",
      );

      // 136 CAD / 1.36 (inverse of USD->CAD) = 100 USD
      expect(result.data[0].total).toBe(100);
    });

    it("returns original amount when no conversion rate is found", async () => {
      // JPY has no rate in our mock rates
      transactionsRepository.query.mockResolvedValue([
        { category_id: "cat-parent", currency_code: "JPY", total: "1000.00" },
      ]);
      categoriesRepository.find.mockResolvedValue([mockParentCategory]);

      const result = await service.getSpendingByCategory(
        mockUserId,
        "2025-01-01",
        "2025-12-31",
      );

      // No JPY->USD or USD->JPY rate, returns original amount
      expect(result.data[0].total).toBe(1000);
    });

    it("does not convert when currency matches default", async () => {
      transactionsRepository.query.mockResolvedValue([
        { category_id: "cat-parent", currency_code: "USD", total: "250.00" },
      ]);
      categoriesRepository.find.mockResolvedValue([mockParentCategory]);

      const result = await service.getSpendingByCategory(
        mockUserId,
        "2025-01-01",
        "2025-12-31",
      );

      expect(result.data[0].total).toBe(250);
    });
  });
});

// --- Helper ---

function yearData(
  result: {
    data: Array<{
      year: number;
      totals: { income: number; expenses: number; savings: number };
    }>;
  },
  year: number,
) {
  const found = result.data.find((d) => d.year === year);
  if (!found) throw new Error(`Year ${year} not found in result`);
  return found;
}
