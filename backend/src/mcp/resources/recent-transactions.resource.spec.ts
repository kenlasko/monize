import { requestContextStorage } from "../../common/request-context";
import { SharedReviewService } from "../../shared-expenses/shared-review.service";
import { sharedReviewMock } from "../../shared-expenses/__fixtures__/shared-review";
import { McpRecentTransactionsResource } from "./recent-transactions.resource";
import { mcpTestCtx, McpTestContext } from "../testing/mcp-test-context";

describe("McpRecentTransactionsResource", () => {
  let resource: McpRecentTransactionsResource;
  let transactionsService: Record<string, jest.Mock>;
  let analyticsService: Record<string, jest.Mock>;
  let server: { registerResource: jest.Mock };
  let ctx: McpTestContext;
  let handler: (...args: any[]) => any;

  beforeEach(() => {
    transactionsService = {
      findAll: jest.fn(),
    };

    analyticsService = {
      getSummary: jest.fn(),
      getLlmFlowTotals: jest.fn().mockResolvedValue({
        totalIncome: 0,
        totalExpenses: 0,
        netCashFlow: 0,
        knownIncomeSubtotal: 0,
        knownExpensesSubtotal: 0,
        totalsCurrency: "PLN",
        fxComplete: true,
        missingRatePairs: [],
      }),
    };

    resource = new McpRecentTransactionsResource(
      sharedReviewMock() as unknown as SharedReviewService,
      transactionsService as any,
      analyticsService as any,
    );

    server = {
      registerResource: jest.fn((_name, _uri, _opts, h) => {
        handler = h;
      }),
    };

    ctx = mcpTestCtx();
    resource.register(server as any);
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
    ctx.setUser(undefined);
    const result = await handler("monize://recent-transactions", ctx);
    expect(result.contents[0].text).toContain("Error");
  });

  it("should return error when scope check fails", async () => {
    ctx.setUser({ userId: "u1", scopes: "write" });
    const result = await handler("monize://recent-transactions", ctx);
    expect(result.contents[0].text).toContain("Insufficient scope");
  });

  it("should return recent transactions with summary", async () => {
    ctx.setUser({ userId: "u1", scopes: "read" });
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
      totalExpenses: 5000,
      transactionCount: 2,
    });
    analyticsService.getLlmFlowTotals.mockResolvedValue({
      totalIncome: 5000,
      totalExpenses: 3000,
      netCashFlow: 2000,
      knownIncomeSubtotal: 5000,
      knownExpensesSubtotal: 3000,
      totalsCurrency: "PLN",
      fxComplete: true,
      missingRatePairs: [],
    });

    const result = await handler("monize://recent-transactions", ctx);
    const parsed = JSON.parse(result.contents[0].text);
    // The converted totals win over the summary's per-currency sums.
    expect(parsed.summary.totalExpenses).toBe(3000);
    expect(parsed.summary.totalsCurrency).toBe("PLN");
    expect(parsed.summary.fxComplete).toBe(true);
    expect(parsed.summary.transactionCount).toBe(2);
    expect(parsed.summary.totalIncome).toBe(5000);
    expect(parsed.recentTransactions).toHaveLength(1);
    expect(parsed.total).toBe(1);
  });

  // #2365: 20:00Z is already 2026-12-01 in Kiritimati (UTC+14).
  it("takes the 30-day window from the user's day, not the server's", async () => {
    jest.useFakeTimers({
      now: new Date("2026-11-30T20:00:00Z"),
      doNotFake: ["nextTick", "setImmediate", "queueMicrotask"],
    });
    try {
      ctx.setUser({ userId: "u1", scopes: "read" });
      transactionsService.findAll.mockResolvedValue({
        data: [],
        pagination: { total: 0, hasMore: false },
      });
      analyticsService.getSummary.mockResolvedValue({});

      await requestContextStorage.run(
        { userId: "u1", timezone: "Pacific/Kiritimati" },
        () => handler("monize://recent-transactions", ctx),
      );

      expect(transactionsService.findAll).toHaveBeenCalledWith(
        "u1",
        undefined,
        "2026-11-01",
        "2026-12-01",
        undefined,
        undefined,
        1,
        100,
      );
    } finally {
      jest.useRealTimers();
    }
  });

  it("expands split transactions into per-split rows", async () => {
    ctx.setUser({ userId: "u1", scopes: "read" });
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

    const result = await handler("monize://recent-transactions", ctx);
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

  // docs/specs/transfer-categories.md section 9: a transfer holding a
  // Transfer category is labelled a transfer, not read as spending.
  it("labels a transfer leg and a split's transfer line with the category's type", async () => {
    ctx.setUser({ userId: "u1", scopes: "read" });
    transactionsService.findAll.mockResolvedValue({
      data: [
        {
          transactionDate: "2026-03-10",
          payeeName: "Transfer to HISA",
          category: { name: "Savings contributions", categoryType: "transfer" },
          amount: -500,
          account: { name: "Checking" },
          isTransfer: true,
          isSplit: false,
        },
        {
          transactionDate: "2026-03-11",
          payeeName: "Bank",
          category: null,
          amount: -60,
          account: { name: "Checking" },
          isSplit: true,
          splits: [
            {
              id: "s1",
              amount: -50,
              transferAccountId: "acc-hisa",
              category: {
                name: "Savings contributions",
                categoryType: "transfer",
              },
            },
            {
              id: "s2",
              amount: -10,
              category: { name: "Fees", categoryType: "expense" },
            },
          ],
        },
      ],
      pagination: { total: 2, hasMore: false },
    });
    analyticsService.getSummary.mockResolvedValue({});

    const result = await handler("monize://recent-transactions", ctx);
    const rows = JSON.parse(result.contents[0].text).recentTransactions;
    expect(
      rows.map((r: any) => [r.amount, r.categoryType, r.isTransfer]),
    ).toEqual([
      [-500, "transfer", true],
      [-50, "transfer", true],
      [-10, "expense", undefined],
    ]);
  });

  it("excludes investment-linked cash transactions from the MCP summary", async () => {
    ctx.setUser({ userId: "u1", scopes: "read" });
    transactionsService.findAll.mockResolvedValue({
      data: [],
      pagination: { total: 0, hasMore: false },
    });
    analyticsService.getSummary.mockResolvedValue({
      totalIncome: 0,
      totalExpenses: 0,
    });

    await handler("monize://recent-transactions", ctx);

    // 10th positional arg is excludeInvestmentLinked.
    const args = analyticsService.getSummary.mock.calls[0];
    expect(args[9]).toBe(true);
  });
});
