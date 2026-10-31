import { SharedReviewService } from "../../shared-expenses/shared-review.service";
import { sharedReviewMock } from "../../shared-expenses/__fixtures__/shared-review";
import { McpBudgetsTools } from "./budgets.tool";
import { mcpTestCtx, McpTestContext } from "../testing/mcp-test-context";

describe("McpBudgetsTools", () => {
  let tool: McpBudgetsTools;
  let sharedReview: ReturnType<typeof sharedReviewMock>;
  let budgetReportsService: Record<string, jest.Mock>;
  let server: { registerTool: jest.Mock };
  let ctx: McpTestContext;
  const handlers: Record<string, (...args: any[]) => any> = {};

  beforeEach(() => {
    budgetReportsService = {
      getLlmBudgetStatus: jest.fn(),
    };

    sharedReview = sharedReviewMock();
    tool = new McpBudgetsTools(
      budgetReportsService as any,
      sharedReview as unknown as SharedReviewService,
    );

    server = {
      registerTool: jest.fn((name, _opts, handler) => {
        handlers[name] = handler;
      }),
    };

    ctx = mcpTestCtx();
    tool.register(server as any);
  });

  it("returns pending shared changes without adjusting accepted budget actuals", async () => {
    ctx.setUser({ userId: "u1", scopes: "read" });
    budgetReportsService.getLlmBudgetStatus.mockResolvedValue({ actual: 100 });
    sharedReview.annotate.mockImplementation(async (_user, data) => ({
      ...(data as object),
      sharedExpenses: { pendingCount: 2 },
    }));
    const result = await handlers.get_budget_status({}, ctx);
    expect(sharedReview.annotate).toHaveBeenCalledWith("u1", { actual: 100 });
    expect(result.structuredContent).toMatchObject({
      actual: 100,
      sharedExpenses: { pendingCount: 2 },
    });
  });

  it("registers exactly one tool", () => {
    expect(server.registerTool).toHaveBeenCalledTimes(1);
    expect(server.registerTool).toHaveBeenCalledWith(
      "get_budget_status",
      expect.objectContaining({ description: expect.any(String) }),
      expect.any(Function),
    );
  });

  describe("get_budget_status", () => {
    it("errors when no user context exists", async () => {
      ctx.setUser(undefined);
      const result = await handlers["get_budget_status"]({}, ctx);
      expect(result.isError).toBe(true);
    });

    it("errors when scope is insufficient", async () => {
      ctx.setUser({ userId: "u1", scopes: "write_only" } as any);
      const result = await handlers["get_budget_status"]({}, ctx);
      expect(result.isError).toBe(true);
      expect(budgetReportsService.getLlmBudgetStatus).not.toHaveBeenCalled();
    });

    it("defaults period to CURRENT and forwards optional budgetName", async () => {
      ctx.setUser({ userId: "u1", scopes: "read" });
      budgetReportsService.getLlmBudgetStatus.mockResolvedValue({
        period: "CURRENT",
        totalBudgeted: 1000,
        totalSpent: 250,
      });

      const result = await handlers["get_budget_status"]({}, ctx);

      expect(budgetReportsService.getLlmBudgetStatus).toHaveBeenCalledWith(
        "u1",
        "CURRENT",
        undefined,
      );
      const parsed = result.structuredContent as any;
      expect(parsed.totalBudgeted).toBe(1000);
    });

    it("passes through period and budgetName arguments", async () => {
      ctx.setUser({ userId: "u1", scopes: "read" });
      budgetReportsService.getLlmBudgetStatus.mockResolvedValue({
        period: "2026-04",
      });

      await handlers["get_budget_status"](
        { period: "2026-04", budgetName: "Household" },
        ctx,
      );

      expect(budgetReportsService.getLlmBudgetStatus).toHaveBeenCalledWith(
        "u1",
        "2026-04",
        "Household",
      );
    });

    it("translates service errors to a tool error result", async () => {
      ctx.setUser({ userId: "u1", scopes: "read" });
      budgetReportsService.getLlmBudgetStatus.mockRejectedValue(
        new Error("DB exploded"),
      );

      const result = await handlers["get_budget_status"]({}, ctx);
      expect(result.isError).toBe(true);
    });
  });
});
