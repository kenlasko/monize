import { McpNetWorthTools } from "./net-worth.tool";
import { UserContextResolver } from "../mcp-context";

describe("McpNetWorthTools", () => {
  let tool: McpNetWorthTools;
  let netWorthService: Record<string, jest.Mock>;
  let accountsService: Record<string, jest.Mock>;
  let server: { registerTool: jest.Mock };
  let resolve: jest.MockedFunction<UserContextResolver>;
  const handlers: Record<string, (...args: any[]) => any> = {};

  beforeEach(() => {
    netWorthService = {
      getMonthlyNetWorth: jest.fn(),
    };

    accountsService = {
      getSummary: jest.fn(),
    };

    tool = new McpNetWorthTools(netWorthService as any, accountsService as any);

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

  describe("get_net_worth", () => {
    it("should return error when no user context", async () => {
      resolve.mockReturnValue(undefined);
      const result = await handlers["get_net_worth"]({}, { sessionId: "s1" });
      expect(result.isError).toBe(true);
    });

    it("should return account summary as net worth", async () => {
      resolve.mockReturnValue({ userId: "u1", scopes: "read" });
      accountsService.getSummary.mockResolvedValue({
        totalAssets: 10000,
        totalLiabilities: 2000,
        netWorth: 8000,
      });

      const result = await handlers["get_net_worth"]({}, { sessionId: "s1" });
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.netWorth).toBe(8000);
    });
  });

  describe("get_net_worth_history", () => {
    it("should return monthly net worth history", async () => {
      resolve.mockReturnValue({ userId: "u1", scopes: "read" });
      netWorthService.getMonthlyNetWorth.mockResolvedValue([
        { month: "2025-01", netWorth: 7000 },
        { month: "2025-02", netWorth: 8000 },
      ]);

      const result = await handlers["get_net_worth_history"](
        {},
        { sessionId: "s1" },
      );
      expect(netWorthService.getMonthlyNetWorth).toHaveBeenCalledWith(
        "u1",
        expect.any(String),
        expect.any(String),
      );
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed).toHaveLength(2);
    });

    it("should use custom months parameter", async () => {
      resolve.mockReturnValue({ userId: "u1", scopes: "read" });
      netWorthService.getMonthlyNetWorth.mockResolvedValue([]);

      await handlers["get_net_worth_history"](
        { months: 6 },
        { sessionId: "s1" },
      );
      expect(netWorthService.getMonthlyNetWorth).toHaveBeenCalled();
    });
  });
});
