import { McpInvestmentsTools } from "./investments.tool";
import { UserContextResolver } from "../mcp-context";

describe("McpInvestmentsTools", () => {
  let tool: McpInvestmentsTools;
  let portfolioService: Record<string, jest.Mock>;
  let holdingsService: Record<string, jest.Mock>;
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

    tool = new McpInvestmentsTools(
      portfolioService as any,
      holdingsService as any,
    );

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
