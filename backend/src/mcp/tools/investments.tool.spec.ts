import { McpInvestmentsTools } from "./investments.tool";
import { UserContextResolver } from "../mcp-context";

describe("McpInvestmentsTools", () => {
  let tool: McpInvestmentsTools;
  let portfolioService: Record<string, jest.Mock>;
  let holdingsService: Record<string, jest.Mock>;
  let investmentTransactionsService: Record<string, jest.Mock>;
  let server: { registerTool: jest.Mock };
  let resolve: jest.MockedFunction<UserContextResolver>;
  const handlers: Record<string, (...args: any[]) => any> = {};

  beforeEach(() => {
    portfolioService = {
      getPortfolioSummary: jest.fn(),
      getLlmSummary: jest.fn(),
    };

    holdingsService = {
      findAll: jest.fn(),
    };

    investmentTransactionsService = {
      getLlmInvestmentTransactions: jest.fn(),
    };

    tool = new McpInvestmentsTools(
      portfolioService as any,
      holdingsService as any,
      investmentTransactionsService as any,
    );

    server = {
      registerTool: jest.fn((name, _opts, handler) => {
        handlers[name] = handler;
      }),
    };

    resolve = jest.fn();
    tool.register(server as any, resolve);
  });

  it("should register 3 tools", () => {
    expect(server.registerTool).toHaveBeenCalledTimes(3);
  });

  describe("get_portfolio_summary", () => {
    it("should return error when no user context", async () => {
      resolve.mockReturnValue(undefined);
      const result = await handlers["get_portfolio_summary"](
        {},
        { sessionId: "s1" },
      );
      expect(result.isError).toBe(true);
    });

    it("should return portfolio summary via shared getLlmSummary", async () => {
      resolve.mockReturnValue({ userId: "u1", scopes: "read" });
      portfolioService.getLlmSummary.mockResolvedValue({
        holdingCount: 2,
        totalPortfolioValue: 10000,
        totalGainLoss: 500,
        holdings: [],
        allocation: [],
      });

      const result = await handlers["get_portfolio_summary"](
        {},
        { sessionId: "s1" },
      );
      expect(portfolioService.getLlmSummary).toHaveBeenCalledWith(
        "u1",
        undefined,
      );
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.totalPortfolioValue).toBe(10000);
      expect(parsed.totalGainLoss).toBe(500);
    });

    it("passes accountIds filter through to getLlmSummary", async () => {
      resolve.mockReturnValue({ userId: "u1", scopes: "read" });
      portfolioService.getLlmSummary.mockResolvedValue({
        holdingCount: 0,
        totalPortfolioValue: 0,
        totalGainLoss: 0,
        holdings: [],
        allocation: [],
      });

      await handlers["get_portfolio_summary"](
        { accountIds: ["00000000-0000-0000-0000-000000000001"] },
        { sessionId: "s1" },
      );
      expect(portfolioService.getLlmSummary).toHaveBeenCalledWith("u1", [
        "00000000-0000-0000-0000-000000000001",
      ]);
    });
  });

  describe("query_investment_transactions", () => {
    it("returns error when no user context", async () => {
      resolve.mockReturnValue(undefined);
      const result = await handlers["query_investment_transactions"](
        {},
        { sessionId: "s1" },
      );
      expect(result.isError).toBe(true);
    });

    it("delegates to shared getLlmInvestmentTransactions with all filters", async () => {
      resolve.mockReturnValue({ userId: "u1", scopes: "read" });
      investmentTransactionsService.getLlmInvestmentTransactions.mockResolvedValue(
        {
          transactionCount: 2,
          totalAmount: 1000,
          totalCommission: 9.99,
          totalQuantity: 10,
          actionCounts: { BUY: 2 },
          groupedBy: "security",
          groups: [
            {
              key: "AAPL",
              transactionCount: 2,
              totalQuantity: 10,
              totalAmount: 1000,
              totalCommission: 9.99,
            },
          ],
          transactions: [],
          truncatedTransactionList: false,
        },
      );

      const result = await handlers["query_investment_transactions"](
        {
          startDate: "2026-01-01",
          endDate: "2026-03-31",
          accountIds: ["00000000-0000-0000-0000-000000000001"],
          symbols: ["AAPL"],
          actions: ["BUY"],
          groupBy: "security",
        },
        { sessionId: "s1" },
      );

      expect(
        investmentTransactionsService.getLlmInvestmentTransactions,
      ).toHaveBeenCalledWith("u1", {
        startDate: "2026-01-01",
        endDate: "2026-03-31",
        accountIds: ["00000000-0000-0000-0000-000000000001"],
        symbols: ["AAPL"],
        actions: ["BUY"],
        groupBy: "security",
      });
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.transactionCount).toBe(2);
      expect(parsed.groupedBy).toBe("security");
      expect(parsed.groups[0].key).toBe("AAPL");
    });

    it("passes undefined filters when no args provided", async () => {
      resolve.mockReturnValue({ userId: "u1", scopes: "read" });
      investmentTransactionsService.getLlmInvestmentTransactions.mockResolvedValue(
        {
          transactionCount: 0,
          totalAmount: 0,
          totalCommission: 0,
          totalQuantity: 0,
          actionCounts: {},
          groupedBy: null,
          groups: null,
          transactions: [],
          truncatedTransactionList: false,
        },
      );

      await handlers["query_investment_transactions"]({}, { sessionId: "s1" });

      expect(
        investmentTransactionsService.getLlmInvestmentTransactions,
      ).toHaveBeenCalledWith("u1", {
        startDate: undefined,
        endDate: undefined,
        accountIds: undefined,
        symbols: undefined,
        actions: undefined,
        groupBy: undefined,
      });
    });

    it("returns a safe error on service failure", async () => {
      resolve.mockReturnValue({ userId: "u1", scopes: "read" });
      investmentTransactionsService.getLlmInvestmentTransactions.mockRejectedValue(
        new Error("boom"),
      );

      const result = await handlers["query_investment_transactions"](
        {},
        { sessionId: "s1" },
      );
      expect(result.isError).toBe(true);
    });
  });

  describe("get_holding_details", () => {
    it("should return holdings", async () => {
      resolve.mockReturnValue({ userId: "u1", scopes: "read" });
      holdingsService.findAll.mockResolvedValue([{ id: "h1", symbol: "AAPL" }]);

      const result = await handlers["get_holding_details"](
        { accountId: "a1" },
        { sessionId: "s1" },
      );
      expect(holdingsService.findAll).toHaveBeenCalledWith("u1", "a1");
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed[0].symbol).toBe("AAPL");
    });

    it("should handle service errors", async () => {
      resolve.mockReturnValue({ userId: "u1", scopes: "read" });
      holdingsService.findAll.mockRejectedValue(new Error("fail"));

      const result = await handlers["get_holding_details"](
        {},
        { sessionId: "s1" },
      );
      expect(result.isError).toBe(true);
    });
  });
});
