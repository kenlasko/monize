import { McpInvestmentsTools } from "./investments.tool";
import { UserContextResolver } from "../mcp-context";

describe("McpInvestmentsTools", () => {
  let tool: McpInvestmentsTools;
  let portfolioService: Record<string, jest.Mock>;
  let holdingsService: Record<string, jest.Mock>;
  let investmentTransactionsService: Record<string, jest.Mock>;
  let server: {
    registerTool: jest.Mock;
    server: { getClientCapabilities: jest.Mock; elicitInput: jest.Mock };
  };
  let elicitInput: jest.Mock;
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
      getLlmCapitalGains: jest.fn(),
      previewCreateInvestmentTransaction: jest.fn(),
      create: jest.fn(),
    };

    tool = new McpInvestmentsTools(
      portfolioService as any,
      holdingsService as any,
      investmentTransactionsService as any,
    );

    elicitInput = jest.fn();
    server = {
      registerTool: jest.fn((name, _opts, handler) => {
        handlers[name] = handler;
      }),
      // confirmWrite() reads capabilities + elicits via server.server. Default
      // to no elicitation capability so writes proceed (matches a client that
      // can't show a dialog); accept/decline tests override these.
      server: {
        getClientCapabilities: jest.fn().mockReturnValue({}),
        elicitInput,
      },
    };

    resolve = jest.fn();
    tool.register(server as any, resolve);
  });

  it("should register 5 tools", () => {
    expect(server.registerTool).toHaveBeenCalledTimes(5);
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

    it("returns error when getLlmSummary throws", async () => {
      resolve.mockReturnValue({ userId: "u1", scopes: "read" });
      portfolioService.getLlmSummary.mockRejectedValue(new Error("fail"));
      const result = await handlers["get_portfolio_summary"](
        {},
        { sessionId: "s1" },
      );
      expect(result.isError).toBe(true);
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

    it("defaults groupBy to 'security' and leaves other filters undefined when no args provided", async () => {
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
        groupBy: "security",
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

  describe("get_capital_gains", () => {
    it("returns error when no user context", async () => {
      resolve.mockReturnValue(undefined);
      const result = await handlers["get_capital_gains"](
        { startDate: "2024-01-01", endDate: "2024-12-31" },
        { sessionId: "s1" },
      );
      expect(result.isError).toBe(true);
    });

    it("delegates to shared getLlmCapitalGains with all filters", async () => {
      resolve.mockReturnValue({ userId: "u1", scopes: "read" });
      investmentTransactionsService.getLlmCapitalGains.mockResolvedValue({
        startDate: "2024-01-01",
        endDate: "2024-12-31",
        totals: {
          realizedGain: 50,
          unrealizedGain: 100,
          totalCapitalGain: 150,
        },
        groupedBy: "security",
        entries: [
          {
            month: null,
            accountName: null,
            symbol: "AAA",
            securityName: "Alpha",
            currency: "CAD",
            startValue: 1000,
            endValue: 1100,
            realizedGain: 50,
            unrealizedGain: 100,
            totalCapitalGain: 150,
          },
        ],
        entryCount: 1,
        truncatedEntryList: false,
      });

      const result = await handlers["get_capital_gains"](
        {
          startDate: "2024-01-01",
          endDate: "2024-12-31",
          accountIds: ["00000000-0000-0000-0000-000000000001"],
          symbols: ["AAA"],
          groupBy: "security",
        },
        { sessionId: "s1" },
      );

      expect(
        investmentTransactionsService.getLlmCapitalGains,
      ).toHaveBeenCalledWith("u1", {
        startDate: "2024-01-01",
        endDate: "2024-12-31",
        accountIds: ["00000000-0000-0000-0000-000000000001"],
        symbols: ["AAA"],
        groupBy: "security",
      });
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.totals.totalCapitalGain).toBe(150);
      expect(parsed.entries[0].symbol).toBe("AAA");
    });

    it("defaults groupBy to 'month' when omitted", async () => {
      resolve.mockReturnValue({ userId: "u1", scopes: "read" });
      investmentTransactionsService.getLlmCapitalGains.mockResolvedValue({
        startDate: "2024-01-01",
        endDate: "2024-12-31",
        totals: { realizedGain: 0, unrealizedGain: 0, totalCapitalGain: 0 },
        groupedBy: "month",
        entries: [],
        entryCount: 0,
        truncatedEntryList: false,
      });

      await handlers["get_capital_gains"](
        { startDate: "2024-01-01", endDate: "2024-12-31" },
        { sessionId: "s1" },
      );

      expect(
        investmentTransactionsService.getLlmCapitalGains,
      ).toHaveBeenCalledWith(
        "u1",
        expect.objectContaining({ groupBy: "month" }),
      );
    });

    it("returns a safe error on service failure", async () => {
      resolve.mockReturnValue({ userId: "u1", scopes: "read" });
      investmentTransactionsService.getLlmCapitalGains.mockRejectedValue(
        new Error("boom"),
      );

      const result = await handlers["get_capital_gains"](
        { startDate: "2024-01-01", endDate: "2024-12-31" },
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

  describe("create_investment_transaction", () => {
    const preview = {
      accountId: "a1",
      accountName: "Brokerage",
      accountCurrency: "USD",
      action: "BUY",
      transactionDate: "2026-01-15",
      securityId: "sec-1",
      symbol: "AAPL",
      securityName: "Apple Inc.",
      securityCurrency: "USD",
      quantity: 10,
      price: 150,
      commission: 9.99,
      totalAmount: 1509.99,
      exchangeRate: 1,
      fundingAccountId: null,
      cashAccountName: "Brokerage Cash",
      cashCurrency: "USD",
      cashAmount: -1509.99,
      description: null,
    };

    const args = {
      accountId: "a1",
      action: "BUY",
      date: "2026-01-15",
      security: "AAPL",
      quantity: 10,
      price: 150,
      commission: 9.99,
    };

    it("returns error when no user context", async () => {
      resolve.mockReturnValue(undefined);
      const result = await handlers["create_investment_transaction"](args, {
        sessionId: "s1",
      });
      expect(result.isError).toBe(true);
    });

    it("requires the write scope", async () => {
      resolve.mockReturnValue({ userId: "u1", scopes: "read" });
      const result = await handlers["create_investment_transaction"](args, {
        sessionId: "s1",
      });
      expect(result.isError).toBe(true);
      expect(
        investmentTransactionsService.previewCreateInvestmentTransaction,
      ).not.toHaveBeenCalled();
    });

    it("returns a preview without persisting on dryRun", async () => {
      resolve.mockReturnValue({ userId: "u1", scopes: "write" });
      investmentTransactionsService.previewCreateInvestmentTransaction.mockResolvedValue(
        preview,
      );

      const result = await handlers["create_investment_transaction"](
        { ...args, dryRun: true },
        { sessionId: "s1" },
      );

      expect(
        investmentTransactionsService.previewCreateInvestmentTransaction,
      ).toHaveBeenCalledWith(
        "u1",
        expect.objectContaining({
          accountId: "a1",
          action: "BUY",
          transactionDate: "2026-01-15",
          securityQuery: "AAPL",
        }),
      );
      expect(investmentTransactionsService.create).not.toHaveBeenCalled();
      expect(elicitInput).not.toHaveBeenCalled();
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.dryRun).toBe(true);
      expect(parsed.preview.symbol).toBe("AAPL");
    });

    it("creates when the client cannot elicit (proceeds)", async () => {
      resolve.mockReturnValue({ userId: "u1", scopes: "write" });
      investmentTransactionsService.previewCreateInvestmentTransaction.mockResolvedValue(
        preview,
      );
      investmentTransactionsService.create.mockResolvedValue({
        id: "inv-tx-1",
        action: "BUY",
        transactionDate: "2026-01-15",
        quantity: 10,
        price: 150,
        totalAmount: 1509.99,
      });

      const result = await handlers["create_investment_transaction"](args, {
        sessionId: "s1",
      });

      expect(investmentTransactionsService.create).toHaveBeenCalledWith(
        "u1",
        expect.objectContaining({
          accountId: "a1",
          action: "BUY",
          securityId: "sec-1",
          quantity: 10,
          price: 150,
          commission: 9.99,
          exchangeRate: 1,
        }),
      );
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.id).toBe("inv-tx-1");
      expect(parsed.symbol).toBe("AAPL");
      expect(parsed.totalAmount).toBe(1509.99);
    });

    it("confirms via elicitation and creates when accepted", async () => {
      resolve.mockReturnValue({ userId: "u1", scopes: "write" });
      server.server.getClientCapabilities.mockReturnValue({
        elicitation: { form: {} },
      });
      elicitInput.mockResolvedValue({ action: "accept" });
      investmentTransactionsService.previewCreateInvestmentTransaction.mockResolvedValue(
        preview,
      );
      investmentTransactionsService.create.mockResolvedValue({
        id: "inv-tx-1",
        action: "BUY",
        transactionDate: "2026-01-15",
        quantity: 10,
        price: 150,
        totalAmount: 1509.99,
      });

      const result = await handlers["create_investment_transaction"](args, {
        sessionId: "s1",
      });

      expect(elicitInput).toHaveBeenCalled();
      expect(investmentTransactionsService.create).toHaveBeenCalled();
      expect(result.isError).toBeUndefined();
    });

    it("does not create when the confirmation is declined", async () => {
      resolve.mockReturnValue({ userId: "u1", scopes: "write" });
      server.server.getClientCapabilities.mockReturnValue({
        elicitation: { form: {} },
      });
      elicitInput.mockResolvedValue({ action: "decline" });
      investmentTransactionsService.previewCreateInvestmentTransaction.mockResolvedValue(
        preview,
      );

      const result = await handlers["create_investment_transaction"](args, {
        sessionId: "s1",
      });

      expect(elicitInput).toHaveBeenCalled();
      expect(investmentTransactionsService.create).not.toHaveBeenCalled();
      expect(result.isError).toBe(true);
    });

    it("surfaces a 4xx from the shared preview", async () => {
      resolve.mockReturnValue({ userId: "u1", scopes: "write" });
      const { BadRequestException } = await import("@nestjs/common");
      investmentTransactionsService.previewCreateInvestmentTransaction.mockRejectedValue(
        new BadRequestException('No security matches "ZZZZ".'),
      );

      const result = await handlers["create_investment_transaction"](
        { ...args, security: "ZZZZ" },
        { sessionId: "s1" },
      );
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("No security matches");
    });
  });
});
