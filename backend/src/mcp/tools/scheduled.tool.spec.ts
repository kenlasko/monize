import { McpScheduledTools } from "./scheduled.tool";
import { UserContextResolver } from "../mcp-context";

describe("McpScheduledTools", () => {
  let tool: McpScheduledTools;
  let scheduledService: Record<string, jest.Mock>;
  let server: { registerTool: jest.Mock };
  let resolve: jest.MockedFunction<UserContextResolver>;
  const handlers: Record<string, (...args: any[]) => any> = {};

  beforeEach(() => {
    scheduledService = {
      getLlmUpcomingBillsAndDeposits: jest.fn(),
      getLlmScheduledList: jest.fn(),
    };

    tool = new McpScheduledTools(scheduledService as any);

    server = {
      registerTool: jest.fn((name, _opts, handler) => {
        handlers[name] = handler;
      }),
    };

    resolve = jest.fn();
    tool.register(server as any, resolve);
  });

  it("should register 2 tools", () => {
    expect(server.registerTool).toHaveBeenCalledTimes(2);
  });

  describe("get_upcoming_bills", () => {
    it("returns error when no user context", async () => {
      resolve.mockReturnValue(undefined);
      const result = await handlers["get_upcoming_bills"](
        {},
        { sessionId: "s1" },
      );
      expect(result.isError).toBe(true);
    });

    it("calls the shared LLM helper with default days=30", async () => {
      resolve.mockReturnValue({ userId: "u1", scopes: "read" });
      scheduledService.getLlmUpcomingBillsAndDeposits.mockResolvedValue({
        daysWindow: 30,
        itemCount: 1,
        overdueCount: 0,
        totalUpcomingBills: 1200,
        totalUpcomingDeposits: 0,
        items: [
          {
            id: "s1",
            name: "Rent",
            accountId: "a1",
            accountName: "Checking",
            payeeName: "Landlord",
            categoryName: "Housing",
            amount: -1200,
            currency: "USD",
            frequency: "MONTHLY",
            nextDueDate: "2026-06-15",
            daysUntilDue: 13,
            isActive: true,
            autoPost: false,
            kind: "bill",
            description: null,
          },
        ],
      });

      const result = await handlers["get_upcoming_bills"](
        {},
        { sessionId: "s1" },
      );

      expect(
        scheduledService.getLlmUpcomingBillsAndDeposits,
      ).toHaveBeenCalledWith("u1", {
        days: 30,
        kind: undefined,
        accountIds: undefined,
      });
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.itemCount).toBe(1);
      expect(parsed.items[0].kind).toBe("bill");
    });

    it("passes through days, kind, and accountIds", async () => {
      resolve.mockReturnValue({ userId: "u1", scopes: "read" });
      scheduledService.getLlmUpcomingBillsAndDeposits.mockResolvedValue({
        daysWindow: 7,
        itemCount: 0,
        overdueCount: 0,
        totalUpcomingBills: 0,
        totalUpcomingDeposits: 0,
        items: [],
      });

      await handlers["get_upcoming_bills"](
        { days: 7, kind: "deposit", accountIds: ["acc-1"] },
        { sessionId: "s1" },
      );
      expect(
        scheduledService.getLlmUpcomingBillsAndDeposits,
      ).toHaveBeenCalledWith("u1", {
        days: 7,
        kind: "deposit",
        accountIds: ["acc-1"],
      });
    });

    it("returns error when service throws", async () => {
      resolve.mockReturnValue({ userId: "u1", scopes: "read" });
      scheduledService.getLlmUpcomingBillsAndDeposits.mockRejectedValue(
        new Error("DB error"),
      );
      const result = await handlers["get_upcoming_bills"](
        {},
        { sessionId: "s1" },
      );
      expect(result.isError).toBe(true);
    });
  });

  describe("get_scheduled_transactions", () => {
    it("returns curated list payload", async () => {
      resolve.mockReturnValue({ userId: "u1", scopes: "read" });
      scheduledService.getLlmScheduledList.mockResolvedValue({
        totalCount: 2,
        activeCount: 2,
        autoPostCount: 1,
        billCount: 1,
        depositCount: 1,
        items: [
          {
            id: "s1",
            name: "Netflix",
            kind: "bill",
            amount: -15,
            accountId: "a1",
            accountName: "Checking",
            payeeName: "Netflix",
            categoryName: "Entertainment",
            currency: "USD",
            frequency: "MONTHLY",
            nextDueDate: "2026-06-10",
            daysUntilDue: 8,
            isActive: true,
            autoPost: true,
            description: null,
          },
          {
            id: "s2",
            name: "Paycheck",
            kind: "deposit",
            amount: 3000,
            accountId: "a1",
            accountName: "Checking",
            payeeName: "Employer",
            categoryName: "Salary",
            currency: "USD",
            frequency: "BIWEEKLY",
            nextDueDate: "2026-06-05",
            daysUntilDue: 3,
            isActive: true,
            autoPost: false,
            description: null,
          },
        ],
      });

      const result = await handlers["get_scheduled_transactions"](
        {},
        { sessionId: "s1" },
      );
      expect(scheduledService.getLlmScheduledList).toHaveBeenCalledWith("u1", {
        kind: undefined,
        accountIds: undefined,
        isActive: undefined,
      });
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.totalCount).toBe(2);
      expect(parsed.billCount).toBe(1);
      expect(parsed.depositCount).toBe(1);
    });

    it("passes through kind, accountIds, and isActive filter", async () => {
      resolve.mockReturnValue({ userId: "u1", scopes: "read" });
      scheduledService.getLlmScheduledList.mockResolvedValue({
        totalCount: 0,
        activeCount: 0,
        autoPostCount: 0,
        billCount: 0,
        depositCount: 0,
        items: [],
      });

      await handlers["get_scheduled_transactions"](
        { kind: "bill", accountIds: ["acc-1"], isActive: false },
        { sessionId: "s1" },
      );
      expect(scheduledService.getLlmScheduledList).toHaveBeenCalledWith("u1", {
        kind: "bill",
        accountIds: ["acc-1"],
        isActive: false,
      });
    });

    it("returns error when service throws", async () => {
      resolve.mockReturnValue({ userId: "u1", scopes: "read" });
      scheduledService.getLlmScheduledList.mockRejectedValue(
        new Error("DB error"),
      );
      const result = await handlers["get_scheduled_transactions"](
        {},
        { sessionId: "s1" },
      );
      expect(result.isError).toBe(true);
    });

    it("returns error when no user context", async () => {
      resolve.mockReturnValue(undefined);
      const result = await handlers["get_scheduled_transactions"](
        {},
        { sessionId: "s1" },
      );
      expect(result.isError).toBe(true);
    });
  });
});
