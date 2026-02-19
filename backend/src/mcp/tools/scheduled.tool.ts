import { Injectable } from "@nestjs/common";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ScheduledTransactionsService } from "../../scheduled-transactions/scheduled-transactions.service";
import {
  UserContextResolver,
  requireScope,
  toolResult,
  toolError,
} from "../mcp-context";

@Injectable()
export class McpScheduledTools {
  constructor(
    private readonly scheduledService: ScheduledTransactionsService,
  ) {}

  register(server: McpServer, resolve: UserContextResolver) {
    server.registerTool(
      "get_upcoming_bills",
      {
        description: "Get scheduled transactions due soon",
        inputSchema: {
          days: z
            .number()
            .optional()
            .default(30)
            .describe("Number of days to look ahead (default 30)"),
        },
      },
      async (args, extra) => {
        const ctx = resolve(extra.sessionId);
        if (!ctx) return toolError("No user context");
        const check = requireScope(ctx.scopes, "read");
        if (check.error) return check.result;

        try {
          const upcoming = await this.scheduledService.findUpcoming(
            ctx.userId,
            args.days || 30,
          );
          return toolResult(upcoming);
        } catch (err: any) {
          return toolError(err.message);
        }
      },
    );

    server.registerTool(
      "get_scheduled_transactions",
      {
        description: "List all scheduled/recurring transactions",
        inputSchema: {},
      },
      async (_args, extra) => {
        const ctx = resolve(extra.sessionId);
        if (!ctx) return toolError("No user context");
        const check = requireScope(ctx.scopes, "read");
        if (check.error) return check.result;

        try {
          const scheduled = await this.scheduledService.findAll(ctx.userId);
          return toolResult(scheduled);
        } catch (err: any) {
          return toolError(err.message);
        }
      },
    );
  }
}
