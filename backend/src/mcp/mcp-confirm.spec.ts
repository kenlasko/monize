import { ClientCapabilitiesSchema } from "@modelcontextprotocol/core/internal";
import {
  CLIENT_CAPABILITIES_META_KEY,
  ProtocolError,
  ProtocolErrorCode,
  SdkError,
  SdkErrorCode,
} from "@modelcontextprotocol/server";
import { Logger } from "@nestjs/common";
import {
  ConfirmMismatchError,
  ConfirmNotAnsweredError,
  ConfirmRequiredError,
  confirmWrite,
  confirmWriteMany,
  confirmationFingerprint,
  installConfirmSupport,
  isAsk,
  needsHumanAnswer,
  roundStableAction,
} from "./mcp-confirm";
import { AiActionBuilderService } from "../ai/actions/ai-action-builder.service";
import { AiActionSigningService } from "../ai/actions/ai-action-signing.service";
import type { CreateTransactionPreview } from "../transactions/transactions.service";
import { McpRequestStateCodec } from "./mcp-request-state";
import { mcpTestCtx, McpTestContext } from "./testing/mcp-test-context";

/**
 * The session's `McpServer`. It carries the client's advertised capabilities
 * and keys the per-session record of what that client actually does with a
 * dialog; every tool's `register` closure already holds it.
 */
function fakeServer(opts: { capabilities?: unknown }): any {
  return {
    server: {
      getClientCapabilities: jest.fn().mockReturnValue(opts.capabilities),
    },
  };
}

/** A peer's refusal crosses the wire; a timeout or a dropped connection does not. */
function buildError(code: unknown) {
  return typeof code === "number"
    ? new ProtocolError(code as ProtocolErrorCode, "client answered for itself")
    : new SdkError(code as SdkErrorCode, "client answered for itself");
}

