import { McpFinancialSummaryResource } from "./financial-summary.resource";
import { UserContextResolver } from "../mcp-context";

describe("McpFinancialSummaryResource", () => {
  let resource: McpFinancialSummaryResource;
  let accountsService: Record<string, jest.Mock>;
  let analyticsService: Record<string, jest.Mock>;
  let server: { registerResource: jest.Mock };
  let resolve: jest.MockedFunction<UserContextResolver>;
  let handler: (...args: any[]) => any;

  beforeEach(() => {
    accountsService = {
      getSummary: jest.fn(),
    };

    analyticsService = {
      getSummary: jest.fn(),
    };

    resource = new McpFinancialSummaryResource(
      accountsService as any,
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
      "financial-summary",
      "monize://financial-summary",
      expect.any(Object),
      expect.any(Function),
    );
  });

  it("should return error when no user context", async () => {
    resolve.mockReturnValue(undefined);
    const result = await handler("monize://financial-summary", {
      sessionId: "s1",
    });
    expect(result.contents[0].text).toContain("Error");
  });

  it("should return financial summary with net worth and current month", async () => {
    resolve.mockReturnValue({ userId: "u1", scopes: "read" });
    accountsService.getSummary.mockResolvedValue({
      totalAssets: 10000,
      totalLiabilities: 2000,
      netWorth: 8000,
    });
    analyticsService.getSummary.mockResolvedValue({
      totalIncome: 5000,
      totalExpenses: -3000,
    });

    const result = await handler("monize://financial-summary", {
      sessionId: "s1",
    });
    const parsed = JSON.parse(result.contents[0].text);
    expect(parsed.netWorth.netWorth).toBe(8000);
    expect(parsed.currentMonth.totalIncome).toBe(5000);
    expect(parsed.currentMonth.period).toBeDefined();
  });
});
