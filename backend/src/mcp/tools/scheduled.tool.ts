import { Injectable } from "@nestjs/common";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/server";
import { ScheduledTransactionsService } from "../../scheduled-transactions/scheduled-transactions.service";
import {
  resolveUserContext,
  requireScope,
  toolResult,
  toolError,
  safeToolError,
} from "../mcp-context";
import { getUpcomingBillsOutput } from "../tool-output-schemas";
import { READ_ONLY } from "../mcp-annotations";
import { uuidString } from "./schema-fragments";
import { numberArg } from "../../common/tool-schemas";

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

  register(server: McpServer) {
    server.registerTool(
      "list_upcoming_bills",
      {
        title: "Upcoming bills and deposits",
        annotations: READ_ONLY,
        description:
          "Scheduled bills, deposits, transfers and investments due in a window. " +
          "Each item is ONE occurrence, the next one due: `nextDueDate` is its " +
          "day and `amount` what it would post today, in its own `currency`. " +
          "An item with `kind` 'unknown', or a null `amount` with " +
          "`amountComplete` false, is unknown: never a bill or a deposit, never " +
          "guessed. Bucket totals cover the WHOLE window whatever the `kind` " +
          "filter, in `totalsCurrency` (name it); never sum items yourself. A " +
          "null total holds something unknown or unconvertible: quote " +
          "`known*Subtotal` as a subtotal and say why from " +
          "`unknownAmountItems` and `missingRatePairs`.",
        inputSchema: z.object({
          days: numberArg(z.number().min(1).max(365))
            .optional()
            .default(30)
            .describe("Days to look ahead. Default 30."),
          kind: z
            .enum(SCHEDULED_KIND_VALUES)
            .optional()
            .describe(
              "Narrow the item list to one kind. Omit or pass 'all' for everything. The bucket totals ignore this filter.",
            ),
          accountIds: z
            .array(uuidString())
            .max(50)
            .optional()
            .describe("Account ids."),
        }),
        outputSchema: getUpcomingBillsOutput,
      },
      async (args, ctx) => {
        const user = resolveUserContext(ctx);
        if (!user) return toolError("No user context");
        const check = requireScope(user.scopes, "read");
        if (check.error) return check.result;

        try {
          const upcoming =
            await this.scheduledService.getLlmUpcomingBillsAndDeposits(
              user.userId,
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
  }
}
