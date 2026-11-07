import { Injectable } from "@nestjs/common";
import { McpServer } from "@modelcontextprotocol/server";
import {
  SEARCH_HELP_DESCRIPTION,
  searchHelpSchema,
} from "../../ai/query/tool-input-schemas";
import { HelpService } from "../../help/help.service";
import {
  resolveUserContext,
  requireScope,
  toolResult,
  toolError,
  safeToolError,
} from "../mcp-context";
import { searchHelpOutput } from "../tool-output-schemas";
import { READ_ONLY } from "../mcp-annotations";

/**
 * `search_help` (in-app help plan 6): a read-only adapter over
 * `HelpService.getLlmHelp`, the method the assistant's executor calls too, so
 * an MCP client and the assistant are handed the same sections with the same
 * monize.net links. It reads only the bundled guide; the `read` scope is
 * asked for like every other read tool, though no user data is involved.
 */
@Injectable()
export class McpHelpTools {
  constructor(private readonly helpService: HelpService) {}

  register(server: McpServer) {
    server.registerTool(
      "search_help",
      {
        title: "Search the user guide",
        annotations: READ_ONLY,
        description: SEARCH_HELP_DESCRIPTION,
        inputSchema: searchHelpSchema,
        outputSchema: searchHelpOutput,
      },
      async (args, ctx) => {
        const user = resolveUserContext(ctx);
        if (!user) return toolError("No user context");
        const check = requireScope(user.scopes, "read");
        if (check.error) return check.result;

        try {
          return toolResult(
            this.helpService.getLlmHelp(args.query, { limit: args.limit }),
          );
        } catch (err: unknown) {
          return safeToolError(err);
        }
      },
    );
  }
}
