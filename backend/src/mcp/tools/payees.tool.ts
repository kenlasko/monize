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
  confirmWrite,
} from "../mcp-context";
import { getPayeesOutput, createPayeeOutput } from "../tool-output-schemas";
import { READ_ONLY, CREATE } from "../mcp-annotations";

@Injectable()
export class McpPayeesTools {
  constructor(private readonly payeesService: PayeesService) {}

  register(server: McpServer, resolve: UserContextResolver) {
    server.registerTool(
      "get_payees",
      {
        title: "List payees",
        annotations: READ_ONLY,
        description: "List payees, optionally filtered by search query",
        inputSchema: {
          search: z
            .string()
            .max(200)
            .optional()
            .describe("Search query to filter payees"),
        },
        outputSchema: getPayeesOutput,
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
        title: "Create payee",
        annotations: CREATE,
        description:
          "Create a new payee. The user is asked to confirm before it is created (clients that support it show a confirmation dialog).",
        inputSchema: {
          name: z.string().max(100).describe("Payee name"),
          defaultCategoryId: z
            .string()
            .uuid()
            .optional()
            .describe("Default category ID for this payee"),
        },
        outputSchema: createPayeeOutput,
      },
      async (args, extra) => {
        const ctx = resolve(extra.sessionId);
        if (!ctx) return toolError("No user context");
        const check = requireScope(ctx.scopes, "write");
        if (check.error) return check.result;

        try {
          // Resolve + validate (rejects duplicates, resolves the category name)
          // so the client's confirmation dialog shows what will be created,
          // mirroring the AI Assistant card.
          const preview = await this.payeesService.previewCreate(ctx.userId, {
            name: args.name,
            defaultCategoryId: args.defaultCategoryId,
          });
          const confirmLines = [
            `Create a new payee named "${preview.name}"?`,
            preview.defaultCategoryName
              ? `Default category: ${preview.defaultCategoryName}`
              : null,
          ].filter((line): line is string => line !== null);
          const confirmation = await confirmWrite(
            server,
            confirmLines.join("\n"),
          );
          if (confirmation === "declined") {
            return toolError(
              "Cancelled: the confirmation was declined, so no payee was created. Do not retry unless the user asks again.",
            );
          }

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