describe("mcp-confirm", () => {
  describe("confirmWrite", () => {
    const caps = { elicitation: { form: {} } };
    let elicit: jest.Mock;
    let ctx: McpTestContext;

    beforeEach(() => {
      elicit = jest.fn();
      ctx = mcpTestCtx(
        { userId: "u1", scopes: "write" },
        { elicitInput: elicit },
      );
    });

    it("returns 'accepted' when the user accepts the elicitation", async () => {
      elicit.mockResolvedValue({ action: "accept" });
      const server = fakeServer({ capabilities: caps });
      await expect(confirmWrite(server, ctx, "Confirm?")).resolves.toBe(
        "accepted",
      );
      expect(elicit).toHaveBeenCalledWith(
        {
          message: "Confirm?",
          requestedSchema: { type: "object", properties: {} },
        },
        { timeout: expect.any(Number) },
      );
    });

    // A server-to-client request with no related request id is routed to the
    // standalone GET SSE stream, which a tool-calling client does not keep open
    // during a tools/call -- so the dialog is silently dropped and never shown.
    // Going out through the request-bound accessor is what relates it to the
    // call the client is waiting on.
    it("sends the elicitation through the tool call's own request", async () => {
      elicit.mockResolvedValue({ action: "accept" });
      const server = fakeServer({ capabilities: caps });
      await confirmWrite(server, ctx, "Confirm?");
      expect(ctx.mcpReq.elicitInput).toBe(elicit);
      expect(elicit).toHaveBeenCalledTimes(1);
    });

    it("returns 'declined' when the user declines or cancels", async () => {
      const server = fakeServer({ capabilities: caps });
      elicit.mockResolvedValue({ action: "decline" });
      await expect(confirmWrite(server, ctx, "Confirm?")).resolves.toBe(
        "declined",
      );

      const cancelCtx = mcpTestCtx(
        { userId: "u1", scopes: "write" },
        { elicitInput: jest.fn().mockResolvedValue({ action: "cancel" }) },
      );
      await expect(
        confirmWrite(fakeServer({ capabilities: caps }), cancelCtx, "Confirm?"),
      ).resolves.toBe("declined");
    });

    it("returns 'unsupported' without eliciting when the client lacks the capability", async () => {
      const server = fakeServer({ capabilities: {} });
      await expect(
        confirmWrite(server, ctx, "Confirm?", { type: "create_transaction" }),
      ).resolves.toBe("unsupported");
      expect(elicit).not.toHaveBeenCalled();
    });

    it("returns 'unsupported' when capabilities are undefined", async () => {
      const server = fakeServer({ capabilities: undefined });
      await expect(
        confirmWrite(server, ctx, "Confirm?", { type: "create_transaction" }),
      ).resolves.toBe("unsupported");
    });

    it("returns 'declined' (never silently proceeds) when a supported dialog fails in an unaccounted-for way", async () => {
      elicit.mockRejectedValue(new Error("boom"));
      const server = fakeServer({ capabilities: caps });
      await expect(confirmWrite(server, ctx, "Confirm?")).resolves.toBe(
        "declined",
      );
    });

    // The regression these guard: the SDK rewrites a bare
    // `{"elicitation":{}}` into `{"elicitation":{"form":{}}}`, so the
    // capability pre-check stopped separating a client that shows dialogs from
    // one that answers -32601 or never answers at all. Every such client then
    // looked form-capable, its non-answer was read as the user saying no, and
    // every write through Claude was refused (or hung past the client's own
    // tool deadline). Only observed behaviour can tell them apart.
    describe("a client that answers for itself", () => {
      it("pins the SDK normalization the old capability check relied on", () => {
        expect(ClientCapabilitiesSchema.parse({ elicitation: {} })).toEqual({
          elicitation: { form: {} },
        });
      });

      it.each([
        ["method not found", ProtocolErrorCode.MethodNotFound],
        ["invalid request", ProtocolErrorCode.InvalidRequest],
        ["invalid params", ProtocolErrorCode.InvalidParams],
        ["parse error", ProtocolErrorCode.ParseError],
        // The SDK refuses locally, before any network call, when the client
        // advertised no elicitation: no dialog reached a human either.
        [
          "a capability the client does not have",
          SdkErrorCode.CapabilityNotSupported,
        ],
      ])("returns 'unsupported' on %s", async (_label, code) => {
        elicit.mockRejectedValue(buildError(code));
        const server = fakeServer({ capabilities: caps });
        await expect(
          confirmWrite(server, ctx, "Confirm?", { type: "create_transaction" }),
        ).resolves.toBe("unsupported");
      });

      it.each([
        ["request timeout", SdkErrorCode.RequestTimeout],
        ["connection closed", SdkErrorCode.ConnectionClosed],
      ])(
        "refuses this write on %s without marking the session silent",
        async (_label, code) => {
          elicit
            .mockRejectedValueOnce(buildError(code))
            .mockResolvedValueOnce({ action: "accept" });
          const server = fakeServer({ capabilities: caps });
          const del = { type: "delete_transaction", id: "t1" };
          await expect(
            confirmWrite(server, ctx, "Delete?", del),
          ).rejects.toBeInstanceOf(ConfirmNotAnsweredError);
          await expect(confirmWrite(server, ctx, "Delete?", del)).resolves.toBe(
            "accepted",
          );
          expect(elicit).toHaveBeenCalledTimes(2);
        },
      );

      it.each([
        ["request timeout", SdkErrorCode.RequestTimeout],
        ["connection closed", SdkErrorCode.ConnectionClosed],
      ])(
        "lets a single create proceed on %s and stops asking",
        async (_label, code) => {
          elicit.mockRejectedValue(buildError(code));
          const server = fakeServer({ capabilities: caps });
          const create = { type: "create_transaction" };
          await expect(
            confirmWrite(server, ctx, "Create?", create),
          ).resolves.toBe("unsupported");
          await expect(
            confirmWrite(server, ctx, "Create?", create),
          ).resolves.toBe("unsupported");
          expect(elicit).toHaveBeenCalledTimes(1);
        },
      );

      it("still asks a delete after a single create timed out", async () => {
        elicit
          .mockRejectedValueOnce(buildError(SdkErrorCode.RequestTimeout))
          .mockResolvedValueOnce({ action: "accept" });
        const server = fakeServer({ capabilities: caps });
        await expect(
          confirmWrite(server, ctx, "Create?", { type: "create_transaction" }),
        ).resolves.toBe("unsupported");
        await expect(
          confirmWrite(server, ctx, "Delete?", {
            type: "delete_transaction",
            id: "t1",
          }),
        ).resolves.toBe("accepted");
        expect(elicit).toHaveBeenCalledTimes(2);
      });

      it("stops asking it for the rest of the session", async () => {
        elicit.mockRejectedValue(
          new ProtocolError(
            ProtocolErrorCode.MethodNotFound,
            "Method not found",
          ),
        );
        const server = fakeServer({ capabilities: caps });
        await confirmWrite(server, ctx, "Confirm?", {
          type: "create_transaction",
        });
        await expect(
          confirmWrite(server, ctx, "Confirm?", { type: "create_transaction" }),
        ).resolves.toBe("unsupported");
        expect(elicit).toHaveBeenCalledTimes(1);
      });

      it("keeps the session's memory to itself", async () => {
        elicit.mockRejectedValue(
          new ProtocolError(
            ProtocolErrorCode.MethodNotFound,
            "Method not found",
          ),
        );
        await confirmWrite(
          fakeServer({ capabilities: caps }),
          ctx,
          "Confirm?",
          {
            type: "create_transaction",
          },
        );

        // A different session's server, whose client does answer.
        const capableCtx = mcpTestCtx(
          { userId: "u1", scopes: "write" },
          { elicitInput: jest.fn().mockResolvedValue({ action: "decline" }) },
        );
        await expect(
          confirmWrite(
            fakeServer({ capabilities: caps }),
            capableCtx,
            "Confirm?",
          ),
        ).resolves.toBe("declined");
      });
    });

    // "unsupported" is also what a raw HTTP caller with a stolen
    // bearer produces, so a deletion or bulk write must not fall through.
    describe("when no dialog reached a human", () => {
      let warn: jest.SpyInstance;

      beforeEach(() => {
        warn = jest.spyOn(Logger.prototype, "warn").mockImplementation();
      });

      afterEach(() => warn.mockRestore());

      it.each([
        ["a deletion", { type: "delete_transaction", id: "t1" }],
        ["a bulk card", { type: "batch_actions", actions: [] }],
        ["a rule run", { type: "run_transaction_rule" }],
      ])("refuses %s from a client with no elicitation", async (_l, action) => {
        const server = fakeServer({ capabilities: {} });
        await expect(
          confirmWrite(server, ctx, "Delete?", action),
        ).rejects.toBeInstanceOf(ConfirmRequiredError);
        expect(elicit).not.toHaveBeenCalled();
      });

      it("still lets a single create through", async () => {
        const server = fakeServer({ capabilities: {} });
        await expect(
          confirmWrite(server, ctx, "Create?", { type: "create_transaction" }),
        ).resolves.toBe("unsupported");
        expect(elicit).not.toHaveBeenCalled();
      });

      it("refuses a deletion when the client advertises elicitation but never answers", async () => {
        elicit.mockRejectedValue(
          new SdkError(SdkErrorCode.RequestTimeout, "Request timed out"),
        );
        const server = fakeServer({ capabilities: caps });
        await expect(
          confirmWrite(server, ctx, "Delete?", {
            type: "delete_transaction",
            id: "t1",
          }),
        ).rejects.toBeInstanceOf(ConfirmNotAnsweredError);
        expect(warn).toHaveBeenLastCalledWith(
          expect.stringContaining("mcp-unconfirmed-write outcome=refused"),
        );
      });

      it("leaves a human's answer to a deletion alone", async () => {
        const server = fakeServer({ capabilities: caps });
        const action = { type: "delete_transaction", id: "t1" };
        elicit.mockResolvedValueOnce({ action: "accept" });
        await expect(
          confirmWrite(server, ctx, "Delete?", action),
        ).resolves.toBe("accepted");
        elicit.mockResolvedValueOnce({ action: "decline" });
        await expect(
          confirmWrite(server, ctx, "Delete?", action),
        ).resolves.toBe("declined");
        expect(warn).not.toHaveBeenCalled();
      });

      it("logs what it let through and what it refused", async () => {
        const server = fakeServer({ capabilities: {} });
        await confirmWrite(server, ctx, "Create?", {
          type: "create_transaction",
        });
        expect(warn).toHaveBeenLastCalledWith(
          expect.stringContaining("mcp-unconfirmed-write outcome=allowed"),
        );
        expect(warn).toHaveBeenLastCalledWith(
          expect.stringContaining("actions=create_transaction"),
        );
        expect(warn).toHaveBeenLastCalledWith(
          expect.stringContaining("user=u1 credential=pat:t1"),
        );

        await expect(
          confirmWrite(server, ctx, "Delete?", {
            type: "delete_transaction",
            id: "t1",
          }),
        ).rejects.toBeInstanceOf(ConfirmRequiredError);
        expect(warn).toHaveBeenLastCalledWith(
          expect.stringContaining("mcp-unconfirmed-write outcome=refused"),
        );
      });
    });

    describe("a client that has already shown a dialog", () => {
      it("refuses a later unanswered one rather than writing", async () => {
        elicit
          .mockResolvedValueOnce({ action: "accept" })
          .mockRejectedValueOnce(
            new SdkError(SdkErrorCode.RequestTimeout, "Request timed out"),
          );
        const server = fakeServer({ capabilities: caps });
        await expect(confirmWrite(server, ctx, "Confirm?")).resolves.toBe(
          "accepted",
        );
        await expect(confirmWrite(server, ctx, "Confirm?")).resolves.toBe(
          "declined",
        );
      });

      it("is not demoted by that failure", async () => {
        elicit
          .mockResolvedValueOnce({ action: "accept" })
          .mockRejectedValueOnce(
            new SdkError(SdkErrorCode.RequestTimeout, "Request timed out"),
          )
          .mockResolvedValueOnce({ action: "accept" });
        const server = fakeServer({ capabilities: caps });
        await confirmWrite(server, ctx, "Confirm?");
        await confirmWrite(server, ctx, "Confirm?");
        await expect(confirmWrite(server, ctx, "Confirm?")).resolves.toBe(
          "accepted",
        );
        expect(elicit).toHaveBeenCalledTimes(3);
      });
    });

    // The wait has to end before the client abandons the tool call that is
    // waiting on it, or an unanswerable dialog produces no result at all --
    // which is how a five-minute wait surfaced as an opaque client-side
    // "timed out after 60s" with no write and no explanation.
    it("waits less than the shortest client tool deadline", async () => {
      elicit.mockResolvedValue({ action: "accept" });
      const server = fakeServer({ capabilities: caps });
      await confirmWrite(server, ctx, "Confirm?");
      const { timeout } = elicit.mock.calls[0][1];
      expect(timeout).toBeGreaterThan(20_000);
      expect(timeout).toBeLessThan(60_000);
    });
  });

  // On 2026-07-28 there is no server-side wait: the tool returns the question
  // and the client calls it again with the answer. Everything the second round
  // needs travels in the sealed state and comes back, so the server holds
  // nothing in between -- which is what makes the endpoint stateless.
  describe("confirmWriteMany on a 2026-07-28 request", () => {
    const CAPS_KEY = CLIENT_CAPABILITIES_META_KEY;
    const items = [
      { key: "card-0", message: "Delete rent?", action: { id: "t1" } },
      { key: "card-1", message: "Delete gym?", action: { id: "t2" } },
    ];
    let codec: McpRequestStateCodec;
    let server: any;

    function modernCtx(options: {
      capabilities?: unknown;
      requestState?: unknown;
      inputResponses?: Record<string, unknown>;
    }) {
      return mcpTestCtx(
        { userId: "u1", scopes: "write" },
        {
          sessionId: undefined,
          envelope: {
            [CAPS_KEY]: options.capabilities ?? { elicitation: { form: {} } },
          },
          requestState: options.requestState,
          inputResponses: options.inputResponses,
        },
      );
    }

    /** What the client echoes for an answered dialog. */
    const answered = (action: "accept" | "decline" | "cancel") => ({
      action,
      content: action === "accept" ? {} : undefined,
    });

    beforeEach(() => {
      codec = new McpRequestStateCodec({
        get: () => "unit-test-secret",
      } as any);
      server = fakeServer({ capabilities: undefined });
      installConfirmSupport(server, codec);
    });

    it("asks once for every item, sealing what it asked", async () => {
      const ctx = modernCtx({});
      const outcome = await confirmWriteMany(server, ctx, items);
      if (!isAsk(outcome)) throw new Error("expected a question");

      expect(Object.keys(outcome.ask.inputRequests ?? {})).toEqual([
        "card-0",
        "card-1",
      ]);
      // The seal verifies under the same request, and carries the fingerprint
      // of exactly these items rather than any row data.
      const state = await codec.verify(
        outcome.ask.requestState as string,
        ctx as never,
      );
      expect(state).toEqual({
        v: 1,
        keys: ["card-0", "card-1"],
        fingerprint: confirmationFingerprint(items),
      });
      expect(JSON.stringify(state)).not.toContain("t1");
    });

    it("reads each answer on the round that writes", async () => {
      const state = {
        v: 1 as const,
        keys: ["card-0", "card-1"],
        fingerprint: confirmationFingerprint(items),
      };
      const outcome = await confirmWriteMany(
        server,
        modernCtx({
          requestState: state,
          inputResponses: {
            "card-0": answered("accept"),
            "card-1": answered("decline"),
          },
        }),
        items,
      );
      if (isAsk(outcome)) throw new Error("expected answers");
      expect(outcome.get("card-0")).toBe("accepted");
      expect(outcome.get("card-1")).toBe("declined");
    });

    it.each([
      ["a cancelled dialog", { "card-0": answered("cancel") }],
      ["an answer that never came", {}],
      ["a response of another shape", { "card-0": { roots: [] } }],
    ])("refuses the write on %s", async (_label, inputResponses) => {
      const state = {
        v: 1 as const,
        keys: ["card-0"],
        fingerprint: confirmationFingerprint([items[0]]),
      };
      const outcome = await confirmWriteMany(
        server,
        modernCtx({ requestState: state, inputResponses }),
        [items[0]],
      );
      if (isAsk(outcome)) throw new Error("expected answers");
      expect(outcome.get("card-0")).toBe("declined");
    });

    // The seam proves the state is ours and unexpired. What it cannot know is
    // whether the retry is about the SAME change: a name that now resolves to
    // another row, or an amount the model altered between rounds, would
    // otherwise commit under a confirmation the user gave for something else.
    it("refuses a retry that re-derived a different change", async () => {
      const state = {
        v: 1 as const,
        keys: ["card-0", "card-1"],
        fingerprint: confirmationFingerprint(items),
      };
      const moved = [items[0], { ...items[1], action: { id: "t9" } }];
      await expect(
        confirmWriteMany(
          server,
          modernCtx({
            requestState: state,
            inputResponses: {
              "card-0": answered("accept"),
              "card-1": answered("accept"),
            },
          }),
          moved,
        ),
      ).rejects.toBeInstanceOf(ConfirmMismatchError);
    });

    it("refuses a retry about a different set of items", async () => {
      const state = {
        v: 1 as const,
        keys: ["card-0", "card-1"],
        fingerprint: confirmationFingerprint(items),
      };
      await expect(
        confirmWriteMany(server, modernCtx({ requestState: state }), [
          items[0],
        ]),
      ).rejects.toBeInstanceOf(ConfirmMismatchError);
    });

    // A client that declared no elicitation cannot be sent one: the SDK answers
    // -32021 and the whole tool call fails, where today it falls through to the
    // client's own approval prompt -- the only consent step such a client has.
    it("does not ask a client that declared no elicitation", async () => {
      const outcome = await confirmWriteMany(
        server,
        modernCtx({ capabilities: {} }),
        [{ ...items[0], action: { type: "create_transaction" } }],
      );
      if (isAsk(outcome)) throw new Error("expected no question");
      expect([...outcome.values()]).toEqual(["unsupported"]);
    });

    it("refuses a round of several items for a client that declared no elicitation", async () => {
      await expect(
        confirmWriteMany(server, modernCtx({ capabilities: {} }), items),
      ).rejects.toBeInstanceOf(ConfirmRequiredError);
    });

    // A state nobody can seal is attacker-controlled input on the way back.
    it("refuses rather than asking when no codec is installed", async () => {
      const outcome = await confirmWriteMany(
        fakeServer({ capabilities: undefined }),
        modernCtx({}),
        items,
      );
      if (isAsk(outcome)) throw new Error("expected no question");
      expect([...outcome.values()]).toEqual(["declined", "declined"]);
    });

    describe("the seal", () => {
      it("is refused when another credential presents it", async () => {
        const asked = modernCtx({});
        const outcome = await confirmWriteMany(server, asked, items);
        if (!isAsk(outcome)) throw new Error("expected a question");

        const otherCaller = mcpTestCtx(
          { userId: "u1", scopes: "write", credentialId: "pat:other" },
          { sessionId: undefined, envelope: {} },
        );
        await expect(
          codec.verify(
            outcome.ask.requestState as string,
            otherCaller as never,
          ),
        ).rejects.toThrow();
      });

      it("is refused when replayed against another tool", async () => {
        const asked = modernCtx({});
        const outcome = await confirmWriteMany(server, asked, items);
        if (!isAsk(outcome)) throw new Error("expected a question");

        const otherMethod = modernCtx({});
        (otherMethod.mcpReq as { method: string }).method = "prompts/get";
        await expect(
          codec.verify(
            outcome.ask.requestState as string,
            otherMethod as never,
          ),
        ).rejects.toThrow();
      });
    });
  });
});

