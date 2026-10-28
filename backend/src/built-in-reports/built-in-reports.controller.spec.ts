jest.mock("../accruals/reporting-basis", () =>
  jest
    .requireActual("../test-helpers/reporting-read-testing")
    .reportingBasisMockModule(),
);
jest.mock("../accruals/reporting-query", () =>
  jest
    .requireActual("../test-helpers/reporting-read-testing")
    .reportingQueryMockModule(),
);
jest.mock("../accruals/reporting-basis.interceptor", () =>
  jest
    .requireActual("../test-helpers/reporting-read-testing")
    .reportingInterceptorMockModule(),
);

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
      getMonthlyCategoryBreakdown: jest.fn(),
      getCashFlowSankey: jest.fn(),
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
        { rollupToParent: undefined, accountIds: undefined },
      );
    });

    it("passes the account filter and rollup choice through", async () => {
      // Both are the dashboard widget's settings, answered by the report rather
      // than re-applied to its result.
      const query = {
        startDate: "2024-01-01",
        endDate: "2024-12-31",
        accountIds: ["acct-1"],
        rollupToParent: true,
      };
      mockService.getSpendingByCategory.mockResolvedValue({
        data: [],
        totalSpending: 0,
      });

      await controller.getSpendingByCategory(mockReq, query as any);

      expect(mockService.getSpendingByCategory).toHaveBeenCalledWith(
        "user-1",
        "2024-01-01",
        "2024-12-31",
        { rollupToParent: true, accountIds: ["acct-1"] },
      );
    });
  });

  describe("getSpendingByCategory() tag filter", () => {
    it("passes the tag key and value through", async () => {
      mockService.getSpendingByCategory.mockResolvedValue({ data: [] });

      await controller.getSpendingByCategory(mockReq, {
        startDate: "2024-01-01",
        endDate: "2024-12-31",
        tagKey: "scope",
        tagValue: "household",
      } as any);

      expect(mockService.getSpendingByCategory).toHaveBeenCalledWith(
        "user-1",
        "2024-01-01",
        "2024-12-31",
        {
          rollupToParent: undefined,
          accountIds: undefined,
          tagKey: "scope",
          tagValue: "household",
        },
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
        { accountIds: undefined },
      );
    });

    it("threads accountIds through to the service", async () => {
      const query = {
        startDate: "2024-01-01",
        endDate: "2024-06-30",
        accountIds: ["a1b2c3d4-0000-4000-8000-000000000001"],
      };
      mockService.getIncomeBySource.mockResolvedValue({ data: [] });

      await controller.getIncomeBySource(mockReq, query as any);

      expect(mockService.getIncomeBySource).toHaveBeenCalledWith(
        "user-1",
        "2024-01-01",
        "2024-06-30",
        { accountIds: ["a1b2c3d4-0000-4000-8000-000000000001"] },
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
    it("passes the account filter and the bucket width through", async () => {
      // Both are the dashboard widget's settings, answered by the report rather
      // than applied to its result.
      mockService.getIncomeVsExpenses.mockResolvedValue({ data: [] });

      await controller.getIncomeVsExpenses(mockReq, {
        startDate: "2024-01-01",
        endDate: "2024-12-31",
        accountIds: ["acct-1"],
        bucket: "week",
        weekStartsOn: 0,
      } as any);

      expect(mockService.getIncomeVsExpenses).toHaveBeenCalledWith(
        "user-1",
        "2024-01-01",
        "2024-12-31",
        { accountIds: ["acct-1"], bucket: "week", weekStartsOn: 0 },
      );
    });

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
        { accountIds: undefined, bucket: undefined, weekStartsOn: undefined },
      );
    });

    it("threads tagKey through to service.getIncomeVsExpenses", async () => {
      mockService.getIncomeVsExpenses.mockResolvedValue({ data: [] });

      await controller.getIncomeVsExpenses(mockReq, {
        startDate: "2024-01-01",
        endDate: "2024-12-31",
        tagKey: "scope",
      } as any);

      expect(mockService.getIncomeVsExpenses).toHaveBeenCalledWith(
        "user-1",
        "2024-01-01",
        "2024-12-31",
        {
          accountIds: undefined,
          bucket: undefined,
          weekStartsOn: undefined,
          tagKey: "scope",
        },
      );
    });
  });

  describe("transferScopeAccountIds (spec 10.8.1)", () => {
    it("passes the tagged-transfer boundary through on Income vs Expenses", async () => {
      mockService.getIncomeVsExpenses.mockResolvedValue({ data: [] });

      await controller.getIncomeVsExpenses(mockReq, {
        startDate: "2024-01-01",
        endDate: "2024-12-31",
        tagKey: "scope",
        transferScopeAccountIds: ["acct-1", "acct-2"],
      } as any);

      expect(mockService.getIncomeVsExpenses).toHaveBeenCalledWith(
        "user-1",
        "2024-01-01",
        "2024-12-31",
        expect.objectContaining({
          tagKey: "scope",
          transferScopeAccountIds: ["acct-1", "acct-2"],
        }),
      );
    });

    it("passes the tagged-transfer boundary through on Cash Flow", async () => {
      mockService.getIncomeVsExpenses.mockResolvedValue({ data: [] });

      await controller.getCashFlow(mockReq, {
        startDate: "2024-01-01",
        endDate: "2024-12-31",
        tagKey: "scope",
        transferScopeAccountIds: ["acct-1"],
      } as any);

      expect(mockService.getIncomeVsExpenses).toHaveBeenCalledWith(
        "user-1",
        "2024-01-01",
        "2024-12-31",
        expect.objectContaining({
          tagKey: "scope",
          transferScopeAccountIds: ["acct-1"],
        }),
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
        { tagKey: undefined },
      );
    });

    it("threads tagKey through to service.getIncomeVsExpenses", async () => {
      const query = {
        startDate: "2024-01-01",
        endDate: "2024-12-31",
        tagKey: "scope",
      };
      const expected = { months: [] };
      mockService.getIncomeVsExpenses.mockResolvedValue(expected);

      await controller.getCashFlow(mockReq, query as any);

      expect(mockService.getIncomeVsExpenses).toHaveBeenCalledWith(
        "user-1",
        "2024-01-01",
        "2024-12-31",
        { tagKey: "scope" },
      );
    });

    it("threads accountIds through to service.getIncomeVsExpenses", async () => {
      const query = {
        startDate: "2024-01-01",
        endDate: "2024-12-31",
        accountIds: ["a1b2c3d4-0000-4000-8000-000000000001"],
      };
      mockService.getIncomeVsExpenses.mockResolvedValue({ months: [] });

      await controller.getCashFlow(mockReq, query as any);

      expect(mockService.getIncomeVsExpenses).toHaveBeenCalledWith(
        "user-1",
        "2024-01-01",
        "2024-12-31",
        {
          tagKey: undefined,
          accountIds: ["a1b2c3d4-0000-4000-8000-000000000001"],
        },
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
        "6m",
      );
    });

    it("defaults minOccurrences to 3 and the range to 6m when not provided", async () => {
      mockService.getRecurringExpenses.mockResolvedValue({ expenses: [] });

      await controller.getRecurringExpenses(mockReq);

      expect(mockService.getRecurringExpenses).toHaveBeenCalledWith(
        "user-1",
        3,
        "6m",
      );
    });

    it.each(["1y", "2y", "5y", "all"])(
      "passes the %s range through",
      async (range) => {
        mockService.getRecurringExpenses.mockResolvedValue({ expenses: [] });

        await controller.getRecurringExpenses(mockReq, "3", range);

        expect(mockService.getRecurringExpenses).toHaveBeenCalledWith(
          "user-1",
          3,
          range,
        );
      },
    );

    it("falls back to 6m for an unknown or repeated range", async () => {
      mockService.getRecurringExpenses.mockResolvedValue({ expenses: [] });

      await controller.getRecurringExpenses(mockReq, "3", "10y");
      // A repeated query key arrives as an array.
      await controller.getRecurringExpenses(mockReq, "3", [
        "1y",
        "2y",
      ] as unknown as string);

      expect(mockService.getRecurringExpenses).toHaveBeenNthCalledWith(
        1,
        "user-1",
        3,
        "6m",
      );
      expect(mockService.getRecurringExpenses).toHaveBeenNthCalledWith(
        2,
        "user-1",
        3,
        "6m",
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

  describe("getMonthlyCategoryBreakdown()", () => {
    it("delegates to service with userId, startDate, and endDate", async () => {
      const query = { startDate: "2024-01-01", endDate: "2024-12-31" };
      const expected = { months: [], data: [], currency: "USD" };
      mockService.getMonthlyCategoryBreakdown.mockResolvedValue(expected);

      const result = await controller.getMonthlyCategoryBreakdown(
        mockReq,
        query as any,
      );

      expect(result).toEqual(expected);
      expect(mockService.getMonthlyCategoryBreakdown).toHaveBeenCalledWith(
        "user-1",
        "2024-01-01",
        "2024-12-31",
        { accountIds: undefined },
      );
    });

    it("passes the account filter through", async () => {
      mockService.getMonthlyCategoryBreakdown.mockResolvedValue({});

      await controller.getMonthlyCategoryBreakdown(mockReq, {
        startDate: "2024-01-01",
        endDate: "2024-12-31",
        accountIds: ["acct-1"],
      } as any);

      expect(mockService.getMonthlyCategoryBreakdown).toHaveBeenCalledWith(
        "user-1",
        "2024-01-01",
        "2024-12-31",
        { accountIds: ["acct-1"] },
      );
    });
  });

  describe("getCashFlowSankey()", () => {
    it("delegates the window, the scope and the depth to the service", async () => {
      const query = {
        startDate: "2026-09-01",
        endDate: "2026-09-30",
        accountIds: ["acc-1"],
        depth: 2,
      };
      const expected = { nodes: [], links: [] };
      mockService.getCashFlowSankey.mockResolvedValue(expected);

      const result = await controller.getCashFlowSankey(mockReq, query as any);

      expect(result).toEqual(expected);
      expect(mockService.getCashFlowSankey).toHaveBeenCalledWith(
        "user-1",
        "2026-09-01",
        "2026-09-30",
        { accountIds: ["acc-1"], depth: 2 },
      );
    });
  });
});
