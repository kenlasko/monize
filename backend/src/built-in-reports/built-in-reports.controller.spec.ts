import { Test, TestingModule } from "@nestjs/testing";
import { BuiltInReportsController } from "./built-in-reports.controller";
import { BuiltInReportsService } from "./built-in-reports.service";

describe("BuiltInReportsController", () => {
  let controller: BuiltInReportsController;
  let mockService: Record<string, jest.Mock>;
  const mockReq = { user: { id: "user-1" } };

  beforeEach(async () => {
    mockService = {
      getSpendingByCategory: jest.fn(),
      getSpendingByPayee: jest.fn(),
      getIncomeBySource: jest.fn(),
      getMonthlySpendingTrend: jest.fn(),
      getIncomeVsExpenses: jest.fn(),
      getYearOverYear: jest.fn(),
      getWeekendVsWeekday: jest.fn(),
      getSpendingAnomalies: jest.fn(),
      getTaxSummary: jest.fn(),
      getRecurringExpenses: jest.fn(),
      getBillPaymentHistory: jest.fn(),
      getUncategorizedTransactions: jest.fn(),
      getDuplicateTransactions: jest.fn(),
      getMonthlyComparison: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [BuiltInReportsController],
      providers: [
        {
          provide: BuiltInReportsService,
          useValue: mockService,
        },
      ],
    }).compile();

    controller = module.get<BuiltInReportsController>(BuiltInReportsController);
  });

  describe("getSpendingByCategory()", () => {
    it("delegates to service with userId, startDate, and endDate", async () => {
      const query = { startDate: "2024-01-01", endDate: "2024-12-31" };
      const expected = { categories: [], total: 0 };
      mockService.getSpendingByCategory.mockResolvedValue(expected);

      const result = await controller.getSpendingByCategory(
        mockReq,
        query as any,
      );

      expect(result).toEqual(expected);
      expect(mockService.getSpendingByCategory).toHaveBeenCalledWith(
        "user-1",
        "2024-01-01",
        "2024-12-31",
      );
    });
  });

  describe("getSpendingByPayee()", () => {
    it("delegates to service with userId, startDate, and endDate", async () => {
      const query = { startDate: "2024-01-01", endDate: "2024-12-31" };
      const expected = { payees: [], total: 0 };
      mockService.getSpendingByPayee.mockResolvedValue(expected);

      const result = await controller.getSpendingByPayee(mockReq, query as any);

      expect(result).toEqual(expected);
      expect(mockService.getSpendingByPayee).toHaveBeenCalledWith(
        "user-1",
        "2024-01-01",
        "2024-12-31",
      );
    });
  });

  describe("getIncomeBySource()", () => {
    it("delegates to service with userId, startDate, and endDate", async () => {
      const query = { startDate: "2024-01-01", endDate: "2024-06-30" };
      const expected = { sources: [], total: 0 };
      mockService.getIncomeBySource.mockResolvedValue(expected);

      const result = await controller.getIncomeBySource(mockReq, query as any);

      expect(result).toEqual(expected);
      expect(mockService.getIncomeBySource).toHaveBeenCalledWith(
        "user-1",
        "2024-01-01",
        "2024-06-30",
      );
    });
  });

  describe("getMonthlySpendingTrend()", () => {
    it("delegates to service with userId, startDate, and endDate", async () => {
      const query = { startDate: "2024-01-01", endDate: "2024-12-31" };
      const expected = { months: [], categories: [] };
      mockService.getMonthlySpendingTrend.mockResolvedValue(expected);

      const result = await controller.getMonthlySpendingTrend(
        mockReq,
        query as any,
      );

      expect(result).toEqual(expected);
      expect(mockService.getMonthlySpendingTrend).toHaveBeenCalledWith(
        "user-1",
        "2024-01-01",
        "2024-12-31",
      );
    });
  });

  describe("getIncomeVsExpenses()", () => {
    it("delegates to service with userId, startDate, and endDate", async () => {
      const query = { startDate: "2024-01-01", endDate: "2024-12-31" };
      const expected = { months: [] };
      mockService.getIncomeVsExpenses.mockResolvedValue(expected);

      const result = await controller.getIncomeVsExpenses(
        mockReq,
        query as any,
      );

      expect(result).toEqual(expected);
      expect(mockService.getIncomeVsExpenses).toHaveBeenCalledWith(
        "user-1",
        "2024-01-01",
        "2024-12-31",
      );
    });
  });

  describe("getCashFlow()", () => {
    it("delegates to service.getIncomeVsExpenses (cash flow reuses same logic)", async () => {
      const query = { startDate: "2024-01-01", endDate: "2024-12-31" };
      const expected = { months: [] };
      mockService.getIncomeVsExpenses.mockResolvedValue(expected);

      const result = await controller.getCashFlow(mockReq, query as any);

      expect(result).toEqual(expected);
      expect(mockService.getIncomeVsExpenses).toHaveBeenCalledWith(
        "user-1",
        "2024-01-01",
        "2024-12-31",
      );
    });
  });

  describe("getYearOverYear()", () => {
    it("delegates to service with userId and parsed yearsToCompare", async () => {
      const expected = { years: [] };
      mockService.getYearOverYear.mockResolvedValue(expected);

      const result = await controller.getYearOverYear(mockReq, "3");

      expect(result).toEqual(expected);
      expect(mockService.getYearOverYear).toHaveBeenCalledWith("user-1", 3);
    });

    it("defaults yearsToCompare to 2 when not provided", async () => {
      mockService.getYearOverYear.mockResolvedValue({ years: [] });

      await controller.getYearOverYear(mockReq);

      expect(mockService.getYearOverYear).toHaveBeenCalledWith("user-1", 2);
    });

    it("falls back to 2 when yearsToCompare is not a number", async () => {
      mockService.getYearOverYear.mockResolvedValue({ years: [] });

      await controller.getYearOverYear(mockReq, "abc");

      expect(mockService.getYearOverYear).toHaveBeenCalledWith("user-1", 2);
    });
  });

  describe("getWeekendVsWeekday()", () => {
    it("delegates to service with userId, startDate, and endDate", async () => {
      const query = { startDate: "2024-01-01", endDate: "2024-12-31" };
      const expected = { weekend: {}, weekday: {} };
      mockService.getWeekendVsWeekday.mockResolvedValue(expected);

      const result = await controller.getWeekendVsWeekday(
        mockReq,
        query as any,
      );

      expect(result).toEqual(expected);
      expect(mockService.getWeekendVsWeekday).toHaveBeenCalledWith(
        "user-1",
        "2024-01-01",
        "2024-12-31",
      );
    });
  });

  describe("getSpendingAnomalies()", () => {
    it("delegates to service with userId and parsed threshold", async () => {
      const expected = { anomalies: [] };
      mockService.getSpendingAnomalies.mockResolvedValue(expected);

      const result = await controller.getSpendingAnomalies(mockReq, "1.5");

      expect(result).toEqual(expected);
      expect(mockService.getSpendingAnomalies).toHaveBeenCalledWith(
        "user-1",
        1.5,
      );
    });

    it("defaults threshold to 2 when not provided", async () => {
      mockService.getSpendingAnomalies.mockResolvedValue({ anomalies: [] });

      await controller.getSpendingAnomalies(mockReq);

      expect(mockService.getSpendingAnomalies).toHaveBeenCalledWith(
        "user-1",
        2,
      );
    });

    it("falls back to 2 when threshold is not a number", async () => {
      mockService.getSpendingAnomalies.mockResolvedValue({ anomalies: [] });

      await controller.getSpendingAnomalies(mockReq, "abc");

      expect(mockService.getSpendingAnomalies).toHaveBeenCalledWith(
        "user-1",
        2,
      );
    });
  });

  describe("getTaxSummary()", () => {
    it("delegates to service with userId and parsed year", async () => {
      const expected = { year: 2024, income: 0, deductions: [] };
      mockService.getTaxSummary.mockResolvedValue(expected);

      const result = await controller.getTaxSummary(mockReq, "2024");

      expect(result).toEqual(expected);
      expect(mockService.getTaxSummary).toHaveBeenCalledWith("user-1", 2024);
    });

    it("falls back to current year when year is not a number", async () => {
      mockService.getTaxSummary.mockResolvedValue({});

      await controller.getTaxSummary(mockReq, "abc");

      expect(mockService.getTaxSummary).toHaveBeenCalledWith(
        "user-1",
        new Date().getFullYear(),
      );
    });
  });

  describe("getRecurringExpenses()", () => {
    it("delegates to service with userId and parsed minOccurrences", async () => {
      const expected = { expenses: [] };
      mockService.getRecurringExpenses.mockResolvedValue(expected);

      const result = await controller.getRecurringExpenses(mockReq, "5");

      expect(result).toEqual(expected);
      expect(mockService.getRecurringExpenses).toHaveBeenCalledWith(
        "user-1",
        5,
      );
    });

    it("defaults minOccurrences to 3 when not provided", async () => {
      mockService.getRecurringExpenses.mockResolvedValue({ expenses: [] });

      await controller.getRecurringExpenses(mockReq);

      expect(mockService.getRecurringExpenses).toHaveBeenCalledWith(
        "user-1",
        3,
      );
    });
  });

  describe("getBillPaymentHistory()", () => {
    it("delegates to service with userId, startDate, and endDate", async () => {
      const query = { startDate: "2024-01-01", endDate: "2024-12-31" };
      const expected = { bills: [] };
      mockService.getBillPaymentHistory.mockResolvedValue(expected);

      const result = await controller.getBillPaymentHistory(
        mockReq,
        query as any,
      );

      expect(result).toEqual(expected);
      expect(mockService.getBillPaymentHistory).toHaveBeenCalledWith(
        "user-1",
        "2024-01-01",
        "2024-12-31",
      );
    });
  });

  describe("getUncategorizedTransactions()", () => {
    it("delegates to service with userId, startDate, endDate, and limit", async () => {
      const query = {
        startDate: "2024-01-01",
        endDate: "2024-12-31",
        limit: 100,
      };
      const expected = { transactions: [], count: 0 };
      mockService.getUncategorizedTransactions.mockResolvedValue(expected);

      const result = await controller.getUncategorizedTransactions(
        mockReq,
        query as any,
      );

      expect(result).toEqual(expected);
      expect(mockService.getUncategorizedTransactions).toHaveBeenCalledWith(
        "user-1",
        "2024-01-01",
        "2024-12-31",
        100,
      );
    });

    it("defaults limit to 500 when not provided", async () => {
      const query = { startDate: "2024-01-01", endDate: "2024-12-31" };
      mockService.getUncategorizedTransactions.mockResolvedValue({});

      await controller.getUncategorizedTransactions(mockReq, query as any);

      expect(mockService.getUncategorizedTransactions).toHaveBeenCalledWith(
        "user-1",
        "2024-01-01",
        "2024-12-31",
        500,
      );
    });
  });

  describe("getDuplicateTransactions()", () => {
    it("delegates to service with userId, startDate, endDate, and sensitivity", async () => {
      const query = {
        startDate: "2024-01-01",
        endDate: "2024-12-31",
        sensitivity: "high",
      };
      const expected = { duplicates: [] };
      mockService.getDuplicateTransactions.mockResolvedValue(expected);

      const result = await controller.getDuplicateTransactions(
        mockReq,
        query as any,
      );

      expect(result).toEqual(expected);
      expect(mockService.getDuplicateTransactions).toHaveBeenCalledWith(
        "user-1",
        "2024-01-01",
        "2024-12-31",
        "high",
      );
    });

    it("defaults sensitivity to medium when not provided", async () => {
      const query = { startDate: "2024-01-01", endDate: "2024-12-31" };
      mockService.getDuplicateTransactions.mockResolvedValue({});

      await controller.getDuplicateTransactions(mockReq, query as any);

      expect(mockService.getDuplicateTransactions).toHaveBeenCalledWith(
        "user-1",
        "2024-01-01",
        "2024-12-31",
        "medium",
      );
    });
  });

  describe("getMonthlyComparison()", () => {
    it("delegates to service with userId and month", async () => {
      const query = { month: "2026-01" };
      const expected = { currentMonth: "2026-01", previousMonth: "2025-12" };
      mockService.getMonthlyComparison.mockResolvedValue(expected);

      const result = await controller.getMonthlyComparison(
        mockReq,
        query as any,
      );

      expect(result).toEqual(expected);
      expect(mockService.getMonthlyComparison).toHaveBeenCalledWith(
        "user-1",
        "2026-01",
      );
    });
  });
});