/**
 * The fingerprint has to survive being computed twice, because that is the
 * whole of a multi round-trip confirmation: round one asks, round two rebuilds
 * the same change from the same arguments and must recognise it.
 *
 * These drive the REAL action builder rather than a double. A double that
 * returns one frozen object agrees with itself no matter what the fingerprint
 * hashes, which is how a descriptor carrying a per-build `actionId` and
 * `expiresAt` shipped: every confirmed write on 2026-07-28 was refused with
 * "the confirmation no longer matches the change", and every test was green.
 */
describe("needsHumanAnswer", () => {
  const item = (action?: unknown) => ({ key: "k", message: "m", action });

  it.each([
    ["a single update", [item({ type: "update_transaction" })], false],
    ["a single item with no action", [item()], true],
    ["a single item with an unknown type", [item({ type: "nope" })], true],
    ["an array of one card", [item([{ type: "create_transaction" }])], false],
    [
      "an array of several cards",
      [item([{ type: "create_transaction" }, { type: "create_transfer" }])],
      true,
    ],
    ["two items", [item(), item()], true],
    [
      "a one-row batch that is not a delete",
      [item({ type: "batch_actions", operation: "create_payee", rows: [{}] })],
      false,
    ],
    [
      "a one-row batch that deletes",
      [item({ type: "batch_actions", operation: "delete_payee", rows: [{}] })],
      true,
    ],
    [
      "a two-row batch",
      [
        item({
          type: "batch_actions",
          operation: "create_payee",
          rows: [{}, {}],
        }),
      ],
      true,
    ],
    ["a batch with no rows array", [item({ type: "batch_actions" })], true],
    [
      "a one-row create_transactions card",
      [item({ type: "create_transactions", rows: [{}] })],
      false,
    ],
    [
      "a one-row create_investment_transactions card",
      [item({ type: "create_investment_transactions", rows: [{}] })],
      false,
    ],
    [
      "a two-row create_transactions card",
      [item({ type: "create_transactions", rows: [{}, {}] })],
      true,
    ],
    [
      "a one-row run_transaction_rule card",
      [item({ type: "run_transaction_rule", rows: [{}] })],
      true,
    ],
    ["a delete_tag action", [item({ type: "delete_tag" })], true],
  ])("is decided for %s", (_label, items, expected) => {
    expect(needsHumanAnswer(items)).toBe(expected);
  });
});

