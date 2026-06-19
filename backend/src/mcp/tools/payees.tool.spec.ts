import { McpPayeesTools } from "./payees.tool";
import { UserContextResolver } from "../mcp-context";

describe("McpPayeesTools", () => {
  let tool: McpPayeesTools;
  let payeesService: Record<string, jest.Mock>;
  let server: {
    registerTool: jest.Mock;
    server: { getClientCapabilities: jest.Mock; elicitInput: jest.Mock };
  };
  let elicitInput: jest.Mock;
  let relayService: { emitPendingAction: jest.Mock };
  let resolve: jest.MockedFunction<UserContextResolver>;
  const handlers: Record<string, (...args: any[]) => any> = {};

  beforeEach(() => {
    payeesService = {
      findAll: jest.fn(),
      search: jest.fn(),
      create: jest.fn(),
      previewCreate: jest.fn().mockResolvedValue({
        name: "New Payee",
        defaultCategoryId: null,
        defaultCategoryName: null,
      }),
    };

    // Default: not serving a relayed prompt, so the tool uses its normal
    // (direct MCP-client) confirmation path and the existing assertions hold.
    relayService = { emitPendingAction: jest.fn().mockReturnValue(false) };
    const actionBuilder = { buildCreatePayee: jest.fn().mockReturnValue({}) };

    tool = new McpPayeesTools(
      payeesService as any,
      relayService as any,
      actionBuilder as any,
    );

    elicitInput = jest.fn();
    server = {
      registerTool: jest.fn((name, _opts, handler) => {
        handlers[name] = handler;
      }),
      // Default to no elicitation capability so create_payee proceeds (matches a
      // client that can't show a dialog); the decline test overrides these.
      server: {
        getClientCapabilities: jest.fn().mockReturnValue({}),
        elicitInput,
      },
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

    it("does not create when the user declines the confirmation", async () => {
      resolve.mockReturnValue({ userId: "u1", scopes: "read,write" });
      server.server.getClientCapabilities.mockReturnValue({
        elicitation: { form: {} },
      });
      elicitInput.mockResolvedValue({ action: "decline" });

      const result = await handlers["create_payee"](
        { name: "New Payee" },
        { sessionId: "s1" },
      );

      expect(payeesService.previewCreate).toHaveBeenCalled();
      expect(payeesService.create).not.toHaveBeenCalled();
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("declined");
    });

    it("shows a web-chat card (no elicitation, no write) when serving a relayed prompt", async () => {
      resolve.mockReturnValue({ userId: "u1", scopes: "read,write" });
      server.server.getClientCapabilities.mockReturnValue({
        elicitation: { form: {} },
      });
      relayService.emitPendingAction.mockReturnValue(true);

      const result = await handlers["create_payee"](
        { name: "New Payee" },
        { sessionId: "s1", requestId: "call-1" },
      );

      expect(relayService.emitPendingAction).toHaveBeenCalled();
      expect(elicitInput).not.toHaveBeenCalled();
      expect(payeesService.create).not.toHaveBeenCalled();
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.status).toBe("preview_shown");
    });

    it("returns error when no user context for create_payee", async () => {
      resolve.mockReturnValue(undefined);
      const result = await handlers["create_payee"](
        { name: "X" },
        { sessionId: "s1" },
      );
      expect(result.isError).toBe(true);
    });

    it("returns error when create_payee service throws", async () => {
      resolve.mockReturnValue({ userId: "u1", scopes: "read,write" });
      payeesService.create.mockRejectedValue(new Error("dup"));

      const result = await handlers["create_payee"](
        { name: "X" },
        { sessionId: "s1" },
      );
      expect(result.isError).toBe(true);
    });
  });

  describe("get_payees error paths", () => {
    it("returns error when no user context", async () => {
      resolve.mockReturnValue(undefined);
      const result = await handlers["get_payees"]({}, { sessionId: "s1" });
      expect(result.isError).toBe(true);
    });

    it("returns error when service throws", async () => {
      resolve.mockReturnValue({ userId: "u1", scopes: "read" });
      payeesService.findAll.mockRejectedValue(new Error("db"));
      const result = await handlers["get_payees"]({}, { sessionId: "s1" });
      expect(result.isError).toBe(true);
    });
  });
});
