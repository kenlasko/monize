import { CLIENT_CAPABILITIES_META_KEY } from "@modelcontextprotocol/server";
import { McpRulesTools } from "./rules.tool";
import { McpWriteLimiter } from "../mcp-write-limiter";
import { AuthAttemptCounterService } from "../../auth/auth-attempt-counter.service";
import { createAuthAttemptCounterMock } from "../../test-helpers/auth-attempt-counter-testing";
import { installConfirmSupport } from "../mcp-confirm";
import { McpRequestStateCodec } from "../mcp-request-state";
import { mcpTestCtx, McpTestContext } from "../testing/mcp-test-context";

const RULE = "40000000-0000-4000-8000-000000000001";

/**
 * A builder double that mints a FRESH envelope per call, exactly as the real
 * `AiActionBuilderService` does: a double returning one frozen object would
 * agree with itself across the two rounds of a 2026-07-28 confirmation by
 * construction (see transactions.tool.spec.ts).
 */
function buildActionBuilderMock(): Record<string, jest.Mock> {
  let minted = 0;
  const build = (type: string) =>
    jest.fn(() => ({
      type,
      preview: {},
      descriptor: {
        type,
        userId: "u1",
        actionId: `action-${++minted}`,
        expiresAt: 1_700_000_000_000 + minted,
        ruleId: RULE,
      },
    }));
  return {
    buildCreateTransactionRule: build("create_transaction_rule"),
    buildUpdateTransactionRule: build("update_transaction_rule"),
    buildDeleteTransactionRule: build("delete_transaction_rule"),
    buildRunTransactionRule: build("run_transaction_rule"),
  };
}

const test = {
  matchedCount: 3,
  conditionMatchedCount: 3,
  scanned: 40,
  truncated: false,
  rows: [],
  skipped: [],
  skippedCount: 0,
  aiReviewRequests: 0,
  labels: {},
};
const ruleState = { name: "Biedronka", enabled: true };

