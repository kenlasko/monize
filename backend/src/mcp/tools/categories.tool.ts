import { Injectable } from "@nestjs/common";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/server";
import { CategoriesService } from "../../categories/categories.service";
import {
  resolveUserContext,
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

  register(server: McpServer) {
    server.registerTool(
      "list_categories",
      {
        title: "List categories",
        annotations: READ_ONLY,
        description:
          "The user's categories with their hierarchy, type and transaction counts. " +
          'Pass a row\'s `qualifiedName` ("Parent: Child") back to any other ' +
          "tool -- a bare child name shared by two parents is rejected, not " +
          "guessed.",
        inputSchema: z.object({
          type: z
            .enum(["expense", "income", "transfer", "all"])
            .optional()
            .describe("Defaults to 'all'."),
          search: z
            .string()
            .max(100)
            .optional()
            .describe(
              "Case-insensitive substring of the name. A match's parents come too, so the hierarchy stays readable.",
            ),
        }),
        outputSchema: getCategoriesOutput,
      },
      async (args, ctx) => {
        const user = resolveUserContext(ctx);
        if (!user) return toolError("No user context");
        const check = requireScope(user.scopes, "read");
        if (check.error) return check.result;

        try {
          const data = await this.categoriesService.getLlmCategories(
            user.userId,
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
