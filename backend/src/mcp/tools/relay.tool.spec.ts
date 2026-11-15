import { RELAY_POLL_REFUSED } from "../../ai/relay/ai-relay.service";
import { McpRelayTools } from "./relay.tool";
import { AiRelayService } from "../../ai/relay/ai-relay.service";
import { SecurityNoticeService } from "../../notifications/security-notice.service";
import { mcpTestCtx } from "../testing/mcp-test-context";

type Handler = (args: any, extra: any) => Promise<any>;

function register(
  relay: Partial<AiRelayService>,
  notices: Partial<SecurityNoticeService> = {
    relayCredentialFirstUse: jest.fn().mockResolvedValue(undefined),
  },
) {
  const handlers: Record<string, Handler> = {};
  const server = {
    registerTool: (name: string, _config: unknown, handler: Handler) => {
      handlers[name] = handler;
    },
  };
  new McpRelayTools(
    relay as AiRelayService,
    notices as SecurityNoticeService,
  ).register(server as any);
  return handlers;
}

const parse = (result: any) => result.structuredContent as any;

// The caller key a relay claim is bound to: the session id on a 2025-era
// connection. `ctx(undefined)` is a request with no identity on it at all.
const ctx = (
  user: { userId: string; scopes: string } | undefined = {
    userId: "user-1",
    scopes: "read",
  },
) => mcpTestCtx(user, { sessionId: "s" });

