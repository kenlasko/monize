import { McpReportsTools } from "./reports.tool";
import { UserContextResolver } from "../mcp-context";

describe("McpReportsTools", () => {
  let tool: McpReportsTools;
  let reportsService: Record<string, jest.Mock>;
  let netWorthService: Record<string, jest.Mock>;
  let server: { registerTool: jest.Mock };
  let resolve: jest.MockedFunction<UserContextResolver>;
  const handlers: Record<string, (...args: any[]) => any> = {};

  beforeEach(() => {
    reportsService = {
      getSpendingByCategory: jest.fn(),
      getSpendingByPayee: jest.fn(),
      getIncomeVsExpenses: jest.fn(),
      getMonthlySpendingTrend: jest.fn(),
      getIncomeBySource: jest.fn(),
      getMonthlyComparison: jest.fn(),
      getSpendingAnomalies: jest.fn(),
    };
    netWorthService = {
      getLlmHistory: jest.fn(),
    };

    tool = new McpReportsTools(reportsService as any, netWorthService as any);

    server = {
      registerTool: jest.fn((name, _opts, handler) => {
        handlers[name] = handler;
      }),
    };

    resolve = jest.fn();
    tool.register(server as any, resolve);
  });

  it("should register 1 tool", () => {
    expect(server.registerTool).toHaveBeenCalledTimes(1);
  });

  describe("generate_report", () => {
    it("should require reports scope", async () => {
      resolve.mockReturnValue({ userId: "u1", scopes: "read,write" });
      const result = await handlers["generate_report"](
        {
          type: "spending_by_category",
          startDate: "2025-01-01",
          endDate: "2025-01-31",
        },
        { sessionId: "s1" },
      );
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("reports");
    });

    it("should run spending_by_category report", async () => {
      resolve.mockReturnValue({ userId: "u1", scopes: "reports" });
      reportsService.getSpendingByCategory.mockResolvedValue({ data: [] });

      const result = await handlers["generate_report"](
        {
          type: "spending_by_category",
          startDate: "2025-01-01",
          endDate: "2025-01-31",
        },
        { sessionId: "s1" },
      );
      expect(reportsService.getSpendingByCategory).toHaveBeenCalledWith(
        "u1",
        "2025-01-01",
        "2025-01-31",
      );
      expect(result.isError).toBeUndefined();
    });

    it("should run spending_by_payee report", async () => {
      resolve.mockReturnValue({ userId: "u1", scopes: "reports" });
      reportsService.getSpendingByPayee.mockResolvedValue({ data: [] });

      await handlers["generate_report"](
        {
          type: "spending_by_payee",
          startDate: "2025-01-01",
          endDate: "2025-01-31",
        },
        { sessionId: "s1" },
      );
      expect(reportsService.getSpendingByPayee).toHaveBeenCalled();
    });

    it("should run income_vs_expenses report", async () => {
      resolve.mockReturnValue({ userId: "u1", scopes: "reports" });
      reportsService.getIncomeVsExpenses.mockResolvedValue({ data: [] });

      await handlers["generate_report"](
        {
          type: "income_vs_expenses",
          startDate: "2025-01-01",
          endDate: "2025-01-31",
        },
        { sessionId: "s1" },
      );
      expect(reportsService.getIncomeVsExpenses).toHaveBeenCalled();
    });

    it("should run monthly_trend report", async () => {
      resolve.mockReturnValue({ userId: "u1", scopes: "reports" });
      reportsService.getMonthlySpendingTrend.mockResolvedValue({ data: [] });

      await handlers["generate_report"](
        {
          type: "monthly_trend",
          startDate: "2025-01-01",
          endDate: "2025-01-31",
        },
        { sessionId: "s1" },
      );
      expect(reportsService.getMonthlySpendingTrend).toHaveBeenCalled();
    });

    it("should run income_by_source report", async () => {
      resolve.mockReturnValue({ userId: "u1", scopes: "reports" });
      reportsService.getIncomeBySource.mockResolvedValue({ data: [] });

      await handlers["generate_report"](
        {
          type: "income_by_source",
          startDate: "2025-01-01",
          endDate: "2025-01-31",
        },
        { sessionId: "s1" },
      );
      expect(reportsService.getIncomeBySource).toHaveBeenCalled();
    });

    it("applies default dates when omitted", async () => {
      resolve.mockReturnValue({ userId: "u1", scopes: "reports" });
      reportsService.getSpendingByCategory.mockResolvedValue({ data: [] });

      await handlers["generate_report"](
        { type: "spending_by_category" },
        { sessionId: "s1" },
      );

      expect(reportsService.getSpendingByCategory).toHaveBeenCalledWith(
        "u1",
        expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
        expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
      );
    });

    it("returns error when no user context", async () => {
      resolve.mockReturnValue(undefined);

      const result = await handlers["generate_report"](
        { type: "spending_by_category" },
        { sessionId: "s1" },
      );
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("No user context");
    });

    describe("type: month_comparison", () => {
      it("requires reports scope", async () => {
        resolve.mockReturnValue({ userId: "u1", scopes: "read,write" });

        const result = await handlers["generate_report"](
          { type: "month_comparison", month: "2026-01" },
          { sessionId: "s1" },
        );
        expect(result.isError).toBe(true);
        expect(result.content[0].text).toContain("reports");
      });

      it("calls getMonthlyComparison and returns data", async () => {
        resolve.mockReturnValue({ userId: "u1", scopes: "reports" });
        const mockData = { currentMonth: "2026-01", previousMonth: "2025-12" };
        reportsService.getMonthlyComparison.mockResolvedValue(mockData);

        const result = await handlers["generate_report"](
          { type: "month_comparison", month: "2026-01" },
          { sessionId: "s1" },
        );

        expect(result.isError).toBeUndefined();
        expect(reportsService.getMonthlyComparison).toHaveBeenCalledWith(
          "u1",
          "2026-01",
        );
        const parsed = JSON.parse(result.content[0].text);
        expect(parsed.currentMonth).toBe("2026-01");
      });

      it("returns error on service exception", async () => {
        resolve.mockReturnValue({ userId: "u1", scopes: "reports" });
        reportsService.getMonthlyComparison.mockRejectedValue(
          new Error("Service failure"),
        );

        const result = await handlers["generate_report"](
          { type: "month_comparison", month: "2026-01" },
          { sessionId: "s1" },
        );
        expect(result.isError).toBe(true);
        expect(result.content[0].text).toContain("An error occurred");
      });

      it("defaults month to the previous calendar month when omitted", async () => {
        resolve.mockReturnValue({ userId: "u1", scopes: "reports" });
        reportsService.getMonthlyComparison.mockResolvedValue({});

        await handlers["generate_report"](
          { type: "month_comparison" },
          { sessionId: "s1" },
        );

        expect(reportsService.getMonthlyComparison).toHaveBeenCalledWith(
          "u1",
          expect.stringMatching(/^\d{4}-\d{2}$/),
        );
      });
    });

    describe("type: spending_anomalies", () => {
      it("detects anomalies with default months", async () => {
        resolve.mockReturnValue({ userId: "u1", scopes: "reports" });
        reportsService.getSpendingAnomalies.mockResolvedValue([]);

        const result = await handlers["generate_report"](
          { type: "spending_anomalies" },
          { sessionId: "s1" },
        );
        expect(reportsService.getSpendingAnomalies).toHaveBeenCalledWith(
          "u1",
          3,
        );
        expect(result.isError).toBeUndefined();
      });

      it("uses custom months", async () => {
        resolve.mockReturnValue({ userId: "u1", scopes: "reports" });
        reportsService.getSpendingAnomalies.mockResolvedValue([]);

        await handlers["generate_report"](
          { type: "spending_anomalies", months: 6 },
          { sessionId: "s1" },
        );
        expect(reportsService.getSpendingAnomalies).toHaveBeenCalledWith(
          "u1",
          6,
        );
      });
    });

    describe("type: net_worth_history", () => {
      it("requires reports scope", async () => {
        resolve.mockReturnValue({ userId: "u1", scopes: "read,write" });

        const result = await handlers["generate_report"](
          { type: "net_worth_history" },
          { sessionId: "s1" },
        );
        expect(result.isError).toBe(true);
        expect(result.content[0].text).toContain("reports");
      });

      it("calls getLlmHistory and returns the monthly history", async () => {
        resolve.mockReturnValue({ userId: "u1", scopes: "reports" });
        netWorthService.getLlmHistory.mockResolvedValue([
          { month: "2025-01", assets: 1, liabilities: 0, netWorth: 1 },
          { month: "2025-02", assets: 2, liabilities: 0, netWorth: 2 },
        ]);

        const result = await handlers["generate_report"](
          { type: "net_worth_history" },
          { sessionId: "s1" },
        );

        expect(result.isError).toBeUndefined();
        expect(netWorthService.getLlmHistory).toHaveBeenCalledWith(
          "u1",
          undefined,
          undefined,
        );
        const parsed = JSON.parse(result.content[0].text);
        expect(parsed).toHaveLength(2);
      });

      it("passes through explicit start and end dates", async () => {
        resolve.mockReturnValue({ userId: "u1", scopes: "reports" });
        netWorthService.getLlmHistory.mockResolvedValue([]);

        await handlers["generate_report"](
          {
            type: "net_worth_history",
            startDate: "2024-01-01",
            endDate: "2024-12-31",
          },
          { sessionId: "s1" },
        );
        expect(netWorthService.getLlmHistory).toHaveBeenCalledWith(
          "u1",
          "2024-01-01",
          "2024-12-31",
        );
      });

      it("returns error on service exception", async () => {
        resolve.mockReturnValue({ userId: "u1", scopes: "reports" });
        netWorthService.getLlmHistory.mockRejectedValue(new Error("boom"));

        const result = await handlers["generate_report"](
          { type: "net_worth_history" },
          { sessionId: "s1" },
        );
        expect(result.isError).toBe(true);
      });
    });
  });
});
