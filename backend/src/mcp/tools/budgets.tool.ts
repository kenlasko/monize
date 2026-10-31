import { SharedReviewService } from "../../shared-expenses/shared-review.service";
import { Injectable } from "@nestjs/common";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/server";
import { BudgetReportsService } from "../../budgets/budget-reports.service";
import {
  resolveUserContext,
  requireScope,
  toolResult,
  toolError,
  safeToolError,
} from "../mcp-context";
import { getBudgetStatusOutput } from "../tool-output-schemas";
import { READ_ONLY } from "../mcp-annotations";

@Injectable()
export class McpBudgetsTools {
  constructor(
    private readonly budgetReportsService: BudgetReportsService,
    private readonly sharedReview: SharedReviewService,
  ) {}

  register(server: McpServer) {
    server.registerTool(
      "get_budget_status",
      {
        title: "Budget status",
        annotations: READ_ONLY,
        description:
          "Period budget versus actuals by category, velocity, safe daily spend " +
          "and health score. Unpriced upcoming bills make " +
          "`velocity.safeDailySpend` null and `upcomingBillsComplete` false.",
        inputSchema: z.object({
          period: z
            .string()
            .max(20)
            .optional()
            .describe(
              "'CURRENT' (default), 'PREVIOUS', or a specific YYYY-MM month.",
            ),
          budgetName: z
            .string()
            .max(100)
            .optional()
            .describe("Defaults to the first active budget."),
        }),
        outputSchema: getBudgetStatusOutput,
      },
      async (args, ctx) => {
        const user = resolveUserContext(ctx);
        if (!user) return toolError("No user context");
        const check = requireScope(user.scopes, "read");
        if (check.error) return check.result;

        try {
          const data = await this.budgetReportsService.getLlmBudgetStatus(
            user.userId,
            args.period ?? "CURRENT",
            args.budgetName,
          );
          return toolResult(
            await this.sharedReview.annotate(user.userId, data),
          );
        } catch (err: unknown) {
          return safeToolError(err);
        }
      },
    );
  }
}
