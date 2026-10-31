import { SharedReviewService } from "../../shared-expenses/shared-review.service";
import { sharedReviewMock } from "../../shared-expenses/__fixtures__/shared-review";
import { McpFinancialSummaryResource } from "./financial-summary.resource";
import { mcpTestCtx, McpTestContext } from "../testing/mcp-test-context";

describe("McpFinancialSummaryResource", () => {
  let resource: McpFinancialSummaryResource;
  let accountsService: Record<string, jest.Mock>;
  let analyticsService: Record<string, jest.Mock>;
  let server: { registerResource: jest.Mock };
  let ctx: McpTestContext;
  let handler: (...args: any[]) => any;

  beforeEach(() => {
    accountsService = {
      getSummary: jest.fn(),
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

    resource = new McpFinancialSummaryResource(
      sharedReviewMock() as unknown as SharedReviewService,
      accountsService as any,
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
      "financial-summary",
      "monize://financial-summary",
      expect.any(Object),
      expect.any(Function),
    );
  });

  it("should return error when no user context", async () => {
    ctx.setUser(undefined);
    const result = await handler("monize://financial-summary", ctx);
    expect(result.contents[0].text).toContain("Error");
  });

  it("should return error when scope check fails", async () => {
    ctx.setUser({ userId: "u1", scopes: "write" });
    const result = await handler("monize://financial-summary", ctx);
    expect(result.contents[0].text).toContain("Insufficient scope");
  });

  it("should return financial summary with net worth and current month", async () => {
    ctx.setUser({ userId: "u1", scopes: "read" });
    accountsService.getSummary.mockResolvedValue({
      totalAssets: 10000,
      totalLiabilities: 2000,
      netWorth: 8000,
    });
    analyticsService.getSummary.mockResolvedValue({
      totalIncome: 5000,
      totalExpenses: -3000,
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

    const result = await handler("monize://financial-summary", ctx);
    const parsed = JSON.parse(result.contents[0].text);
    expect(parsed.netWorth.netWorth).toBe(8000);
    expect(parsed.currentMonth.totalsCurrency).toBe("PLN");
    expect(parsed.currentMonth.totalIncome).toBe(5000);
    expect(parsed.currentMonth.period).toBeDefined();
  });

  it("reports the month's totals converted into one currency, withheld while a rate is missing", async () => {
    ctx.setUser({ userId: "u1", scopes: "read" });
    accountsService.getSummary.mockResolvedValue({ netWorth: 0 });
    // The per-currency sums the summary adds as bare numbers.
    analyticsService.getSummary.mockResolvedValue({
      totalIncome: 5000,
      totalExpenses: 5000,
      byCurrency: { PLN: {}, USD: {} },
    });
    analyticsService.getLlmFlowTotals.mockResolvedValue({
      totalIncome: null,
      totalExpenses: null,
      netCashFlow: null,
      knownIncomeSubtotal: 0,
      knownExpensesSubtotal: 4000,
      totalsCurrency: "PLN",
      fxComplete: false,
      missingRatePairs: ["USD->PLN"],
    });

    const result = await handler("monize://financial-summary", ctx);
    const month = JSON.parse(result.contents[0].text).currentMonth;

    expect(month.totalExpenses).toBeNull();
    expect(month.totalsCurrency).toBe("PLN");
    expect(month.fxComplete).toBe(false);
    expect(month.missingRatePairs).toEqual(["USD->PLN"]);
    expect(month.byCurrency).toBeDefined();
    expect(analyticsService.getLlmFlowTotals).toHaveBeenCalledWith(
      "u1",
      expect.objectContaining({ excludeTransfers: false }),
    );
  });

  it("carries a withheld net worth and its completeness flags to the client", async () => {
    ctx.setUser({ userId: "u1", scopes: "read" });
    accountsService.getSummary.mockResolvedValue({
      totalAccounts: 2,
      totalBalance: 1000,
      totalAssets: null,
      totalLiabilities: 0,
      netWorth: null,
      knownNetWorthSubtotal: 1000,
      fxComplete: false,
      pricesComplete: true,
      valuationComplete: false,
      missingRatePairs: ["ZZZ->USD"],
      unpricedSecurityIds: [],
      unpricedSymbols: [],
    });
    analyticsService.getSummary.mockResolvedValue({
      totalIncome: 0,
      totalExpenses: 0,
    });

    const result = await handler("monize://financial-summary", ctx);
    const nw = JSON.parse(result.contents[0].text).netWorth;

    expect(nw.netWorth).toBeNull();
    expect(nw.knownNetWorthSubtotal).toBe(1000);
    expect(nw.fxComplete).toBe(false);
    expect(nw.pricesComplete).toBe(true);
    expect(nw.valuationComplete).toBe(false);
    expect(nw.missingRatePairs).toEqual(["ZZZ->USD"]);
  });

  it("excludes investment-linked cash transactions from the MCP summary", async () => {
    ctx.setUser({ userId: "u1", scopes: "read" });
    accountsService.getSummary.mockResolvedValue({
      totalAssets: 0,
      totalLiabilities: 0,
      netWorth: 0,
    });
    analyticsService.getSummary.mockResolvedValue({
      totalIncome: 0,
      totalExpenses: 0,
    });

    await handler("monize://financial-summary", ctx);

    // 10th positional arg is excludeInvestmentLinked.
    const args = analyticsService.getSummary.mock.calls[0];
    expect(args[9]).toBe(true);
  });
});
