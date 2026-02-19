import { Injectable } from "@nestjs/common";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CategoriesService } from "../../categories/categories.service";
import {
  UserContextResolver,
  requireScope,
  toolResult,
  toolError,
} from "../mcp-context";

@Injectable()
export class McpCategoriesTools {
  constructor(private readonly categoriesService: CategoriesService) {}

  register(server: McpServer, resolve: UserContextResolver) {
    server.registerTool(
      "get_categories",
      {
        description: "Get full category tree or filter by type",
        inputSchema: {
          type: z
            .enum(["income", "expense"])
            .optional()
            .describe("Filter by income or expense categories"),
        },
      },
      async (args, extra) => {
        const ctx = resolve(extra.sessionId);
        if (!ctx) return toolError("No user context");
        const check = requireScope(ctx.scopes, "read");
        if (check.error) return check.result;

        try {
          if (args.type) {
            const categories = await this.categoriesService.findByType(
              ctx.userId,
              args.type === "income",
            );
            return toolResult(categories);
          }
          const tree = await this.categoriesService.getTree(ctx.userId);
          return toolResult(tree);
        } catch (err: any) {
          return toolError(err.message);
        }
      },
    );
  }
}
