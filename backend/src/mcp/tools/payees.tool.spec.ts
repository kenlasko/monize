import { McpPayeesTools } from "./payees.tool";
import { McpWriteLimiter } from "../mcp-write-limiter";
import { AuthAttemptCounterService } from "../../auth/auth-attempt-counter.service";
import { createAuthAttemptCounterMock } from "../../test-helpers/auth-attempt-counter-testing";
import { mcpTestCtx, McpTestContext } from "../testing/mcp-test-context";

describe("McpPayeesTools", () => {
  let tool: McpPayeesTools;
  let payeesService: Record<string, jest.Mock>;
  let prepService: Record<string, jest.Mock>;
  let server: {
    registerTool: jest.Mock;
    server: { getClientCapabilities: jest.Mock };
  };
  let elicitInput: jest.Mock;
  let relayService: { emitPendingAction: jest.Mock };
  let actionBuilder: Record<string, jest.Mock>;
  let ctx: McpTestContext;
  const handlers: Record<string, (...args: any[]) => any> = {};
  const toolConfigs: Record<string, any> = {};

  beforeEach(() => {
    payeesService = {
      findAll: jest.fn(),
      search: jest.fn(),
      getLlmPayees: jest.fn(),
      create: jest.fn().mockResolvedValue({ id: "p2", name: "New Payee" }),
      update: jest.fn().mockResolvedValue({ id: "p2", name: "New Payee" }),
      remove: jest.fn().mockResolvedValue(undefined),
    };

    prepService = {
      prepareCreatePayeeSingle: jest.fn().mockResolvedValue({
        name: "New Payee",
        defaultCategoryId: null,
        defaultCategoryName: null,
      }),
      prepareUpdatePayeeSingle: jest.fn().mockResolvedValue({
        payeeId: "p2",
        name: "New Payee",
        defaultCategoryId: null,
        defaultCategoryName: null,
      }),
      prepareDeletePayeeSingle: jest
        .fn()
        .mockResolvedValue({ payeeId: "p2", name: "Old Payee" }),
      prepareCreatePayees: jest.fn(),
      prepareUpdatePayees: jest.fn(),
      prepareDeletePayees: jest.fn(),
    };

    // Default: not serving a relayed prompt, so the tool uses its normal
    // (direct MCP-client) confirmation path.
    relayService = { emitPendingAction: jest.fn().mockResolvedValue(false) };
    actionBuilder = {
      buildCreatePayee: jest.fn().mockReturnValue({
        type: "create_payee",
        preview: { name: "New Payee" },
        descriptor: {
          type: "create_payee",
          name: "New Payee",
          defaultCategoryId: null,
        },
      }),
      buildUpdatePayee: jest.fn().mockReturnValue({
        type: "update_payee",
        preview: { name: "New Payee" },
        descriptor: {
          type: "update_payee",
          payeeId: "p2",
          name: "New Payee",
          defaultCategoryId: null,
        },
      }),
      buildDeletePayee: jest.fn().mockReturnValue({
        type: "delete_payee",
        preview: { name: "Old Payee" },
        descriptor: { type: "delete_payee", payeeId: "p2" },
      }),
      buildBatchActions: jest.fn().mockReturnValue({
        type: "batch_actions",
        descriptor: { type: "batch_actions" },
      }),
    };

    tool = new McpPayeesTools(
      payeesService as any,
      prepService as any,
      relayService as any,
      actionBuilder as any,
      new McpWriteLimiter(
        createAuthAttemptCounterMock() as unknown as AuthAttemptCounterService,
      ),
    );

    elicitInput = jest.fn().mockResolvedValue({ action: "accept" });
    server = {
      registerTool: jest.fn((name, opts, handler) => {
        handlers[name] = handler;
        toolConfigs[name] = opts;
      }),
      // Default to no elicitation capability so writes proceed (matches a client
      // that can't show a dialog); the decline test overrides these.
      server: {
        getClientCapabilities: jest.fn().mockReturnValue({}),
      },
    };

    ctx = mcpTestCtx(undefined, { elicitInput });
    tool.register(server as any);
  });

  it("should register 2 tools", () => {
    expect(server.registerTool).toHaveBeenCalledTimes(2);
  });

  describe("list_payees", () => {
    const list = {
      payees: [{ id: "p1", name: "Amazon" }],
      totalCount: 1,
      truncated: false,
    };

    it("returns the list with its match count and truncation flag", async () => {
      ctx.setUser({ userId: "u1", scopes: "read" });
      payeesService.getLlmPayees.mockResolvedValue(list);

      const result = await handlers["list_payees"]({}, ctx);

      expect(payeesService.getLlmPayees).toHaveBeenCalledWith("u1", {});
      const parsed = result.structuredContent as any;
      expect(parsed.payees[0].name).toBe("Amazon");
      expect(parsed.totalCount).toBe(1);
      expect(parsed.truncated).toBe(false);
    });

    it("passes every filter, the sort and the limit through to the service", async () => {
      // The tool is a thin adapter: the AI Assistant calls the same method, so
      // a filter offered here and dropped on the way down would leave the two
      // surfaces answering the same question differently.
      ctx.setUser({ userId: "u1", scopes: "read" });
      payeesService.getLlmPayees.mockResolvedValue(list);

      const args = {
        search: "ama",
        status: "active" as const,
        sortBy: "lastUsed" as const,
        limit: 10,
        hasWebsite: true,
        hasLogo: false,
        hasAddress: true,
        hasEmail: false,
        hasPhone: true,
        hasDefaultCategory: false,
      };
      await handlers["list_payees"](args, ctx);

      expect(payeesService.getLlmPayees).toHaveBeenCalledWith("u1", args);
    });

    it("accepts a limit written as a string, as a model sends it", async () => {
      // The reported defect: the SDK refused `limit: "10"` with -32602
      // "expected number, received string". Validation runs on the declared
      // input schema, so this asserts against that schema rather than the
      // handler, which never saw the call.
      const schema = toolConfigs["list_payees"].inputSchema;

      expect(schema.parse({ limit: "10" }).limit).toBe(10);
      expect(schema.parse({ limit: 10 }).limit).toBe(10);
      expect(schema.parse({ hasEmail: "false" }).hasEmail).toBe(false);
      expect(schema.parse({ hasEmail: "true" }).hasEmail).toBe(true);
    });

    it("still refuses a limit that is not a number", async () => {
      const schema = toolConfigs["list_payees"].inputSchema;

      // "" and null must not arrive as 0: an unknown is not a measured zero.
      for (const junk of ["", "  ", "abc", null, [], true]) {
        expect(schema.safeParse({ limit: junk }).success).toBe(false);
      }
      expect(schema.safeParse({ limit: "501" }).success).toBe(false);
      expect(schema.safeParse({ hasEmail: "yes" }).success).toBe(false);
    });

    it("returns error when no user context", async () => {
      ctx.setUser(undefined);
      const result = await handlers["list_payees"]({}, ctx);
      expect(result.isError).toBe(true);
    });
  });

  describe("manage_payees", () => {
    it("requires write scope", async () => {
      ctx.setUser({ userId: "u1", scopes: "read" });
      const result = await handlers["manage_payees"](
        { operation: "create", items: [{ name: "New Payee" }] },
        ctx,
      );
      expect(result.isError).toBe(true);
    });

    it("creates a single payee on success", async () => {
      ctx.setUser({ userId: "u1", scopes: "read,write" });
      const result = await handlers["manage_payees"](
        { operation: "create", items: [{ name: "New Payee" }] },
        ctx,
      );
      expect(payeesService.create).toHaveBeenCalledWith(
        "u1",
        { name: "New Payee", defaultCategoryId: undefined },
        {},
      );
      const parsed = result.structuredContent as any;
      expect(parsed.id).toBe("p2");
      expect(parsed.count).toBe(1);
    });

    it("passes a website through to the prep layer and the write", async () => {
      ctx.setUser({ userId: "u1", scopes: "read,write" });
      prepService.prepareCreatePayeeSingle.mockResolvedValue({
        name: "Acme",
        defaultCategoryId: null,
        defaultCategoryName: null,
        website: "https://acme.com",
      });

      await handlers["manage_payees"](
        {
          operation: "create",
          items: [{ name: "Acme", website: "acme.com" }],
        },
        ctx,
      );

      expect(prepService.prepareCreatePayeeSingle).toHaveBeenCalledWith(
        "u1",
        { name: "Acme", categoryName: undefined, website: "acme.com" },
        { lookupContact: true },
      );
      // The normalised address from the preview is what gets stored, so the
      // saved payee matches the card the user approved.
      expect(payeesService.create).toHaveBeenCalledWith(
        "u1",
        {
          name: "Acme",
          defaultCategoryId: undefined,
          website: "https://acme.com",
        },
        {},
      );
    });

    it("passes the contact fields through to the prep layer and the write", async () => {
      ctx.setUser({ userId: "u1", scopes: "read,write" });
      prepService.prepareCreatePayeeSingle.mockResolvedValue({
        name: "Acme",
        defaultCategoryId: null,
        defaultCategoryName: null,
        address: "1 Main St, Springfield",
        email: "hi@acme.com",
        phone: "+1 555-0100",
      });

      await handlers["manage_payees"](
        {
          operation: "create",
          items: [
            {
              name: "Acme",
              address: "1 Main St, Springfield",
              email: "hi@acme.com",
              phone: "+1 555-0100",
            },
          ],
        },
        ctx,
      );

      expect(prepService.prepareCreatePayeeSingle).toHaveBeenCalledWith(
        "u1",
        expect.objectContaining({
          address: "1 Main St, Springfield",
          email: "hi@acme.com",
          phone: "+1 555-0100",
        }),
        { lookupContact: true },
      );
      expect(payeesService.create).toHaveBeenCalledWith(
        "u1",
        expect.objectContaining({
          address: "1 Main St, Springfield",
          email: "hi@acme.com",
          phone: "+1 555-0100",
        }),
        {},
      );
    });

    it("shows the contact fields on the confirmation card", async () => {
      // The card is the whole point of the confirmation step: a field written
      // by the approval but absent from the text is a change nobody agreed to.
      ctx.setUser({ userId: "u1", scopes: "read,write" });
      server.server.getClientCapabilities.mockReturnValue({
        elicitation: { form: {} },
      });
      prepService.prepareCreatePayeeSingle.mockResolvedValue({
        name: "Acme",
        defaultCategoryId: null,
        defaultCategoryName: null,
        address: "1 Main St",
        email: "hi@acme.com",
        phone: "555",
      });

      await handlers["manage_payees"](
        {
          operation: "create",
          items: [{ name: "Acme", address: "1 Main St" }],
        },
        ctx,
      );

      const card =
        elicitInput.mock.calls[elicitInput.mock.calls.length - 1]?.[0] ?? "";
      const text = typeof card === "string" ? card : JSON.stringify(card);
      expect(text).toContain("1 Main St");
      expect(text).toContain("hi@acme.com");
      expect(text).toContain("555");
    });

    it("says a cleared contact field is being cleared rather than omitting it", async () => {
      ctx.setUser({ userId: "u1", scopes: "read,write" });
      server.server.getClientCapabilities.mockReturnValue({
        elicitation: { form: {} },
      });
      prepService.prepareUpdatePayeeSingle.mockResolvedValue({
        payeeId: "p1",
        name: "Acme",
        defaultCategoryId: null,
        defaultCategoryName: null,
        address: null,
      });

      await handlers["manage_payees"](
        { operation: "update", items: [{ name: "Acme", address: "" }] },
        ctx,
      );

      const card =
        elicitInput.mock.calls[elicitInput.mock.calls.length - 1]?.[0] ?? "";
      const text = typeof card === "string" ? card : JSON.stringify(card);
      expect(text).toContain("(cleared)");
    });

    it("updates a single payee on success", async () => {
      ctx.setUser({ userId: "u1", scopes: "read,write" });
      const result = await handlers["manage_payees"](
        {
          operation: "update",
          items: [{ name: "Old", newName: "New Payee" }],
        },
        ctx,
      );
      expect(payeesService.update).toHaveBeenCalledWith("u1", "p2", {
        name: "New Payee",
        defaultCategoryId: null,
      });
      const parsed = result.structuredContent as any;
      expect(parsed.count).toBe(1);
    });

    it("deletes a single payee on success", async () => {
      server.server.getClientCapabilities.mockReturnValue({
        elicitation: { form: {} },
      });
      ctx.setUser({ userId: "u1", scopes: "read,write" });
      const result = await handlers["manage_payees"](
        { operation: "delete", items: [{ name: "Old Payee" }] },
        ctx,
      );
      expect(payeesService.remove).toHaveBeenCalledWith("u1", "p2");
      const parsed = result.structuredContent as any;
      expect(parsed.deleted).toBe(true);
    });

    it("does not write when the user declines the confirmation", async () => {
      ctx.setUser({ userId: "u1", scopes: "read,write" });
      server.server.getClientCapabilities.mockReturnValue({
        elicitation: { form: {} },
      });
      elicitInput.mockResolvedValue({ action: "decline" });

      const result = await handlers["manage_payees"](
        { operation: "create", items: [{ name: "New Payee" }] },
        ctx,
      );

      expect(prepService.prepareCreatePayeeSingle).toHaveBeenCalled();
      expect(payeesService.create).not.toHaveBeenCalled();
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("declined");
    });

    it("shows a web-chat card (no write) when serving a relayed prompt", async () => {
      ctx.setUser({ userId: "u1", scopes: "read,write" });
      relayService.emitPendingAction.mockResolvedValue(true);

      const result = await handlers["manage_payees"](
        { operation: "create", items: [{ name: "New Payee" }] },
        ctx,
      );

      expect(relayService.emitPendingAction).toHaveBeenCalled();
      expect(payeesService.create).not.toHaveBeenCalled();
      const parsed = result.structuredContent as any;
      expect(parsed.status).toBe("preview_shown");
    });

    it("returns a dry-run preview without writing", async () => {
      ctx.setUser({ userId: "u1", scopes: "read,write" });
      prepService.prepareCreatePayees.mockResolvedValue({
        okPreviews: [{ name: "New Payee" }],
        okRows: [{ name: "New Payee", defaultCategoryId: null }],
        previewRows: [{ status: "ok", name: "New Payee" }],
        okIndex: [0],
        skipped: [],
      });

      const result = await handlers["manage_payees"](
        { operation: "create", items: [{ name: "New Payee" }], dryRun: true },
        ctx,
      );

      expect(payeesService.create).not.toHaveBeenCalled();
      const parsed = result.structuredContent as any;
      expect(parsed.dryRun).toBe(true);
      expect(parsed.operation).toBe("create");
    });

    it("lets a 2-item create with one row left proceed for a client that cannot elicit", async () => {
      ctx.setUser({ userId: "u1", scopes: "read,write" });
      actionBuilder.buildBatchActions.mockReturnValue({
        type: "batch_actions",
        descriptor: {
          type: "batch_actions",
          operation: "create_payee",
          rows: [{ name: "A" }],
        },
      });
      prepService.prepareCreatePayees.mockResolvedValue({
        okPreviews: [
          { name: "A", defaultCategoryId: null, defaultCategoryName: null },
        ],
        okRows: [{ name: "A", defaultCategoryId: null }],
        previewRows: [{ status: "ok", name: "A" }],
        okIndex: [0],
        skipped: [{ index: 1, reason: "duplicate" }],
      });

      const result = await handlers["manage_payees"](
        { operation: "create", items: [{ name: "A" }, { name: "B" }] },
        ctx,
      );

      expect(result.isError).toBeUndefined();
      expect(payeesService.create).toHaveBeenCalledTimes(1);
    });

    it("creates multiple payees as one bulk card via confirmation", async () => {
      server.server.getClientCapabilities.mockReturnValue({
        elicitation: { form: {} },
      });
      elicitInput.mockResolvedValue({ action: "accept" });
      ctx.setUser({ userId: "u1", scopes: "read,write" });
      prepService.prepareCreatePayees.mockResolvedValue({
        okPreviews: [
          { name: "A", defaultCategoryId: null, defaultCategoryName: null },
          { name: "B", defaultCategoryId: null, defaultCategoryName: null },
        ],
        okRows: [
          { name: "A", defaultCategoryId: null },
          { name: "B", defaultCategoryId: null },
        ],
        previewRows: [
          { status: "ok", name: "A" },
          { status: "ok", name: "B" },
        ],
        okIndex: [0, 1],
        skipped: [],
      });

      const result = await handlers["manage_payees"](
        { operation: "create", items: [{ name: "A" }, { name: "B" }] },
        ctx,
      );

      expect(actionBuilder.buildBatchActions).toHaveBeenCalledWith(
        "u1",
        "create_payee",
        expect.any(Array),
        expect.any(Array),
      );
      expect(payeesService.create).toHaveBeenCalledTimes(2);
      const parsed = result.structuredContent as any;
      expect(parsed.count).toBe(2);
    });

    it("bulk-updates multiple payees via confirmation", async () => {
      server.server.getClientCapabilities.mockReturnValue({
        elicitation: { form: {} },
      });
      elicitInput.mockResolvedValue({ action: "accept" });
      ctx.setUser({ userId: "u1", scopes: "read,write" });
      prepService.prepareUpdatePayees.mockResolvedValue({
        okPreviews: [
          { payeeId: "p1", name: "A", defaultCategoryId: null },
          { payeeId: "p2", name: "B", defaultCategoryId: null },
        ],
        okRows: [
          { payeeId: "p1", name: "A", defaultCategoryId: null },
          { payeeId: "p2", name: "B", defaultCategoryId: null },
        ],
        previewRows: [
          { status: "ok", name: "A" },
          { status: "ok", name: "B" },
        ],
        okIndex: [0, 1],
        skipped: [],
      });

      const result = await handlers["manage_payees"](
        {
          operation: "update",
          items: [
            { name: "A", newName: "A2" },
            { name: "B", newName: "B2" },
          ],
        },
        ctx,
      );

      expect(payeesService.update).toHaveBeenCalledTimes(2);
      const parsed = result.structuredContent as any;
      expect(parsed.count).toBe(2);
    });

    it("bulk-deletes multiple payees via confirmation", async () => {
      server.server.getClientCapabilities.mockReturnValue({
        elicitation: { form: {} },
      });
      elicitInput.mockResolvedValue({ action: "accept" });
      ctx.setUser({ userId: "u1", scopes: "read,write" });
      prepService.prepareDeletePayees.mockResolvedValue({
        okPreviews: [
          { payeeId: "p1", name: "A" },
          { payeeId: "p2", name: "B" },
        ],
        okRows: [{ payeeId: "p1" }, { payeeId: "p2" }],
        previewRows: [
          { status: "ok", name: "A" },
          { status: "ok", name: "B" },
        ],
        okIndex: [0, 1],
        skipped: [],
      });

      const result = await handlers["manage_payees"](
        { operation: "delete", items: [{ name: "A" }, { name: "B" }] },
        ctx,
      );

      expect(payeesService.remove).toHaveBeenCalledTimes(2);
      const parsed = result.structuredContent as any;
      expect(parsed.count).toBe(2);
    });

    it("bulk create reports skipped rows in the summary (non-relay)", async () => {
      server.server.getClientCapabilities.mockReturnValue({
        elicitation: { form: {} },
      });
      elicitInput.mockResolvedValue({ action: "accept" });
      ctx.setUser({ userId: "u1", scopes: "read,write" });
      prepService.prepareCreatePayees.mockResolvedValue({
        okPreviews: [
          { name: "A", defaultCategoryId: null, defaultCategoryName: null },
        ],
        okRows: [{ name: "A", defaultCategoryId: null }],
        previewRows: [
          { status: "ok", name: "A" },
          { status: "error", name: "B" },
        ],
        okIndex: [0],
        skipped: [{ index: 1, reason: "dup" }],
      });

      const result = await handlers["manage_payees"](
        { operation: "create", items: [{ name: "A" }, { name: "B" }] },
        ctx,
      );

      const parsed = result.structuredContent as any;
      expect(parsed.count).toBe(1);
      expect(parsed.skipped).toHaveLength(1);
    });

    it("individual mode commits one card per item (non-relay)", async () => {
      server.server.getClientCapabilities.mockReturnValue({
        elicitation: { form: {} },
      });
      ctx.setUser({ userId: "u1", scopes: "read,write" });
      prepService.prepareCreatePayees.mockResolvedValue({
        okPreviews: [
          { name: "A", defaultCategoryId: null, defaultCategoryName: null },
          { name: "B", defaultCategoryId: null, defaultCategoryName: null },
        ],
        okRows: [
          { name: "A", defaultCategoryId: null },
          { name: "B", defaultCategoryId: null },
        ],
        previewRows: [
          { status: "ok", name: "A" },
          { status: "ok", name: "B" },
        ],
        okIndex: [0, 1],
        skipped: [],
      });

      const result = await handlers["manage_payees"](
        {
          operation: "create",
          items: [{ name: "A" }, { name: "B" }],
          approvalMode: "individual",
        },
        ctx,
      );

      // Each card is confirmed and committed individually.
      expect(payeesService.create).toHaveBeenCalledTimes(2);
      const parsed = result.structuredContent as any;
      expect(parsed.count).toBe(2);
    });

    it("individual mode emits all cards via relay when relayed", async () => {
      ctx.setUser({ userId: "u1", scopes: "read,write" });
      relayService.emitPendingAction.mockResolvedValue(true);
      prepService.prepareDeletePayees.mockResolvedValue({
        okPreviews: [
          { payeeId: "p1", name: "A" },
          { payeeId: "p2", name: "B" },
        ],
        okRows: [{ payeeId: "p1" }, { payeeId: "p2" }],
        previewRows: [
          { status: "ok", name: "A" },
          { status: "ok", name: "B" },
        ],
        okIndex: [0, 1],
        skipped: [],
      });

      const result = await handlers["manage_payees"](
        {
          operation: "delete",
          items: [{ name: "A" }, { name: "B" }],
          approvalMode: "individual",
        },
        ctx,
      );

      expect(relayService.emitPendingAction).toHaveBeenCalledTimes(2);
      expect(payeesService.remove).not.toHaveBeenCalled();
      const parsed = result.structuredContent as any;
      expect(parsed.status).toBe("preview_shown");
    });

    it("individual mode updates each payee (non-relay commit)", async () => {
      server.server.getClientCapabilities.mockReturnValue({
        elicitation: { form: {} },
      });
      ctx.setUser({ userId: "u1", scopes: "read,write" });
      prepService.prepareUpdatePayees.mockResolvedValue({
        okPreviews: [
          { payeeId: "p1", name: "A", defaultCategoryId: null },
          { payeeId: "p2", name: "B", defaultCategoryId: null },
        ],
        okRows: [],
        previewRows: [
          { status: "ok", name: "A" },
          { status: "ok", name: "B" },
        ],
        okIndex: [0, 1],
        skipped: [],
      });

      await handlers["manage_payees"](
        {
          operation: "update",
          items: [
            { name: "A", newName: "A2" },
            { name: "B", newName: "B2" },
          ],
          approvalMode: "individual",
        },
        ctx,
      );
      expect(payeesService.update).toHaveBeenCalledTimes(2);
    });

    it("individual mode deletes each payee (non-relay commit)", async () => {
      server.server.getClientCapabilities.mockReturnValue({
        elicitation: { form: {} },
      });
      ctx.setUser({ userId: "u1", scopes: "read,write" });
      prepService.prepareDeletePayees.mockResolvedValue({
        okPreviews: [
          { payeeId: "p1", name: "A" },
          { payeeId: "p2", name: "B" },
        ],
        okRows: [],
        previewRows: [
          { status: "ok", name: "A" },
          { status: "ok", name: "B" },
        ],
        okIndex: [0, 1],
        skipped: [],
      });

      await handlers["manage_payees"](
        {
          operation: "delete",
          items: [{ name: "A" }, { name: "B" }],
          approvalMode: "individual",
        },
        ctx,
      );
      expect(payeesService.remove).toHaveBeenCalledTimes(2);
    });

    it("declines a single create without writing", async () => {
      ctx.setUser({ userId: "u1", scopes: "read,write" });
      server.server.getClientCapabilities.mockReturnValue({
        elicitation: { form: {} },
      });
      elicitInput.mockResolvedValue({ action: "decline" });

      const result = await handlers["manage_payees"](
        { operation: "update", items: [{ name: "A", newName: "B" }] },
        ctx,
      );
      expect(payeesService.update).not.toHaveBeenCalled();
      expect(result.isError).toBe(true);
    });

    it("dry-run previews update and delete without writing", async () => {
      ctx.setUser({ userId: "u1", scopes: "read,write" });
      prepService.prepareUpdatePayees.mockResolvedValue({
        okPreviews: [],
        okRows: [],
        previewRows: [{ status: "ok", name: "A" }],
        okIndex: [],
        skipped: [],
      });
      prepService.prepareDeletePayees.mockResolvedValue({
        okPreviews: [],
        okRows: [],
        previewRows: [{ status: "ok", name: "A" }],
        okIndex: [],
        skipped: [],
      });

      const upd = await handlers["manage_payees"](
        {
          operation: "update",
          items: [{ name: "A", newName: "B" }],
          dryRun: true,
        },
        ctx,
      );
      const del = await handlers["manage_payees"](
        { operation: "delete", items: [{ name: "A" }], dryRun: true },
        ctx,
      );

      expect(payeesService.update).not.toHaveBeenCalled();
      expect(payeesService.remove).not.toHaveBeenCalled();
      expect((upd.structuredContent as any).operation).toBe("update");
      expect((del.structuredContent as any).operation).toBe("delete");
    });

    it("single update/delete go through the relay when relayed", async () => {
      ctx.setUser({ userId: "u1", scopes: "read,write" });
      relayService.emitPendingAction.mockResolvedValue(true);

      const upd = await handlers["manage_payees"](
        { operation: "update", items: [{ name: "A", newName: "B" }] },
        ctx,
      );
      const del = await handlers["manage_payees"](
        { operation: "delete", items: [{ name: "A" }] },
        ctx,
      );

      expect(payeesService.update).not.toHaveBeenCalled();
      expect(payeesService.remove).not.toHaveBeenCalled();
      expect((upd.structuredContent as any).status).toBe("preview_shown");
      expect((del.structuredContent as any).status).toBe("preview_shown");
    });

    it("bulk update/delete go through the relay when relayed", async () => {
      ctx.setUser({ userId: "u1", scopes: "read,write" });
      relayService.emitPendingAction.mockResolvedValue(true);
      const okPrev = {
        okPreviews: [
          { payeeId: "p1", name: "A", defaultCategoryId: null },
          { payeeId: "p2", name: "B", defaultCategoryId: null },
        ],
        okRows: [{ payeeId: "p1" }, { payeeId: "p2" }],
        previewRows: [{ status: "ok" }, { status: "ok" }],
        okIndex: [0, 1],
        skipped: [{ index: 2, reason: "x" }],
      };
      prepService.prepareUpdatePayees.mockResolvedValue(okPrev);
      prepService.prepareDeletePayees.mockResolvedValue(okPrev);

      const upd = await handlers["manage_payees"](
        { operation: "update", items: [{ name: "A" }, { name: "B" }] },
        ctx,
      );
      const del = await handlers["manage_payees"](
        { operation: "delete", items: [{ name: "A" }, { name: "B" }] },
        ctx,
      );
      expect(payeesService.update).not.toHaveBeenCalled();
      expect(payeesService.remove).not.toHaveBeenCalled();
      expect((upd.structuredContent as any).status).toBe("preview_shown");
      expect((del.structuredContent as any).status).toBe("preview_shown");
    });

    it("returns error when no user context", async () => {
      ctx.setUser(undefined);
      const result = await handlers["manage_payees"](
        { operation: "create", items: [{ name: "X" }] },
        ctx,
      );
      expect(result.isError).toBe(true);
    });

    it("returns error when prep throws", async () => {
      ctx.setUser({ userId: "u1", scopes: "read,write" });
      prepService.prepareCreatePayeeSingle.mockRejectedValue(new Error("dup"));
      const result = await handlers["manage_payees"](
        { operation: "create", items: [{ name: "X" }] },
        ctx,
      );
      expect(result.isError).toBe(true);
    });
  });
});
