import { Injectable } from "@nestjs/common";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ScheduledTransactionsService } from "../../scheduled-transactions/scheduled-transactions.service";
import {
  UserContextResolver,
  requireScope,
  toolResult,
  toolError,
  safeToolError,
} from "../mcp-context";

const SCHEDULED_KIND_VALUES = [
  "bill",
  "deposit",
  "transfer",
  "investment",
  "all",
] as const;

@Injectable()
export class McpScheduledTools {
  constructor(
    private readonly scheduledService: ScheduledTransactionsService,
  ) {}

  register(server: McpServer, resolve: UserContextResolver) {
    server.registerTool(
      "get_upcoming_bills",
      {
        description:
          "Get upcoming scheduled bills and deposits due within a date window. Each item is classified as bill / deposit / transfer / investment and includes a daysUntilDue value (negative when overdue). Returns the same shape as the AI Assistant's get_upcoming_bills tool.",
        inputSchema: {
          days: z
            .number()
            .min(1)
            .max(365)
            .optional()
            .default(30)
            .describe("Number of days to look ahead (default 30)"),
          kind: z
            .enum(SCHEDULED_KIND_VALUES)
            .optional()
            .describe(
              "Narrow to a single kind: 'bill', 'deposit', 'transfer', 'investment'. Omit or pass 'all' for everything.",
            ),
          accountIds: z
            .array(z.string().uuid())
            .max(50)
            .optional()
            .describe("Optional account IDs to filter to."),
        },
      },
      async (args, extra) => {
        const ctx = resolve(extra.sessionId);
        if (!ctx) return toolError("No user context");
        const check = requireScope(ctx.scopes, "read");
        if (check.error) return check.result;

        try {
          const upcoming =
            await this.scheduledService.getLlmUpcomingBillsAndDeposits(
              ctx.userId,
              {
                days: args.days ?? 30,
                kind: args.kind,
                accountIds: args.accountIds,
              },
            );
          return toolResult(upcoming);
        } catch (err: unknown) {
          return safeToolError(err);
        }
      },
    );

    server.registerTool(
      "get_scheduled_transactions",
      {
        description:
          "List all scheduled/recurring transactions (bills, deposits, transfers, investments). Returns rollup counts plus a curated per-item payload. Returns the same shape as the AI Assistant's get_scheduled_transactions tool.",
        inputSchema: {
          kind: z
            .enum(SCHEDULED_KIND_VALUES)
            .optional()
            .describe(
              "Narrow to a single kind: 'bill', 'deposit', 'transfer', 'investment'. Omit or pass 'all' for everything.",
            ),
          accountIds: z
            .array(z.string().uuid())
            .max(50)
            .optional()
            .describe("Optional account IDs to filter to."),
          isActive: z
            .boolean()
            .optional()
            .describe(
              "Filter by active status. Omit to include both active and paused schedules.",
            ),
        },
      },
      async (args, extra) => {
        const ctx = resolve(extra.sessionId);
        if (!ctx) return toolError("No user context");
        const check = requireScope(ctx.scopes, "read");
        if (check.error) return check.result;

        try {
          const scheduled = await this.scheduledService.getLlmScheduledList(
            ctx.userId,
            {
              kind: args.kind,
              accountIds: args.accountIds,
              isActive: args.isActive,
            },
          );
          return toolResult(scheduled);
        } catch (err: unknown) {
          return safeToolError(err);
        }
      },
    );
  }
}
