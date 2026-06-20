import { McpTransactionsTools } from "./transactions.tool";
import { UserContextResolver } from "../mcp-context";

describe("McpTransactionsTools", () => {
  let tool: McpTransactionsTools;
  let transactionsService: Record<string, jest.Mock>;
  let payeesService: Record<string, jest.Mock>;
  let analyticsService: Record<string, jest.Mock>;
  let accountsService: Record<string, jest.Mock>;
  let server: {
    registerTool: jest.Mock;
    server: { getClientCapabilities: jest.Mock; elicitInput: jest.Mock };
  };
  let elicitInput: jest.Mock;
  let relayService: { emitPendingAction: jest.Mock };
  let actionBuilder: Record<string, jest.Mock>;
  let prepService: Record<string, jest.Mock>;
  let resolve: jest.MockedFunction<UserContextResolver>;
  const handlers: Record<string, (...args: any[]) => any> = {};

  beforeEach(() => {
    transactionsService = {
      findAll: jest.fn(),
      getLlmTransactionRows: jest.fn(),
      previewCreate: jest.fn(),
      previewCategorize: jest.fn().mockResolvedValue({
        transactionId: "t1",
        payeeName: "Store",
        amount: -50,
        transactionDate: "2025-01-15",
        accountName: "Checking",
        currentCategoryName: "Uncategorized",
        categoryId: "c1",
        newCategoryName: "Groceries",
      }),
      create: jest.fn(),
      createBulk: jest.fn(),
      update: jest.fn(),
      updateSplits: jest.fn().mockResolvedValue([]),
      remove: jest.fn().mockResolvedValue(undefined),
      removeAny: jest.fn().mockResolvedValue(undefined),
      previewUpdate: jest.fn(),
      previewDelete: jest.fn(),
      createTransfer: jest.fn(),
      updateTransfer: jest.fn(),
    };

    payeesService = {
      findOrCreate: jest.fn().mockResolvedValue({ id: "new-payee-id" }),
      findByName: jest.fn(),
    };

    analyticsService = {
      getTransfersByAccount: jest.fn(),
      getLlmQueryTransactions: jest.fn(),
      getLlmListTransactions: jest.fn(),
      getLlmPeriodComparison: jest.fn(),
      resolveLlmCategoryIds: jest
        .fn()
        .mockResolvedValue({ categoryIds: [], unresolved: [] }),
    };

    accountsService = {
      findAll: jest.fn().mockResolvedValue([]),
    };

    // Default: not serving a relayed prompt, so the tool uses its normal
    // (direct MCP-client) confirmation path and the existing assertions hold.
    relayService = { emitPendingAction: jest.fn().mockReturnValue(false) };
    actionBuilder = {
      buildCreateTransaction: jest
        .fn()
        .mockReturnValue({ type: "create_transaction", preview: {} }),
      buildCreateTransactions: jest
        .fn()
        .mockReturnValue({ type: "create_transactions", preview: {} }),
      buildCategorizeTransaction: jest.fn().mockReturnValue({}),
      buildUpdateTransaction: jest
        .fn()
        .mockReturnValue({ type: "update_transaction", preview: {} }),
      buildDeleteTransaction: jest
        .fn()
        .mockReturnValue({ type: "delete_transaction", preview: {} }),
      buildCreateTransfer: jest
        .fn()
        .mockReturnValue({ type: "create_transfer", preview: {} }),
      buildUpdateTransfer: jest
        .fn()
        .mockReturnValue({ type: "update_transfer", preview: {} }),
      buildBatchActions: jest
        .fn()
        .mockReturnValue({ type: "batch_actions", preview: {} }),
    };
    prepService = {
      prepareCreate: jest.fn(),
      prepareCreateTransfer: jest.fn().mockResolvedValue({
        okPreviews: [],
        okIndex: [],
        previewRows: [],
        skipped: [],
      }),
      prepareCreateSingle: jest.fn(),
      prepareCreateTransferSingle: jest.fn(),
      prepareUpdate: jest.fn(),
      prepareUpdateBulk: jest.fn(),
      prepareDelete: jest.fn(),
      prepareDeleteBulk: jest.fn(),
      transferToBatchRow: jest.fn((p) => p),
    };

    tool = new McpTransactionsTools(
      transactionsService as any,
      payeesService as any,
      analyticsService as any,
      relayService as any,
      actionBuilder as any,
      prepService as any,
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

  it("should register 3 tools", () => {
    expect(server.registerTool).toHaveBeenCalledTimes(3);
  });

  describe("list_transactions", () => {
    const summary = {
      totalIncome: 1000,
      totalExpenses: 200,
      netCashFlow: 800,
      transactionCount: 5,
      groupedBy: "none",
    };

    it("returns error when no user context", async () => {
      resolve.mockReturnValue(undefined);
      const result = await handlers["list_transactions"](
        {},
        { sessionId: "s1" },
      );
      expect(result.isError).toBe(true);
    });

    it("requires read scope", async () => {
      resolve.mockReturnValue({ userId: "u1", scopes: "write" });
      const result = await handlers["list_transactions"](
        {},
        { sessionId: "s1" },
      );
      expect(result.isError).toBe(true);
    });

    it("returns the summary only and omits transactions when includeTransactions is false", async () => {
      resolve.mockReturnValue({ userId: "u1", scopes: "read" });
      analyticsService.getLlmListTransactions.mockResolvedValue(summary);

      const result = await handlers["list_transactions"](
        { startDate: "2026-01-01", endDate: "2026-01-31" },
        { sessionId: "s1" },
      );

      expect(analyticsService.getLlmListTransactions).toHaveBeenCalledWith(
        "u1",
        expect.objectContaining({
          startDate: "2026-01-01",
          endDate: "2026-01-31",
        }),
      );
      expect(transactionsService.getLlmTransactionRows).not.toHaveBeenCalled();
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.totalIncome).toBe(1000);
      expect(parsed.transactions).toBeUndefined();
    });

    it("fills in default dates when omitted", async () => {
      resolve.mockReturnValue({ userId: "u1", scopes: "read" });
      analyticsService.getLlmListTransactions.mockResolvedValue(summary);

      await handlers["list_transactions"]({}, { sessionId: "s1" });

      expect(analyticsService.getLlmListTransactions).toHaveBeenCalledWith(
        "u1",
        expect.objectContaining({
          startDate: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
          endDate: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
        }),
      );
    });

    it("attaches the raw transaction list when includeTransactions is true", async () => {
      resolve.mockReturnValue({ userId: "u1", scopes: "read" });
      analyticsService.getLlmListTransactions.mockResolvedValue(summary);
      transactionsService.getLlmTransactionRows.mockResolvedValue({
        transactions: [
          {
            id: "t1",
            date: "2026-01-15",
            payeeName: "Store",
            amount: -50,
            status: "cleared",
          },
        ],
        total: 1,
        hasMore: true,
      });

      const result = await handlers["list_transactions"](
        {
          startDate: "2026-01-01",
          endDate: "2026-01-31",
          includeTransactions: true,
          limit: 10,
        },
        { sessionId: "s1" },
      );

      expect(transactionsService.getLlmTransactionRows).toHaveBeenCalledWith(
        "u1",
        expect.objectContaining({
          startDate: "2026-01-01",
          endDate: "2026-01-31",
          limit: 10,
        }),
      );
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.transactions).toHaveLength(1);
      expect(parsed.total).toBe(1);
      expect(parsed.hasMore).toBe(true);
      expect(parsed.truncatedTransactionList).toBe(true);
    });

    it("resolves account, category, and payee names to IDs", async () => {
      resolve.mockReturnValue({ userId: "u1", scopes: "read" });
      accountsService.findAll.mockResolvedValue([
        { id: "acc-1", name: "Checking" },
      ]);
      analyticsService.resolveLlmCategoryIds.mockResolvedValue({
        categoryIds: ["cat-1"],
        unresolved: [],
      });
      payeesService.findByName.mockResolvedValue({ id: "payee-1" });
      analyticsService.getLlmListTransactions.mockResolvedValue(summary);

      await handlers["list_transactions"](
        {
          startDate: "2026-01-01",
          endDate: "2026-01-31",
          accountNames: ["Checking"],
          categoryNames: ["Food"],
          payeeNames: ["Costco"],
        },
        { sessionId: "s1" },
      );

      expect(analyticsService.getLlmListTransactions).toHaveBeenCalledWith(
        "u1",
        expect.objectContaining({
          accountIds: ["acc-1"],
          categoryIds: ["cat-1"],
          payeeIds: ["payee-1"],
        }),
      );
    });

    it("errors on an unknown account name", async () => {
      resolve.mockReturnValue({ userId: "u1", scopes: "read" });
      accountsService.findAll.mockResolvedValue([
        { id: "acc-1", name: "Checking" },
      ]);

      const result = await handlers["list_transactions"](
        { accountNames: ["Ghost"] },
        { sessionId: "s1" },
      );

      expect(result.isError).toBe(true);
      expect(analyticsService.getLlmListTransactions).not.toHaveBeenCalled();
      expect(result.content[0].text).toContain("Ghost");
    });

    it("errors on an unknown category name", async () => {
      resolve.mockReturnValue({ userId: "u1", scopes: "read" });
      analyticsService.resolveLlmCategoryIds.mockResolvedValue({
        categoryIds: [],
        unresolved: ["Bogus"],
      });

      const result = await handlers["list_transactions"](
        { categoryNames: ["Bogus"] },
        { sessionId: "s1" },
      );

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("Bogus");
    });

    it("errors on an unknown payee name", async () => {
      resolve.mockReturnValue({ userId: "u1", scopes: "read" });
      payeesService.findByName.mockResolvedValue(null);

      const result = await handlers["list_transactions"](
        { payeeNames: ["Nobody"] },
        { sessionId: "s1" },
      );

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("Nobody");
    });

    it("passes transfersOnly through to the summary", async () => {
      resolve.mockReturnValue({ userId: "u1", scopes: "read" });
      analyticsService.getLlmListTransactions.mockResolvedValue({
        ...summary,
        transfers: {
          accounts: [],
          totalInbound: 0,
          totalOutbound: 0,
          transferCount: 0,
        },
      });

      const result = await handlers["list_transactions"](
        { transfersOnly: true },
        { sessionId: "s1" },
      );

      expect(analyticsService.getLlmListTransactions).toHaveBeenCalledWith(
        "u1",
        expect.objectContaining({ transfersOnly: true }),
      );
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.transfers).toBeDefined();
    });

    it("returns safeToolError when the analytics service throws", async () => {
      resolve.mockReturnValue({ userId: "u1", scopes: "read" });
      analyticsService.getLlmListTransactions.mockRejectedValue(
        new Error("boom"),
      );

      const result = await handlers["list_transactions"](
        { startDate: "2026-01-01", endDate: "2026-01-31" },
        { sessionId: "s1" },
      );

      expect(result.isError).toBe(true);
    });
  });

  describe("compare_periods", () => {
    it("delegates to analyticsService.getLlmPeriodComparison", async () => {
      resolve.mockReturnValue({ userId: "u1", scopes: "read" });
      analyticsService.getLlmPeriodComparison.mockResolvedValue({
        period1: { start: "2025-12-01", end: "2025-12-31", total: 0 },
        period2: { start: "2026-01-01", end: "2026-01-31", total: 0 },
        totalChange: 0,
        totalChangePercent: 0,
        comparison: [],
      });

      await handlers["compare_periods"](
        {
          period1Start: "2025-12-01",
          period1End: "2025-12-31",
          period2Start: "2026-01-01",
          period2End: "2026-01-31",
        },
        { sessionId: "s1" },
      );

      expect(analyticsService.getLlmPeriodComparison).toHaveBeenCalledWith(
        "u1",
        expect.objectContaining({
          period1Start: "2025-12-01",
          period2Start: "2026-01-01",
        }),
      );
    });

    it("fills in all four dates when omitted", async () => {
      resolve.mockReturnValue({ userId: "u1", scopes: "read" });
      analyticsService.getLlmPeriodComparison.mockResolvedValue({
        period1: { start: "", end: "", total: 0 },
        period2: { start: "", end: "", total: 0 },
        totalChange: 0,
        totalChangePercent: 0,
        comparison: [],
      });

      await handlers["compare_periods"]({}, { sessionId: "s1" });

      expect(analyticsService.getLlmPeriodComparison).toHaveBeenCalledWith(
        "u1",
        expect.objectContaining({
          period1Start: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
          period1End: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
          period2Start: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
          period2End: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
        }),
      );
    });
  });

  describe("manage_transactions", () => {
    const stdPreview = {
      accountId: "a1",
      accountName: "Checking",
      amount: -50,
      transactionDate: "2025-01-15",
      payeeId: "p1",
      payeeName: "Store",
      payeeMatched: true,
      payeeWillBeCreated: false,
      categoryId: null,
      categoryName: null,
      description: null,
      currencyCode: "USD",
    };

    it("requires write scope", async () => {
      resolve.mockReturnValue({ userId: "u1", scopes: "read" });
      const result = await handlers["manage_transactions"](
        { operation: "create", items: [{ accountName: "Checking" }] },
        { sessionId: "s1" },
      );
      expect(result.isError).toBe(true);
    });

    it("dryRun previews create rows without writing", async () => {
      resolve.mockReturnValue({ userId: "u1", scopes: "write" });
      prepService.prepareCreate.mockResolvedValue({
        okPreviews: [stdPreview],
        okCreatePayee: [true],
        okIndex: [0],
        previewRows: [{ status: "ok", accountName: "Checking" }],
        skipped: [],
      });

      const result = await handlers["manage_transactions"](
        {
          operation: "create",
          items: [{ accountName: "Checking", amount: -50, date: "2025-01-15" }],
          dryRun: true,
        },
        { sessionId: "s1" },
      );

      expect(transactionsService.create).not.toHaveBeenCalled();
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.dryRun).toBe(true);
      expect(parsed.previews).toHaveLength(1);
    });

    it("creates a single standard transaction when the client cannot elicit", async () => {
      resolve.mockReturnValue({ userId: "u1", scopes: "write" });
      prepService.prepareCreate.mockResolvedValue({
        okPreviews: [stdPreview],
        okCreatePayee: [true],
        okIndex: [0],
        previewRows: [{ status: "ok" }],
        skipped: [],
      });
      transactionsService.create.mockResolvedValue({
        id: "t1",
        transactionDate: "2025-01-15",
      });

      const result = await handlers["manage_transactions"](
        {
          operation: "create",
          items: [{ accountName: "Checking", amount: -50, date: "2025-01-15" }],
        },
        { sessionId: "s1" },
      );

      expect(transactionsService.create).toHaveBeenCalledTimes(1);
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.id).toBe("t1");
      expect(parsed.count).toBe(1);
    });

    it("creates a single transfer when the item carries toAccountName", async () => {
      resolve.mockReturnValue({ userId: "u1", scopes: "write" });
      const xferPreview = {
        fromAccountId: "a1",
        fromAccountName: "Checking",
        fromCurrencyCode: "USD",
        toAccountId: "a2",
        toAccountName: "Savings",
        toCurrencyCode: "USD",
        amount: 100,
        toAmount: 100,
        exchangeRate: 1,
        transactionDate: "2025-01-15",
        description: null,
        payeeName: "Shared rent",
      };
      prepService.prepareCreate.mockResolvedValue({
        okPreviews: [],
        okCreatePayee: [],
        okIndex: [],
        previewRows: [],
        skipped: [],
      });
      prepService.prepareCreateTransfer.mockResolvedValue({
        okPreviews: [xferPreview],
        okIndex: [0],
        previewRows: [{ status: "ok" }],
        skipped: [],
      });
      transactionsService.createTransfer.mockResolvedValue({
        fromTransaction: { id: "tf1" },
        toTransaction: { id: "tf2" },
      });

      const result = await handlers["manage_transactions"](
        {
          operation: "create",
          items: [
            {
              fromAccountName: "Checking",
              toAccountName: "Savings",
              amount: 100,
              date: "2025-01-15",
              payeeName: "Shared rent",
            },
          ],
        },
        { sessionId: "s1" },
      );

      expect(transactionsService.createTransfer).toHaveBeenCalledTimes(1);
      expect(transactionsService.createTransfer).toHaveBeenCalledWith(
        "u1",
        expect.objectContaining({ payeeName: "Shared rent" }),
      );
      expect(prepService.prepareCreateTransfer).toHaveBeenCalledWith(
        "u1",
        expect.arrayContaining([
          expect.objectContaining({ payeeName: "Shared rent" }),
        ]),
      );
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.id).toBe("tf1");
    });

    it("find-or-creates the payee for an unmatched transfer label and links the new id", async () => {
      resolve.mockReturnValue({ userId: "u1", scopes: "write" });
      const xferPreview = {
        fromAccountId: "a1",
        fromAccountName: "Checking",
        fromCurrencyCode: "USD",
        toAccountId: "a2",
        toAccountName: "Savings",
        toCurrencyCode: "USD",
        amount: 100,
        toAmount: 100,
        exchangeRate: 1,
        transactionDate: "2025-01-15",
        description: null,
        payeeId: null,
        payeeName: "Brand new label",
        payeeMatched: false,
        payeeWillBeCreated: true,
      };
      prepService.prepareCreate.mockResolvedValue({
        okPreviews: [],
        okCreatePayee: [],
        okIndex: [],
        previewRows: [],
        skipped: [],
      });
      prepService.prepareCreateTransfer.mockResolvedValue({
        okPreviews: [xferPreview],
        okIndex: [0],
        previewRows: [{ status: "ok" }],
        skipped: [],
      });
      transactionsService.createTransfer.mockResolvedValue({
        fromTransaction: { id: "tf1" },
        toTransaction: { id: "tf2" },
      });

      await handlers["manage_transactions"](
        {
          operation: "create",
          items: [
            {
              fromAccountName: "Checking",
              toAccountName: "Savings",
              amount: 100,
              date: "2025-01-15",
              payeeName: "Brand new label",
            },
          ],
        },
        { sessionId: "s1" },
      );

      expect(payeesService.findOrCreate).toHaveBeenCalledWith(
        "u1",
        "Brand new label",
      );
      expect(transactionsService.createTransfer).toHaveBeenCalledWith(
        "u1",
        expect.objectContaining({ payeeId: "new-payee-id" }),
      );
    });

    it("bulk create (>= 6 items) emits one relay card", async () => {
      resolve.mockReturnValue({ userId: "u1", scopes: "write" });
      relayService.emitPendingAction.mockReturnValue(true);
      prepService.prepareCreate.mockResolvedValue({
        okPreviews: [stdPreview, stdPreview],
        okCreatePayee: [true, true],
        okIndex: [0, 1],
        previewRows: [{ status: "ok" }, { status: "ok" }],
        skipped: [],
      });

      const result = await handlers["manage_transactions"](
        {
          operation: "create",
          items: Array.from({ length: 6 }, (_, i) => ({
            accountName: "Checking",
            amount: -50 - i,
            date: "2025-01-15",
          })),
        },
        { sessionId: "s1" },
      );

      expect(actionBuilder.buildCreateTransactions).toHaveBeenCalledTimes(1);
      expect(relayService.emitPendingAction).toHaveBeenCalledTimes(1);
      expect(transactionsService.create).not.toHaveBeenCalled();
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.status).toBeDefined();
    });

    it("bulk create (individual mode) emits one relay card per item", async () => {
      resolve.mockReturnValue({ userId: "u1", scopes: "write" });
      relayService.emitPendingAction.mockReturnValue(true);
      prepService.prepareCreate.mockResolvedValue({
        okPreviews: [stdPreview, stdPreview],
        okCreatePayee: [true, true],
        okIndex: [0, 1],
        previewRows: [{ status: "ok" }, { status: "ok" }],
        skipped: [],
      });

      await handlers["manage_transactions"](
        {
          operation: "create",
          items: [
            { accountName: "Checking", amount: -50, date: "2025-01-15" },
            { accountName: "Checking", amount: -20, date: "2025-01-16" },
          ],
          approvalMode: "individual",
        },
        { sessionId: "s1" },
      );

      expect(actionBuilder.buildCreateTransaction).toHaveBeenCalledTimes(2);
      expect(relayService.emitPendingAction).toHaveBeenCalledTimes(2);
    });

    it("updates a single transaction (standard) when the client cannot elicit", async () => {
      resolve.mockReturnValue({ userId: "u1", scopes: "write" });
      prepService.prepareUpdate.mockResolvedValue({
        kind: "standard",
        createPayee: true,
        preview: {
          transactionId: "t1",
          accountId: "a1",
          accountName: "Checking",
          amount: -75,
          transactionDate: "2025-02-01",
          payeeId: "p1",
          payeeName: "Store",
          payeeMatched: true,
          payeeWillBeCreated: false,
          categoryId: "c1",
          categoryName: "Groceries",
          description: null,
          currencyCode: "USD",
        },
      });
      transactionsService.update.mockResolvedValue({ id: "t1" });

      const result = await handlers["manage_transactions"](
        {
          operation: "update",
          items: [{ transactionId: "t1", amount: -75 }],
        },
        { sessionId: "s1" },
      );

      expect(transactionsService.update).toHaveBeenCalledTimes(1);
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.id).toBe("t1");
    });

    it("routes a single transfer update through updateTransfer", async () => {
      resolve.mockReturnValue({ userId: "u1", scopes: "write" });
      prepService.prepareUpdate.mockResolvedValue({
        kind: "transfer",
        preview: {
          transactionId: "t1",
          fromAccountId: "a1",
          fromAccountName: "Checking",
          fromCurrencyCode: "USD",
          toAccountId: "a2",
          toAccountName: "Savings",
          toCurrencyCode: "USD",
          amount: 100,
          toAmount: 100,
          exchangeRate: 1,
          transactionDate: "2025-02-01",
          description: null,
        },
      });
      transactionsService.updateTransfer.mockResolvedValue({
        fromTransaction: { id: "t1" },
        toTransaction: { id: "t2" },
      });

      await handlers["manage_transactions"](
        {
          operation: "update",
          items: [{ transactionId: "t1", amount: 100 }],
        },
        { sessionId: "s1" },
      );

      expect(transactionsService.updateTransfer).toHaveBeenCalledTimes(1);
    });

    it("bulk update (>= 6 items) builds one batch card", async () => {
      resolve.mockReturnValue({ userId: "u1", scopes: "write" });
      relayService.emitPendingAction.mockReturnValue(true);
      prepService.prepareUpdateBulk.mockResolvedValue({
        okRows: [
          {
            transactionId: "t1",
            accountId: "a1",
            amount: -5,
            transactionDate: "2025-01-01",
            payeeId: null,
            payeeName: null,
            createPayee: false,
            categoryId: "c1",
            description: null,
            currencyCode: "USD",
          },
        ],
        previewRows: [{ status: "ok" }],
        okIndex: [0],
        skipped: [],
      });

      await handlers["manage_transactions"](
        {
          operation: "update",
          items: Array.from({ length: 6 }, (_, i) => ({
            transactionId: `t${i + 1}`,
            categoryName: "Groceries",
          })),
        },
        { sessionId: "s1" },
      );

      expect(actionBuilder.buildBatchActions).toHaveBeenCalledWith(
        "u1",
        "update",
        expect.any(Array),
        expect.any(Array),
      );
      expect(relayService.emitPendingAction).toHaveBeenCalledTimes(1);
    });

    it("deletes a single transaction when the client cannot elicit", async () => {
      resolve.mockReturnValue({ userId: "u1", scopes: "write" });
      prepService.prepareDelete.mockResolvedValue({
        transactionId: "t1",
        accountName: "Checking",
        amount: -75,
        transactionDate: "2025-02-01",
        payeeName: "Store",
        categoryName: "Groceries",
        description: null,
        currencyCode: "USD",
      });

      const result = await handlers["manage_transactions"](
        { operation: "delete", items: [{ transactionId: "t1" }] },
        { sessionId: "s1" },
      );

      expect(transactionsService.removeAny).toHaveBeenCalledWith("u1", "t1");
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.deleted).toBe(true);
    });

    it("bulk delete (>= 6 items) builds one batch card", async () => {
      resolve.mockReturnValue({ userId: "u1", scopes: "write" });
      relayService.emitPendingAction.mockReturnValue(true);
      prepService.prepareDeleteBulk.mockResolvedValue({
        okRows: [{ transactionId: "t1" }, { transactionId: "t2" }],
        previewRows: [{ status: "ok" }, { status: "ok" }],
        okIndex: [0, 1],
        skipped: [],
      });

      await handlers["manage_transactions"](
        {
          operation: "delete",
          items: Array.from({ length: 6 }, (_, i) => ({
            transactionId: `t${i + 1}`,
          })),
        },
        { sessionId: "s1" },
      );

      expect(actionBuilder.buildBatchActions).toHaveBeenCalledWith(
        "u1",
        "delete",
        expect.any(Array),
        expect.any(Array),
      );
    });
  });

  describe("manage_transactions (commit, decline, dry-run, error branches)", () => {
    const acceptingClient = () => {
      server.server.getClientCapabilities.mockReturnValue({
        elicitation: { form: {} },
      });
      elicitInput.mockResolvedValue({ action: "accept" });
    };
    const decliningClient = () => {
      server.server.getClientCapabilities.mockReturnValue({
        elicitation: { form: {} },
      });
      elicitInput.mockResolvedValue({ action: "decline" });
    };

    const stdPreview = {
      accountId: "a1",
      accountName: "Checking",
      amount: -50,
      transactionDate: "2025-01-15",
      payeeId: "p1",
      payeeName: "Store",
      payeeMatched: true,
      payeeWillBeCreated: false,
      categoryId: null,
      categoryName: null,
      description: null,
      currencyCode: "USD",
    };

    const xferPreview = {
      fromAccountId: "a1",
      fromAccountName: "Checking",
      fromCurrencyCode: "USD",
      toAccountId: "a2",
      toAccountName: "Savings",
      toCurrencyCode: "USD",
      amount: 100,
      toAmount: 100,
      exchangeRate: 1,
      transactionDate: "2025-01-15",
      description: null,
      payeeId: "p1",
      payeeName: "Rent",
      payeeMatched: true,
      payeeWillBeCreated: false,
    };

    const okStd = (previews = [stdPreview]) => ({
      okPreviews: previews,
      okCreatePayee: previews.map(() => true),
      okIndex: previews.map((_p, i) => i),
      previewRows: previews.map(() => ({ status: "ok" })),
      skipped: [],
    });
    const emptyStd = () => ({
      okPreviews: [],
      okCreatePayee: [],
      okIndex: [],
      previewRows: [],
      skipped: [],
    });

    beforeEach(() => {
      resolve.mockReturnValue({ userId: "u1", scopes: "write" });
    });

    it("declines a single create and writes nothing", async () => {
      decliningClient();
      prepService.prepareCreate.mockResolvedValue(okStd());
      const result = await handlers["manage_transactions"](
        {
          operation: "create",
          items: [{ accountName: "Checking", amount: -50, date: "2025-01-15" }],
        },
        { sessionId: "s1" },
      );
      expect(result.isError).toBe(true);
      expect(transactionsService.create).not.toHaveBeenCalled();
    });

    it("errors when no create row could be prepared", async () => {
      prepService.prepareCreate.mockResolvedValue(emptyStd());
      const result = await handlers["manage_transactions"](
        {
          operation: "create",
          items: [{ accountName: "Ghost", amount: -50, date: "2025-01-15" }],
        },
        { sessionId: "s1" },
      );
      expect(result.isError).toBe(true);
    });

    it("commits a bulk create through confirmWrite when relay is unavailable", async () => {
      relayService.emitPendingAction.mockReturnValue(false);
      acceptingClient();
      prepService.prepareCreate.mockResolvedValue(
        okStd([stdPreview, stdPreview]),
      );
      transactionsService.create
        .mockResolvedValueOnce({ id: "t1", transactionDate: "2025-01-15" })
        .mockResolvedValueOnce({ id: "t2", transactionDate: "2025-01-16" });
      const result = await handlers["manage_transactions"](
        {
          operation: "create",
          items: Array.from({ length: 6 }, (_, i) => ({
            accountName: "Checking",
            amount: -50 - i,
            date: "2025-01-15",
          })),
        },
        { sessionId: "s1" },
      );
      expect(transactionsService.create).toHaveBeenCalledTimes(2);
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.ids).toEqual(["t1", "t2"]);
    });

    it("declines a bulk create through confirmWrite", async () => {
      relayService.emitPendingAction.mockReturnValue(false);
      decliningClient();
      prepService.prepareCreate.mockResolvedValue(
        okStd([stdPreview, stdPreview]),
      );
      const result = await handlers["manage_transactions"](
        {
          operation: "create",
          items: Array.from({ length: 6 }, (_, i) => ({
            accountName: "Checking",
            amount: -50 - i,
            date: "2025-01-15",
          })),
        },
        { sessionId: "s1" },
      );
      expect(result.isError).toBe(true);
      expect(transactionsService.create).not.toHaveBeenCalled();
    });

    it("commits a bulk create including a transfer card via confirmWrite", async () => {
      relayService.emitPendingAction.mockReturnValue(false);
      acceptingClient();
      prepService.prepareCreate.mockResolvedValue(okStd());
      prepService.prepareCreateTransfer.mockResolvedValue({
        okPreviews: [xferPreview],
        okIndex: [0],
        previewRows: [{ status: "ok" }],
        skipped: [],
      });
      transactionsService.create.mockResolvedValue({
        id: "t1",
        transactionDate: "2025-01-15",
      });
      transactionsService.createTransfer.mockResolvedValue({
        fromTransaction: { id: "tf1" },
        toTransaction: { id: "tf2" },
      });
      const result = await handlers["manage_transactions"](
        {
          operation: "create",
          items: [
            ...Array.from({ length: 5 }, (_, i) => ({
              accountName: "Checking",
              amount: -50 - i,
              date: "2025-01-15",
            })),
            {
              fromAccountName: "Checking",
              toAccountName: "Savings",
              amount: 100,
              date: "2025-01-15",
            },
          ],
        },
        { sessionId: "s1" },
      );
      expect(transactionsService.createTransfer).toHaveBeenCalledTimes(1);
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.ids).toEqual(["t1", "tf1"]);
    });

    it("runs individual create cards via confirmWrite, skipping declined ones", async () => {
      relayService.emitPendingAction.mockReturnValue(false);
      server.server.getClientCapabilities.mockReturnValue({
        elicitation: { form: {} },
      });
      elicitInput
        .mockResolvedValueOnce({ action: "accept" })
        .mockResolvedValueOnce({ action: "decline" });
      prepService.prepareCreate.mockResolvedValue(
        okStd([stdPreview, stdPreview]),
      );
      actionBuilder.buildCreateTransaction
        .mockReturnValueOnce({
          type: "create_transaction",
          preview: {
            accountName: "Checking",
            amount: -50,
            currencyCode: "USD",
          },
          descriptor: {
            type: "create_transaction",
            accountId: "a1",
            amount: -50,
            transactionDate: "2025-01-15",
            currencyCode: "USD",
          },
        })
        .mockReturnValueOnce({
          type: "create_transaction",
          preview: {
            accountName: "Checking",
            amount: -20,
            currencyCode: "USD",
          },
          descriptor: {
            type: "create_transaction",
            accountId: "a1",
            amount: -20,
            transactionDate: "2025-01-16",
            currencyCode: "USD",
          },
        });
      transactionsService.create.mockResolvedValue({ id: "t1" });
      const result = await handlers["manage_transactions"](
        {
          operation: "create",
          items: [
            { accountName: "Checking", amount: -50, date: "2025-01-15" },
            { accountName: "Checking", amount: -20, date: "2025-01-16" },
          ],
          approvalMode: "individual",
        },
        { sessionId: "s1" },
      );
      expect(transactionsService.create).toHaveBeenCalledTimes(1);
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.ids).toEqual(["t1"]);
    });

    it("dry-run previews update rows without writing", async () => {
      prepService.prepareUpdateBulk.mockResolvedValue({
        okRows: [{ transactionId: "t1" }],
        previewRows: [{ status: "ok" }],
        okIndex: [0],
        skipped: [],
      });
      const result = await handlers["manage_transactions"](
        {
          operation: "update",
          items: [{ transactionId: "t1", amount: -5 }],
          dryRun: true,
        },
        { sessionId: "s1" },
      );
      expect(transactionsService.update).not.toHaveBeenCalled();
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.dryRun).toBe(true);
    });

    it("dry-run previews delete rows without writing", async () => {
      prepService.prepareDeleteBulk.mockResolvedValue({
        okRows: [{ transactionId: "t1" }],
        previewRows: [{ status: "ok" }],
        okIndex: [0],
        skipped: [],
      });
      const result = await handlers["manage_transactions"](
        {
          operation: "delete",
          items: [{ transactionId: "t1" }],
          dryRun: true,
        },
        { sessionId: "s1" },
      );
      expect(transactionsService.removeAny).not.toHaveBeenCalled();
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.dryRun).toBe(true);
    });

    it("declines a single update", async () => {
      decliningClient();
      prepService.prepareUpdate.mockResolvedValue({
        kind: "standard",
        createPayee: true,
        preview: {
          transactionId: "t1",
          accountId: "a1",
          accountName: "Checking",
          amount: -75,
          transactionDate: "2025-02-01",
          payeeId: "p1",
          payeeName: "Store",
          payeeMatched: true,
          payeeWillBeCreated: false,
          categoryId: "c1",
          categoryName: "Groceries",
          description: null,
          currencyCode: "USD",
        },
      });
      const result = await handlers["manage_transactions"](
        { operation: "update", items: [{ transactionId: "t1", amount: -75 }] },
        { sessionId: "s1" },
      );
      expect(result.isError).toBe(true);
      expect(transactionsService.update).not.toHaveBeenCalled();
    });

    it("commits a bulk update via confirmWrite when relay is unavailable", async () => {
      relayService.emitPendingAction.mockReturnValue(false);
      acceptingClient();
      prepService.prepareUpdateBulk.mockResolvedValue({
        okRows: [
          {
            transactionId: "t1",
            accountId: "a1",
            amount: -5,
            transactionDate: "2025-01-01",
            payeeId: null,
            payeeName: null,
            createPayee: false,
            categoryId: "c1",
            description: null,
            currencyCode: "USD",
          },
        ],
        previewRows: [{ status: "ok" }],
        okIndex: [0],
        skipped: [{ index: 1, reason: "bad" }],
      });
      transactionsService.update.mockResolvedValue({ id: "t1" });
      const result = await handlers["manage_transactions"](
        {
          operation: "update",
          items: Array.from({ length: 6 }, (_, i) => ({
            transactionId: `t${i + 1}`,
            amount: -5 - i,
          })),
        },
        { sessionId: "s1" },
      );
      expect(transactionsService.update).toHaveBeenCalledTimes(1);
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.ids).toEqual(["t1"]);
    });

    it("errors when no bulk update row prepares", async () => {
      prepService.prepareUpdateBulk.mockResolvedValue({
        okRows: [],
        previewRows: [],
        okIndex: [],
        skipped: [{ index: 0, reason: "bad" }],
      });
      const result = await handlers["manage_transactions"](
        {
          operation: "update",
          items: [{ transactionId: "t1", amount: -5 }],
          approvalMode: "bulk",
        },
        { sessionId: "s1" },
      );
      expect(result.isError).toBe(true);
    });

    it("commits a single transfer update via confirmWrite (resolving the payee)", async () => {
      relayService.emitPendingAction.mockReturnValue(false);
      acceptingClient();
      prepService.prepareUpdate.mockResolvedValue({
        kind: "transfer",
        preview: {
          transactionId: "t1",
          fromAccountId: "a1",
          fromAccountName: "Checking",
          fromCurrencyCode: "USD",
          toAccountId: "a2",
          toAccountName: "Savings",
          toCurrencyCode: "USD",
          amount: 100,
          toAmount: 100,
          exchangeRate: 1,
          transactionDate: "2025-02-01",
          description: null,
          payeeId: null,
          payeeName: "New label",
          payeeWillBeCreated: true,
        },
      });
      transactionsService.updateTransfer.mockResolvedValue({
        fromTransaction: { id: "t1" },
        toTransaction: { id: "t2" },
      });
      await handlers["manage_transactions"](
        { operation: "update", items: [{ transactionId: "t1", amount: 100 }] },
        { sessionId: "s1" },
      );
      expect(payeesService.findOrCreate).toHaveBeenCalledWith(
        "u1",
        "New label",
      );
      expect(transactionsService.updateTransfer).toHaveBeenCalledWith(
        "u1",
        "t1",
        expect.objectContaining({ payeeId: "new-payee-id" }),
      );
    });

    it("runs individual update cards via confirmWrite", async () => {
      relayService.emitPendingAction.mockReturnValue(false);
      acceptingClient();
      prepService.prepareUpdate.mockResolvedValue({
        kind: "standard",
        createPayee: false,
        preview: {
          transactionId: "t1",
          accountId: "a1",
          accountName: "Checking",
          amount: -5,
          transactionDate: "2025-01-01",
          payeeId: null,
          payeeName: null,
          categoryId: "c1",
          categoryName: "Groceries",
          description: null,
          currencyCode: "USD",
        },
      });
      actionBuilder.buildUpdateTransaction.mockReturnValue({
        type: "update_transaction",
        preview: { accountName: "Checking", amount: -5, currencyCode: "USD" },
        descriptor: {
          type: "update_transaction",
          transactionId: "t1",
          amount: -5,
          transactionDate: "2025-01-01",
          currencyCode: "USD",
          createPayee: false,
        },
      });
      transactionsService.update.mockResolvedValue({ id: "t1" });
      const result = await handlers["manage_transactions"](
        {
          operation: "update",
          items: [
            { transactionId: "t1", amount: -5 },
            { transactionId: "t2", amount: -6 },
          ],
          approvalMode: "individual",
        },
        { sessionId: "s1" },
      );
      expect(transactionsService.update).toHaveBeenCalledTimes(2);
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.count).toBe(2);
    });

    it("errors when every individual update row fails to prepare", async () => {
      prepService.prepareUpdate.mockRejectedValue(new Error("boom"));
      const result = await handlers["manage_transactions"](
        {
          operation: "update",
          items: [
            { transactionId: "t1", amount: -5 },
            { transactionId: "t2", amount: -6 },
          ],
          approvalMode: "individual",
        },
        { sessionId: "s1" },
      );
      expect(result.isError).toBe(true);
    });

    it("declines a single delete", async () => {
      decliningClient();
      prepService.prepareDelete.mockResolvedValue({
        transactionId: "t1",
        accountName: "Checking",
        amount: -75,
        transactionDate: "2025-02-01",
        payeeName: "Store",
        categoryName: "Groceries",
        description: null,
        currencyCode: "USD",
      });
      const result = await handlers["manage_transactions"](
        { operation: "delete", items: [{ transactionId: "t1" }] },
        { sessionId: "s1" },
      );
      expect(result.isError).toBe(true);
      expect(transactionsService.removeAny).not.toHaveBeenCalled();
    });

    it("commits a bulk delete via confirmWrite when relay is unavailable", async () => {
      relayService.emitPendingAction.mockReturnValue(false);
      acceptingClient();
      prepService.prepareDeleteBulk.mockResolvedValue({
        okRows: [{ transactionId: "t1" }, { transactionId: "t2" }],
        previewRows: [{ status: "ok" }, { status: "ok" }],
        okIndex: [0, 1],
        skipped: [],
      });
      const result = await handlers["manage_transactions"](
        {
          operation: "delete",
          items: Array.from({ length: 6 }, (_, i) => ({
            transactionId: `t${i + 1}`,
          })),
        },
        { sessionId: "s1" },
      );
      expect(transactionsService.removeAny).toHaveBeenCalledTimes(2);
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.ids).toEqual(["t1", "t2"]);
    });

    it("errors when no bulk delete row prepares", async () => {
      prepService.prepareDeleteBulk.mockResolvedValue({
        okRows: [],
        previewRows: [],
        okIndex: [],
        skipped: [{ index: 0, reason: "gone" }],
      });
      const result = await handlers["manage_transactions"](
        {
          operation: "delete",
          items: [{ transactionId: "t1" }],
          approvalMode: "bulk",
        },
        { sessionId: "s1" },
      );
      expect(result.isError).toBe(true);
    });

    it("runs individual delete cards via confirmWrite", async () => {
      relayService.emitPendingAction.mockReturnValue(false);
      acceptingClient();
      prepService.prepareDelete.mockResolvedValue({
        transactionId: "t1",
        accountName: "Checking",
        amount: -5,
        transactionDate: "2025-01-01",
        payeeName: "Store",
        categoryName: "Groceries",
        description: null,
        currencyCode: "USD",
      });
      actionBuilder.buildDeleteTransaction.mockReturnValue({
        type: "delete_transaction",
        preview: { accountName: "Checking" },
        descriptor: { type: "delete_transaction", transactionId: "t1" },
      });
      const result = await handlers["manage_transactions"](
        {
          operation: "delete",
          items: [{ transactionId: "t1" }, { transactionId: "t2" }],
          approvalMode: "individual",
        },
        { sessionId: "s1" },
      );
      expect(transactionsService.removeAny).toHaveBeenCalledTimes(2);
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.count).toBe(2);
    });

    it("commits an individual create_transfer card via confirmWrite", async () => {
      relayService.emitPendingAction.mockReturnValue(false);
      acceptingClient();
      prepService.prepareCreate.mockResolvedValue(emptyStd());
      prepService.prepareCreateTransfer.mockResolvedValue({
        okPreviews: [xferPreview, xferPreview],
        okIndex: [0, 1],
        previewRows: [{ status: "ok" }, { status: "ok" }],
        skipped: [],
      });
      actionBuilder.buildCreateTransfer.mockReturnValue({
        type: "create_transfer",
        preview: {
          fromAccountName: "Checking",
          toAccountName: "Savings",
          amount: 100,
          currencyCode: "USD",
        },
        descriptor: {
          type: "create_transfer",
          fromAccountId: "a1",
          toAccountId: "a2",
          transactionDate: "2025-01-15",
          amount: 100,
          fromCurrencyCode: "USD",
          toCurrencyCode: "USD",
          exchangeRate: 1,
          toAmount: 100,
          payeeId: null,
          payeeName: "Rent",
          payeeWillBeCreated: true,
        },
      });
      transactionsService.createTransfer.mockResolvedValue({
        fromTransaction: { id: "tf1" },
        toTransaction: { id: "tf2" },
      });
      const result = await handlers["manage_transactions"](
        {
          operation: "create",
          items: [
            {
              fromAccountName: "Checking",
              toAccountName: "Savings",
              amount: 100,
              date: "2025-01-15",
            },
            {
              fromAccountName: "Checking",
              toAccountName: "Savings",
              amount: 50,
              date: "2025-01-16",
            },
          ],
          approvalMode: "individual",
        },
        { sessionId: "s1" },
      );
      expect(transactionsService.createTransfer).toHaveBeenCalledTimes(2);
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.ids).toEqual(["tf1", "tf1"]);
    });

    it("commits an individual update_transfer card via confirmWrite", async () => {
      relayService.emitPendingAction.mockReturnValue(false);
      acceptingClient();
      prepService.prepareUpdate.mockResolvedValue({
        kind: "transfer",
        preview: {
          transactionId: "t1",
          fromAccountId: "a1",
          fromAccountName: "Checking",
          fromCurrencyCode: "USD",
          toAccountId: "a2",
          toAccountName: "Savings",
          toCurrencyCode: "USD",
          amount: 100,
          toAmount: 100,
          exchangeRate: 1,
          transactionDate: "2025-02-01",
          description: null,
        },
      });
      actionBuilder.buildUpdateTransfer.mockReturnValue({
        type: "update_transfer",
        preview: {
          fromAccountName: "Checking",
          toAccountName: "Savings",
          amount: 100,
          currencyCode: "USD",
        },
        descriptor: {
          type: "update_transfer",
          transactionId: "t1",
          amount: 100,
          transactionDate: "2025-02-01",
          exchangeRate: 1,
          toAmount: 100,
          payeeId: "p1",
          payeeName: "Rent",
        },
      });
      transactionsService.updateTransfer.mockResolvedValue({
        fromTransaction: { id: "t1" },
        toTransaction: { id: "t2" },
      });
      const result = await handlers["manage_transactions"](
        {
          operation: "update",
          items: [
            { transactionId: "t1", amount: 100 },
            { transactionId: "t2", amount: 100 },
          ],
          approvalMode: "individual",
        },
        { sessionId: "s1" },
      );
      expect(transactionsService.updateTransfer).toHaveBeenCalledTimes(2);
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.count).toBe(2);
    });

    it("skips individual delete cards that cannot be prepared", async () => {
      relayService.emitPendingAction.mockReturnValue(false);
      acceptingClient();
      prepService.prepareDelete
        .mockResolvedValueOnce({
          transactionId: "t1",
          accountName: "Checking",
          amount: -5,
          transactionDate: "2025-01-01",
          payeeName: "Store",
          categoryName: "Groceries",
          description: null,
          currencyCode: "USD",
        })
        .mockRejectedValueOnce(new Error("gone"));
      actionBuilder.buildDeleteTransaction.mockReturnValue({
        type: "delete_transaction",
        preview: { accountName: "Checking" },
        descriptor: { type: "delete_transaction", transactionId: "t1" },
      });
      const result = await handlers["manage_transactions"](
        {
          operation: "delete",
          items: [{ transactionId: "t1" }, { transactionId: "t2" }],
          approvalMode: "individual",
        },
        { sessionId: "s1" },
      );
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.skipped).toHaveLength(1);
    });

    const splitPreview = { ...stdPreview };
    const resolvedSplits = [
      { categoryId: "c1", categoryName: "Groceries", amount: -30, memo: null },
      {
        categoryId: "c2",
        categoryName: "Household",
        amount: -20,
        memo: "soap",
      },
    ];

    it("creates a split transaction with splits on accept", async () => {
      acceptingClient();
      prepService.prepareCreateSingle.mockResolvedValue({
        preview: splitPreview,
        createPayee: true,
        splits: resolvedSplits,
      });
      transactionsService.create.mockResolvedValue({
        id: "t-split",
        transactionDate: "2025-01-15",
      });
      const result = await handlers["manage_transactions"](
        {
          operation: "create",
          items: [
            {
              accountName: "Checking",
              amount: -50,
              date: "2025-01-15",
              splits: [
                { categoryName: "Groceries", amount: -30 },
                { categoryName: "Household", amount: -20, memo: "soap" },
              ],
            },
          ],
        },
        { sessionId: "s1" },
      );
      expect(transactionsService.create).toHaveBeenCalledWith(
        "u1",
        expect.objectContaining({
          splits: [
            { categoryId: "c1", amount: -30, memo: undefined },
            { categoryId: "c2", amount: -20, memo: "soap" },
          ],
        }),
        { createPayeeIfMissing: true },
      );
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.id).toBe("t-split");
      expect(parsed.count).toBe(1);
    });

    it("declines a split create and writes nothing", async () => {
      decliningClient();
      prepService.prepareCreateSingle.mockResolvedValue({
        preview: splitPreview,
        createPayee: true,
        splits: resolvedSplits,
      });
      const result = await handlers["manage_transactions"](
        {
          operation: "create",
          items: [
            {
              accountName: "Checking",
              amount: -50,
              date: "2025-01-15",
              splits: [
                { categoryName: "Groceries", amount: -30 },
                { categoryName: "Household", amount: -20 },
              ],
            },
          ],
        },
        { sessionId: "s1" },
      );
      expect(result.isError).toBe(true);
      expect(transactionsService.create).not.toHaveBeenCalled();
    });

    it("replaces splits on a split update", async () => {
      acceptingClient();
      prepService.prepareUpdate.mockResolvedValue({
        kind: "standard",
        preview: {
          transactionId: "t1",
          accountName: "Checking",
          amount: -50,
          transactionDate: "2025-01-15",
          payeeId: null,
          payeeName: null,
          categoryId: null,
          description: null,
          currencyCode: "USD",
        },
        createPayee: true,
        splits: resolvedSplits,
      });
      transactionsService.update.mockResolvedValue({ id: "t1" });
      const result = await handlers["manage_transactions"](
        {
          operation: "update",
          items: [
            {
              transactionId: "11111111-1111-4111-8111-111111111111",
              splits: [
                { categoryName: "Groceries", amount: -30 },
                { categoryName: "Household", amount: -20, memo: "soap" },
              ],
            },
          ],
        },
        { sessionId: "s1" },
      );
      expect(transactionsService.update).toHaveBeenCalled();
      expect(transactionsService.updateSplits).toHaveBeenCalledWith(
        "u1",
        "t1",
        [
          { categoryId: "c1", amount: -30, memo: undefined },
          { categoryId: "c2", amount: -20, memo: "soap" },
        ],
      );
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.id).toBe("t1");
    });

    it("dry-run create returns split previews without writing", async () => {
      prepService.prepareCreateSingle.mockResolvedValue({
        preview: splitPreview,
        createPayee: true,
        splits: resolvedSplits,
      });
      const result = await handlers["manage_transactions"](
        {
          operation: "create",
          dryRun: true,
          items: [
            {
              accountName: "Checking",
              amount: -50,
              date: "2025-01-15",
              splits: [
                { categoryName: "Groceries", amount: -30 },
                { categoryName: "Household", amount: -20 },
              ],
            },
          ],
        },
        { sessionId: "s1" },
      );
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.dryRun).toBe(true);
      expect(parsed.previews[0].splits).toHaveLength(2);
      expect(transactionsService.create).not.toHaveBeenCalled();
    });
  });
});