describe("McpRelayTools", () => {
  describe("get_next_prompt", () => {
    it("returns the claimed prompt when one is available", async () => {
      const claimed = {
        promptId: "p1",
        prompt: "hi",
        history: [],
      };
      const waitForPrompt = jest.fn().mockResolvedValue(claimed);
      const handlers = register({ waitForPrompt });
      const result = await handlers.get_next_prompt({}, ctx());
      // The credential binds the claim (#2176), beside the session.
      expect(waitForPrompt).toHaveBeenCalledWith("user-1", "s", "pat:t1");
      const body = parse(result);
      expect(body.hasPrompt).toBe(true);
      expect(body.promptId).toBe("p1");
      expect(body.prompt).toBe("hi");
    });

    it("announces the claiming credential once a prompt is claimed", async () => {
      const relayCredentialFirstUse = jest.fn().mockResolvedValue(undefined);
      const handlers = register(
        {
          waitForPrompt: jest
            .fn()
            .mockResolvedValue({ promptId: "p1", prompt: "hi", history: [] }),
        },
        { relayCredentialFirstUse },
      );
      await handlers.get_next_prompt({}, ctx());
      expect(relayCredentialFirstUse).toHaveBeenCalledWith("user-1", "pat:t1");
    });

    it("announces nothing when no prompt was claimed", async () => {
      const relayCredentialFirstUse = jest.fn();
      const handlers = register(
        {
          waitForPrompt: jest.fn().mockResolvedValue(null),
          shouldStopForIdle: jest.fn().mockResolvedValue(false),
        },
        { relayCredentialFirstUse },
      );
      await handlers.get_next_prompt({}, ctx());
      expect(relayCredentialFirstUse).not.toHaveBeenCalled();
    });

    it("includes attachment refs when the prompt carries uploads", async () => {
      const claimed = {
        promptId: "p1",
        prompt: "what is this?",
        history: [],
        attachments: [
          {
            id: "att-1",
            filename: "chart.png",
            mediaType: "image/png",
            kind: "image",
            uri: "monize-attachment://att-1",
          },
        ],
      };
      const handlers = register({
        waitForPrompt: jest.fn().mockResolvedValue(claimed),
      });
      const result = await handlers.get_next_prompt({}, ctx());
      const body = parse(result);
      expect(body.attachments).toHaveLength(1);
      expect(body.attachments[0].uri).toBe("monize-attachment://att-1");
    });

    it("returns hasPrompt:false when the poll window elapses (still listening)", async () => {
      const handlers = register({
        waitForPrompt: jest.fn().mockResolvedValue(null),
        shouldStopForIdle: jest.fn().mockResolvedValue(false),
      });
      const result = await handlers.get_next_prompt({}, ctx());
      expect(parse(result)).toEqual({ hasPrompt: false });
    });

    it("returns stop:true when the user has been inactive too long", async () => {
      const handlers = register({
        waitForPrompt: jest.fn().mockResolvedValue(null),
        shouldStopForIdle: jest.fn().mockResolvedValue(true),
      });
      const result = await handlers.get_next_prompt({}, ctx());
      expect(parse(result)).toEqual({ hasPrompt: false, stop: true });
    });

    it("tells a refused poll to stop because another connection serves the chat, without touching the idle clock", async () => {
      const shouldStopForIdle = jest.fn().mockResolvedValue(true);
      const handlers = register({
        waitForPrompt: jest.fn().mockResolvedValue(RELAY_POLL_REFUSED),
        shouldStopForIdle,
      });
      const result = await handlers.get_next_prompt({}, ctx());
      expect(parse(result)).toEqual({
        hasPrompt: false,
        heldElsewhere: true,
        stop: true,
      });
      expect(shouldStopForIdle).not.toHaveBeenCalled();
    });

    it("consults the idle clock for the holder's empty poll", async () => {
      const shouldStopForIdle = jest.fn().mockResolvedValue(false);
      const handlers = register({
        waitForPrompt: jest.fn().mockResolvedValue(null),
        shouldStopForIdle,
      });
      await handlers.get_next_prompt({}, ctx());
      expect(shouldStopForIdle).toHaveBeenCalledWith("user-1");
    });

    it("errors without user context", async () => {
      const handlers = register({});
      const result = await handlers.get_next_prompt({}, ctx(undefined));
      expect(result.isError).toBe(true);
    });

    it("errors without the read scope", async () => {
      const handlers = register({});
      const result = await handlers.get_next_prompt(
        {},
        ctx({ userId: "user-1", scopes: "reports" }),
      );
      expect(result.isError).toBe(true);
    });
  });

  describe("post_response", () => {
    it("reports delivered:true when the response is routed", async () => {
      const postResponse = jest.fn().mockResolvedValue(true);
      const handlers = register({ postResponse });
      const result = await handlers.post_response(
        { promptId: "p1", text: "answer" },
        ctx(),
      );
      expect(parse(result)).toEqual({ delivered: true });
      expect(postResponse).toHaveBeenCalledWith(
        "user-1",
        "p1",
        "answer",
        "pat:t1",
      );
    });

    it("reports delivered:false for an unknown prompt", async () => {
      const handlers = register({
        postResponse: jest.fn().mockResolvedValue(false),
      });
      const result = await handlers.post_response(
        { promptId: "p1", text: "answer" },
        ctx(),
      );
      expect(parse(result)).toEqual({ delivered: false });
    });
  });

  describe("report_progress", () => {
    it("streams the update and reports delivered:true", async () => {
      const reportProgress = jest.fn().mockResolvedValue(true);
      const handlers = register({ reportProgress });
      const result = await handlers.report_progress(
        { promptId: "p1", text: "looking up category" },
        ctx(),
      );
      expect(parse(result)).toEqual({ delivered: true });
      expect(reportProgress).toHaveBeenCalledWith(
        "user-1",
        "p1",
        "looking up category",
        // The calling session, so an agent that reconnected mid-prompt re-binds
        // its relay turn instead of losing it to the old session id.
        "s",
        "pat:t1",
      );
    });

    it("reports delivered:false when the prompt is no longer active", async () => {
      const handlers = register({
        reportProgress: jest.fn().mockResolvedValue(false),
      });
      const result = await handlers.report_progress(
        { promptId: "p1", text: "late update" },
        ctx(),
      );
      expect(parse(result)).toEqual({ delivered: false });
    });

    it("requires read scope", async () => {
      const handlers = register({});
      const result = await handlers.report_progress(
        { promptId: "p1", text: "x" },
        ctx({ userId: "user-1", scopes: "reports" }),
      );
      expect(result.isError).toBe(true);
    });
  });
});
