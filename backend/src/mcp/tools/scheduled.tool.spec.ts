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
      findUpcoming: jest.fn(),
      findAll: jest.fn(),
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
    it("should return error when no user context", async () => {
      resolve.mockReturnValue(undefined);
      const result = await handlers["get_upcoming_bills"](
        {},
        { sessionId: "s1" },
      );
      expect(result.isError).toBe(true);
    });

    it("should return upcoming bills with default days", async () => {
      resolve.mockReturnValue({ userId: "u1", scopes: "read" });
      scheduledService.findUpcoming.mockResolvedValue([
        { id: "s1", name: "Rent", amount: -1200 },
      ]);

      const result = await handlers["get_upcoming_bills"](
        {},
        { sessionId: "s1" },
      );
      expect(scheduledService.findUpcoming).toHaveBeenCalledWith("u1", 30);
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed[0].name).toBe("Rent");
    });

    it("should use custom days parameter", async () => {
      resolve.mockReturnValue({ userId: "u1", scopes: "read" });
      scheduledService.findUpcoming.mockResolvedValue([]);

      await handlers["get_upcoming_bills"]({ days: 7 }, { sessionId: "s1" });
      expect(scheduledService.findUpcoming).toHaveBeenCalledWith("u1", 7);
    });
  });

  describe("get_scheduled_transactions", () => {
    it("should return all scheduled transactions", async () => {
      resolve.mockReturnValue({ userId: "u1", scopes: "read" });
      scheduledService.findAll.mockResolvedValue([
        { id: "s1", name: "Netflix" },
        { id: "s2", name: "Gym" },
      ]);

      const result = await handlers["get_scheduled_transactions"](
        {},
        { sessionId: "s1" },
      );
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed).toHaveLength(2);
    });

    it("should handle service errors", async () => {
      resolve.mockReturnValue({ userId: "u1", scopes: "read" });
      scheduledService.findAll.mockRejectedValue(new Error("DB error"));

      const result = await handlers["get_scheduled_transactions"](
        {},
        { sessionId: "s1" },
      );
      expect(result.isError).toBe(true);
    });
  });
});