describe("McpRulesTools", () => {
  let tool: McpRulesTools;
  let prep: Record<string, jest.Mock>;
  let relayService: { emitPendingAction: jest.Mock };
  let actionBuilder: Record<string, jest.Mock>;
  let aiActions: { commitApproved: jest.Mock };
  let limiter: McpWriteLimiter;
  let elicitInput: jest.Mock;
  let server: {
    registerTool: jest.Mock;
    server: { getClientCapabilities: jest.Mock };
  };
  let ctx: McpTestContext;
  const handlers: Record<string, (...args: any[]) => any> = {};
  const configs: Record<string, any> = {};

  const okCreate = () => ({
    ok: true,
    preview: { rule: ruleState, labels: {}, test },
  });

  beforeEach(() => {
    prep = {
      list: jest.fn().mockResolvedValue({
        rules: [{ id: RULE, name: "Biedronka" }],
        totalCount: 1,
        truncated: false,
      }),
      prepareCreate: jest.fn().mockResolvedValue(okCreate()),
      prepareUpdate: jest.fn().mockResolvedValue({
        ok: true,
        preview: {
          ruleId: RULE,
          rule: { ...ruleState, name: "Biedronka 2" },
          current: ruleState,
          labels: {},
          test,
        },
      }),
      prepareDelete: jest.fn().mockResolvedValue({
        ok: true,
        preview: { ruleId: RULE, rule: ruleState, labels: {} },
      }),
      prepareRun: jest.fn().mockResolvedValue({
        ok: true,
        preview: { ruleId: RULE, rule: ruleState, labels: {}, test },
      }),
      prepareTest: jest.fn().mockResolvedValue({
        ok: true,
        preview: { rule: ruleState, labels: {}, test },
      }),
      toLlmTest: jest.fn().mockReturnValue({
        matchedCount: 3,
        scanned: 40,
        truncated: false,
        rows: [],
        skippedCount: 0,
        skipped: [],
      }),
    };
    relayService = { emitPendingAction: jest.fn().mockResolvedValue(false) };
    actionBuilder = buildActionBuilderMock();
    aiActions = {
      commitApproved: jest
        .fn()
        .mockResolvedValue({ type: "create_transaction_rule", id: RULE }),
    };
    limiter = new McpWriteLimiter(
      createAuthAttemptCounterMock() as unknown as AuthAttemptCounterService,
    );
    jest.spyOn(limiter, "record");
    tool = new McpRulesTools(
      prep as never,
      relayService as never,
      actionBuilder as never,
      aiActions as never,
      limiter,
    );
    elicitInput = jest.fn().mockResolvedValue({ action: "accept" });
    server = {
      registerTool: jest.fn((name, opts, handler) => {
        handlers[name] = handler;
        configs[name] = opts;
      }),
      // No elicitation capability: the "unsupported" path, where the client's
      // own tool-call prompt is the consent step.
      server: { getClientCapabilities: jest.fn().mockReturnValue({}) },
    };
    ctx = mcpTestCtx(undefined, { elicitInput });
    tool.register(server as any);
  });

  const call = (args: Record<string, unknown>, scopes = "read,write") => {
    ctx.setUser({ userId: "u1", scopes });
    return handlers["manage_transaction_rules"](args, ctx);
  };
  const createArgs = {
    operation: "create",
    name: "Biedronka",
    condition: { field: "payeeText", op: "contains", value: "biedronka" },
    actions: [{ type: "set_category", categoryName: "Groceries" }],
  };

  it("registers one tool with the five required fields and the delete-capable annotation", () => {
    expect(server.registerTool).toHaveBeenCalledTimes(1);
    const c = configs["manage_transaction_rules"];
    expect(c.title).toEqual(expect.any(String));
    expect(c.description).toEqual(expect.any(String));
    expect(c.inputSchema).toBeDefined();
    expect(c.outputSchema).toBeDefined();
    expect(c.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false,
    });
  });

  it("takes the operation list including the two reads, and the A1 field shapes", () => {
    const shape = configs["manage_transaction_rules"].inputSchema.shape;
    expect(
      shape.operation.safeParse("list").success &&
        shape.operation.safeParse("test").success &&
        !shape.operation.safeParse("bogus").success,
    ).toBe(true);
    for (const field of ["condition", "actions", "triggers", "accountNames"]) {
      expect(shape[field]).toBeDefined();
    }
  });

  it("accepts condition and actions sent as JSON strings, as models routinely do", () => {
    const schema = configs["manage_transaction_rules"].inputSchema;
    const parsed = schema.parse({
      operation: "test",
      condition: JSON.stringify(createArgs.condition),
      actions: JSON.stringify(createArgs.actions),
    });
    expect(parsed.condition).toEqual(createArgs.condition);
    expect(parsed.actions).toEqual(createArgs.actions);
    const perAction = schema.parse({
      operation: "test",
      condition: createArgs.condition,
      actions: [JSON.stringify(createArgs.actions[0])],
    });
    expect(perAction.actions).toEqual(createArgs.actions);
  });

  it("still refuses a string that is not a JSON object", () => {
    const schema = configs["manage_transaction_rules"].inputSchema;
    expect(
      schema.safeParse({
        operation: "test",
        condition: "description contains ASSECO",
        actions: createArgs.actions,
      }).success,
    ).toBe(false);
  });

  it("refuses a caller with no user context", async () => {
    ctx.setUser(undefined);
    const result = await handlers["manage_transaction_rules"](
      { operation: "list" },
      ctx,
    );
    expect(result.isError).toBe(true);
  });

  describe("reads", () => {
    it("lists with the read scope alone", async () => {
      const result = await call(
        { operation: "list", search: "bied", limit: 5 },
        "read",
      );
      expect(prep.list).toHaveBeenCalledWith("u1", {
        ruleId: undefined,
        search: "bied",
        limit: 5,
      });
      expect(result.structuredContent.rules[0].name).toBe("Biedronka");
      expect(result.structuredContent.totalCount).toBe(1);
    });

    it("refuses a list without the read scope", async () => {
      const result = await call({ operation: "list" }, "write");
      expect(result.isError).toBe(true);
      expect(prep.list).not.toHaveBeenCalled();
    });

    it("tests a draft with the read scope, writing and confirming nothing", async () => {
      const result = await call(
        {
          operation: "test",
          condition: createArgs.condition,
          actions: createArgs.actions,
          accountNames: ["Checking"],
          limit: 100,
        },
        "read",
      );
      expect(prep.prepareTest).toHaveBeenCalledWith(
        "u1",
        expect.objectContaining({ condition: createArgs.condition }),
        {
          accountNames: ["Checking"],
          startDate: undefined,
          endDate: undefined,
          limit: 100,
        },
      );
      expect(result.structuredContent).toMatchObject({
        rule: "Biedronka",
        matchedCount: 3,
        scanned: 40,
      });
      expect(relayService.emitPendingAction).not.toHaveBeenCalled();
      expect(elicitInput).not.toHaveBeenCalled();
      expect(aiActions.commitApproved).not.toHaveBeenCalled();
    });

    it("answers a test refusal as a tool error carrying the structured entries", async () => {
      prep.prepareTest.mockResolvedValue({
        ok: false,
        message: "A name did not match.",
        errors: [{ path: "condition.value", code: "NAME_NOT_FOUND" }],
      });
      const result = await call({ operation: "test", ruleId: RULE }, "read");
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("NAME_NOT_FOUND");
      expect(result.content[0].text).toContain("condition.value");
    });

    it("refuses a test with neither a rule nor a draft", async () => {
      const result = await call({ operation: "test" }, "read");
      expect(result.isError).toBe(true);
      expect(prep.prepareTest).not.toHaveBeenCalled();
    });
  });

  describe("writes", () => {
    it.each(["create", "update", "delete", "run"])(
      "refuses %s without the write scope, preparing nothing",
      async (operation) => {
        const result = await call(
          { ...createArgs, operation, ruleId: RULE },
          "read",
        );
        expect(result.isError).toBe(true);
        expect(result.content[0].text).toContain("write");
        expect(prep.prepareCreate).not.toHaveBeenCalled();
        expect(aiActions.commitApproved).not.toHaveBeenCalled();
      },
    );

    it("enforces the same per-operation requirements as the assistant", async () => {
      const result = await call({ operation: "update", name: "x" });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("ruleId");
      expect(prep.prepareUpdate).not.toHaveBeenCalled();
    });

    it("hands the active window to the preparation", async () => {
      await call({
        ...createArgs,
        activeFrom: "2026-10-01",
        activeTo: "2026-12-31",
      });
      expect(prep.prepareCreate).toHaveBeenCalledWith(
        "u1",
        expect.objectContaining({
          activeFrom: "2026-10-01",
          activeTo: "2026-12-31",
        }),
      );
    });

    it("refuses a window side that is not a real date, preparing nothing", async () => {
      const result = await call({ ...createArgs, activeFrom: "2026-02-31" });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("activeFrom");
      expect(prep.prepareCreate).not.toHaveBeenCalled();
    });

    it("strips HTML from the name before it is prepared", async () => {
      await call({ ...createArgs, name: "<b>Biedronka</b>" });
      expect(prep.prepareCreate).toHaveBeenCalledWith(
        "u1",
        expect.objectContaining({ name: "bBiedronka/b" }),
      );
    });

    it("refuses with the entries the preparation found, and reserves no write", async () => {
      prep.prepareCreate.mockResolvedValue({
        ok: false,
        message: "The rule definition is not valid.",
        errors: [{ path: "actions.0", code: "CATEGORY_NOT_FOUND" }],
      });
      const result = await call(createArgs);
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("CATEGORY_NOT_FOUND");
      expect(actionBuilder.buildCreateTransactionRule).not.toHaveBeenCalled();
      expect(aiActions.commitApproved).not.toHaveBeenCalled();
      expect(limiter.record).not.toHaveBeenCalled();
    });

    it("sends a fix for each problem beside the entries", async () => {
      prep.prepareCreate.mockResolvedValue({
        ok: false,
        message: "The rule definition is not valid",
        errors: [{ path: "condition.operator", code: "UNKNOWN_KEY" }],
        hints: ['"operator" is not allowed in a leaf; use field, op, value.'],
      });
      const result = await call(createArgs);
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("UNKNOWN_KEY");
      expect(result.content[0].text).toContain(
        'Fix: "operator" is not allowed in a leaf',
      );
    });

    it("says on the confirmation that the rule matches none of the transactions examined", async () => {
      server.server.getClientCapabilities.mockReturnValue({
        elicitation: { form: {} },
      });
      prep.prepareCreate.mockResolvedValue({
        ok: true,
        preview: {
          rule: ruleState,
          labels: {},
          test: { ...test, matchedCount: 0, conditionMatchedCount: 0 },
        },
      });
      await call(createArgs);
      const message = elicitInput.mock.calls[0][0].message as string;
      expect(message).toContain(
        "This rule matches none of the 40 latest transactions.",
      );
      expect(message).toContain("usually wrong");
    });

    it("says the condition matches but nothing would change, without calling the rule wrong", async () => {
      server.server.getClientCapabilities.mockReturnValue({
        elicitation: { form: {} },
      });
      prep.prepareCreate.mockResolvedValue({
        ok: true,
        preview: {
          rule: ruleState,
          labels: {},
          test: { ...test, matchedCount: 0, conditionMatchedCount: 12 },
        },
      });
      await call(createArgs);
      const message = elicitInput.mock.calls[0][0].message as string;
      expect(message).toContain(
        "The condition matches 12 of the 40 latest transactions, but nothing would change",
      );
      expect(message).not.toContain("matches none");
      expect(message).not.toContain("usually wrong");
    });

    it("does not warn when the rule matches something", async () => {
      server.server.getClientCapabilities.mockReturnValue({
        elicitation: { form: {} },
      });
      await call(createArgs);
      expect(elicitInput.mock.calls[0][0].message).not.toContain(
        "matches none",
      );
    });

    it("refuses over the daily write cap without offering a card or committing", async () => {
      jest.spyOn(limiter, "reserve").mockResolvedValue({
        content: [{ type: "text", text: "Error: Daily write limit reached" }],
        isError: true,
      } as never);
      const result = await call(createArgs);
      expect(result.isError).toBe(true);
      expect(relayService.emitPendingAction).not.toHaveBeenCalled();
      expect(aiActions.commitApproved).not.toHaveBeenCalled();
    });

    describe("a 2025-era connection", () => {
      it("commits through the AI executor when the user accepts, and counts one write", async () => {
        server.server.getClientCapabilities.mockReturnValue({
          elicitation: { form: {} },
        });
        elicitInput.mockResolvedValue({ action: "accept" });

        const result = await call(createArgs);

        const action =
          actionBuilder.buildCreateTransactionRule.mock.results[0].value;
        expect(aiActions.commitApproved).toHaveBeenCalledWith(
          "u1",
          action.descriptor,
        );
        expect(limiter.record).toHaveBeenCalledWith(
          "u1",
          "create_transaction_rule",
        );
        expect(result.structuredContent).toEqual({ id: RULE });
      });

      it("commits when no dialog could be shown (the client's own prompt is the consent step)", async () => {
        const result = await call(createArgs);
        expect(elicitInput).not.toHaveBeenCalled();
        expect(aiActions.commitApproved).toHaveBeenCalledTimes(1);
        expect(result.isError).toBeUndefined();
      });

      it("writes nothing when the user declines", async () => {
        server.server.getClientCapabilities.mockReturnValue({
          elicitation: { form: {} },
        });
        elicitInput.mockResolvedValue({ action: "decline" });

        const result = await call(createArgs);

        expect(result.isError).toBe(true);
        expect(result.content[0].text).toContain("declined");
        expect(aiActions.commitApproved).not.toHaveBeenCalled();
        expect(limiter.record).not.toHaveBeenCalled();
      });

      it("shows a web-chat card, writing and confirming nothing, when serving a relayed prompt", async () => {
        relayService.emitPendingAction.mockResolvedValue(true);

        const result = await call(createArgs);

        expect(result.structuredContent.status).toBe("preview_shown");
        expect(aiActions.commitApproved).not.toHaveBeenCalled();
        expect(elicitInput).not.toHaveBeenCalled();
      });

      it.each([
        [
          "update",
          { operation: "update", ruleId: RULE, name: "Biedronka 2" },
          "update_transaction_rule",
        ],
        [
          "delete",
          { operation: "delete", ruleId: RULE },
          "delete_transaction_rule",
        ],
        ["run", { operation: "run", ruleId: RULE }, "run_transaction_rule"],
      ])("commits a %s through the same path", async (_n, args, type) => {
        aiActions.commitApproved.mockResolvedValue({
          type,
          id: RULE,
          ...(type === "run_transaction_rule"
            ? { ruleRun: { changed: 3, skipped: [] } }
            : {}),
        });

        const result = await call(args);

        expect(aiActions.commitApproved).toHaveBeenCalledWith(
          "u1",
          expect.objectContaining({ type }),
        );
        expect(limiter.record).toHaveBeenCalledWith("u1", type);
        if (type === "delete_transaction_rule") {
          expect(result.structuredContent).toEqual({ id: RULE, deleted: true });
        }
        if (type === "run_transaction_rule") {
          expect(result.structuredContent.ruleRun.changed).toBe(3);
        }
      });
    });

    describe("a 2026-07-28 request (multi round-trip)", () => {
      const codec = new McpRequestStateCodec({
        get: () => "unit-test-secret",
      } as any);

      function modernCtx(options: {
        requestState?: unknown;
        inputResponses?: Record<string, unknown>;
      }) {
        return mcpTestCtx(
          { userId: "u1", scopes: "read,write" },
          {
            sessionId: undefined,
            envelope: {
              [CLIENT_CAPABILITIES_META_KEY]: { elicitation: { form: {} } },
            },
            requestState: options.requestState,
            inputResponses: options.inputResponses,
          },
        );
      }
      const verified = async (asked: any) =>
        codec.verify(asked.requestState, {
          mcpReq: { method: "tools/call" },
          http: { authInfo: { clientId: "pat:t1" } },
        } as any);

      beforeEach(() => installConfirmSupport(server as any, codec));

      it("returns the question and writes nothing on the asking round", async () => {
        const result = await handlers["manage_transaction_rules"](
          createArgs,
          modernCtx({}),
        );
        expect(result.resultType).toBe("input_required");
        expect(aiActions.commitApproved).not.toHaveBeenCalled();
        expect(limiter.record).not.toHaveBeenCalled();
      });

      it("commits on the round the user accepted, and only then", async () => {
        const asked = await handlers["manage_transaction_rules"](
          createArgs,
          modernCtx({}),
        );
        const result = await handlers["manage_transaction_rules"](
          createArgs,
          modernCtx({
            requestState: await verified(asked),
            inputResponses: { confirm: { action: "accept", content: {} } },
          }),
        );
        expect(aiActions.commitApproved).toHaveBeenCalledTimes(1);
        expect(result.structuredContent.id).toBe(RULE);
      });

      it("writes nothing when the user declines on the second round", async () => {
        const asked = await handlers["manage_transaction_rules"](
          createArgs,
          modernCtx({}),
        );
        const result = await handlers["manage_transaction_rules"](
          createArgs,
          modernCtx({
            requestState: await verified(asked),
            inputResponses: { confirm: { action: "decline" } },
          }),
        );
        expect(result.isError).toBe(true);
        expect(aiActions.commitApproved).not.toHaveBeenCalled();
      });

      it("does not hand a confirmed retry to the web chat", async () => {
        const asked = await handlers["manage_transaction_rules"](
          createArgs,
          modernCtx({}),
        );
        relayService.emitPendingAction.mockClear();
        relayService.emitPendingAction.mockResolvedValue(true);
        await handlers["manage_transaction_rules"](
          createArgs,
          modernCtx({
            requestState: await verified(asked),
            inputResponses: { confirm: { action: "accept", content: {} } },
          }),
        );
        expect(relayService.emitPendingAction).not.toHaveBeenCalled();
        expect(aiActions.commitApproved).toHaveBeenCalledTimes(1);
      });

      it("refuses a retry that asks about a different change", async () => {
        const asked = await handlers["manage_transaction_rules"](
          createArgs,
          modernCtx({}),
        );
        prep.prepareCreate.mockResolvedValue({
          ok: true,
          preview: {
            rule: { ...ruleState, name: "Other" },
            labels: {},
            test,
          },
        });
        // A different message is not what the fingerprint covers; the
        // descriptor is. Change what the double puts in it.
        actionBuilder.buildCreateTransactionRule.mockImplementation(() => ({
          type: "create_transaction_rule",
          preview: {},
          descriptor: {
            type: "create_transaction_rule",
            userId: "u1",
            actionId: "another",
            expiresAt: 1,
            ruleId: "different",
          },
        }));
        const result = await handlers["manage_transaction_rules"](
          createArgs,
          modernCtx({
            requestState: await verified(asked),
            inputResponses: { confirm: { action: "accept", content: {} } },
          }),
        );
        expect(result.isError).toBe(true);
        expect(result.content[0].text).toContain("no longer matches");
        expect(aiActions.commitApproved).not.toHaveBeenCalled();
      });
    });
  });
});
