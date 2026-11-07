import { McpHelpTools } from "./help.tool";
import { mcpTestCtx, McpTestContext } from "../testing/mcp-test-context";
import { READ_ONLY } from "../mcp-annotations";
import { searchHelpOutput } from "../tool-output-schemas";
import {
  SEARCH_HELP_DESCRIPTION,
  searchHelpSchema,
} from "../../ai/query/tool-input-schemas";
import type { HelpService } from "../../help/help.service";
import type { LlmHelpAnswer } from "../../help/help-llm-shape";

/** What `HelpService.getLlmHelp` answers for one matched section. */
const ANSWER: LlmHelpAnswer = {
  available: true,
  guideVersion: "1.2.3",
  language: "en",
  sections: [
    {
      pageTitle: "Transactions",
      heading: "Creating a Split",
      url: "https://www.monize.net/docs/transactions#creating-a-split",
      text: "Removing the second-to-last row turns the transaction back into a regular one.",
    },
  ],
};

describe("McpHelpTools", () => {
  let helpService: {
    getLlmHelp: jest.MockedFunction<HelpService["getLlmHelp"]>;
  };
  let server: { registerTool: jest.Mock };
  let ctx: McpTestContext;
  const handlers: Record<string, (...args: any[]) => any> = {};

  beforeEach(() => {
    helpService = { getLlmHelp: jest.fn().mockReturnValue(ANSWER) };
    const tool = new McpHelpTools(helpService as any);
    server = {
      registerTool: jest.fn((name, _opts, handler) => {
        handlers[name] = handler;
      }),
    };
    ctx = mcpTestCtx();
    tool.register(server as any);
  });

  it("registers search_help read-only over the assistant's schema and description", () => {
    expect(server.registerTool).toHaveBeenCalledTimes(1);
    const [name, config] = server.registerTool.mock.calls[0];
    expect(name).toBe("search_help");
    expect(config.annotations).toBe(READ_ONLY);
    expect(config.description).toBe(SEARCH_HELP_DESCRIPTION);
    expect(config.inputSchema).toBe(searchHelpSchema);
    expect(config.outputSchema).toBe(searchHelpOutput);
  });

  it("errors when no user context exists", async () => {
    ctx.setUser(undefined);
    const result = await handlers["search_help"]({ query: "split" }, ctx);
    expect(result.isError).toBe(true);
    expect(helpService.getLlmHelp).not.toHaveBeenCalled();
  });

  it("requires the read scope", async () => {
    ctx.setUser({ userId: "u1", scopes: "write" });
    const result = await handlers["search_help"]({ query: "split" }, ctx);
    expect(result.isError).toBe(true);
    expect(helpService.getLlmHelp).not.toHaveBeenCalled();
  });

  it("answers the domain shape for the question and limit as given", async () => {
    ctx.setUser({ userId: "u1", scopes: "read" });

    const result = await handlers["search_help"](
      { query: "how do I undo a split?", limit: 3 },
      ctx,
    );

    expect(helpService.getLlmHelp).toHaveBeenCalledWith(
      "how do I undo a split?",
      { limit: 3 },
    );
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toEqual(ANSWER);
    expect(searchHelpOutput.safeParse(result.structuredContent).success).toBe(
      true,
    );
  });

  it("validates an answer with no sections, and one from a server with no guide", async () => {
    ctx.setUser({ userId: "u1", scopes: "read" });
    for (const answer of [
      { ...ANSWER, sections: [] },
      { ...ANSWER, available: false, sections: [] },
    ]) {
      helpService.getLlmHelp.mockReturnValueOnce(answer);
      const result = await handlers["search_help"]({ query: "zzz" }, ctx);
      expect(result.isError).toBeUndefined();
      expect(searchHelpOutput.safeParse(result.structuredContent).success).toBe(
        true,
      );
    }
  });

  it("hides an unexpected failure behind a generic error", async () => {
    ctx.setUser({ userId: "u1", scopes: "read" });
    helpService.getLlmHelp.mockImplementationOnce(() => {
      throw new Error("ENOENT /app/help/nav.json");
    });

    const result = await handlers["search_help"]({ query: "split" }, ctx);

    expect(result.isError).toBe(true);
    expect(result.content[0].text).not.toContain("ENOENT");
  });
});
