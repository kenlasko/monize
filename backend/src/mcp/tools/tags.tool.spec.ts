import { NotFoundException } from "@nestjs/common";
import { McpTagsTools } from "./tags.tool";
import { McpWriteLimiter } from "../mcp-write-limiter";
import { AuthAttemptCounterService } from "../../auth/auth-attempt-counter.service";
import { createAuthAttemptCounterMock } from "../../test-helpers/auth-attempt-counter-testing";
import { mcpTestCtx, McpTestContext } from "../testing/mcp-test-context";

const TAG = "50000000-0000-4000-8000-000000000001";

/**
 * A builder double that mints a FRESH envelope per call, as the real
 * `AiActionBuilderService` does (see transactions.tool.spec.ts for why a frozen
 * double hides a fingerprint defect).
 */
function buildActionBuilderMock(): Record<string, jest.Mock> {
  let minted = 0;
  const envelope = () => ({
    userId: "u1",
    actionId: `action-${++minted}`,
    expiresAt: 1_700_000_000_000 + minted,
  });
  return {
    buildTagAction: jest.fn((_userId: string, preview: any) => {
      const type =
        "useCount" in preview
          ? "delete_tag"
          : "tagId" in preview
            ? "update_tag"
            : "create_tag";
      return {
        type,
        preview: { name: preview.name ?? preview.currentName },
        descriptor: { ...envelope(), type, ...preview },
      };
    }),
    buildBatchActions: jest.fn((_userId: string, operation: string, rows) => ({
      type: "batch_actions",
      preview: { rows: [] },
      descriptor: { ...envelope(), type: "batch_actions", operation, rows },
    })),
  };
}

