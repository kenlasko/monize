import { McpRecentTransactionsResource } from "./recent-transactions.resource";
import { UserContextResolver } from "../mcp-context";

describe("McpRecentTransactionsResource", () => {
  let resource: McpRecentTransactionsResource;
  let transactionsService: Record<string, jest.Mock>;
  let analyticsService: Record<string, jest.Mock>;
  let server: { registerResource: jest.Mock };
  let resolve: jest.MockedFunction<UserContextResolver>;
  let handler: (...args: any[]) => any;

  beforeEach(() => {
    transactionsService = {
      findAll: jest.fn(),
    };

    analyticsService = {
      getSummary: jest.fn(),
    };

    resource = new McpRecentTransactionsResource(
      transactionsService as any,
      analyticsService as any,
    );

    server = {
      registerResource: jest.fn((_name, _uri, _opts, h) => {
        handler = h;
      }),
    };

    resolve = jest.fn();
    resource.register(server as any, resolve);
  });

  it("should register the resource", () => {
    expect(server.registerResource).toHaveBeenCalledWith(
      "recent-transactions",
      "monize://recent-transactions",
      expect.any(Object),
      expect.any(Function),
    );
  });

  it("should return error when no user context", async () => {
    resolve.mockReturnValue(undefined);
    const result = await handler("monize://recent-transactions", {
      sessionId: "s1",
    });
    expect(result.contents[0].text).toContain("Error");
  });

  it("should return error when scope check fails", async () => {
    resolve.mockReturnValue({ userId: "u1", scopes: "write" });
    const result = await handler("monize://recent-transactions", {
      sessionId: "s1",
    });
    expect(result.contents[0].text).toContain("Insufficient scope");
  });

  it("should return recent transactions with summary", async () => {
    resolve.mockReturnValue({ userId: "u1", scopes: "read" });
    transactionsService.findAll.mockResolvedValue({
      data: [
        {
          transactionDate: "2025-01-15",
          payeeName: "Store",
          category: { name: "Food" },
          amount: -50,
          account: { name: "Checking" },
        },
      ],
      pagination: { total: 1, hasMore: false },
    });
    analyticsService.getSummary.mockResolvedValue({
      totalIncome: 5000,
      totalExpenses: -3000,
    });

    const result = await handler("monize://recent-transactions", {
      sessionId: "s1",
    });
    const parsed = JSON.parse(result.contents[0].text);
    expect(parsed.summary.totalIncome).toBe(5000);
    expect(parsed.recentTransactions).toHaveLength(1);
    expect(parsed.total).toBe(1);
  });
});
