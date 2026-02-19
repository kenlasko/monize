import { McpPayeesTools } from "./payees.tool";
import { UserContextResolver } from "../mcp-context";

describe("McpPayeesTools", () => {
  let tool: McpPayeesTools;
  let payeesService: Record<string, jest.Mock>;
  let server: { registerTool: jest.Mock };
  let resolve: jest.MockedFunction<UserContextResolver>;
  const handlers: Record<string, (...args: any[]) => any> = {};

  beforeEach(() => {
    payeesService = {
      findAll: jest.fn(),
      search: jest.fn(),
      create: jest.fn(),
    };

    tool = new McpPayeesTools(payeesService as any);

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

  describe("get_payees", () => {
    it("should return all payees without search", async () => {
      resolve.mockReturnValue({ userId: "u1", scopes: "read" });
      payeesService.findAll.mockResolvedValue([{ id: "p1", name: "Amazon" }]);

      const result = await handlers["get_payees"]({}, { sessionId: "s1" });
      expect(payeesService.findAll).toHaveBeenCalledWith("u1");
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed[0].name).toBe("Amazon");
    });

    it("should search payees when query provided", async () => {
      resolve.mockReturnValue({ userId: "u1", scopes: "read" });
      payeesService.search.mockResolvedValue([{ id: "p1", name: "Amazon" }]);

      await handlers["get_payees"]({ search: "ama" }, { sessionId: "s1" });
      expect(payeesService.search).toHaveBeenCalledWith("u1", "ama", 50);
    });
  });

  describe("create_payee", () => {
    it("should require write scope", async () => {
      resolve.mockReturnValue({ userId: "u1", scopes: "read" });
      const result = await handlers["create_payee"](
        { name: "New Payee" },
        { sessionId: "s1" },
      );
      expect(result.isError).toBe(true);
    });

    it("should create payee on success", async () => {
      resolve.mockReturnValue({ userId: "u1", scopes: "read,write" });
      payeesService.create.mockResolvedValue({ id: "p2", name: "New Payee" });

      const result = await handlers["create_payee"](
        { name: "New Payee" },
        { sessionId: "s1" },
      );
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.message).toContain("created");
    });
  });
});
