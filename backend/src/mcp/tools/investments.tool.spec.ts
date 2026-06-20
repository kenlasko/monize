import { BadRequestException } from "@nestjs/common";
import { McpInvestmentsTools } from "./investments.tool";
import { UserContextResolver } from "../mcp-context";

describe("McpInvestmentsTools", () => {
  let tool: McpInvestmentsTools;
  let portfolioService: Record<string, jest.Mock>;
  let holdingsService: Record<string, jest.Mock>;
  let investmentTransactionsService: Record<string, jest.Mock>;
  let securitiesService: Record<string, jest.Mock>;
  let accountsService: Record<string, jest.Mock>;
  let server: {
    registerTool: jest.Mock;
    server: { getClientCapabilities: jest.Mock; elicitInput: jest.Mock };
  };
  let elicitInput: jest.Mock;
  let relayService: { emitPendingAction: jest.Mock };
  let actionBuilderRef: Record<string, jest.Mock>;
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
      previewUpdateInvestmentTransaction: jest.fn(),
      previewDeleteInvestmentTransaction: jest.fn(),
      prepareCreateInvestmentSingle: jest.fn(),
      prepareCreateInvestmentBulk: jest.fn(),
      prepareUpdateInvestmentBulk: jest.fn(),
      prepareDeleteInvestmentBulk: jest.fn(),
      create: jest.fn(),
      createBulk: jest.fn(),
      update: jest.fn(),
      remove: jest.fn().mockResolvedValue(undefined),
    };

    // Default: not serving a relayed prompt, so the tool uses its normal
    // (direct MCP-client) confirmation path and the existing assertions hold.
    securitiesService = {
      previewCreateSecurity: jest.fn(),
      lookupSecuritiesForLlm: jest.fn(),
      create: jest.fn(),
    };

    accountsService = { resolveByName: jest.fn() };

    relayService = { emitPendingAction: jest.fn().mockReturnValue(false) };
    const actionBuilder = {
      buildCreateInvestmentTransaction: jest
        .fn()
        .mockReturnValue({ type: "create_investment_transaction" }),
      buildCreateInvestmentTransactions: jest
        .fn()
        .mockReturnValue({ type: "create_investment_transactions" }),
      buildCreateSecurity: jest.fn().mockReturnValue({}),
      buildUpdateInvestmentTransaction: jest
        .fn()
        .mockReturnValue({ type: "update_investment_transaction" }),
      buildDeleteInvestmentTransaction: jest
        .fn()
        .mockReturnValue({ type: "delete_investment_transaction" }),
      buildBatchUpdateInvestmentTransactions: jest
        .fn()
        .mockReturnValue({ type: "batch_actions" }),
      buildBatchDeleteInvestmentTransactions: jest
        .fn()
        .mockReturnValue({ type: "batch_actions" }),
    };
    actionBuilderRef = actionBuilder;

    tool = new McpInvestmentsTools(
      portfolioService as any,
      holdingsService as any,
      investmentTransactionsService as any,
      securitiesService as any,
      relayService as any,
      actionBuilder as any,
      accountsService as any,
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

  it("should register 7 tools", () => {
    expect(server.registerTool).toHaveBeenCalledTimes(7);
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

  describe("list_investment_transactions", () => {
    it("returns error when no user context", async () => {
      resolve.mockReturnValue(undefined);
      const result = await handlers["list_investment_transactions"](
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

      const result = await handlers["list_investment_transactions"](
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

      await handlers["list_investment_transactions"]({}, { sessionId: "s1" });

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

      const result = await handlers["list_investment_transactions"](
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

  describe("create_security", () => {
    const securityPreview = {
      symbol: "AAPL",
      name: "Apple Inc.",
      securityType: "STOCK",
      exchange: "NASDAQ",
      currencyCode: "USD",
      isFavourite: false,
      quoteProvider: "yahoo" as const,
      msnInstrumentId: null,
    };

    const securityArgs = { query: "AAPL" };

    it("returns error when no user context", async () => {
      resolve.mockReturnValue(undefined);
      const result = await handlers["create_security"](securityArgs, {
        sessionId: "s1",
      });
      expect(result.isError).toBe(true);
    });

    it("requires the write scope", async () => {
      resolve.mockReturnValue({ userId: "u1", scopes: "read" });
      const result = await handlers["create_security"](securityArgs, {
        sessionId: "s1",
      });
      expect(result.isError).toBe(true);
      expect(securitiesService.previewCreateSecurity).not.toHaveBeenCalled();
    });

    it("returns a preview without persisting on dryRun", async () => {
      resolve.mockReturnValue({ userId: "u1", scopes: "write" });
      securitiesService.previewCreateSecurity.mockResolvedValue(
        securityPreview,
      );

      const result = await handlers["create_security"](
        { ...securityArgs, dryRun: true },
        { sessionId: "s1" },
      );

      expect(securitiesService.previewCreateSecurity).toHaveBeenCalledWith(
        "u1",
        expect.objectContaining({ query: "AAPL" }),
      );
      expect(securitiesService.create).not.toHaveBeenCalled();
      expect(elicitInput).not.toHaveBeenCalled();
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.dryRun).toBe(true);
      expect(parsed.preview.symbol).toBe("AAPL");
      expect(parsed.preview.exchange).toBe("NASDAQ");
    });

    it("creates when the client cannot elicit (proceeds)", async () => {
      resolve.mockReturnValue({ userId: "u1", scopes: "write" });
      securitiesService.previewCreateSecurity.mockResolvedValue(
        securityPreview,
      );
      securitiesService.create.mockResolvedValue({
        id: "sec-1",
        symbol: "AAPL",
        name: "Apple Inc.",
        securityType: "STOCK",
        exchange: "NASDAQ",
        currencyCode: "USD",
        isFavourite: false,
      });

      const result = await handlers["create_security"](securityArgs, {
        sessionId: "s1",
      });

      expect(securitiesService.create).toHaveBeenCalledWith(
        "u1",
        expect.objectContaining({
          symbol: "AAPL",
          name: "Apple Inc.",
          securityType: "STOCK",
          exchange: "NASDAQ",
          currencyCode: "USD",
        }),
      );
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.id).toBe("sec-1");
      expect(parsed.symbol).toBe("AAPL");
    });

    it("surfaces a 4xx lookup failure to the caller", async () => {
      resolve.mockReturnValue({ userId: "u1", scopes: "write" });
      securitiesService.previewCreateSecurity.mockRejectedValue(
        new BadRequestException('No security found matching "ZZZZ".'),
      );

      const result = await handlers["create_security"](
        { query: "ZZZZ" },
        { sessionId: "s1" },
      );

      expect(result.isError).toBe(true);
      expect(securitiesService.create).not.toHaveBeenCalled();
    });

    it("shows the web-chat card via relay instead of persisting", async () => {
      resolve.mockReturnValue({ userId: "u1", scopes: "write" });
      securitiesService.previewCreateSecurity.mockResolvedValue(
        securityPreview,
      );
      relayService.emitPendingAction.mockReturnValue(true);

      const result = await handlers["create_security"](securityArgs, {
        sessionId: "s1",
      });

      expect(relayService.emitPendingAction).toHaveBeenCalled();
      expect(securitiesService.create).not.toHaveBeenCalled();
      expect(result.isError).toBeUndefined();
    });
  });
  describe("manage_investment_transactions", () => {
    const createArgs = {
      operation: "create",
      items: [
        {
          accountName: "Brokerage",
          action: "BUY",
          date: "2026-01-15",
          security: "AAPL",
          quantity: 10,
          price: 150,
        },
      ],
    };
    const createPreview = {
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
      commission: 0,
      totalAmount: 1500,
      exchangeRate: 1,
      fundingAccountId: null,
      cashAccountName: "Brokerage Cash",
      cashCurrency: "USD",
      cashAmount: -1500,
      description: null,
    };

    it("returns error when no user context", async () => {
      resolve.mockReturnValue(undefined);
      const result = await handlers["manage_investment_transactions"](
        createArgs,
        { sessionId: "s1" },
      );
      expect(result.isError).toBe(true);
    });

    it("requires the write scope", async () => {
      resolve.mockReturnValue({ userId: "u1", scopes: "read" });
      const result = await handlers["manage_investment_transactions"](
        createArgs,
        { sessionId: "s1" },
      );
      expect(result.isError).toBe(true);
      expect(
        investmentTransactionsService.prepareCreateInvestmentSingle,
      ).not.toHaveBeenCalled();
    });

    it("creates a single transaction (name resolved internally) when the client cannot elicit", async () => {
      resolve.mockReturnValue({ userId: "u1", scopes: "write" });
      investmentTransactionsService.prepareCreateInvestmentSingle.mockResolvedValue(
        createPreview,
      );
      investmentTransactionsService.create.mockResolvedValue({
        id: "inv-1",
        transactionDate: "2026-01-15",
      });

      const result = await handlers["manage_investment_transactions"](
        createArgs,
        { sessionId: "s1" },
      );

      expect(
        investmentTransactionsService.prepareCreateInvestmentSingle,
      ).toHaveBeenCalledWith(
        "u1",
        expect.objectContaining({
          accountName: "Brokerage",
          securityQuery: "AAPL",
        }),
      );
      expect(investmentTransactionsService.create).toHaveBeenCalled();
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.id).toBe("inv-1");
      expect(parsed.count).toBe(1);
    });

    it("surfaces an unknown-account error from the single create prep", async () => {
      resolve.mockReturnValue({ userId: "u1", scopes: "write" });
      investmentTransactionsService.prepareCreateInvestmentSingle.mockRejectedValue(
        new BadRequestException("Unknown account: Nope."),
      );

      const result = await handlers["manage_investment_transactions"](
        createArgs,
        { sessionId: "s1" },
      );
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("Unknown account");
    });

    it("shows a relay card for a single create without writing", async () => {
      resolve.mockReturnValue({ userId: "u1", scopes: "write" });
      relayService.emitPendingAction.mockReturnValue(true);
      investmentTransactionsService.prepareCreateInvestmentSingle.mockResolvedValue(
        createPreview,
      );

      const result = await handlers["manage_investment_transactions"](
        createArgs,
        { sessionId: "s1", requestId: "c1" },
      );

      expect(relayService.emitPendingAction).toHaveBeenCalled();
      expect(investmentTransactionsService.create).not.toHaveBeenCalled();
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.status).toBe("preview_shown");
    });

    it("does not create a single transaction when the confirmation is declined", async () => {
      resolve.mockReturnValue({ userId: "u1", scopes: "write" });
      server.server.getClientCapabilities.mockReturnValue({
        elicitation: { form: {} },
      });
      elicitInput.mockResolvedValue({ action: "decline" });
      investmentTransactionsService.prepareCreateInvestmentSingle.mockResolvedValue(
        createPreview,
      );

      const result = await handlers["manage_investment_transactions"](
        createArgs,
        { sessionId: "s1", requestId: "c1" },
      );

      expect(elicitInput).toHaveBeenCalled();
      expect(investmentTransactionsService.create).not.toHaveBeenCalled();
      expect(result.isError).toBe(true);
    });

    it("blocks a single create when the daily write limit is exhausted", async () => {
      resolve.mockReturnValue({ userId: "u1", scopes: "write" });
      investmentTransactionsService.prepareCreateInvestmentSingle.mockResolvedValue(
        createPreview,
      );
      (tool as any).writeLimiter.checkLimit = jest
        .fn()
        .mockReturnValue({ allowed: false, currentCount: 500, limit: 500 });

      const result = await handlers["manage_investment_transactions"](
        createArgs,
        { sessionId: "s1" },
      );
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("Daily write limit");
      expect(investmentTransactionsService.create).not.toHaveBeenCalled();
    });

    it("creates a bulk batch in one card and maps skip indices back", async () => {
      resolve.mockReturnValue({ userId: "u1", scopes: "write" });
      investmentTransactionsService.prepareCreateInvestmentBulk.mockResolvedValue(
        {
          okPreviews: [createPreview, { ...createPreview, action: "SELL" }],
          okIndex: [0, 2],
          previewRows: [{ status: "ok" }, { status: "ok" }],
          skipped: [{ index: 1, reason: "Unknown account: Ghost" }],
        },
      );
      investmentTransactionsService.createBulk.mockResolvedValue({
        created: [{ id: "i1" }],
        skipped: [{ index: 1, reason: "Oversell" }],
      });

      const result = await handlers["manage_investment_transactions"](
        {
          operation: "create",
          items: [
            {
              accountName: "Brokerage",
              action: "BUY",
              date: "2026-01-15",
              security: "AAPL",
              quantity: 1,
              price: 1,
            },
            {
              accountName: "Brokerage",
              action: "BUY",
              date: "2026-01-15",
              security: "AAPL",
              quantity: 1,
              price: 1,
            },
            {
              accountName: "Brokerage",
              action: "SELL",
              date: "2026-01-16",
              security: "AAPL",
              quantity: 1,
              price: 1,
            },
          ],
        },
        { sessionId: "s1", requestId: "c1" },
      );

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.ids).toEqual(["i1"]);
      expect(parsed.count).toBe(1);
      // original skip (index 1) plus createBulk skip mapped via okIndex[1] = 2.
      expect(parsed.skipped).toEqual(
        expect.arrayContaining([
          { index: 1, reason: "Unknown account: Ghost" },
          { index: 2, reason: "Oversell" },
        ]),
      );
    });

    it("errors when no bulk create row could be prepared", async () => {
      resolve.mockReturnValue({ userId: "u1", scopes: "write" });
      investmentTransactionsService.prepareCreateInvestmentBulk.mockResolvedValue(
        { okPreviews: [], okIndex: [], previewRows: [], skipped: [] },
      );
      const result = await handlers["manage_investment_transactions"](
        {
          operation: "create",
          items: [
            { accountName: "x", action: "BUY", date: "2026-01-15" },
            { accountName: "y", action: "BUY", date: "2026-01-15" },
          ],
        },
        { sessionId: "s1" },
      );
      expect(result.isError).toBe(true);
      expect(investmentTransactionsService.createBulk).not.toHaveBeenCalled();
    });

    it("emits individual cards for a bulk create in individual mode (relay)", async () => {
      resolve.mockReturnValue({ userId: "u1", scopes: "write" });
      relayService.emitPendingAction.mockReturnValue(true);
      investmentTransactionsService.prepareCreateInvestmentBulk.mockResolvedValue(
        {
          okPreviews: [createPreview, createPreview],
          okIndex: [0, 1],
          previewRows: [{ status: "ok" }, { status: "ok" }],
          skipped: [],
        },
      );

      const result = await handlers["manage_investment_transactions"](
        {
          operation: "create",
          approvalMode: "individual",
          items: [
            {
              accountName: "Brokerage",
              action: "BUY",
              date: "2026-01-15",
              security: "AAPL",
              quantity: 1,
              price: 1,
            },
            {
              accountName: "Brokerage",
              action: "BUY",
              date: "2026-01-15",
              security: "AAPL",
              quantity: 1,
              price: 1,
            },
          ],
        },
        { sessionId: "s1", requestId: "c1" },
      );

      // One card per ok row, all emitted to the web chat.
      expect(relayService.emitPendingAction).toHaveBeenCalledTimes(2);
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.status).toBe("preview_shown");
    });

    it("updates a single investment transaction", async () => {
      resolve.mockReturnValue({ userId: "u1", scopes: "write" });
      investmentTransactionsService.previewUpdateInvestmentTransaction.mockResolvedValue(
        { ...createPreview, transactionId: "it1", action: "SELL" },
      );
      investmentTransactionsService.update.mockResolvedValue({ id: "it1" });

      const result = await handlers["manage_investment_transactions"](
        {
          operation: "update",
          items: [{ transactionId: "it1", action: "SELL", quantity: 5 }],
        },
        { sessionId: "s1" },
      );

      expect(
        investmentTransactionsService.previewUpdateInvestmentTransaction,
      ).toHaveBeenCalledWith(
        "u1",
        "it1",
        expect.objectContaining({ action: "SELL", quantity: 5 }),
      );
      expect(investmentTransactionsService.update).toHaveBeenCalled();
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.id).toBe("it1");
    });

    it("shows one bulk update card and writes each edit on confirm", async () => {
      resolve.mockReturnValue({ userId: "u1", scopes: "write" });
      investmentTransactionsService.prepareUpdateInvestmentBulk.mockResolvedValue(
        {
          okRows: [
            {
              transactionId: "it1",
              accountId: "a1",
              action: "SELL",
              transactionDate: "2026-02-01",
              securityId: "s1",
              fundingAccountId: null,
              quantity: 5,
              price: 160,
              commission: 0,
              exchangeRate: 1,
              description: null,
            },
          ],
          okIndex: [0],
          previewRows: [{ status: "ok" }],
          skipped: [{ index: 1, reason: "not found" }],
        },
      );
      investmentTransactionsService.update.mockResolvedValue({ id: "it1" });

      const result = await handlers["manage_investment_transactions"](
        {
          operation: "update",
          items: [
            { transactionId: "it1", action: "SELL" },
            { transactionId: "bad", action: "SELL" },
          ],
        },
        { sessionId: "s1", requestId: "c1" },
      );

      expect(
        actionBuilderRef.buildBatchUpdateInvestmentTransactions,
      ).toHaveBeenCalled();
      expect(investmentTransactionsService.update).toHaveBeenCalledTimes(1);
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.count).toBe(1);
      expect(parsed.skipped).toEqual([{ index: 1, reason: "not found" }]);
    });

    it("deletes a single investment transaction", async () => {
      resolve.mockReturnValue({ userId: "u1", scopes: "write" });
      investmentTransactionsService.previewDeleteInvestmentTransaction.mockResolvedValue(
        {
          transactionId: "it1",
          accountName: "Brokerage",
          action: "BUY",
          transactionDate: "2026-01-15",
          symbol: "AAPL",
          securityName: "Apple Inc.",
          securityCurrency: "USD",
          quantity: 10,
          price: 150,
          commission: 0,
          totalAmount: 1500,
          description: null,
        },
      );

      const result = await handlers["manage_investment_transactions"](
        { operation: "delete", items: [{ transactionId: "it1" }] },
        { sessionId: "s1" },
      );

      expect(investmentTransactionsService.remove).toHaveBeenCalledWith(
        "u1",
        "it1",
      );
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.id).toBe("it1");
      expect(parsed.deleted).toBe(true);
    });

    it("shows one bulk delete card and removes each on confirm", async () => {
      resolve.mockReturnValue({ userId: "u1", scopes: "write" });
      investmentTransactionsService.prepareDeleteInvestmentBulk.mockResolvedValue(
        {
          okRows: [{ transactionId: "it1" }, { transactionId: "it2" }],
          okIndex: [0, 1],
          previewRows: [{ status: "ok" }, { status: "ok" }],
          skipped: [],
        },
      );

      const result = await handlers["manage_investment_transactions"](
        {
          operation: "delete",
          items: [{ transactionId: "it1" }, { transactionId: "it2" }],
        },
        { sessionId: "s1", requestId: "c1" },
      );

      expect(
        actionBuilderRef.buildBatchDeleteInvestmentTransactions,
      ).toHaveBeenCalled();
      expect(investmentTransactionsService.remove).toHaveBeenCalledTimes(2);
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.count).toBe(2);
    });

    it("errors when no bulk delete row could be prepared", async () => {
      resolve.mockReturnValue({ userId: "u1", scopes: "write" });
      investmentTransactionsService.prepareDeleteInvestmentBulk.mockResolvedValue(
        { okRows: [], okIndex: [], previewRows: [], skipped: [] },
      );
      const result = await handlers["manage_investment_transactions"](
        {
          operation: "delete",
          items: [{ transactionId: "it1" }, { transactionId: "it2" }],
        },
        { sessionId: "s1" },
      );
      expect(result.isError).toBe(true);
      expect(investmentTransactionsService.remove).not.toHaveBeenCalled();
    });
  });
});
