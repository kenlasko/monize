import { Injectable } from "@nestjs/common";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/server";
import {
  AiRelayService,
  RELAY_POLL_REFUSED,
} from "../../ai/relay/ai-relay.service";
import { SecurityNoticeService } from "../../notifications/security-notice.service";
import {
  callerKey,
  resolveUserContext,
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
import { RELAY_TURN_GUIDANCE } from "../relay-guidance";
import { uuidString } from "./schema-fragments";

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
  constructor(
    private readonly relayService: AiRelayService,
    private readonly securityNotices: SecurityNoticeService,
  ) {}

  register(server: McpServer) {
    server.registerTool(
      "get_next_prompt",
      {
        title: "Wait for the next chat prompt",
        annotations: READ_ONLY,
        description:
          "Long-poll for the next prompt typed in the Monize web chat. " +
          "{ hasPrompt: false }: call again. With stop: true the user went " +
          "inactive: exit, they will reconnect you. With heldElsewhere: true " +
          "another connection of this account serves the chat: stop and " +
          "exit. { hasPrompt: true }: carries the prompt, `history` (oldest " +
          "first), any `attachments` (read each `uri`; text files are inlined) " +
          "and `guidance` -- follow it, and always finish the prompt with post_response.",
        inputSchema: z.object({}),
        outputSchema: getNextPromptOutput,
      },
      async (_args, ctx) => {
        const user = resolveUserContext(ctx);
        // The credential is what a relay turn is bound to (#2176); a request
        // that cannot name one is refused rather than served user-wide.
        if (!user?.credentialId) return toolError("No user context");
        const check = requireScope(user.scopes, "read");
        if (check.error) return check.result;

        try {
          // The claim is bound to THIS caller: it is what makes a later write
          // from this agent part of the relay turn, and a write from any other
          // caller of the same user a direct client's. Only the credential
          // serving the user's chat claims anything; another one comes back
          // empty, never with someone else's prompt.
          const claimed = await this.relayService.waitForPrompt(
            user.userId,
            callerKey(ctx),
            user.credentialId,
          );
          if (claimed === RELAY_POLL_REFUSED) {
            // Stop, but not through the idle clock: it is per user, and a
            // refused poller must not consume the stop meant for the holder.
            return toolResult({
              hasPrompt: false,
              heldElsewhere: true,
              stop: true,
            });
          }
          if (!claimed) {
            // No prompt this window. If the user has gone quiet long enough,
            // tell the agent to stop looping instead of polling forever.
            if (await this.relayService.shouldStopForIdle(user.userId)) {
              return toolResult({ hasPrompt: false, stop: true });
            }
            return toolResult({ hasPrompt: false });
          }
          // First claim by a credential: the dedupe key makes a repeat a no-op.
          // Awaits only the row write (the fan-out is detached); never throws.
          if (user.credentialId) {
            await this.securityNotices.relayCredentialFirstUse(
              user.userId,
              user.credentialId,
            );
          }
          return toolResult({
            hasPrompt: true,
            promptId: claimed.promptId,
            prompt: claimed.prompt,
            history: claimed.history,
            // Travels with the claimed prompt rather than in the server
            // instructions, so only a relay turn pays for it.
            guidance: RELAY_TURN_GUIDANCE,
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
          "Deliver the final answer for a prompt from get_next_prompt. Always " +
          "post it, however long the task ran: a buffered answer is shown when " +
          "the chat reconnects, so it is never wasted. delivered:false means " +
          "the promptId is unknown or already answered -- only then move on.",
        inputSchema: z.object({
          promptId: uuidString().describe("The promptId from get_next_prompt."),
          text: z.string().max(50000).describe("The answer to show the user."),
        }),
        outputSchema: postResponseOutput,
      },
      async (args, ctx) => {
        const user = resolveUserContext(ctx);
        // The credential is what a relay turn is bound to (#2176); a request
        // that cannot name one is refused rather than served user-wide.
        if (!user?.credentialId) return toolError("No user context");
        const check = requireScope(user.scopes, "read");
        if (check.error) return check.result;

        try {
          // Only the credential that claimed the turn may answer it.
          const delivered = await this.relayService.postResponse(
            user.userId,
            args.promptId,
            args.text,
            user.credentialId,
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
          "Stream one short sentence of live narration to the web chat while " +
          'you work on a claimed prompt ("Looking up the groceries ' +
          'category..."): before each lookup or decision, and at least every ' +
          "minute or two. It does not answer the prompt: finish with " +
          "post_response. delivered:false means only that narration is not " +
          "attached now; keep working, cards and your answer are still shown.",
        inputSchema: z.object({
          promptId: uuidString().describe("The promptId from get_next_prompt."),
          text: z.string().max(2000).describe("One short status sentence."),
        }),
        outputSchema: reportProgressOutput,
      },
      async (args, ctx) => {
        const user = resolveUserContext(ctx);
        // The credential is what a relay turn is bound to (#2176); a request
        // that cannot name one is refused rather than served user-wide.
        if (!user?.credentialId) return toolError("No user context");
        const check = requireScope(user.scopes, "read");
        if (check.error) return check.result;

        try {
          const delivered = await this.relayService.reportProgress(
            user.userId,
            args.promptId,
            args.text,
            // Re-binds the turn when an agent reconnects mid-prompt with a
            // fresh caller key -- only for the credential that claimed it.
            callerKey(ctx),
            user.credentialId,
          );
          return toolResult({ delivered });
        } catch (err: unknown) {
          return safeToolError(err);
        }
      },
    );
  }
}
