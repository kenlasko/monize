import { Injectable } from "@nestjs/common";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { BudgetReportsService } from "../../budgets/budget-reports.service";
import {
  UserContextResolver,
  requireScope,
  toolResult,
  toolError,
  safeToolError,
} from "../mcp-context";
import { getBudgetStatusOutput } from "../tool-output-schemas";
import { READ_ONLY } from "../mcp-annotations";

@Injectable()
export class McpBudgetsTools {
  constructor(private readonly budgetReportsService: BudgetReportsService) {}

  register(server: McpServer, resolve: UserContextResolver) {
    server.registerTool(
      "get_budget_status",
      {
        title: "Budget status",
        annotations: READ_ONLY,
        description:
          "Get budget status for a specific period. Returns total budgeted vs actual spending, per-category breakdowns, spending velocity, safe daily spend, and health score. Returns the same shape as the AI Assistant's get_budget_status tool.",
        inputSchema: {
          period: z
            .string()
            .max(20)
            .optional()
            .describe(
              "Which period to check: 'CURRENT' for the current month, 'PREVIOUS' for last month, or a specific month in YYYY-MM format. Default: CURRENT.",
            ),
          budgetName: z
            .string()
            .max(100)
            .optional()
            .describe(
              "Optional: filter to a specific budget by name. If omitted, uses the first active budget.",
            ),
        },
        outputSchema: getBudgetStatusOutput,
      },
      async (args, extra) => {
        const ctx = resolve(extra.sessionId);
        if (!ctx) return toolError("No user context");
        const check = requireScope(ctx.scopes, "read");
        if (check.error) return check.result;

        try {
          const data = await this.budgetReportsService.getLlmBudgetStatus(
            ctx.userId,
            args.period ?? "CURRENT",
            args.budgetName,
          );
          return toolResult(data);
        } catch (err: unknown) {
          return safeToolError(err);
        }
      },
    );
  }
}
