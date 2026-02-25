import { Injectable } from "@nestjs/common";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { PayeesService } from "../../payees/payees.service";
import {
  UserContextResolver,
  requireScope,
  toolResult,
  toolError,
  safeToolError,
} from "../mcp-context";

@Injectable()
export class McpPayeesTools {
  constructor(private readonly payeesService: PayeesService) {}

  register(server: McpServer, resolve: UserContextResolver) {
    server.registerTool(
      "get_payees",
      {
        description: "List payees, optionally filtered by search query",
        inputSchema: {
          search: z
            .string()
            .max(200)
            .optional()
            .describe("Search query to filter payees"),
        },
      },
      async (args, extra) => {
        const ctx = resolve(extra.sessionId);
        if (!ctx) return toolError("No user context");
        const check = requireScope(ctx.scopes, "read");
        if (check.error) return check.result;

        try {
          if (args.search) {
            const payees = await this.payeesService.search(
              ctx.userId,
              args.search,
              50,
            );
            return toolResult(payees);
          }
          const payees = await this.payeesService.findAll(ctx.userId);
          return toolResult(payees);
        } catch (err: unknown) {
          return safeToolError(err);
        }
      },
    );

    server.registerTool(
      "create_payee",
      {
        description: "Create a new payee",
        inputSchema: {
          name: z.string().max(100).describe("Payee name"),
          defaultCategoryId: z
            .string()
            .uuid()
            .optional()
            .describe("Default category ID for this payee"),
        },
      },
      async (args, extra) => {
        const ctx = resolve(extra.sessionId);
        if (!ctx) return toolError("No user context");
        const check = requireScope(ctx.scopes, "write");
        if (check.error) return check.result;

        try {
          const payee = await this.payeesService.create(ctx.userId, {
            name: args.name,
            defaultCategoryId: args.defaultCategoryId,
          });
          return toolResult({
            id: payee.id,
            name: payee.name,
            message: "Payee created successfully",
          });
        } catch (err: unknown) {
          return safeToolError(err);
        }
      },
    );
  }
}
