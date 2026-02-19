import { McpTransactionsTools } from "./transactions.tool";
import { UserContextResolver } from "../mcp-context";

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
  });
});
