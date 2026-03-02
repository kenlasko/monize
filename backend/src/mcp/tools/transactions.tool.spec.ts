import { McpTransactionsTools } from "./transactions.tool";
import { UserContextResolver } from "../mcp-context";
import { MCP_DAILY_WRITE_LIMIT } from "../mcp-write-limiter";

describe("McpTransactionsTools", () => {
  let tool: McpTransactionsTools;
  let transactionsService: Record<string, jest.Mock>;
  let accountsService: Record<string, jest.Mock>;
  let server: { registerTool: jest.Mock };
  let resolve: jest.MockedFunction<UserContextResolver>;
  const handlers: Record<string, (...args: any[]) => any> = {};

  beforeEach(() => {
    transactionsService = {
      findAll: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
    };

    accountsService = {
      findOne: jest.fn(),
    };

    tool = new McpTransactionsTools(
      transactionsService as any,
      accountsService as any,
    );

    server = {
      registerTool: jest.fn((name, _opts, handler) => {
        handlers[name] = handler;
      }),
    };

    resolve = jest.fn();
    tool.register(server as any, resolve);
  });

  it("should register 3 tools", () => {
    expect(server.registerTool).toHaveBeenCalledTimes(3);
  });

  describe("search_transactions", () => {
    it("should return error when no user context", async () => {
      resolve.mockReturnValue(undefined);
      const result = await handlers["search_transactions"](
        {},
        { sessionId: "s1" },
      );
      expect(result.isError).toBe(true);
    });

    it("should require read scope", async () => {
      resolve.mockReturnValue({ userId: "u1", scopes: "write" });
      const result = await handlers["search_transactions"](
        {},
        { sessionId: "s1" },
      );
      expect(result.isError).toBe(true);
    });

    it("should search transactions with filters", async () => {
      resolve.mockReturnValue({ userId: "u1", scopes: "read" });
      transactionsService.findAll.mockResolvedValue({
        data: [
          {
            id: "t1",
            transactionDate: "2025-01-15",
            payeeName: "Store",
            category: { name: "Food" },
            amount: -50,
            account: { name: "Checking" },
            description: "Groceries",
            status: "cleared",
          },
        ],
        pagination: { total: 1, hasMore: false },
      });

      const result = await handlers["search_transactions"](
        { query: "store", limit: 10 },
        { sessionId: "s1" },
      );
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.transactions).toHaveLength(1);
      expect(parsed.transactions[0].payeeName).toBe("Store");
    });

    it("should cap limit at 100", async () => {
      resolve.mockReturnValue({ userId: "u1", scopes: "read" });
      transactionsService.findAll.mockResolvedValue({
        data: [],
        pagination: { total: 0, hasMore: false },
      });

      await handlers["search_transactions"](
        { limit: 999 },
        { sessionId: "s1" },
      );
      expect(transactionsService.findAll).toHaveBeenCalledWith(
        "u1",
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        1,
        100,
        false,
        undefined,
      );
    });

    it("should apply min/max amount filters", async () => {
      resolve.mockReturnValue({ userId: "u1", scopes: "read" });
      transactionsService.findAll.mockResolvedValue({
        data: [
          { id: "t1", amount: -20, transactionDate: "2025-01-15" },
          { id: "t2", amount: -100, transactionDate: "2025-01-14" },
          { id: "t3", amount: -200, transactionDate: "2025-01-13" },
        ],
        pagination: { total: 3, hasMore: false },
      });

      const result = await handlers["search_transactions"](
        { minAmount: -150, maxAmount: -10 },
        { sessionId: "s1" },
      );
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.transactions).toHaveLength(2);
    });
  });

  describe("create_transaction", () => {
    it("should require write scope", async () => {
      resolve.mockReturnValue({ userId: "u1", scopes: "read" });
      const result = await handlers["create_transaction"](
        { accountId: "a1", amount: -50, date: "2025-01-15" },
        { sessionId: "s1" },
      );
      expect(result.isError).toBe(true);
    });

    it("should create transaction with account currency", async () => {
      resolve.mockReturnValue({ userId: "u1", scopes: "read,write" });
      accountsService.findOne.mockResolvedValue({ currencyCode: "USD" });
      transactionsService.create.mockResolvedValue({
        id: "t1",
        transactionDate: "2025-01-15",
        amount: -50,
        payeeName: "Store",
        status: "pending",
      });

      const result = await handlers["create_transaction"](
        {
          accountId: "a1",
          amount: -50,
          date: "2025-01-15",
          payeeName: "Store",
          dryRun: false,
        },
        { sessionId: "s1" },
      );
      expect(accountsService.findOne).toHaveBeenCalledWith("u1", "a1");
      expect(transactionsService.create).toHaveBeenCalledWith(
        "u1",
        expect.objectContaining({
          currencyCode: "USD",
          amount: -50,
        }),
      );
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.id).toBe("t1");
    });

    it("should return preview in dry-run mode without creating", async () => {
      resolve.mockReturnValue({ userId: "u1", scopes: "read,write" });
      accountsService.findOne.mockResolvedValue({
        name: "Checking",
        currencyCode: "USD",
      });

      const result = await handlers["create_transaction"](
        {
          accountId: "a1",
          amount: -75,
          date: "2025-02-01",
          payeeName: "Coffee Shop",
          dryRun: true,
        },
        { sessionId: "s1" },
      );

      // Should NOT call create
      expect(transactionsService.create).not.toHaveBeenCalled();

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.dryRun).toBe(true);
      expect(parsed.preview.amount).toBe(-75);
      expect(parsed.preview.accountName).toBe("Checking");
      expect(parsed.preview.currencyCode).toBe("USD");
      expect(parsed.message).toContain("preview");
    });

    it("should strip HTML from payeeName and description (LLM07-F3)", async () => {
      resolve.mockReturnValue({ userId: "u1", scopes: "read,write" });
      accountsService.findOne.mockResolvedValue({ currencyCode: "USD" });
      transactionsService.create.mockResolvedValue({
        id: "t1",
        transactionDate: "2025-01-15",
        amount: -50,
        payeeName: "script alert XSS /script",
        status: "pending",
      });

      await handlers["create_transaction"](
        {
          accountId: "a1",
          amount: -50,
          date: "2025-01-15",
          payeeName: "<script>alert('XSS')</script>",
          description: "Purchase at <b>Store</b>",
          dryRun: false,
        },
        { sessionId: "s1" },
      );

      expect(transactionsService.create).toHaveBeenCalledWith(
        "u1",
        expect.objectContaining({
          payeeName: "scriptalert('XSS')/script",
          description: "Purchase at bStore/b",
        }),
      );
    });

    it("should strip HTML in dry-run preview (LLM07-F3)", async () => {
      resolve.mockReturnValue({ userId: "u1", scopes: "read,write" });
      accountsService.findOne.mockResolvedValue({
        name: "Checking",
        currencyCode: "USD",
      });

      const result = await handlers["create_transaction"](
        {
          accountId: "a1",
          amount: -50,
          date: "2025-01-15",
          payeeName: "<img src=x>",
          description: "Test <script>",
          dryRun: true,
        },
        { sessionId: "s1" },
      );

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.preview.payeeName).toBe("img src=x");
      expect(parsed.preview.description).toBe("Test script");
    });

    it("should enforce daily write rate limit", async () => {
      resolve.mockReturnValue({ userId: "u1", scopes: "read,write" });
      accountsService.findOne.mockResolvedValue({ currencyCode: "USD" });
      transactionsService.create.mockResolvedValue({
        id: "t-new",
        transactionDate: "2025-01-15",
        amount: -10,
        payeeName: "Store",
        status: "pending",
      });

      // Exhaust the rate limit by creating a new tool instance
      // and manually filling up the limiter
      const freshTool = new McpTransactionsTools(
        transactionsService as any,
        accountsService as any,
      );
      const freshHandlers: Record<string, (...args: any[]) => any> = {};
      const freshServer = {
        registerTool: jest.fn((name: string, _opts: any, handler: any) => {
          freshHandlers[name] = handler;
        }),
      };
      freshTool.register(freshServer as any, resolve);

      // Fill up the limiter via internal access
      const limiter = (freshTool as any).writeLimiter;
      for (let i = 0; i < MCP_DAILY_WRITE_LIMIT; i++) {
        limiter.record("u1", "create_transaction");
      }

      const result = await freshHandlers["create_transaction"](
        {
          accountId: "a1",
          amount: -10,
          date: "2025-01-15",
          dryRun: false,
        },
        { sessionId: "s1" },
      );

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("Daily write limit reached");
    });
  });

  describe("categorize_transaction", () => {
    it("should categorize a transaction", async () => {
      resolve.mockReturnValue({ userId: "u1", scopes: "read,write" });
      transactionsService.update.mockResolvedValue({
        id: "t1",
        categoryId: "c1",
      });

      const result = await handlers["categorize_transaction"](
        { transactionId: "t1", categoryId: "c1" },
        { sessionId: "s1" },
      );
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.message).toContain("categorized");
    });

    it("should enforce daily write rate limit for categorization", async () => {
      resolve.mockReturnValue({ userId: "u1", scopes: "read,write" });

      const freshTool = new McpTransactionsTools(
        transactionsService as any,
        accountsService as any,
      );
      const freshHandlers: Record<string, (...args: any[]) => any> = {};
      const freshServer = {
        registerTool: jest.fn((name: string, _opts: any, handler: any) => {
          freshHandlers[name] = handler;
        }),
      };
      freshTool.register(freshServer as any, resolve);

      const limiter = (freshTool as any).writeLimiter;
      for (let i = 0; i < MCP_DAILY_WRITE_LIMIT; i++) {
        limiter.record("u1", "categorize_transaction");
      }

      const result = await freshHandlers["categorize_transaction"](
        { transactionId: "t1", categoryId: "c1" },
        { sessionId: "s1" },
      );

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("Daily write limit reached");
    });
  });
});
