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

  it("expands split transactions into per-split rows", async () => {
    resolve.mockReturnValue({ userId: "u1", scopes: "read" });
    transactionsService.findAll.mockResolvedValue({
      data: [
        {
          transactionDate: "2025-01-15",
          payeeName: "Costco",
          category: null,
          amount: -150,
          account: { name: "Checking" },
          isSplit: true,
          splits: [
            { id: "s1", amount: -100, category: { name: "Groceries" } },
            { id: "s2", amount: -50, category: { name: "Household" } },
          ],
        },
        {
          transactionDate: "2025-01-14",
          payeeName: "Coffee",
          category: { name: "Dining" },
          amount: -5,
          account: { name: "Checking" },
          isSplit: false,
        },
      ],
      pagination: { total: 2, hasMore: false },
    });
    analyticsService.getSummary.mockResolvedValue({});

    const result = await handler("monize://recent-transactions", {
      sessionId: "s1",
    });
    const parsed = JSON.parse(result.contents[0].text);
    expect(parsed.recentTransactions).toHaveLength(3);
    const groceries = parsed.recentTransactions.find(
      (r: any) => r.categoryName === "Groceries",
    );
    expect(groceries.amount).toBe(-100);
    expect(groceries.isSplit).toBe(true);
    const plain = parsed.recentTransactions.find(
      (r: any) => r.payeeName === "Coffee",
    );
    expect(plain.categoryName).toBe("Dining");
    expect(plain.isSplit).toBeUndefined();
  });

  it("excludes investment-linked cash transactions from the MCP summary", async () => {
    resolve.mockReturnValue({ userId: "u1", scopes: "read" });
    transactionsService.findAll.mockResolvedValue({
      data: [],
      pagination: { total: 0, hasMore: false },
    });
    analyticsService.getSummary.mockResolvedValue({
      totalIncome: 0,
      totalExpenses: 0,
    });

    await handler("monize://recent-transactions", { sessionId: "s1" });

    // 10th positional arg is excludeInvestmentLinked.
    const args = analyticsService.getSummary.mock.calls[0];
    expect(args[9]).toBe(true);
  });
});
