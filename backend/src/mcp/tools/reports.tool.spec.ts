import { SharedReviewService } from "../../shared-expenses/shared-review.service";
import { sharedReviewMock } from "../../shared-expenses/__fixtures__/shared-review";
import { McpReportsTools } from "./reports.tool";
import { mcpTestCtx, McpTestContext } from "../testing/mcp-test-context";

describe("McpReportsTools", () => {
  let tool: McpReportsTools;
  let sharedReview: ReturnType<typeof sharedReviewMock>;
  let reportsService: Record<string, jest.Mock>;
  let netWorthService: Record<string, jest.Mock>;
  let server: { registerTool: jest.Mock };
  let ctx: McpTestContext;
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

    sharedReview = sharedReviewMock();
    tool = new McpReportsTools(
      sharedReview as unknown as SharedReviewService,
      reportsService as any,
      netWorthService as any,
    );

    server = {
      registerTool: jest.fn((name, _opts, handler) => {
        handlers[name] = handler;
      }),
    };

    ctx = mcpTestCtx();
    tool.register(server as any);
  });

  it.each([
    "spending_by_category",
    "spending_by_payee",
    "income_vs_expenses",
    "monthly_trend",
    "income_by_source",
    "spending_anomalies",
    "month_comparison",
    "net_worth_history",
  ])(
    "discloses shared review for %s, including array results",
    async (type) => {
      ctx.setUser({ userId: "u1", scopes: "read" });
      for (const method of Object.values(reportsService))
        method.mockResolvedValue([{ amount: 100 }]);
      netWorthService.getLlmHistory.mockResolvedValue([{ amount: 100 }]);
      sharedReview.annotate.mockImplementation(async (_user, data) => ({
        items: data,
        sharedExpenses: { pendingCount: 2 },
      }));
      const result = await handlers.generate_report({ type }, ctx);
      expect(sharedReview.annotate).toHaveBeenCalledWith("u1", [
        { amount: 100 },
      ]);
      expect(result.structuredContent).toEqual({
        items: [{ amount: 100 }],
        sharedExpenses: { pendingCount: 2 },
      });
    },
  );

  it("should register 1 tool", () => {
    expect(server.registerTool).toHaveBeenCalledTimes(1);
  });

  describe("generate_report", () => {
    it("should require read scope", async () => {
      ctx.setUser({ userId: "u1", scopes: "write" });
      const result = await handlers["generate_report"](
        {
          type: "spending_by_category",
          startDate: "2025-01-01",
          endDate: "2025-01-31",
        },
        ctx,
      );
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("read");
    });

    it("should run spending_by_category report", async () => {
      ctx.setUser({ userId: "u1", scopes: "read" });
      reportsService.getSpendingByCategory.mockResolvedValue({ data: [] });

      const result = await handlers["generate_report"](
        {
          type: "spending_by_category",
          startDate: "2025-01-01",
          endDate: "2025-01-31",
        },
        ctx,
      );
      expect(reportsService.getSpendingByCategory).toHaveBeenCalledWith(
        "u1",
        "2025-01-01",
        "2025-01-31",
      );
      expect(result.isError).toBeUndefined();
    });

    it("should pass a withheld total and its gap through unchanged (INV-FX-001)", async () => {
      ctx.setUser({ userId: "u1", scopes: "read" });
      const report = {
        data: [],
        totalSpending: null,
        knownSpending: 50,
        currency: "USD",
        missingCurrencies: ["JPY"],
        excludedCount: 1,
      };
      reportsService.getSpendingByCategory.mockResolvedValue(report);

      const result = await handlers["generate_report"](
        {
          type: "spending_by_category",
          startDate: "2025-01-01",
          endDate: "2025-01-31",
        },
        ctx,
      );

      expect(result.structuredContent).toEqual(report);
    });

    it("should run spending_by_payee report", async () => {
      ctx.setUser({ userId: "u1", scopes: "read" });
      reportsService.getSpendingByPayee.mockResolvedValue({ data: [] });

      await handlers["generate_report"](
        {
          type: "spending_by_payee",
          startDate: "2025-01-01",
          endDate: "2025-01-31",
        },
        ctx,
      );
      expect(reportsService.getSpendingByPayee).toHaveBeenCalled();
    });

    it("should run income_vs_expenses report", async () => {
      ctx.setUser({ userId: "u1", scopes: "read" });
      reportsService.getIncomeVsExpenses.mockResolvedValue({ data: [] });

      await handlers["generate_report"](
        {
          type: "income_vs_expenses",
          startDate: "2025-01-01",
          endDate: "2025-01-31",
        },
        ctx,
      );
      expect(reportsService.getIncomeVsExpenses).toHaveBeenCalled();
    });

    it("should run monthly_trend report", async () => {
      ctx.setUser({ userId: "u1", scopes: "read" });
      reportsService.getMonthlySpendingTrend.mockResolvedValue({ data: [] });

      await handlers["generate_report"](
        {
          type: "monthly_trend",
          startDate: "2025-01-01",
          endDate: "2025-01-31",
        },
        ctx,
      );
      expect(reportsService.getMonthlySpendingTrend).toHaveBeenCalled();
    });

    it("should run income_by_source report", async () => {
      ctx.setUser({ userId: "u1", scopes: "read" });
      reportsService.getIncomeBySource.mockResolvedValue({ data: [] });

      await handlers["generate_report"](
        {
          type: "income_by_source",
          startDate: "2025-01-01",
          endDate: "2025-01-31",
        },
        ctx,
      );
      expect(reportsService.getIncomeBySource).toHaveBeenCalled();
    });

    it("applies default dates when omitted", async () => {
      ctx.setUser({ userId: "u1", scopes: "read" });
      reportsService.getSpendingByCategory.mockResolvedValue({ data: [] });

      await handlers["generate_report"]({ type: "spending_by_category" }, ctx);

      expect(reportsService.getSpendingByCategory).toHaveBeenCalledWith(
        "u1",
        expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
        expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
      );
    });

    it("returns error when no user context", async () => {
      ctx.setUser(undefined);

      const result = await handlers["generate_report"](
        { type: "spending_by_category" },
        ctx,
      );
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("No user context");
    });

    describe("type: month_comparison", () => {
      it("requires read scope", async () => {
        ctx.setUser({ userId: "u1", scopes: "write" });

        const result = await handlers["generate_report"](
          { type: "month_comparison", month: "2026-01" },
          ctx,
        );
        expect(result.isError).toBe(true);
        expect(result.content[0].text).toContain("read");
      });

      it("calls getMonthlyComparison and returns data", async () => {
        ctx.setUser({ userId: "u1", scopes: "read" });
        const mockData = { currentMonth: "2026-01", previousMonth: "2025-12" };
        reportsService.getMonthlyComparison.mockResolvedValue(mockData);

        const result = await handlers["generate_report"](
          { type: "month_comparison", month: "2026-01" },
          ctx,
        );

        expect(result.isError).toBeUndefined();
        expect(reportsService.getMonthlyComparison).toHaveBeenCalledWith(
          "u1",
          "2026-01",
        );
        const parsed = result.structuredContent as any;
        expect(parsed.currentMonth).toBe("2026-01");
      });

      it("returns error on service exception", async () => {
        ctx.setUser({ userId: "u1", scopes: "read" });
        reportsService.getMonthlyComparison.mockRejectedValue(
          new Error("Service failure"),
        );

        const result = await handlers["generate_report"](
          { type: "month_comparison", month: "2026-01" },
          ctx,
        );
        expect(result.isError).toBe(true);
        expect(result.content[0].text).toContain("An error occurred");
      });

      it("defaults month to the previous calendar month when omitted", async () => {
        ctx.setUser({ userId: "u1", scopes: "read" });
        reportsService.getMonthlyComparison.mockResolvedValue({});

        await handlers["generate_report"]({ type: "month_comparison" }, ctx);

        expect(reportsService.getMonthlyComparison).toHaveBeenCalledWith(
          "u1",
          expect.stringMatching(/^\d{4}-\d{2}$/),
        );
      });
    });

    describe("type: spending_anomalies", () => {
      it("detects anomalies over the default window at the default threshold", async () => {
        ctx.setUser({ userId: "u1", scopes: "read" });
        reportsService.getSpendingAnomalies.mockResolvedValue([]);

        const result = await handlers["generate_report"](
          { type: "spending_anomalies" },
          ctx,
        );
        // The report's own six-month window at the Reports page's threshold;
        // the months were once passed as the threshold (A26-M34).
        expect(reportsService.getSpendingAnomalies).toHaveBeenCalledWith(
          "u1",
          2,
          6,
        );
        expect(result.isError).toBeUndefined();
      });

      it("uses custom months", async () => {
        ctx.setUser({ userId: "u1", scopes: "read" });
        reportsService.getSpendingAnomalies.mockResolvedValue([]);

        await handlers["generate_report"](
          { type: "spending_anomalies", months: 12 },
          ctx,
        );
        expect(reportsService.getSpendingAnomalies).toHaveBeenCalledWith(
          "u1",
          2,
          12,
        );
      });
    });

    describe("type: net_worth_history", () => {
      it("requires read scope", async () => {
        ctx.setUser({ userId: "u1", scopes: "write" });

        const result = await handlers["generate_report"](
          { type: "net_worth_history" },
          ctx,
        );
        expect(result.isError).toBe(true);
        expect(result.content[0].text).toContain("read");
      });

      it("calls getLlmHistory and returns the monthly history", async () => {
        ctx.setUser({ userId: "u1", scopes: "read" });
        netWorthService.getLlmHistory.mockResolvedValue([
          { month: "2025-01", assets: 1, liabilities: 0, netWorth: 1 },
          { month: "2025-02", assets: 2, liabilities: 0, netWorth: 2 },
        ]);

        const result = await handlers["generate_report"](
          { type: "net_worth_history" },
          ctx,
        );

        expect(result.isError).toBeUndefined();
        expect(netWorthService.getLlmHistory).toHaveBeenCalledWith(
          "u1",
          undefined,
          undefined,
        );
        // A bare array is wrapped under `items`: structured content must be an
        // object, and this report type is the one that returns a plain list.
        const parsed = (result.structuredContent as any).items;
        expect(parsed).toHaveLength(2);
      });

      it("passes through explicit start and end dates", async () => {
        ctx.setUser({ userId: "u1", scopes: "read" });
        netWorthService.getLlmHistory.mockResolvedValue([]);

        await handlers["generate_report"](
          {
            type: "net_worth_history",
            startDate: "2024-01-01",
            endDate: "2024-12-31",
          },
          ctx,
        );
        expect(netWorthService.getLlmHistory).toHaveBeenCalledWith(
          "u1",
          "2024-01-01",
          "2024-12-31",
        );
      });

      it("returns error on service exception", async () => {
        ctx.setUser({ userId: "u1", scopes: "read" });
        netWorthService.getLlmHistory.mockRejectedValue(new Error("boom"));

        const result = await handlers["generate_report"](
          { type: "net_worth_history" },
          ctx,
        );
        expect(result.isError).toBe(true);
      });
    });
  });
});
