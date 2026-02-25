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
        description: "Get current net worth breakdown by account",
        inputSchema: {},
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
        description: "Get net worth over time (monthly snapshots)",
        inputSchema: {
          months: z
            .number()
            .min(1)
            .max(120)
            .optional()
            .default(12)
            .describe("Number of months of history (default 12)"),
        },
      },
      async (args, extra) => {
        const ctx = resolve(extra.sessionId);
        if (!ctx) return toolError("No user context");
        const check = requireScope(ctx.scopes, "read");
        if (check.error) return check.result;

        try {
          const months = args.months || 12;
          const endDate = new Date();
          const startDate = new Date();
          startDate.setMonth(startDate.getMonth() - months);

          const history = await this.netWorthService.getMonthlyNetWorth(
            ctx.userId,
            startDate.toISOString().split("T")[0],
            endDate.toISOString().split("T")[0],
          );
          return toolResult(history);
        } catch (err: unknown) {
          return safeToolError(err);
        }
      },
    );
  }
}