describe("McpTagsTools", () => {
  let tool: McpTagsTools;
  let tagsService: { getLlmTags: jest.Mock };
  let prep: Record<string, jest.Mock>;
  let relayService: { emitPendingAction: jest.Mock };
  let actionBuilder: Record<string, jest.Mock>;
  let aiActions: { commitApproved: jest.Mock };
  let limiter: McpWriteLimiter;
  let server: {
    registerTool: jest.Mock;
    server: { getClientCapabilities: jest.Mock };
  };
  let ctx: McpTestContext;
  const handlers: Record<string, (...args: any[]) => any> = {};
  const configs: Record<string, any> = {};

  const createPreview = { name: "Trip", color: null, icon: null };

  beforeEach(() => {
    tagsService = {
      getLlmTags: jest.fn().mockResolvedValue({
        tags: [{ id: TAG, name: "Trip", useCount: 2, lastUsed: "2026-10-01" }],
        total: 1,
        truncated: false,
      }),
    };
    prep = {
      prepareOne: jest.fn().mockResolvedValue(createPreview),
      prepareMany: jest.fn(async (_u: string, _op: string, rows: any[]) => ({
        okPreviews: rows.map((r) => ({
          name: r.name,
          color: null,
          icon: null,
        })),
        okRows: rows.map((r) => ({ name: r.name, color: null, icon: null })),
        previewRows: rows.map((r) => ({ status: "ok", name: r.name })),
        okIndex: rows.map((_r, i) => i),
        skipped: [],
      })),
    };
    relayService = { emitPendingAction: jest.fn().mockResolvedValue(false) };
    actionBuilder = buildActionBuilderMock();
    aiActions = {
      commitApproved: jest
        .fn()
        .mockResolvedValue({ type: "create_tag", id: TAG }),
    };
    limiter = new McpWriteLimiter(
      createAuthAttemptCounterMock() as unknown as AuthAttemptCounterService,
    );
    jest.spyOn(limiter, "record");
    tool = new McpTagsTools(
      tagsService as never,
      prep as never,
      relayService as never,
      actionBuilder as never,
      aiActions as never,
      limiter,
    );
    server = {
      registerTool: jest.fn((name, opts, handler) => {
        handlers[name] = handler;
        configs[name] = opts;
      }),
      // No elicitation capability: the "unsupported" path, where the client's
      // own tool-call prompt is the consent step.
      server: { getClientCapabilities: jest.fn().mockReturnValue({}) },
    };
    ctx = mcpTestCtx(undefined, {
      elicitInput: jest.fn().mockResolvedValue({ action: "accept" }),
    });
    tool.register(server as any);
  });

  const call = (
    name: string,
    args: Record<string, unknown>,
    scopes = "read,write",
  ) => {
    ctx.setUser({ userId: "u1", scopes });
    return handlers[name](args, ctx);
  };

  it("registers list_tags read-only and manage_tags as a delete-capable write", () => {
    expect(Object.keys(configs)).toEqual(["list_tags", "manage_tags"]);
    expect(configs["list_tags"].annotations).toMatchObject({
      readOnlyHint: true,
    });
    expect(configs["manage_tags"].annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: true,
    });
    for (const c of Object.values(configs)) {
      expect(c.title).toEqual(expect.any(String));
      expect(c.description).toEqual(expect.any(String));
      expect(c.inputSchema).toBeDefined();
      expect(c.outputSchema).toBeDefined();
    }
  });

  describe("list_tags", () => {
    it("answers the shared domain read with the read scope", async () => {
      const result = await call(
        "list_tags",
        { search: "tr", limit: 10 },
        "read",
      );
      expect(tagsService.getLlmTags).toHaveBeenCalledWith("u1", {
        search: "tr",
        limit: 10,
      });
      expect(result.structuredContent.tags[0].name).toBe("Trip");
      expect(result.structuredContent.total).toBe(1);
    });

    it("refuses without the read scope", async () => {
      const result = await call("list_tags", {}, "write");
      expect(result.isError).toBe(true);
      expect(tagsService.getLlmTags).not.toHaveBeenCalled();
    });
  });

  describe("manage_tags", () => {
    it("refuses without the write scope, before preparing anything", async () => {
      const result = await call(
        "manage_tags",
        { operation: "create", items: [{ name: "Trip" }] },
        "read",
      );
      expect(result.isError).toBe(true);
      expect(prep.prepareOne).not.toHaveBeenCalled();
    });

    it("commits one confirmed card through the confirm endpoint's executors", async () => {
      const result = await call("manage_tags", {
        operation: "create",
        items: [{ name: "Trip" }],
      });
      expect(prep.prepareOne).toHaveBeenCalledWith("u1", "create", {
        name: "Trip",
      });
      expect(aiActions.commitApproved).toHaveBeenCalledWith(
        "u1",
        expect.objectContaining({ type: "create_tag", name: "Trip" }),
      );
      expect(limiter.record).toHaveBeenCalledWith("u1", "create_tag");
      expect(result.structuredContent).toEqual({ id: TAG, count: 1 });
    });

    it("shows a relay card instead of writing on a web-chat turn", async () => {
      relayService.emitPendingAction.mockResolvedValue(true);
      const result = await call("manage_tags", {
        operation: "create",
        items: [{ name: "Trip" }],
      });
      expect(relayService.emitPendingAction).toHaveBeenCalled();
      expect(aiActions.commitApproved).not.toHaveBeenCalled();
      expect(result.isError).toBeFalsy();
    });

    it("previews without writing on a dry run", async () => {
      const result = await call("manage_tags", {
        operation: "delete",
        items: [{ name: "Trip" }],
        dryRun: true,
      });
      expect(prep.prepareMany).toHaveBeenCalledWith("u1", "delete", [
        { name: "Trip" },
      ]);
      expect(result.structuredContent.dryRun).toBe(true);
      expect(aiActions.commitApproved).not.toHaveBeenCalled();
    });

    it("surfaces a refusal from the shared prep and writes nothing", async () => {
      prep.prepareOne.mockRejectedValue(
        new NotFoundException("Unknown tag: Trp. Did you mean: Trip?"),
      );
      const result = await call("manage_tags", {
        operation: "delete",
        items: [{ name: "Trp" }],
      });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("Did you mean: Trip?");
      expect(aiActions.commitApproved).not.toHaveBeenCalled();
    });

    it("refuses newName outside an update", async () => {
      const result = await call("manage_tags", {
        operation: "create",
        items: [{ name: "Trip", newName: "Travel" }],
      });
      expect(result.isError).toBe(true);
      expect(prep.prepareOne).not.toHaveBeenCalled();
    });

    it("commits a batch of six as one card, counting each write", async () => {
      aiActions.commitApproved.mockResolvedValue({
        type: "batch_actions",
        id: "t1",
        ids: ["t1", "t2", "t3", "t4", "t5"],
        count: 5,
        skipped: [{ index: 2, reason: "Could not apply this row." }],
      });
      const items = ["A", "B", "C", "D", "E", "F"].map((name) => ({ name }));
      const result = await call("manage_tags", {
        operation: "create",
        items,
      });
      expect(actionBuilder.buildBatchActions).toHaveBeenCalledWith(
        "u1",
        "create_tag",
        expect.any(Array),
        expect.any(Array),
      );
      expect(aiActions.commitApproved).toHaveBeenCalledTimes(1);
      expect(limiter.record).toHaveBeenCalledTimes(5);
      expect(result.structuredContent.count).toBe(5);
      expect(result.structuredContent.skipped).toEqual([
        { index: 2, reason: "Could not apply this row." },
      ]);
    });

    it("commits each card of a small batch on its own", async () => {
      const result = await call("manage_tags", {
        operation: "create",
        items: [{ name: "A" }, { name: "B" }],
      });
      expect(actionBuilder.buildTagAction).toHaveBeenCalledTimes(2);
      expect(aiActions.commitApproved).toHaveBeenCalledTimes(2);
      expect(result.structuredContent.count).toBe(2);
    });
  });
});
