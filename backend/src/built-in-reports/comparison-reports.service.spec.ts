import { Test, TestingModule } from "@nestjs/testing";
import { getRepositoryToken } from "@nestjs/typeorm";
import { ComparisonReportsService } from "./comparison-reports.service";
import { ReportCurrencyService } from "./report-currency.service";
import { Transaction } from "../transactions/entities/transaction.entity";
import { Category } from "../categories/entities/category.entity";

describe("ComparisonReportsService", () => {
  let service: ComparisonReportsService;
  let transactionsRepository: Record<string, jest.Mock>;
  let categoriesRepository: Record<string, jest.Mock>;
  let currencyService: Record<string, jest.Mock>;

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

  const mockStandaloneCategory: Category = {
    id: "cat-standalone",
    userId: mockUserId,
    parentId: null,
    parent: null,
    children: [],
    name: "Transport",
    description: null,
    icon: null,
    color: "#3357FF",
    isIncome: false,
    isSystem: false,
    createdAt: new Date("2025-01-03"),
  };

  beforeEach(async () => {
    transactionsRepository = {
      query: jest.fn().mockResolvedValue([]),
    };

    categoriesRepository = {
      find: jest.fn().mockResolvedValue([]),
    };

    currencyService = {
      getDefaultCurrency: jest.fn().mockResolvedValue("USD"),
      buildRateMap: jest.fn().mockResolvedValue(new Map()),
      convertAmount: jest.fn().mockImplementation((amount) => amount),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ComparisonReportsService,
        {
          provide: ReportCurrencyService,
          useValue: currencyService,
        },
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

    service = module.get<ComparisonReportsService>(ComparisonReportsService);
  });

  // ---------------------------------------------------------------------------
  // getYearOverYear
  // ---------------------------------------------------------------------------
  describe("getYearOverYear", () => {
    it("returns empty year structures when no transactions exist", async () => {
      transactionsRepository.query.mockResolvedValue([]);

      const result = await service.getYearOverYear(mockUserId, 3);

      expect(result.data).toHaveLength(3);
      result.data.forEach((yearData) => {
        expect(yearData.months).toHaveLength(12);
        expect(yearData.totals).toEqual({ income: 0, expenses: 0, savings: 0 });
        yearData.months.forEach((m) => {
          expect(m.income).toBe(0);
          expect(m.expenses).toBe(0);
          expect(m.savings).toBe(0);
        });
      });
    });

    it("creates correct number of year entries based on yearsToCompare", async () => {
      transactionsRepository.query.mockResolvedValue([]);

      const result1 = await service.getYearOverYear(mockUserId, 1);
      expect(result1.data).toHaveLength(1);

      const result5 = await service.getYearOverYear(mockUserId, 5);
      expect(result5.data).toHaveLength(5);
    });

    it("populates income and expenses from raw results", async () => {
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
          month: 2,
          currency_code: "USD",
          income: "5500.00",
          expenses: "2800.00",
        },
      ]);

      const result = await service.getYearOverYear(mockUserId, 1);

      expect(result.data).toHaveLength(1);
      const yearData = result.data[0];
      expect(yearData.year).toBe(currentYear);
      expect(yearData.months[0].income).toBe(5000);
      expect(yearData.months[0].expenses).toBe(3000);
      expect(yearData.months[0].savings).toBe(2000);
      expect(yearData.months[1].income).toBe(5500);
      expect(yearData.months[1].expenses).toBe(2800);
      expect(yearData.months[1].savings).toBe(2700);
    });

    it("calculates year totals correctly", async () => {
      const currentYear = new Date().getFullYear();
      transactionsRepository.query.mockResolvedValue([
        {
          year: currentYear,
          month: 1,
          currency_code: "USD",
          income: "1000.00",
          expenses: "500.00",
        },
        {
          year: currentYear,
          month: 6,
          currency_code: "USD",
          income: "2000.00",
          expenses: "1500.00",
        },
      ]);

      const result = await service.getYearOverYear(mockUserId, 1);
      const yearData = result.data[0];

      expect(yearData.totals.income).toBe(3000);
      expect(yearData.totals.expenses).toBe(2000);
      expect(yearData.totals.savings).toBe(1000);
    });

    it("merges multiple currency rows for the same month into one entry", async () => {
      const currentYear = new Date().getFullYear();
      currencyService.convertAmount.mockImplementation(
        (amount: number, fromCurrency: string) => {
          if (fromCurrency === "EUR") return amount * 1.1;
          return amount;
        },
      );

      transactionsRepository.query.mockResolvedValue([
        {
          year: currentYear,
          month: 3,
          currency_code: "USD",
          income: "1000.00",
          expenses: "400.00",
        },
        {
          year: currentYear,
          month: 3,
          currency_code: "EUR",
          income: "500.00",
          expenses: "200.00",
        },
      ]);

      const result = await service.getYearOverYear(mockUserId, 1);
      const march = result.data[0].months[2];

      // USD: 1000 income, 400 expenses
      // EUR: 500 * 1.1 = 550 income, 200 * 1.1 = 220 expenses
      expect(march.income).toBe(1550);
      expect(march.expenses).toBe(620);
      expect(march.savings).toBe(930);
    });

    it("sorts years in ascending order", async () => {
      const currentYear = new Date().getFullYear();
      transactionsRepository.query.mockResolvedValue([
        {
          year: currentYear,
          month: 1,
          currency_code: "USD",
          income: "100.00",
          expenses: "50.00",
        },
        {
          year: currentYear - 2,
          month: 1,
          currency_code: "USD",
          income: "300.00",
          expenses: "150.00",
        },
      ]);

      const result = await service.getYearOverYear(mockUserId, 3);

      expect(result.data[0].year).toBe(currentYear - 2);
      expect(result.data[1].year).toBe(currentYear - 1);
      expect(result.data[2].year).toBe(currentYear);
    });

    it("passes correct query parameters", async () => {
      const currentYear = new Date().getFullYear();
      transactionsRepository.query.mockResolvedValue([]);

      await service.getYearOverYear(mockUserId, 3);

      const queryCall = transactionsRepository.query.mock.calls[0];
      expect(queryCall[1]).toEqual([
        mockUserId,
        currentYear - 2,
        currentYear,
      ]);
    });

    it("rounds monetary values to 2 decimal places", async () => {
      const currentYear = new Date().getFullYear();
      transactionsRepository.query.mockResolvedValue([
        {
          year: currentYear,
          month: 1,
          currency_code: "USD",
          income: "100.555",
          expenses: "50.444",
        },
      ]);

      const result = await service.getYearOverYear(mockUserId, 1);
      const jan = result.data[0].months[0];

      expect(jan.income).toBe(100.56);
      expect(jan.expenses).toBe(50.44);
      expect(jan.savings).toBe(50.12);
    });

    it("rounds year totals to 2 decimal places", async () => {
      const currentYear = new Date().getFullYear();
      transactionsRepository.query.mockResolvedValue([
        {
          year: currentYear,
          month: 1,
          currency_code: "USD",
          income: "33.333",
          expenses: "11.111",
        },
        {
          year: currentYear,
          month: 2,
          currency_code: "USD",
          income: "33.333",
          expenses: "11.111",
        },
      ]);

      const result = await service.getYearOverYear(mockUserId, 1);
      const totals = result.data[0].totals;

      expect(totals.income).toBe(66.67);
      expect(totals.expenses).toBe(22.22);
      expect(totals.savings).toBe(44.44);
    });

    it("initializes all 12 months for each year", async () => {
      transactionsRepository.query.mockResolvedValue([]);

      const result = await service.getYearOverYear(mockUserId, 1);

      expect(result.data[0].months).toHaveLength(12);
      result.data[0].months.forEach((m, index) => {
        expect(m.month).toBe(index + 1);
      });
    });

    it("handles zero income and expenses gracefully", async () => {
      const currentYear = new Date().getFullYear();
      transactionsRepository.query.mockResolvedValue([
        {
          year: currentYear,
          month: 5,
          currency_code: "USD",
          income: "0",
          expenses: "0",
        },
      ]);

      const result = await service.getYearOverYear(mockUserId, 1);
      const may = result.data[0].months[4];

      expect(may.income).toBe(0);
      expect(may.expenses).toBe(0);
      expect(may.savings).toBe(0);
    });

    it("calls currency service with correct user id", async () => {
      transactionsRepository.query.mockResolvedValue([]);

      await service.getYearOverYear(mockUserId, 1);

      expect(currencyService.getDefaultCurrency).toHaveBeenCalledWith(
        mockUserId,
      );
      expect(currencyService.buildRateMap).toHaveBeenCalledWith("USD");
    });
  });

  // ---------------------------------------------------------------------------
  // getWeekendVsWeekday
  // ---------------------------------------------------------------------------
  describe("getWeekendVsWeekday", () => {
    it("returns zeroed summary when no transactions exist", async () => {
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
      result.byDay.forEach((d) => {
        expect(d.total).toBe(0);
        expect(d.count).toBe(0);
      });
    });

    it("separates weekend and weekday spending correctly", async () => {
      // day_of_week: 0 = Sunday, 6 = Saturday (weekend)
      // day_of_week: 1-5 = Mon-Fri (weekday)
      transactionsRepository.query.mockResolvedValue([
        {
          day_of_week: 0,
          category_id: null,
          currency_code: "USD",
          tx_count: 5,
          total: "200.00",
        },
        {
          day_of_week: 6,
          category_id: null,
          currency_code: "USD",
          tx_count: 3,
          total: "150.00",
        },
        {
          day_of_week: 1,
          category_id: null,
          currency_code: "USD",
          tx_count: 10,
          total: "500.00",
        },
        {
          day_of_week: 3,
          category_id: null,
          currency_code: "USD",
          tx_count: 8,
          total: "400.00",
        },
      ]);
      categoriesRepository.find.mockResolvedValue([]);

      const result = await service.getWeekendVsWeekday(
        mockUserId,
        "2025-01-01",
        "2025-12-31",
      );

      expect(result.summary.weekendTotal).toBe(350);
      expect(result.summary.weekdayTotal).toBe(900);
      expect(result.summary.weekendCount).toBe(8);
      expect(result.summary.weekdayCount).toBe(18);
    });

    it("returns byDay array with correct day-of-week indexing", async () => {
      transactionsRepository.query.mockResolvedValue([
        {
          day_of_week: 2,
          category_id: null,
          currency_code: "USD",
          tx_count: 4,
          total: "100.00",
        },
      ]);
      categoriesRepository.find.mockResolvedValue([]);

      const result = await service.getWeekendVsWeekday(
        mockUserId,
        "2025-01-01",
        "2025-12-31",
      );

      expect(result.byDay[2].dayOfWeek).toBe(2);
      expect(result.byDay[2].total).toBe(100);
      expect(result.byDay[2].count).toBe(4);
      // Other days should be zero
      expect(result.byDay[0].total).toBe(0);
      expect(result.byDay[1].total).toBe(0);
    });

    it("groups spending by category using parent category rollup", async () => {
      transactionsRepository.query.mockResolvedValue([
        {
          day_of_week: 1,
          category_id: "cat-child",
          currency_code: "USD",
          tx_count: 5,
          total: "300.00",
        },
        {
          day_of_week: 1,
          category_id: "cat-parent",
          currency_code: "USD",
          tx_count: 3,
          total: "200.00",
        },
      ]);
      categoriesRepository.find.mockResolvedValue([
        mockParentCategory,
        mockChildCategory,
      ]);

      const result = await service.getWeekendVsWeekday(
        mockUserId,
        "2025-01-01",
        "2025-12-31",
      );

      // Both should roll up to parent "Food & Dining"
      const foodCategory = result.byCategory.find(
        (c) => c.categoryName === "Food & Dining",
      );
      expect(foodCategory).toBeDefined();
      expect(foodCategory!.weekdayTotal).toBe(500);
    });

    it("separates the same category between weekend and weekday", async () => {
      transactionsRepository.query.mockResolvedValue([
        {
          day_of_week: 0,
          category_id: "cat-standalone",
          currency_code: "USD",
          tx_count: 2,
          total: "80.00",
        },
        {
          day_of_week: 1,
          category_id: "cat-standalone",
          currency_code: "USD",
          tx_count: 5,
          total: "200.00",
        },
      ]);
      categoriesRepository.find.mockResolvedValue([mockStandaloneCategory]);

      const result = await service.getWeekendVsWeekday(
        mockUserId,
        "2025-01-01",
        "2025-12-31",
      );

      const transport = result.byCategory.find(
        (c) => c.categoryName === "Transport",
      );
      expect(transport).toBeDefined();
      expect(transport!.weekendTotal).toBe(80);
      expect(transport!.weekdayTotal).toBe(200);
    });

    it("handles uncategorized transactions", async () => {
      transactionsRepository.query.mockResolvedValue([
        {
          day_of_week: 3,
          category_id: null,
          currency_code: "USD",
          tx_count: 3,
          total: "150.00",
        },
      ]);
      categoriesRepository.find.mockResolvedValue([]);

      const result = await service.getWeekendVsWeekday(
        mockUserId,
        "2025-01-01",
        "2025-12-31",
      );

      const uncategorized = result.byCategory.find(
        (c) => c.categoryId === null,
      );
      expect(uncategorized).toBeDefined();
      expect(uncategorized!.categoryName).toBe("Uncategorized");
      expect(uncategorized!.weekdayTotal).toBe(150);
    });

    it("limits byCategory to top 10 entries sorted by combined total", async () => {
      const rawResults = Array.from({ length: 15 }, (_, i) => ({
        day_of_week: 1,
        category_id: `cat-gen-${i}`,
        currency_code: "USD",
        tx_count: 1,
        total: `${(15 - i) * 100}.00`,
      }));
      const categories: Category[] = Array.from({ length: 15 }, (_, i) => ({
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

      const result = await service.getWeekendVsWeekday(
        mockUserId,
        "2025-01-01",
        "2025-12-31",
      );

      expect(result.byCategory).toHaveLength(10);
      // Should be sorted by combined total descending
      expect(
        result.byCategory[0].weekendTotal + result.byCategory[0].weekdayTotal,
      ).toBeGreaterThanOrEqual(
        result.byCategory[1].weekendTotal + result.byCategory[1].weekdayTotal,
      );
    });

    it("converts foreign currency amounts", async () => {
      currencyService.convertAmount.mockImplementation(
        (amount: number, fromCurrency: string) => {
          if (fromCurrency === "EUR") return amount * 1.1;
          return amount;
        },
      );

      transactionsRepository.query.mockResolvedValue([
        {
          day_of_week: 5,
          category_id: null,
          currency_code: "EUR",
          tx_count: 2,
          total: "100.00",
        },
      ]);
      categoriesRepository.find.mockResolvedValue([]);

      const result = await service.getWeekendVsWeekday(
        mockUserId,
        "2025-01-01",
        "2025-12-31",
      );

      expect(result.byDay[5].total).toBe(110);
      expect(result.summary.weekdayTotal).toBe(110);
    });

    it("rounds monetary values to 2 decimal places", async () => {
      transactionsRepository.query.mockResolvedValue([
        {
          day_of_week: 0,
          category_id: null,
          currency_code: "USD",
          tx_count: 1,
          total: "33.337",
        },
        {
          day_of_week: 6,
          category_id: null,
          currency_code: "USD",
          tx_count: 1,
          total: "66.663",
        },
      ]);
      categoriesRepository.find.mockResolvedValue([]);

      const result = await service.getWeekendVsWeekday(
        mockUserId,
        "2025-01-01",
        "2025-12-31",
      );

      expect(result.summary.weekendTotal).toBe(100);
      expect(result.byDay[0].total).toBe(33.34);
      expect(result.byDay[6].total).toBe(66.66);
    });

    it("includes startDate filter when provided", async () => {
      transactionsRepository.query.mockResolvedValue([]);
      categoriesRepository.find.mockResolvedValue([]);

      await service.getWeekendVsWeekday(
        mockUserId,
        "2025-06-01",
        "2025-12-31",
      );

      const queryCall = transactionsRepository.query.mock.calls[0];
      expect(queryCall[1]).toEqual([mockUserId, "2025-12-31", "2025-06-01"]);
    });

    it("omits startDate filter when undefined", async () => {
      transactionsRepository.query.mockResolvedValue([]);
      categoriesRepository.find.mockResolvedValue([]);

      await service.getWeekendVsWeekday(mockUserId, undefined, "2025-12-31");

      const queryCall = transactionsRepository.query.mock.calls[0];
      expect(queryCall[1]).toEqual([mockUserId, "2025-12-31"]);
      expect(queryCall[0]).not.toContain("$3");
    });

    it("handles a category appearing in both weekend and weekday by-category maps", async () => {
      transactionsRepository.query.mockResolvedValue([
        {
          day_of_week: 0,
          category_id: "cat-parent",
          currency_code: "USD",
          tx_count: 1,
          total: "50.00",
        },
        {
          day_of_week: 3,
          category_id: "cat-parent",
          currency_code: "USD",
          tx_count: 2,
          total: "100.00",
        },
      ]);
      categoriesRepository.find.mockResolvedValue([mockParentCategory]);

      const result = await service.getWeekendVsWeekday(
        mockUserId,
        "2025-01-01",
        "2025-12-31",
      );

      const food = result.byCategory.find(
        (c) => c.categoryName === "Food & Dining",
      );
      expect(food).toBeDefined();
      expect(food!.weekendTotal).toBe(50);
      expect(food!.weekdayTotal).toBe(100);
    });

    it("handles a category that only appears on weekends", async () => {
      transactionsRepository.query.mockResolvedValue([
        {
          day_of_week: 6,
          category_id: "cat-standalone",
          currency_code: "USD",
          tx_count: 3,
          total: "120.00",
        },
      ]);
      categoriesRepository.find.mockResolvedValue([mockStandaloneCategory]);

      const result = await service.getWeekendVsWeekday(
        mockUserId,
        "2025-01-01",
        "2025-12-31",
      );

      const transport = result.byCategory.find(
        (c) => c.categoryName === "Transport",
      );
      expect(transport).toBeDefined();
      expect(transport!.weekendTotal).toBe(120);
      expect(transport!.weekdayTotal).toBe(0);
    });

    it("calls currency service with correct user id", async () => {
      transactionsRepository.query.mockResolvedValue([]);
      categoriesRepository.find.mockResolvedValue([]);

      await service.getWeekendVsWeekday(
        mockUserId,
        "2025-01-01",
        "2025-12-31",
      );

      expect(currencyService.getDefaultCurrency).toHaveBeenCalledWith(
        mockUserId,
      );
      expect(currencyService.buildRateMap).toHaveBeenCalledWith("USD");
    });
  });
});
