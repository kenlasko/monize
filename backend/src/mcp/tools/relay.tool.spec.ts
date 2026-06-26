import { McpRelayTools } from "./relay.tool";
import { AiRelayService } from "../../ai/relay/ai-relay.service";

type Handler = (args: any, extra: any) => Promise<any>;

function register(relay: Partial<AiRelayService>, scopes = "read") {
  const handlers: Record<string, Handler> = {};
  const server = {
    registerTool: (name: string, _config: unknown, handler: Handler) => {
      handlers[name] = handler;
    },
  };
  const resolve = (sessionId?: string) =>
    sessionId === "no-ctx" ? undefined : { userId: "user-1", scopes };
  new McpRelayTools(relay as AiRelayService).register(
    server as any,
    resolve as any,
  );
  return handlers;
}

const parse = (result: any) => JSON.parse(result.content[0].text);

describe("McpRelayTools", () => {
  describe("get_next_prompt", () => {
    it("returns the claimed prompt when one is available", async () => {
      const claimed = {
        promptId: "p1",
        prompt: "hi",
        history: [],
      };
      const handlers = register({
        waitForPrompt: jest.fn().mockResolvedValue(claimed),
      });
      const result = await handlers.get_next_prompt({}, { sessionId: "s" });
      const body = parse(result);
      expect(body.hasPrompt).toBe(true);
      expect(body.promptId).toBe("p1");
      expect(body.prompt).toBe("hi");
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
      const result = await handlers.get_next_prompt({}, { sessionId: "s" });
      const body = parse(result);
      expect(body.attachments).toHaveLength(1);
      expect(body.attachments[0].uri).toBe("monize-attachment://att-1");
    });

    it("returns hasPrompt:false when the poll window elapses", async () => {
      const handlers = register({
        waitForPrompt: jest.fn().mockResolvedValue(null),
      });
      const result = await handlers.get_next_prompt({}, { sessionId: "s" });
      expect(parse(result)).toEqual({ hasPrompt: false });
    });

    it("errors without user context", async () => {
      const handlers = register({});
      const result = await handlers.get_next_prompt(
        {},
        { sessionId: "no-ctx" },
      );
      expect(result.isError).toBe(true);
    });

    it("errors without the read scope", async () => {
      const handlers = register({}, "reports");
      const result = await handlers.get_next_prompt({}, { sessionId: "s" });
      expect(result.isError).toBe(true);
    });
  });

  describe("post_response", () => {
    it("reports delivered:true when the response is routed", async () => {
      const postResponse = jest.fn().mockReturnValue(true);
      const handlers = register({ postResponse });
      const result = await handlers.post_response(
        { promptId: "p1", text: "answer" },
        { sessionId: "s" },
      );
      expect(parse(result)).toEqual({ delivered: true });
      expect(postResponse).toHaveBeenCalledWith("user-1", "p1", "answer");
    });

    it("reports delivered:false for an unknown prompt", async () => {
      const handlers = register({
        postResponse: jest.fn().mockReturnValue(false),
      });
      const result = await handlers.post_response(
        { promptId: "p1", text: "answer" },
        { sessionId: "s" },
      );
      expect(parse(result)).toEqual({ delivered: false });
    });
  });

  describe("report_progress", () => {
    it("streams the update and reports delivered:true", async () => {
      const reportProgress = jest.fn().mockReturnValue(true);
      const handlers = register({ reportProgress });
      const result = await handlers.report_progress(
        { promptId: "p1", text: "looking up category" },
        { sessionId: "s" },
      );
      expect(parse(result)).toEqual({ delivered: true });
      expect(reportProgress).toHaveBeenCalledWith(
        "user-1",
        "p1",
        "looking up category",
      );
    });

    it("reports delivered:false when the prompt is no longer active", async () => {
      const handlers = register({
        reportProgress: jest.fn().mockReturnValue(false),
      });
      const result = await handlers.report_progress(
        { promptId: "p1", text: "late update" },
        { sessionId: "s" },
      );
      expect(parse(result)).toEqual({ delivered: false });
    });

    it("requires read scope", async () => {
      const handlers = register({}, "reports");
      const result = await handlers.report_progress(
        { promptId: "p1", text: "x" },
        { sessionId: "s" },
      );
      expect(result.isError).toBe(true);
    });
  });
});
