import { Injectable } from "@nestjs/common";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { BuiltInReportsService } from "../../built-in-reports/built-in-reports.service";
import {
  UserContextResolver,
  requireScope,
  toolResult,
  toolError,
  safeToolError,
} from "../mcp-context";
import {
  getDefaultDateRange,
  getDefaultPreviousMonth,
} from "../../common/tool-schemas";
import {
  generateReportOutput,
  monthlyComparisonOutput,
  getAnomaliesOutput,
} from "../tool-output-schemas";
import { READ_ONLY } from "../mcp-annotations";

@Injectable()
export class McpReportsTools {
  constructor(private readonly reportsService: BuiltInReportsService) {}

  register(server: McpServer, resolve: UserContextResolver) {
    server.registerTool(
      "generate_report",
      {
        title: "Generate report",
        annotations: READ_ONLY,
        description: "Run a financial report",
        inputSchema: {
          type: z
            .enum([
              "spending_by_category",
              "spending_by_payee",
              "income_vs_expenses",
              "monthly_trend",
              "income_by_source",
            ])
            .describe("Report type"),
          startDate: z
            .string()
            .max(10)
            .optional()
            .describe("Start date (YYYY-MM-DD). Defaults to 30 days ago."),
          endDate: z
            .string()
            .max(10)
            .optional()
            .describe("End date (YYYY-MM-DD). Defaults to today."),
        },
        outputSchema: generateReportOutput,
      },
      async (args, extra) => {
        const ctx = resolve(extra.sessionId);
        if (!ctx) return toolError("No user context");
        const check = requireScope(ctx.scopes, "reports");
        if (check.error) return check.result;

        try {
          const defaults = getDefaultDateRange();
          const startDate = args.startDate ?? defaults.startDate;
          const endDate = args.endDate ?? defaults.endDate;
          let data: any;
          switch (args.type) {
            case "spending_by_category":
              data = await this.reportsService.getSpendingByCategory(
                ctx.userId,
                startDate,
                endDate,
              );
              break;
            case "spending_by_payee":
              data = await this.reportsService.getSpendingByPayee(
                ctx.userId,
                startDate,
                endDate,
              );
              break;
            case "income_vs_expenses":
              data = await this.reportsService.getIncomeVsExpenses(
                ctx.userId,
                startDate,
                endDate,
              );
              break;
            case "monthly_trend":
              data = await this.reportsService.getMonthlySpendingTrend(
                ctx.userId,
                startDate,
                endDate,
              );
              break;
            case "income_by_source":
              data = await this.reportsService.getIncomeBySource(
                ctx.userId,
                startDate,
                endDate,
              );
              break;
          }
          return toolResult(data);
        } catch (err: unknown) {
          return safeToolError(err);
        }
      },
    );

    server.registerTool(
      "monthly_comparison",
      {
        title: "Monthly comparison",
        annotations: READ_ONLY,
        description:
          "Generate a monthly comparison report comparing one month to the previous month. Includes income vs expenses, category spending breakdown, net worth, and investment performance.",
        inputSchema: {
          month: z
            .string()
            .max(7)
            .optional()
            .describe(
              "Month to compare in YYYY-MM format (e.g., 2026-01). Defaults to the previous complete month.",
            ),
        },
        outputSchema: monthlyComparisonOutput,
      },
      async (args, extra) => {
        const ctx = resolve(extra.sessionId);
        if (!ctx) return toolError("No user context");
        const check = requireScope(ctx.scopes, "reports");
        if (check.error) return check.result;

        try {
          const data = await this.reportsService.getMonthlyComparison(
            ctx.userId,
            args.month ?? getDefaultPreviousMonth(),
          );
          return toolResult(data);
        } catch (err: unknown) {
          return safeToolError(err);
        }
      },
    );

    server.registerTool(
      "get_anomalies",
      {
        title: "Detect spending anomalies",
        annotations: READ_ONLY,
        description: "Find unusual transactions or spending patterns",
        inputSchema: {
          months: z
            .number()
            .min(1)
            .max(24)
            .optional()
            .default(3)
            .describe("Number of months to analyze (default 3)"),
        },
        outputSchema: getAnomaliesOutput,
      },
      async (args, extra) => {
        const ctx = resolve(extra.sessionId);
        if (!ctx) return toolError("No user context");
        const check = requireScope(ctx.scopes, "reports");
        if (check.error) return check.result;

        try {
          const anomalies = await this.reportsService.getSpendingAnomalies(
            ctx.userId,
            args.months || 3,
          );
          return toolResult(anomalies);
        } catch (err: unknown) {
          return safeToolError(err);
        }
      },
    );
  }
}
