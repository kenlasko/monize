import { BadRequestException } from "@nestjs/common";
import { McpInvestmentsTools } from "./investments.tool";
import { McpWriteLimiter } from "../mcp-write-limiter";
import { AuthAttemptCounterService } from "../../auth/auth-attempt-counter.service";
import { createAuthAttemptCounterMock } from "../../test-helpers/auth-attempt-counter-testing";
import { mcpTestCtx, McpTestContext } from "../testing/mcp-test-context";

describe("McpInvestmentsTools", () => {
  let tool: McpInvestmentsTools;
  let portfolioService: Record<string, jest.Mock>;
  let investmentTransactionsService: Record<string, jest.Mock>;
  let securitiesService: Record<string, jest.Mock>;
  let securityPrepService: Record<string, jest.Mock>;
  let accountsService: Record<string, jest.Mock>;
  let server: {
    registerTool: jest.Mock;
    server: { getClientCapabilities: jest.Mock };
  };
  let elicitInput: jest.Mock;
  let relayService: { emitPendingAction: jest.Mock };
  let actionBuilderRef: Record<string, jest.Mock>;
  let ctx: McpTestContext;
  const handlers: Record<string, (...args: any[]) => any> = {};
  const configs: Record<string, any> = {};

  beforeEach(() => {
    portfolioService = {
      getPortfolioSummary: jest.fn(),
      getLlmSummary: jest.fn(),
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
      listSecuritiesInAccount: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      remove: jest.fn().mockResolvedValue(undefined),
    };

    securityPrepService = {
      prepareCreateSecuritySingle: jest.fn(),
      prepareUpdateSecuritySingle: jest.fn(),
      prepareDeleteSecuritySingle: jest.fn(),
      prepareCreateSecurities: jest.fn(),
      prepareUpdateSecurities: jest.fn(),
      prepareDeleteSecurities: jest.fn(),
    };

    accountsService = {
      resolveByName: jest.fn(),
      resolveBrokerageByNameOrId: jest.fn(),
      // Default: no name filter resolves to "all accounts"; tests that pass
      // accountNames override this with resolved ids or an error.
      resolveAccountFilter: jest
        .fn()
        .mockResolvedValue({ accountIds: undefined }),
    };

    relayService = { emitPendingAction: jest.fn().mockResolvedValue(false) };
    const actionBuilder = {
      buildCreateInvestmentTransaction: jest
        .fn()
        .mockReturnValue({ type: "create_investment_transaction" }),
      buildCreateInvestmentTransactions: jest
        .fn()
        .mockReturnValue({ type: "create_investment_transactions" }),
      buildCreateSecurity: jest.fn().mockReturnValue({
        type: "create_security",
        preview: { symbol: "AAPL", securityName: "Apple Inc." },
        descriptor: {
          type: "create_security",
          symbol: "AAPL",
          name: "Apple Inc.",
          securityType: "STOCK",
          exchange: "NASDAQ",
          currencyCode: "USD",
          isFavourite: false,
          quoteProvider: "yahoo",
          msnInstrumentId: null,
        },
      }),
      buildUpdateSecurity: jest.fn().mockReturnValue({
        type: "update_security",
        preview: { symbol: "AAPL" },
        descriptor: {
          type: "update_security",
          securityId: "sec-1",
          securityType: "ETF",
          exchange: "NYSE",
          currencyCode: "USD",
          isFavourite: true,
        },
      }),
      buildDeleteSecurity: jest.fn().mockReturnValue({
        type: "delete_security",
        preview: { symbol: "AAPL", securityName: "Apple Inc." },
        descriptor: { type: "delete_security", securityId: "sec-1" },
      }),
      buildBatchActions: jest.fn().mockReturnValue({ type: "batch_actions" }),
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
      investmentTransactionsService as any,
      securitiesService as any,
      securityPrepService as any,
      relayService as any,
      actionBuilder as any,
      accountsService as any,
      new McpWriteLimiter(
        createAuthAttemptCounterMock() as unknown as AuthAttemptCounterService,
      ),
    );

    elicitInput = jest.fn();
    server = {
      registerTool: jest.fn((name, opts, handler) => {
        handlers[name] = handler;
        configs[name] = opts;
      }),
      // confirmWrite() reads the client's advertised capabilities from the
      // session's server and sends the dialog through the request (ctx). The
      // default is no elicitation capability, so writes proceed (matching a
      // client that cannot show a dialog); accept/decline tests override it.
      server: {
        getClientCapabilities: jest.fn().mockReturnValue({}),
      },
    };

    ctx = mcpTestCtx(undefined, { elicitInput });
    tool.register(server as any);
  });

  it("should register 6 tools", () => {
    // get_portfolio_summary, list_investment_transactions, list_capital_gains,
    // lookup_securities, manage_securities, manage_investment_transactions.
    expect(server.registerTool).toHaveBeenCalledTimes(6);
  });

  describe("get_portfolio_summary", () => {
    it("should return error when no user context", async () => {
      ctx.setUser(undefined);
      const result = await handlers["get_portfolio_summary"]({}, ctx);
      expect(result.isError).toBe(true);
    });

    it("should return portfolio summary via shared getLlmSummary", async () => {
      ctx.setUser({ userId: "u1", scopes: "read" });
      portfolioService.getLlmSummary.mockResolvedValue({
        holdingCount: 2,
        totalPortfolioValue: 10000,
        totalGainLoss: 500,
        holdings: [],
        allocation: [],
      });

      const result = await handlers["get_portfolio_summary"]({}, ctx);
      expect(portfolioService.getLlmSummary).toHaveBeenCalledWith(
        "u1",
        undefined,
        { includeLookThrough: false },
      );
      const parsed = result.structuredContent as any;
      expect(parsed.totalPortfolioValue).toBe(10000);
      expect(parsed.totalGainLoss).toBe(500);
    });

    it("resolves accountNames and passes the ids to getLlmSummary", async () => {
      ctx.setUser({ userId: "u1", scopes: "read" });
      accountsService.resolveAccountFilter.mockResolvedValue({
        accountIds: ["acc-1"],
      });
      portfolioService.getLlmSummary.mockResolvedValue({
        holdingCount: 0,
        totalPortfolioValue: 0,
        totalGainLoss: 0,
        holdings: [],
        allocation: [],
      });

      await handlers["get_portfolio_summary"]({ accountNames: ["RRSP"] }, ctx);
      expect(accountsService.resolveAccountFilter).toHaveBeenCalledWith("u1", [
        "RRSP",
      ]);
      expect(portfolioService.getLlmSummary).toHaveBeenCalledWith(
        "u1",
        ["acc-1"],
        { includeLookThrough: false },
      );
    });

    it("returns the country and asset-class look-through when asked", async () => {
      ctx.setUser({ userId: "u1", scopes: "read" });
      portfolioService.getLlmSummary.mockResolvedValue({
        holdingCount: 1,
        totalPortfolioValue: 1000,
        totalGainLoss: 0,
        holdings: [],
        allocation: [],
        lookThrough: {
          totalPortfolioValue: 1000,
          byCountry: {
            items: [{ name: "United States", value: 750, percentage: 75 }],
            unclassifiedValue: 250,
            unclassifiedPercentage: 25,
          },
          byAssetClass: {
            items: [{ name: "Equity", value: 600, percentage: 60 }],
            unclassifiedValue: 400,
            unclassifiedPercentage: 40,
          },
        },
      });

      const result = await handlers["get_portfolio_summary"](
        { includeLookThrough: true },
        ctx,
      );

      expect(portfolioService.getLlmSummary).toHaveBeenCalledWith(
        "u1",
        undefined,
        { includeLookThrough: true },
      );
      const parsed = result.structuredContent as any;
      expect(parsed.lookThrough.byCountry.items[0].name).toBe("United States");
      expect(parsed.lookThrough.byAssetClass.items[0].name).toBe("Equity");
      expect(parsed.lookThrough.byAssetClass.unclassifiedValue).toBe(400);
    });

    it("returns error when getLlmSummary throws", async () => {
      ctx.setUser({ userId: "u1", scopes: "read" });
      portfolioService.getLlmSummary.mockRejectedValue(new Error("fail"));
      const result = await handlers["get_portfolio_summary"]({}, ctx);
      expect(result.isError).toBe(true);
    });

    it("surfaces the resolver's did-you-mean error for an unknown account", async () => {
      ctx.setUser({ userId: "u1", scopes: "read" });
      accountsService.resolveAccountFilter.mockResolvedValue({
        error: "Unknown account: Foo. Did you mean 'RRSP'?",
      });

      const result = await handlers["get_portfolio_summary"](
        { accountNames: ["Foo"] },
        ctx,
      );
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("Unknown account: Foo");
      expect(portfolioService.getLlmSummary).not.toHaveBeenCalled();
    });
  });

  describe("list_investment_transactions", () => {
    it("returns error when no user context", async () => {
      ctx.setUser(undefined);
      const result = await handlers["list_investment_transactions"]({}, ctx);
      expect(result.isError).toBe(true);
    });

    it("delegates to shared getLlmInvestmentTransactions with all filters", async () => {
      ctx.setUser({ userId: "u1", scopes: "read" });
      investmentTransactionsService.getLlmInvestmentTransactions.mockResolvedValue(
        {
          transactionCount: 2,
          totalAmount: 1000,
          totalCommission: 9.99,
          incomeByCurrency: {},
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
              incomeByCurrency: {},
            },
          ],
          transactions: [],
          truncatedTransactionList: false,
        },
      );

      accountsService.resolveAccountFilter.mockResolvedValue({
        accountIds: ["acc-1"],
      });

      const result = await handlers["list_investment_transactions"](
        {
          startDate: "2026-01-01",
          endDate: "2026-03-31",
          accountNames: ["RRSP"],
          symbols: ["AAPL"],
          actions: ["BUY"],
          groupBy: "security",
        },
        ctx,
      );

      expect(accountsService.resolveAccountFilter).toHaveBeenCalledWith("u1", [
        "RRSP",
      ]);
      expect(
        investmentTransactionsService.getLlmInvestmentTransactions,
      ).toHaveBeenCalledWith("u1", {
        startDate: "2026-01-01",
        endDate: "2026-03-31",
        accountIds: ["acc-1"],
        symbols: ["AAPL"],
        actions: ["BUY"],
        groupBy: "security",
      });
      const parsed = result.structuredContent as any;
      expect(parsed.transactionCount).toBe(2);
      expect(parsed.groupedBy).toBe("security");
      expect(parsed.groups[0].key).toBe("AAPL");
    });

    it("defaults groupBy to 'security' and leaves other filters undefined when no args provided", async () => {
      ctx.setUser({ userId: "u1", scopes: "read" });
      investmentTransactionsService.getLlmInvestmentTransactions.mockResolvedValue(
        {
          transactionCount: 0,
          totalAmount: 0,
          totalCommission: 0,
          incomeByCurrency: {},
          totalQuantity: 0,
          actionCounts: {},
          groupedBy: null,
          groups: null,
          transactions: [],
          truncatedTransactionList: false,
        },
      );

      await handlers["list_investment_transactions"]({}, ctx);

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
      ctx.setUser({ userId: "u1", scopes: "read" });
      investmentTransactionsService.getLlmInvestmentTransactions.mockRejectedValue(
        new Error("boom"),
      );

      const result = await handlers["list_investment_transactions"]({}, ctx);
      expect(result.isError).toBe(true);
    });
  });

  describe("list_capital_gains", () => {
    it("returns error when no user context", async () => {
      ctx.setUser(undefined);
      const result = await handlers["list_capital_gains"](
        { startDate: "2024-01-01", endDate: "2024-12-31" },
        ctx,
      );
      expect(result.isError).toBe(true);
    });

    it("delegates to shared getLlmCapitalGains with all filters", async () => {
      ctx.setUser({ userId: "u1", scopes: "read" });
      investmentTransactionsService.getLlmCapitalGains.mockResolvedValue({
        startDate: "2024-01-01",
        endDate: "2024-12-31",
        totals: {
          realizedGain: 50,
          unrealizedGain: 100,
          totalCapitalGain: 150,
          currency: "CAD",
          fxComplete: true,
          missingRatePairs: [],
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

      accountsService.resolveAccountFilter.mockResolvedValue({
        accountIds: ["acc-1"],
      });

      const result = await handlers["list_capital_gains"](
        {
          startDate: "2024-01-01",
          endDate: "2024-12-31",
          accountNames: ["RRSP"],
          symbols: ["AAA"],
          groupBy: "security",
        },
        ctx,
      );

      expect(accountsService.resolveAccountFilter).toHaveBeenCalledWith("u1", [
        "RRSP",
      ]);
      expect(
        investmentTransactionsService.getLlmCapitalGains,
      ).toHaveBeenCalledWith("u1", {
        startDate: "2024-01-01",
        endDate: "2024-12-31",
        accountIds: ["acc-1"],
        symbols: ["AAA"],
        groupBy: "security",
      });
      const parsed = result.structuredContent as any;
      expect(parsed.totals.totalCapitalGain).toBe(150);
      expect(parsed.entries[0].symbol).toBe("AAA");
    });

    it("defaults groupBy to 'month' when omitted", async () => {
      ctx.setUser({ userId: "u1", scopes: "read" });
      investmentTransactionsService.getLlmCapitalGains.mockResolvedValue({
        startDate: "2024-01-01",
        endDate: "2024-12-31",
        totals: { realizedGain: 0, unrealizedGain: 0, totalCapitalGain: 0 },
        groupedBy: "month",
        entries: [],
        entryCount: 0,
        truncatedEntryList: false,
      });

      await handlers["list_capital_gains"](
        { startDate: "2024-01-01", endDate: "2024-12-31" },
        ctx,
      );

      expect(
        investmentTransactionsService.getLlmCapitalGains,
      ).toHaveBeenCalledWith(
        "u1",
        expect.objectContaining({ groupBy: "month" }),
      );
    });

    it("returns a safe error on service failure", async () => {
      ctx.setUser({ userId: "u1", scopes: "read" });
      investmentTransactionsService.getLlmCapitalGains.mockRejectedValue(
        new Error("boom"),
      );

      const result = await handlers["list_capital_gains"](
        { startDate: "2024-01-01", endDate: "2024-12-31" },
        ctx,
      );
      expect(result.isError).toBe(true);
    });
  });

  describe("lookup_securities", () => {
    it("takes its text as `search` and asks the service by query", async () => {
      // The field is named `search` like every other read tool's text filter.
      // A security scanner flags a parameter named `query` as a SQL-injection
      // shape; nothing here builds SQL, but one name across the read tools is
      // better than an exception to explain.
      ctx.setUser({ userId: "u1", scopes: "read" });
      securitiesService.lookupSecuritiesForLlm.mockResolvedValue({
        query: "apple",
        count: 0,
        candidates: [],
      });

      await handlers["lookup_securities"]({ search: "apple" }, ctx);

      expect(securitiesService.lookupSecuritiesForLlm).toHaveBeenCalledWith(
        "u1",
        { query: "apple", exchange: undefined, provider: undefined },
      );
    });
  });

  describe("manage_securities", () => {
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

    const createArgs = { operation: "create", items: [{ query: "AAPL" }] };

    beforeEach(() => {
      securityPrepService.prepareCreateSecuritySingle.mockResolvedValue(
        securityPreview,
      );
      securityPrepService.prepareUpdateSecuritySingle.mockResolvedValue({
        securityId: "sec-1",
        symbol: "AAPL",
        name: "Apple Inc.",
        securityType: "STOCK",
        exchange: "NASDAQ",
        currencyCode: "USD",
        isFavourite: true,
      });
      securityPrepService.prepareDeleteSecuritySingle.mockResolvedValue({
        securityId: "sec-1",
        symbol: "AAPL",
        name: "Apple Inc.",
      });
      securitiesService.create.mockResolvedValue({
        id: "sec-1",
        symbol: "AAPL",
        name: "Apple Inc.",
      });
      securitiesService.update.mockResolvedValue({
        id: "sec-1",
        symbol: "AAPL",
        name: "Apple Inc.",
      });
    });

    describe("list", () => {
      const held = {
        symbol: "XCNS",
        name: "iShares Core Conservative Balanced ETF Portfolio",
        securityType: "ETF",
        exchange: "TSX",
        currencyCode: "CAD",
        isFavourite: false,
        quantity: 3728.63344325,
        averageCost: 25.5808,
      };

      it("lists the securities held in the account with only the read scope", async () => {
        ctx.setUser({ userId: "u1", scopes: "read" });
        accountsService.resolveBrokerageByNameOrId.mockResolvedValue({
          match: {
            id: "acc-1",
            name: "CA RRSP - Brokerage",
            currencyCode: "CAD",
          },
          candidates: [],
        });
        securitiesService.listSecuritiesInAccount.mockResolvedValue([held]);

        const result = await handlers["manage_securities"](
          { operation: "list", accountName: "CA RRSP" },
          ctx,
        );

        expect(accountsService.resolveBrokerageByNameOrId).toHaveBeenCalledWith(
          "u1",
          "CA RRSP",
        );
        expect(securitiesService.listSecuritiesInAccount).toHaveBeenCalledWith(
          "u1",
          "acc-1",
        );
        expect(result.structuredContent).toMatchObject({
          operation: "list",
          account: "CA RRSP - Brokerage",
          count: 1,
          securities: [held],
        });
      });

      it("accepts the schema with an empty items array", () => {
        expect(
          configs["manage_securities"].inputSchema.safeParse({
            operation: "list",
            accountName: "CA RRSP",
            items: [],
          }).success,
        ).toBe(true);
      });

      it("accepts blank optional fields a form client sends", () => {
        expect(
          configs["manage_securities"].inputSchema.safeParse({
            operation: "list",
            accountName: "CA RRSP",
            items: [],
            approvalMode: "",
          }).success,
        ).toBe(true);
      });

      it("errors without an accountName", async () => {
        ctx.setUser({ userId: "u1", scopes: "read" });
        const result = await handlers["manage_securities"](
          { operation: "list" },
          ctx,
        );
        expect(result.isError).toBe(true);
        expect(
          securitiesService.listSecuritiesInAccount,
        ).not.toHaveBeenCalled();
      });

      it("errors on an unknown account", async () => {
        ctx.setUser({ userId: "u1", scopes: "read" });
        accountsService.resolveBrokerageByNameOrId.mockResolvedValue({
          match: undefined,
          candidates: [],
        });
        const result = await handlers["manage_securities"](
          { operation: "list", accountName: "Nope" },
          ctx,
        );
        expect(result.isError).toBe(true);
        expect(
          securitiesService.listSecuritiesInAccount,
        ).not.toHaveBeenCalled();
      });

      it("errors on an ambiguous account naming the candidates", async () => {
        ctx.setUser({ userId: "u1", scopes: "read" });
        accountsService.resolveBrokerageByNameOrId.mockResolvedValue({
          match: undefined,
          candidates: [
            { id: "a", name: "RRSP - Brokerage" },
            { id: "b", name: "RRSP - Brokerage" },
          ],
        });
        const result = await handlers["manage_securities"](
          { operation: "list", accountName: "RRSP" },
          ctx,
        );
        expect(result.isError).toBe(true);
      });
    });

    it("requires items for a write operation", async () => {
      ctx.setUser({ userId: "u1", scopes: "write" });
      const result = await handlers["manage_securities"](
        { operation: "create" },
        ctx,
      );
      expect(result.isError).toBe(true);
    });

    it("returns error when no user context", async () => {
      ctx.setUser(undefined);
      const result = await handlers["manage_securities"](createArgs, ctx);
      expect(result.isError).toBe(true);
    });

    it("requires the write scope", async () => {
      ctx.setUser({ userId: "u1", scopes: "read" });
      const result = await handlers["manage_securities"](createArgs, ctx);
      expect(result.isError).toBe(true);
      expect(
        securityPrepService.prepareCreateSecuritySingle,
      ).not.toHaveBeenCalled();
    });

    it("returns a dry-run preview without persisting", async () => {
      ctx.setUser({ userId: "u1", scopes: "write" });
      securityPrepService.prepareCreateSecurities.mockResolvedValue({
        okPreviews: [securityPreview],
        okRows: [],
        previewRows: [{ status: "ok", symbol: "AAPL" }],
        okIndex: [0],
        skipped: [],
      });

      const result = await handlers["manage_securities"](
        { ...createArgs, dryRun: true },
        ctx,
      );

      expect(securitiesService.create).not.toHaveBeenCalled();
      const parsed = result.structuredContent as any;
      expect(parsed.dryRun).toBe(true);
      expect(parsed.operation).toBe("create");
    });

    it("creates a single security when the client cannot elicit", async () => {
      ctx.setUser({ userId: "u1", scopes: "write" });

      const result = await handlers["manage_securities"](createArgs, ctx);

      expect(securitiesService.create).toHaveBeenCalledWith(
        "u1",
        expect.objectContaining({ symbol: "AAPL", name: "Apple Inc." }),
      );
      const parsed = result.structuredContent as any;
      expect(parsed.id).toBe("sec-1");
    });

    it("updates a single security on success", async () => {
      ctx.setUser({ userId: "u1", scopes: "write" });
      const result = await handlers["manage_securities"](
        { operation: "update", items: [{ symbol: "AAPL", isFavourite: true }] },
        ctx,
      );
      expect(securitiesService.update).toHaveBeenCalledWith(
        "u1",
        "sec-1",
        expect.objectContaining({ isFavourite: true }),
      );
      const parsed = result.structuredContent as any;
      expect(parsed.count).toBe(1);
    });

    it("forwards a manual asset allocation on update", async () => {
      ctx.setUser({ userId: "u1", scopes: "write" });
      securityPrepService.prepareUpdateSecuritySingle.mockResolvedValue({
        securityId: "sec-1",
        symbol: "VBAL",
        name: "Vanguard Balanced ETF",
        securityType: "ETF",
        exchange: "TSX",
        currencyCode: "CAD",
        isFavourite: false,
        countryWeightings: null,
        // The prep service has already converted percentages to decimals.
        assetWeightings: [
          { name: "Equity", weight: 0.6 },
          { name: "Fixed Income", weight: 0.4 },
        ],
      });

      await handlers["manage_securities"](
        {
          operation: "update",
          items: [
            {
              symbol: "VBAL",
              assetWeightings: [
                { name: "Equity", weight: 60 },
                { name: "Fixed Income", weight: 40 },
              ],
            },
          ],
        },
        ctx,
      );

      // The tool passes the row through to the shared prep service...
      expect(
        securityPrepService.prepareUpdateSecuritySingle,
      ).toHaveBeenCalledWith(
        "u1",
        expect.objectContaining({
          assetWeightings: [
            { name: "Equity", weight: 60 },
            { name: "Fixed Income", weight: 40 },
          ],
        }),
      );
      // ...and commits the resolved decimals.
      expect(securitiesService.update).toHaveBeenCalledWith(
        "u1",
        "sec-1",
        expect.objectContaining({
          assetWeightings: [
            { name: "Equity", weight: 0.6 },
            { name: "Fixed Income", weight: 0.4 },
          ],
        }),
      );
    });

    it("deletes a single security on success", async () => {
      ctx.setUser({ userId: "u1", scopes: "write" });
      const result = await handlers["manage_securities"](
        { operation: "delete", items: [{ symbol: "AAPL" }] },
        ctx,
      );
      expect(securitiesService.remove).toHaveBeenCalledWith("u1", "sec-1");
      const parsed = result.structuredContent as any;
      expect(parsed.deleted).toBe(true);
    });

    it("surfaces a 4xx lookup failure to the caller", async () => {
      ctx.setUser({ userId: "u1", scopes: "write" });
      securityPrepService.prepareCreateSecuritySingle.mockRejectedValue(
        new BadRequestException('No security found matching "ZZZZ".'),
      );

      const result = await handlers["manage_securities"](
        { operation: "create", items: [{ query: "ZZZZ" }] },
        ctx,
      );

      expect(result.isError).toBe(true);
      expect(securitiesService.create).not.toHaveBeenCalled();
    });

    it("shows the web-chat card via relay instead of persisting", async () => {
      ctx.setUser({ userId: "u1", scopes: "write" });
      relayService.emitPendingAction.mockResolvedValue(true);

      const result = await handlers["manage_securities"](createArgs, ctx);

      expect(relayService.emitPendingAction).toHaveBeenCalled();
      expect(securitiesService.create).not.toHaveBeenCalled();
      const parsed = result.structuredContent as any;
      expect(parsed.status).toBe("preview_shown");
    });

    it("creates multiple securities as one bulk card via confirmation", async () => {
      ctx.setUser({ userId: "u1", scopes: "write" });
      securityPrepService.prepareCreateSecurities.mockResolvedValue({
        okPreviews: [securityPreview, { ...securityPreview, symbol: "MSFT" }],
        okRows: [{ symbol: "AAPL" }, { symbol: "MSFT" }],
        previewRows: [
          { status: "ok", symbol: "AAPL" },
          { status: "ok", symbol: "MSFT" },
        ],
        okIndex: [0, 1],
        skipped: [],
      });

      const result = await handlers["manage_securities"](
        { operation: "create", items: [{ query: "AAPL" }, { query: "MSFT" }] },
        ctx,
      );

      expect(actionBuilderRef.buildBatchActions).toHaveBeenCalledWith(
        "u1",
        "create_security",
        expect.any(Array),
        expect.any(Array),
      );
      expect(securitiesService.create).toHaveBeenCalledTimes(2);
      const parsed = result.structuredContent as any;
      expect(parsed.count).toBe(2);
    });

    it("bulk-updates multiple securities via confirmation", async () => {
      ctx.setUser({ userId: "u1", scopes: "write" });
      securityPrepService.prepareUpdateSecurities.mockResolvedValue({
        okPreviews: [
          {
            securityId: "s1",
            symbol: "AAPL",
            name: "Apple",
            securityType: "ETF",
            exchange: "NYSE",
            currencyCode: "USD",
            isFavourite: true,
          },
          {
            securityId: "s2",
            symbol: "MSFT",
            name: "Microsoft",
            securityType: "ETF",
            exchange: "NYSE",
            currencyCode: "USD",
            isFavourite: true,
          },
        ],
        okRows: [
          {
            securityId: "s1",
            securityType: "ETF",
            exchange: "NYSE",
            currencyCode: "USD",
            isFavourite: true,
          },
          {
            securityId: "s2",
            securityType: "ETF",
            exchange: "NYSE",
            currencyCode: "USD",
            isFavourite: true,
          },
        ],
        previewRows: [
          { status: "ok", symbol: "AAPL" },
          { status: "ok", symbol: "MSFT" },
        ],
        okIndex: [0, 1],
        skipped: [],
      });

      const result = await handlers["manage_securities"](
        {
          operation: "update",
          items: [
            { symbol: "AAPL", isFavourite: true },
            { symbol: "MSFT", isFavourite: true },
          ],
        },
        ctx,
      );

      expect(securitiesService.update).toHaveBeenCalledTimes(2);
      expect((result.structuredContent as any).count).toBe(2);
    });

    it("bulk-deletes multiple securities via confirmation", async () => {
      ctx.setUser({ userId: "u1", scopes: "write" });
      securityPrepService.prepareDeleteSecurities.mockResolvedValue({
        okPreviews: [
          { securityId: "s1", symbol: "AAPL", name: "Apple" },
          { securityId: "s2", symbol: "MSFT", name: "Microsoft" },
        ],
        okRows: [{ securityId: "s1" }, { securityId: "s2" }],
        previewRows: [
          { status: "ok", symbol: "AAPL" },
          { status: "ok", symbol: "MSFT" },
        ],
        okIndex: [0, 1],
        skipped: [],
      });

      const result = await handlers["manage_securities"](
        {
          operation: "delete",
          items: [{ symbol: "AAPL" }, { symbol: "MSFT" }],
        },
        ctx,
      );

      expect(securitiesService.remove).toHaveBeenCalledTimes(2);
      expect((result.structuredContent as any).count).toBe(2);
    });

    it("individual mode commits one security card per item (non-relay)", async () => {
      ctx.setUser({ userId: "u1", scopes: "write" });
      securityPrepService.prepareCreateSecurities.mockResolvedValue({
        okPreviews: [securityPreview, { ...securityPreview, symbol: "MSFT" }],
        okRows: [{ symbol: "AAPL" }, { symbol: "MSFT" }],
        previewRows: [
          { status: "ok", symbol: "AAPL" },
          { status: "ok", symbol: "MSFT" },
        ],
        okIndex: [0, 1],
        skipped: [],
      });

      const result = await handlers["manage_securities"](
        {
          operation: "create",
          items: [{ query: "AAPL" }, { query: "MSFT" }],
          approvalMode: "individual",
        },
        ctx,
      );

      expect(securitiesService.create).toHaveBeenCalledTimes(2);
      expect((result.structuredContent as any).count).toBe(2);
    });

    it("individual mode updates each security (non-relay commit)", async () => {
      ctx.setUser({ userId: "u1", scopes: "write" });
      securityPrepService.prepareUpdateSecurities.mockResolvedValue({
        okPreviews: [
          {
            securityId: "s1",
            symbol: "AAPL",
            name: "Apple",
            securityType: "ETF",
            exchange: "NYSE",
            currencyCode: "USD",
            isFavourite: true,
          },
          {
            securityId: "s2",
            symbol: "MSFT",
            name: "Microsoft",
            securityType: "ETF",
            exchange: "NYSE",
            currencyCode: "USD",
            isFavourite: true,
          },
        ],
        okRows: [],
        previewRows: [
          { status: "ok", symbol: "AAPL" },
          { status: "ok", symbol: "MSFT" },
        ],
        okIndex: [0, 1],
        skipped: [],
      });

      await handlers["manage_securities"](
        {
          operation: "update",
          items: [
            { symbol: "AAPL", isFavourite: true },
            { symbol: "MSFT", isFavourite: true },
          ],
          approvalMode: "individual",
        },
        ctx,
      );
      expect(securitiesService.update).toHaveBeenCalledTimes(2);
    });

    it("individual mode deletes each security (non-relay commit)", async () => {
      ctx.setUser({ userId: "u1", scopes: "write" });
      securityPrepService.prepareDeleteSecurities.mockResolvedValue({
        okPreviews: [
          { securityId: "s1", symbol: "AAPL", name: "Apple" },
          { securityId: "s2", symbol: "MSFT", name: "Microsoft" },
        ],
        okRows: [],
        previewRows: [
          { status: "ok", symbol: "AAPL" },
          { status: "ok", symbol: "MSFT" },
        ],
        okIndex: [0, 1],
        skipped: [],
      });

      await handlers["manage_securities"](
        {
          operation: "delete",
          items: [{ symbol: "AAPL" }, { symbol: "MSFT" }],
          approvalMode: "individual",
        },
        ctx,
      );
      expect(securitiesService.remove).toHaveBeenCalledTimes(2);
    });

    it("declines a single update without writing", async () => {
      ctx.setUser({ userId: "u1", scopes: "write" });
      server.server.getClientCapabilities.mockReturnValue({
        elicitation: { form: {} },
      });
      elicitInput.mockResolvedValue({ action: "decline" });

      const result = await handlers["manage_securities"](
        { operation: "update", items: [{ symbol: "AAPL", isFavourite: true }] },
        ctx,
      );
      expect(securitiesService.update).not.toHaveBeenCalled();
      expect(result.isError).toBe(true);
    });

    it("single update/delete go through the relay when relayed", async () => {
      ctx.setUser({ userId: "u1", scopes: "write" });
      relayService.emitPendingAction.mockResolvedValue(true);

      const upd = await handlers["manage_securities"](
        { operation: "update", items: [{ symbol: "AAPL", isFavourite: true }] },
        ctx,
      );
      const del = await handlers["manage_securities"](
        { operation: "delete", items: [{ symbol: "AAPL" }] },
        ctx,
      );
      expect(securitiesService.update).not.toHaveBeenCalled();
      expect(securitiesService.remove).not.toHaveBeenCalled();
      expect((upd.structuredContent as any).status).toBe("preview_shown");
      expect((del.structuredContent as any).status).toBe("preview_shown");
    });

    it("bulk update/delete go through the relay when relayed", async () => {
      ctx.setUser({ userId: "u1", scopes: "write" });
      relayService.emitPendingAction.mockResolvedValue(true);
      const okPrev = {
        okPreviews: [
          {
            securityId: "s1",
            symbol: "AAPL",
            name: "Apple",
            securityType: "ETF",
            exchange: "NYSE",
            currencyCode: "USD",
            isFavourite: true,
          },
          {
            securityId: "s2",
            symbol: "MSFT",
            name: "MS",
            securityType: "ETF",
            exchange: "NYSE",
            currencyCode: "USD",
            isFavourite: true,
          },
        ],
        okRows: [{ securityId: "s1" }, { securityId: "s2" }],
        previewRows: [{ status: "ok" }, { status: "ok" }],
        okIndex: [0, 1],
        skipped: [{ index: 2, reason: "x" }],
      };
      securityPrepService.prepareUpdateSecurities.mockResolvedValue(okPrev);
      securityPrepService.prepareDeleteSecurities.mockResolvedValue(okPrev);

      const upd = await handlers["manage_securities"](
        {
          operation: "update",
          items: [{ symbol: "AAPL" }, { symbol: "MSFT" }],
        },
        ctx,
      );
      const del = await handlers["manage_securities"](
        {
          operation: "delete",
          items: [{ symbol: "AAPL" }, { symbol: "MSFT" }],
        },
        ctx,
      );
      expect(securitiesService.update).not.toHaveBeenCalled();
      expect(securitiesService.remove).not.toHaveBeenCalled();
      expect((upd.structuredContent as any).status).toBe("preview_shown");
      expect((del.structuredContent as any).status).toBe("preview_shown");
    });

    it("dry-run previews update and delete without writing", async () => {
      ctx.setUser({ userId: "u1", scopes: "write" });
      securityPrepService.prepareUpdateSecurities.mockResolvedValue({
        okPreviews: [],
        okRows: [],
        previewRows: [{ status: "ok", symbol: "AAPL" }],
        okIndex: [],
        skipped: [],
      });
      securityPrepService.prepareDeleteSecurities.mockResolvedValue({
        okPreviews: [],
        okRows: [],
        previewRows: [{ status: "ok", symbol: "AAPL" }],
        okIndex: [],
        skipped: [],
      });

      const upd = await handlers["manage_securities"](
        {
          operation: "update",
          items: [{ symbol: "AAPL", isFavourite: true }],
          dryRun: true,
        },
        ctx,
      );
      const del = await handlers["manage_securities"](
        { operation: "delete", items: [{ symbol: "AAPL" }], dryRun: true },
        ctx,
      );

      expect(securitiesService.update).not.toHaveBeenCalled();
      expect(securitiesService.remove).not.toHaveBeenCalled();
      expect((upd.structuredContent as any).operation).toBe("update");
      expect((del.structuredContent as any).operation).toBe("delete");
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
      ctx.setUser(undefined);
      const result = await handlers["manage_investment_transactions"](
        createArgs,
        ctx,
      );
      expect(result.isError).toBe(true);
    });

    it("requires the write scope", async () => {
      ctx.setUser({ userId: "u1", scopes: "read" });
      const result = await handlers["manage_investment_transactions"](
        createArgs,
        ctx,
      );
      expect(result.isError).toBe(true);
      expect(
        investmentTransactionsService.prepareCreateInvestmentSingle,
      ).not.toHaveBeenCalled();
    });

    it("creates a single transaction (name resolved internally) when the client cannot elicit", async () => {
      ctx.setUser({ userId: "u1", scopes: "write" });
      investmentTransactionsService.prepareCreateInvestmentSingle.mockResolvedValue(
        createPreview,
      );
      investmentTransactionsService.create.mockResolvedValue({
        id: "inv-1",
        transactionDate: "2026-01-15",
      });

      const result = await handlers["manage_investment_transactions"](
        createArgs,
        ctx,
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
      const parsed = result.structuredContent as any;
      expect(parsed.id).toBe("inv-1");
      expect(parsed.count).toBe(1);
    });

    it("forwards the series code to the prep and the resolved series to the write (INV-BOND-007)", async () => {
      ctx.setUser({ userId: "u1", scopes: "write" });
      investmentTransactionsService.prepareCreateInvestmentSingle.mockResolvedValue(
        {
          ...createPreview,
          bondInstrumentId: "11111111-1111-5111-8111-111111111111",
          bondSeriesCode: "EDO1036",
        },
      );
      investmentTransactionsService.create.mockResolvedValue({
        id: "inv-1",
        transactionDate: "2026-01-15",
      });

      await handlers["manage_investment_transactions"](
        {
          operation: "create",
          items: [{ ...createArgs.items[0], bondSeriesCode: "EDO1036" }],
        },
        ctx,
      );

      expect(
        investmentTransactionsService.prepareCreateInvestmentSingle,
      ).toHaveBeenCalledWith(
        "u1",
        expect.objectContaining({ bondSeriesCode: "EDO1036" }),
      );
      expect(investmentTransactionsService.create).toHaveBeenCalledWith(
        "u1",
        expect.objectContaining({
          bondInstrumentId: "11111111-1111-5111-8111-111111111111",
        }),
      );
    });

    it("sends no series for a row that is not a bond", async () => {
      ctx.setUser({ userId: "u1", scopes: "write" });
      investmentTransactionsService.prepareCreateInvestmentSingle.mockResolvedValue(
        createPreview,
      );
      investmentTransactionsService.create.mockResolvedValue({
        id: "inv-1",
        transactionDate: "2026-01-15",
      });
      await handlers["manage_investment_transactions"](createArgs, ctx);
      expect(
        investmentTransactionsService.create.mock.calls[0][1].bondInstrumentId,
      ).toBeUndefined();
    });

    it("forwards an explicit exchangeRate to the create prep (issue #744)", async () => {
      ctx.setUser({ userId: "u1", scopes: "write" });
      investmentTransactionsService.prepareCreateInvestmentSingle.mockResolvedValue(
        createPreview,
      );
      investmentTransactionsService.create.mockResolvedValue({
        id: "inv-1",
        transactionDate: "2026-01-15",
      });

      await handlers["manage_investment_transactions"](
        {
          operation: "create",
          items: [{ ...createArgs.items[0], exchangeRate: 4.2514 }],
        },
        ctx,
      );

      expect(
        investmentTransactionsService.prepareCreateInvestmentSingle,
      ).toHaveBeenCalledWith(
        "u1",
        expect.objectContaining({ exchangeRate: 4.2514 }),
      );
    });

    it("surfaces an unknown-account error from the single create prep", async () => {
      ctx.setUser({ userId: "u1", scopes: "write" });
      investmentTransactionsService.prepareCreateInvestmentSingle.mockRejectedValue(
        new BadRequestException("Unknown account: Nope."),
      );

      const result = await handlers["manage_investment_transactions"](
        createArgs,
        ctx,
      );
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("Unknown account");
    });

    it("shows a relay card for a single create without writing", async () => {
      ctx.setUser({ userId: "u1", scopes: "write" });
      relayService.emitPendingAction.mockResolvedValue(true);
      investmentTransactionsService.prepareCreateInvestmentSingle.mockResolvedValue(
        createPreview,
      );

      const result = await handlers["manage_investment_transactions"](
        createArgs,
        ctx,
      );

      expect(relayService.emitPendingAction).toHaveBeenCalled();
      expect(investmentTransactionsService.create).not.toHaveBeenCalled();
      const parsed = result.structuredContent as any;
      expect(parsed.status).toBe("preview_shown");
    });

    it("does not create a single transaction when the confirmation is declined", async () => {
      ctx.setUser({ userId: "u1", scopes: "write" });
      server.server.getClientCapabilities.mockReturnValue({
        elicitation: { form: {} },
      });
      elicitInput.mockResolvedValue({ action: "decline" });
      investmentTransactionsService.prepareCreateInvestmentSingle.mockResolvedValue(
        createPreview,
      );

      const result = await handlers["manage_investment_transactions"](
        createArgs,
        ctx,
      );

      expect(elicitInput).toHaveBeenCalled();
      expect(investmentTransactionsService.create).not.toHaveBeenCalled();
      expect(result.isError).toBe(true);
    });

    it("blocks a single create when the daily write limit is exhausted", async () => {
      ctx.setUser({ userId: "u1", scopes: "write" });
      investmentTransactionsService.prepareCreateInvestmentSingle.mockResolvedValue(
        createPreview,
      );
      (tool as any).writeLimiter.checkLimit = jest
        .fn()
        .mockResolvedValue({ allowed: false, currentCount: 500, limit: 500 });

      const result = await handlers["manage_investment_transactions"](
        createArgs,
        ctx,
      );
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("Daily write limit");
      expect(investmentTransactionsService.create).not.toHaveBeenCalled();
    });

    it("creates a bulk batch in one card and maps skip indices back", async () => {
      ctx.setUser({ userId: "u1", scopes: "write" });
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
            ...Array.from({ length: 3 }, () => ({
              accountName: "Brokerage",
              action: "BUY",
              date: "2026-01-17",
              security: "AAPL",
              quantity: 1,
              price: 1,
            })),
          ],
        },
        ctx,
      );

      const parsed = result.structuredContent as any;
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
      ctx.setUser({ userId: "u1", scopes: "write" });
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
        ctx,
      );
      expect(result.isError).toBe(true);
      expect(investmentTransactionsService.createBulk).not.toHaveBeenCalled();
    });

    it("emits individual cards for a bulk create in individual mode (relay)", async () => {
      ctx.setUser({ userId: "u1", scopes: "write" });
      relayService.emitPendingAction.mockResolvedValue(true);
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
        ctx,
      );

      // One card per ok row, all emitted to the web chat.
      expect(relayService.emitPendingAction).toHaveBeenCalledTimes(2);
      const parsed = result.structuredContent as any;
      expect(parsed.status).toBe("preview_shown");
    });

    describe("a bond REDEEM (R2-1, R2-3, R2-6)", () => {
      const SERIES = "11111111-1111-5111-8111-111111111111";
      const split = {
        principal: 1000,
        interest: 470.5,
        deduction: 0,
        payout: 1470.5,
        outcome: "filled" as const,
      };
      const redeemPreview = {
        ...createPreview,
        action: "REDEEM",
        transactionDate: "2023-04-01",
        symbol: "EDO",
        securityName: "EDO bonds",
        securityCurrency: "PLN",
        quantity: 10,
        price: 100,
        totalAmount: 1000,
        cashAmount: 1470.5,
        accruedInterest: 47.05,
        bondInstrumentId: SERIES,
        bondSeriesCode: "EDO0423",
        redemptionSplit: split,
      };
      const redeemArgs = {
        operation: "create",
        items: [
          {
            accountName: "Brokerage",
            action: "REDEEM",
            date: "2023-04-01",
            security: "EDO",
            quantity: 10,
          },
        ],
      };

      it("rejects an empty or blank series code, as the assistant's schema does, and trims a padded one", () => {
        const schema = configs["manage_investment_transactions"].inputSchema;
        const withCode = (bondSeriesCode: string) =>
          schema.safeParse({
            operation: "create",
            items: [{ ...redeemArgs.items[0], bondSeriesCode }],
          });
        expect(withCode("").success).toBe(false);
        expect(withCode("   ").success).toBe(false);
        expect(withCode("x".repeat(41)).success).toBe(false);
        const padded = withCode("  EDO0423 ");
        expect(padded.success).toBe(true);
        expect(padded.data.items[0].bondSeriesCode).toBe("EDO0423");
      });

      it("writes the accrued interest the card showed (single create)", async () => {
        ctx.setUser({ userId: "u1", scopes: "write" });
        investmentTransactionsService.prepareCreateInvestmentSingle.mockResolvedValue(
          redeemPreview,
        );
        investmentTransactionsService.create.mockResolvedValue({
          id: "inv-1",
          transactionDate: "2023-04-01",
        });
        await handlers["manage_investment_transactions"](redeemArgs, ctx);
        expect(investmentTransactionsService.create).toHaveBeenCalledWith(
          "u1",
          expect.objectContaining({
            action: "REDEEM",
            price: 100,
            accruedInterest: 47.05,
          }),
        );
      });

      it("writes the accrued interest of every row (bulk create)", async () => {
        ctx.setUser({ userId: "u1", scopes: "write" });
        investmentTransactionsService.prepareCreateInvestmentBulk.mockResolvedValue(
          {
            okPreviews: Array(6).fill(redeemPreview),
            okIndex: [0, 1, 2, 3, 4, 5],
            previewRows: Array(6).fill({ status: "ok" }),
            skipped: [],
          },
        );
        investmentTransactionsService.createBulk.mockResolvedValue({
          created: Array(6).fill({ id: "i1" }),
          skipped: [],
        });
        await handlers["manage_investment_transactions"](
          {
            operation: "create",
            items: Array(6).fill(redeemArgs.items[0]),
          },
          ctx,
        );
        expect(investmentTransactionsService.createBulk).toHaveBeenCalledWith(
          "u1",
          Array(6).fill(
            expect.objectContaining({ price: 100, accruedInterest: 47.05 }),
          ),
        );
      });

      it("writes the accrued interest of an edit (single and bulk update)", async () => {
        ctx.setUser({ userId: "u1", scopes: "write" });
        investmentTransactionsService.previewUpdateInvestmentTransaction.mockResolvedValue(
          { ...redeemPreview, transactionId: "it1" },
        );
        investmentTransactionsService.update.mockResolvedValue({ id: "it1" });
        await handlers["manage_investment_transactions"](
          {
            operation: "update",
            items: [{ transactionId: "it1", accruedInterest: 47.05 }],
          },
          ctx,
        );
        expect(investmentTransactionsService.update).toHaveBeenLastCalledWith(
          "u1",
          "it1",
          expect.objectContaining({ accruedInterest: 47.05 }),
        );

        investmentTransactionsService.prepareUpdateInvestmentBulk.mockResolvedValue(
          {
            okRows: ["it1", "it2", "it3", "it4", "it5", "it6"].map((id) => ({
              ...redeemPreview,
              transactionId: id,
            })),
            okIndex: [0, 1, 2, 3, 4, 5],
            previewRows: [],
            skipped: [],
          },
        );
        await handlers["manage_investment_transactions"](
          {
            operation: "update",
            items: ["it1", "it2", "it3", "it4", "it5", "it6"].map(
              (transactionId) => ({ transactionId, accruedInterest: 47.05 }),
            ),
          },
          ctx,
        );
        expect(investmentTransactionsService.update).toHaveBeenLastCalledWith(
          "u1",
          "it6",
          expect.objectContaining({ accruedInterest: 47.05 }),
        );
      });

      it("shows the series, the interest and the split in the confirmation text, and warns when the figures differ", async () => {
        ctx.setUser({ userId: "u1", scopes: "write" });
        server.server.getClientCapabilities.mockReturnValue({
          elicitation: { form: {} },
        });
        elicitInput.mockResolvedValue({ action: "decline" });
        investmentTransactionsService.prepareCreateInvestmentSingle.mockResolvedValue(
          {
            ...redeemPreview,
            redemptionSplit: { ...split, outcome: "differs" },
          },
        );
        await handlers["manage_investment_transactions"](redeemArgs, ctx);
        const message = elicitInput.mock.calls[0][0].message as string;
        expect(message).toContain("Series: EDO0423");
        expect(message).toContain("Accrued interest: 47.05");
        expect(message).toContain(
          "Redemption split: principal 1000, interest 470.5, deduction 0, payout 1470.5",
        );
        expect(message).toContain("Warning");
      });

      it("describes how the server fills a bond REDEEM in the schema", () => {
        const shape =
          configs["manage_investment_transactions"].inputSchema.shape.items
            .element.shape;
        expect(shape.accruedInterest.description).toMatch(/redemption split/);
      });
    });

    it("updates a single investment transaction", async () => {
      ctx.setUser({ userId: "u1", scopes: "write" });
      investmentTransactionsService.previewUpdateInvestmentTransaction.mockResolvedValue(
        { ...createPreview, transactionId: "it1", action: "SELL" },
      );
      investmentTransactionsService.update.mockResolvedValue({ id: "it1" });

      const result = await handlers["manage_investment_transactions"](
        {
          operation: "update",
          items: [{ transactionId: "it1", action: "SELL", quantity: 5 }],
        },
        ctx,
      );

      expect(
        investmentTransactionsService.previewUpdateInvestmentTransaction,
      ).toHaveBeenCalledWith(
        "u1",
        "it1",
        expect.objectContaining({ action: "SELL", quantity: 5 }),
      );
      expect(investmentTransactionsService.update).toHaveBeenCalled();
      const parsed = result.structuredContent as any;
      expect(parsed.id).toBe("it1");
    });

    it("shows one bulk update card and writes each edit on confirm", async () => {
      ctx.setUser({ userId: "u1", scopes: "write" });
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
            ...Array.from({ length: 4 }, (_, i) => ({
              transactionId: `it${i + 3}`,
              action: "SELL",
            })),
          ],
        },
        ctx,
      );

      expect(
        actionBuilderRef.buildBatchUpdateInvestmentTransactions,
      ).toHaveBeenCalled();
      expect(investmentTransactionsService.update).toHaveBeenCalledTimes(1);
      const parsed = result.structuredContent as any;
      expect(parsed.count).toBe(1);
      expect(parsed.skipped).toEqual([{ index: 1, reason: "not found" }]);
    });

    it("deletes a single investment transaction", async () => {
      ctx.setUser({ userId: "u1", scopes: "write" });
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
        ctx,
      );

      expect(investmentTransactionsService.remove).toHaveBeenCalledWith(
        "u1",
        "it1",
      );
      const parsed = result.structuredContent as any;
      expect(parsed.id).toBe("it1");
      expect(parsed.deleted).toBe(true);
    });

    it("shows one bulk delete card and removes each on confirm", async () => {
      ctx.setUser({ userId: "u1", scopes: "write" });
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
          items: Array.from({ length: 6 }, (_, i) => ({
            transactionId: `it${i + 1}`,
          })),
        },
        ctx,
      );

      expect(
        actionBuilderRef.buildBatchDeleteInvestmentTransactions,
      ).toHaveBeenCalled();
      expect(investmentTransactionsService.remove).toHaveBeenCalledTimes(2);
      const parsed = result.structuredContent as any;
      expect(parsed.count).toBe(2);
    });

    it("errors when no bulk delete row could be prepared", async () => {
      ctx.setUser({ userId: "u1", scopes: "write" });
      investmentTransactionsService.prepareDeleteInvestmentBulk.mockResolvedValue(
        { okRows: [], okIndex: [], previewRows: [], skipped: [] },
      );
      const result = await handlers["manage_investment_transactions"](
        {
          operation: "delete",
          items: [{ transactionId: "it1" }, { transactionId: "it2" }],
        },
        ctx,
      );
      expect(result.isError).toBe(true);
      expect(investmentTransactionsService.remove).not.toHaveBeenCalled();
    });
  });
});
