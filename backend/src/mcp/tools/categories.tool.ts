import { Injectable } from "@nestjs/common";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CategoriesService } from "../../categories/categories.service";
import {
  UserContextResolver,
  requireScope,
  toolResult,
  toolError,
  safeToolError,
} from "../mcp-context";
import { getCategoriesOutput } from "../tool-output-schemas";
import { READ_ONLY } from "../mcp-annotations";

@Injectable()
export class McpCategoriesTools {
  constructor(private readonly categoriesService: CategoriesService) {}

  register(server: McpServer, resolve: UserContextResolver) {
    server.registerTool(
      "get_categories",
      {
        title: "List categories",
        annotations: READ_ONLY,
        description:
          "List the user's categories with their hierarchy (parent names) and transaction counts. Optionally filter by type or search by name. Returns the same shape as the AI Assistant's get_categories tool.",
        inputSchema: {
          type: z
            .enum(["expense", "income", "all"])
            .optional()
            .describe(
              "Filter by category type. Defaults to 'all' when omitted.",
            ),
          search: z
            .string()
            .max(100)
            .optional()
            .describe(
              "Optional case-insensitive substring match on category name. Matched subcategories' parents are included so hierarchy stays visible.",
            ),
        },
        outputSchema: getCategoriesOutput,
      },
      async (args, extra) => {
        const ctx = resolve(extra.sessionId);
        if (!ctx) return toolError("No user context");
        const check = requireScope(ctx.scopes, "read");
        if (check.error) return check.result;

        try {
          const data = await this.categoriesService.getLlmCategories(
            ctx.userId,
            { type: args.type, search: args.search },
          );
          return toolResult(data);
        } catch (err: unknown) {
          return safeToolError(err);
        }
      },
    );
  }
}
