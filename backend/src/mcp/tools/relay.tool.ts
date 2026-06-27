import { Injectable } from "@nestjs/common";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { AiRelayService } from "../../ai/relay/ai-relay.service";
import {
  UserContextResolver,
  requireScope,
  toolResult,
  toolError,
  safeToolError,
} from "../mcp-context";
import {
  getNextPromptOutput,
  postResponseOutput,
  reportProgressOutput,
} from "../tool-output-schemas";
import { READ_ONLY } from "../mcp-annotations";

/**
 * Reverse-relay control tools. These do not touch the financial dataset -- they
 * route a chat prompt from the Monize web UI to this agent and the answer back
 * -- so both carry the READ_ONLY annotation (the hint describes effect on the
 * user's data, which is none here). The agent does the actual work through the
 * other MCP tools between `get_next_prompt` and `post_response`.
 *
 * Usage pattern the agent is told to follow: loop forever -- call
 * `get_next_prompt`; if `hasPrompt` is false, call it again; otherwise handle
 * the request with the Monize tools, narrating progress with `report_progress`
 * as it goes, then call `post_response` with the final answer, then loop.
 */
@Injectable()
export class McpRelayTools {
  constructor(private readonly relayService: AiRelayService) {}

  register(server: McpServer, resolve: UserContextResolver) {
    server.registerTool(
      "get_next_prompt",
      {
        title: "Wait for the next chat prompt",
        annotations: READ_ONLY,
        description:
          "Long-poll for the next prompt a user typed in the Monize web chat. Returns { hasPrompt: false } if none arrives within the poll window -- in that case call this tool again immediately to keep listening. When hasPrompt is true, handle the request using the other Monize tools, calling report_progress with short status updates as you work (before a lookup, or when sending a confirmation card), then call post_response with promptId and your final answer. ALWAYS finish a claimed prompt and call post_response, even for a long task: never abandon it partway. Send your FIRST report_progress immediately after claiming a prompt, and keep sending one at least every minute or two while you read, plan, or compose a large request -- the web chat shows the user a 'went quiet' message if it hears nothing from you for a few minutes, and a steady progress signal prevents that. 'history' is the prior conversation, oldest first. If 'attachments' is present, the user uploaded files with the prompt: read each attachment's 'uri' (a monize-attachment:// resource) to view the file before answering. Text files are also inlined into the prompt text, so you only need to read image and PDF attachments.",
        inputSchema: {},
        outputSchema: getNextPromptOutput,
      },
      async (_args, extra) => {
        const ctx = resolve(extra.sessionId);
        if (!ctx) return toolError("No user context");
        const check = requireScope(ctx.scopes, "read");
        if (check.error) return check.result;

        try {
          const claimed = await this.relayService.waitForPrompt(ctx.userId);
          if (!claimed) {
            return toolResult({ hasPrompt: false });
          }
          return toolResult({
            hasPrompt: true,
            promptId: claimed.promptId,
            prompt: claimed.prompt,
            history: claimed.history,
            ...(claimed.attachments
              ? { attachments: claimed.attachments }
              : {}),
          });
        } catch (err: unknown) {
          return safeToolError(err);
        }
      },
    );

    server.registerTool(
      "post_response",
      {
        title: "Send a chat answer",
        annotations: READ_ONLY,
        description:
          "Deliver your answer for a prompt obtained from get_next_prompt back to the Monize web chat. Pass the promptId you received and the full answer text. Always post your final answer, even if the task ran long: { delivered: true } is returned even when the user's live request already timed out -- the answer is buffered and shown as soon as the web chat reconnects, so it is never wasted. { delivered: false } is rare and means the promptId is unknown or was already answered; only then move on without retrying.",
        inputSchema: {
          promptId: z
            .string()
            .uuid()
            .describe("The promptId from get_next_prompt"),
          text: z
            .string()
            .max(50000)
            .describe("The answer to show the user in the chat"),
        },
        outputSchema: postResponseOutput,
      },
      async (args, extra) => {
        const ctx = resolve(extra.sessionId);
        if (!ctx) return toolError("No user context");
        const check = requireScope(ctx.scopes, "read");
        if (check.error) return check.result;

        try {
          const delivered = this.relayService.postResponse(
            ctx.userId,
            args.promptId,
            args.text,
          );
          return toolResult({ delivered });
        } catch (err: unknown) {
          return safeToolError(err);
        }
      },
    );

    server.registerTool(
      "report_progress",
      {
        title: "Stream a progress update",
        annotations: READ_ONLY,
        description:
          "Stream a short, human-readable progress update to the Monize web chat while you work on a prompt from get_next_prompt. Shown live to the user as the assistant's running narration (e.g. 'Looking up the sporting goods category...' or 'Dry run looks good, sending the confirmation card.'). Call it whenever you start a lookup or make a decision, before the relevant tool call, and at least every minute or two during long reading/planning so the chat does not think you went quiet. Pass the promptId you are handling and one concise sentence. This does not answer the prompt -- still call post_response with the final answer when done. { delivered: false } means the web chat is not attached to your live narration right now (it may have stopped waiting after a silent gap). This is NOT a signal to abandon the prompt: keep working and still send your confirmation cards and your final post_response -- those ARE buffered and shown to the user when the chat reconnects, even though live progress lines are not. You may stop sending further progress lines once you see delivered:false, but you must still complete the task and post_response.",
        inputSchema: {
          promptId: z
            .string()
            .uuid()
            .describe("The promptId from get_next_prompt"),
          text: z
            .string()
            .max(2000)
            .describe("A short status update to show the user"),
        },
        outputSchema: reportProgressOutput,
      },
      async (args, extra) => {
        const ctx = resolve(extra.sessionId);
        if (!ctx) return toolError("No user context");
        const check = requireScope(ctx.scopes, "read");
        if (check.error) return check.result;

        try {
          const delivered = this.relayService.reportProgress(
            ctx.userId,
            args.promptId,
            args.text,
          );
          return toolResult({ delivered });
        } catch (err: unknown) {
          return safeToolError(err);
        }
      },
    );
  }
}
