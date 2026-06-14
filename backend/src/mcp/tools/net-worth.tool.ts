import { Injectable } from "@nestjs/common";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { NetWorthService } from "../../net-worth/net-worth.service";
import { AccountsService } from "../../accounts/accounts.service";
import {
  UserContextResolver,
  requireScope,
  toolResult,
  toolError,
  safeToolError,
} from "../mcp-context";
import { formatDateYMD } from "../../common/date-utils";
import {
  getNetWorthOutput,
  getNetWorthHistoryOutput,
} from "../tool-output-schemas";
import { READ_ONLY } from "../mcp-annotations";

@Injectable()
export class McpNetWorthTools {
  constructor(
    private readonly netWorthService: NetWorthService,
    private readonly accountsService: AccountsService,
  ) {}

  register(server: McpServer, resolve: UserContextResolver) {
    server.registerTool(
      "get_net_worth",
      {
        title: "Get net worth",
        annotations: READ_ONLY,
        description: "Get current net worth breakdown by account",
        inputSchema: {},
        outputSchema: getNetWorthOutput,
      },
      async (_args, extra) => {
        const ctx = resolve(extra.sessionId);
        if (!ctx) return toolError("No user context");
        const check = requireScope(ctx.scopes, "read");
        if (check.error) return check.result;

        try {
          const summary = await this.accountsService.getSummary(ctx.userId);
          return toolResult(summary);
        } catch (err: unknown) {
          return safeToolError(err);
        }
      },
    );

    server.registerTool(
      "get_net_worth_history",
      {
        title: "Get net worth history",
        annotations: READ_ONLY,
        description:
          "Get net worth over time (monthly snapshots). Returns the same shape as the AI Assistant's get_net_worth_history tool. Default range is the last 12 months when both dates are omitted.",
        inputSchema: {
          startDate: z
            .string()
            .max(10)
            .optional()
            .describe("Start date (YYYY-MM-DD). Defaults to 12 months ago."),
          endDate: z
            .string()
            .max(10)
            .optional()
            .describe("End date (YYYY-MM-DD). Defaults to today."),
          months: z
            .number()
            .min(1)
            .max(120)
            .optional()
            .describe(
              "Number of months of history. Only applied when startDate/endDate are omitted.",
            ),
        },
        outputSchema: getNetWorthHistoryOutput,
      },
      async (args, extra) => {
        const ctx = resolve(extra.sessionId);
        if (!ctx) return toolError("No user context");
        const check = requireScope(ctx.scopes, "read");
        if (check.error) return check.result;

        try {
          let startDate = args.startDate;
          let endDate = args.endDate;
          if (!startDate && !endDate && args.months) {
            const end = new Date();
            const start = new Date();
            start.setMonth(start.getMonth() - args.months);
            startDate = formatDateYMD(start);
            endDate = formatDateYMD(end);
          }

          const history = await this.netWorthService.getLlmHistory(
            ctx.userId,
            startDate,
            endDate,
          );
          return toolResult(history);
        } catch (err: unknown) {
          return safeToolError(err);
        }
      },
    );
  }
}
