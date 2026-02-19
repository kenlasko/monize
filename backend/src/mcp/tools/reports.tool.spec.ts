import { McpReportsTools } from "./reports.tool";
import { UserContextResolver } from "../mcp-context";

describe("McpReportsTools", () => {
  let tool: McpReportsTools;
  let reportsService: Record<string, jest.Mock>;
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
      getSpendingAnomalies: jest.fn(),
    };

    tool = new McpReportsTools(reportsService as any);

    server = {
      registerTool: jest.fn((name, _opts, handler) => {
        handlers[name] = handler;
      }),
    };

    resolve = jest.fn();
    tool.register(server as any, resolve);
  });

  it("should register 2 tools", () => {
    expect(server.registerTool).toHaveBeenCalledTimes(2);
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
  });

  describe("get_anomalies", () => {
    it("should detect anomalies with default months", async () => {
      resolve.mockReturnValue({ userId: "u1", scopes: "reports" });
      reportsService.getSpendingAnomalies.mockResolvedValue([]);

      const result = await handlers["get_anomalies"]({}, { sessionId: "s1" });
      expect(reportsService.getSpendingAnomalies).toHaveBeenCalledWith("u1", 3);
      expect(result.isError).toBeUndefined();
    });

    it("should use custom months", async () => {
      resolve.mockReturnValue({ userId: "u1", scopes: "reports" });
      reportsService.getSpendingAnomalies.mockResolvedValue([]);

      await handlers["get_anomalies"]({ months: 6 }, { sessionId: "s1" });
      expect(reportsService.getSpendingAnomalies).toHaveBeenCalledWith("u1", 6);
    });
  });
});