describe("the fingerprint of a real action, across two rounds", () => {
  const builder = new AiActionBuilderService(
    new AiActionSigningService({
      get: () => "unit-test-secret",
    } as never),
  );

  const preview: CreateTransactionPreview = {
    accountId: "acc-1",
    accountName: "Checking",
    amount: -50,
    transactionDate: "2025-01-15",
    payeeId: null,
    payeeName: "Store",
    payeeMatched: false,
    payeeWillBeCreated: true,
    categoryId: "cat-1",
    categoryName: "Groceries",
    description: null,
    currencyCode: "CAD",
  };

  /** What a tool passes to `confirmWrite`, built fresh as each round does. */
  const round = (action: unknown) => [
    { key: "confirm", message: "Create this transaction?", action },
  ];

  it("agrees with itself when the same change is re-derived", () => {
    const first = builder.buildCreateTransaction("u1", preview);
    const second = builder.buildCreateTransaction("u1", preview);

    // The premise: the two descriptors are NOT equal, so this is a real test.
    expect(second.descriptor).not.toEqual(first.descriptor);
    expect(confirmationFingerprint(round(second.descriptor))).toBe(
      confirmationFingerprint(round(first.descriptor)),
    );
  });

  it("agrees when the change carries attachments parked in a new slot", () => {
    const attachment = {
      filename: "receipt.png",
      contentType: "image/png",
      byteSize: 1024,
      sha256: "a".repeat(64),
    };
    const first = builder.buildCreateTransaction("u1", preview, undefined, [
      { attachmentRefId: "ref-round-one", ...attachment },
    ]);
    const second = builder.buildCreateTransaction("u1", preview, undefined, [
      { attachmentRefId: "ref-round-two", ...attachment },
    ]);

    expect(confirmationFingerprint(round(second.descriptor))).toBe(
      confirmationFingerprint(round(first.descriptor)),
    );
  });

  // The projection removes the round, not the change: everything that says
  // WHAT is being approved has to survive it, or the fingerprint stops
  // catching a retry that altered the change.
  it("still separates two different changes", () => {
    const first = builder.buildCreateTransaction("u1", preview);
    const other = builder.buildCreateTransaction("u1", {
      ...preview,
      amount: -999,
    });

    expect(confirmationFingerprint(round(other.descriptor))).not.toBe(
      confirmationFingerprint(round(first.descriptor)),
    );
  });

  it("still separates the same change against another account", () => {
    const first = builder.buildCreateTransaction("u1", preview);
    const other = builder.buildCreateTransaction("u1", {
      ...preview,
      accountId: "acc-2",
      accountName: "Savings",
    });

    expect(confirmationFingerprint(round(other.descriptor))).not.toBe(
      confirmationFingerprint(round(first.descriptor)),
    );
  });

  it("still separates a different file behind the same parking slot", () => {
    const slot = "ref-1";
    const first = builder.buildCreateTransaction("u1", preview, undefined, [
      {
        attachmentRefId: slot,
        filename: "receipt.png",
        contentType: "image/png",
        byteSize: 1024,
        sha256: "a".repeat(64),
      },
    ]);
    const other = builder.buildCreateTransaction("u1", preview, undefined, [
      {
        attachmentRefId: slot,
        filename: "receipt.png",
        contentType: "image/png",
        byteSize: 1024,
        sha256: "b".repeat(64),
      },
    ]);

    expect(confirmationFingerprint(round(other.descriptor))).not.toBe(
      confirmationFingerprint(round(first.descriptor)),
    );
  });

  // A batch descriptor nests its rows, and a row can nest attachments, so the
  // projection has to reach every depth rather than the top level only.
  it("removes the per-build fields at every depth", () => {
    expect(
      roundStableAction({
        type: "batch_actions",
        actionId: "a1",
        expiresAt: 1,
        rows: [
          {
            actionId: "a2",
            amount: -50,
            attachments: [{ attachmentRefId: "r1", sha256: "abc" }],
          },
        ],
      }),
    ).toEqual({
      type: "batch_actions",
      rows: [{ amount: -50, attachments: [{ sha256: "abc" }] }],
    });
  });
});
