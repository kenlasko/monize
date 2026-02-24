import { Injectable } from "@nestjs/common";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { BuiltInReportsService } from "../../built-in-reports/built-in-reports.service";
import {
  UserContextResolver,
  requireScope,
  toolResult,
  toolError,
} from "../mcp-context";

@Injectable()
export class McpReportsTools {
  constructor(private readonly reportsService: BuiltInReportsService) {}

  register(server: McpServer, resolve: UserContextResolver) {
    server.registerTool(
      "generate_report",
      {
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
          startDate: z.string().describe("Start date (YYYY-MM-DD)"),
          endDate: z.string().describe("End date (YYYY-MM-DD)"),
        },
      },
      async (args, extra) => {
        const ctx = resolve(extra.sessionId);
        if (!ctx) return toolError("No user context");
        const check = requireScope(ctx.scopes, "reports");
        if (check.error) return check.result;

        try {
          let data: any;
          switch (args.type) {
            case "spending_by_category":
              data = await this.reportsService.getSpendingByCategory(
                ctx.userId,
                args.startDate,
                args.endDate,
              );
              break;
            case "spending_by_payee":
              data = await this.reportsService.getSpendingByPayee(
                ctx.userId,
                args.startDate,
                args.endDate,
              );
              break;
            case "income_vs_expenses":
              data = await this.reportsService.getIncomeVsExpenses(
                ctx.userId,
                args.startDate,
                args.endDate,
              );
              break;
            case "monthly_trend":
              data = await this.reportsService.getMonthlySpendingTrend(
                ctx.userId,
                args.startDate,
                args.endDate,
              );
              break;
            case "income_by_source":
              data = await this.reportsService.getIncomeBySource(
                ctx.userId,
                args.startDate,
                args.endDate,
              );
              break;
          }
          return toolResult(data);
        } catch (err: any) {
          return toolError(err.message);
        }
      },
    );

    server.registerTool(
      "monthly_comparison",
      {
        description:
          "Generate a monthly comparison report comparing one month to the previous month. Includes income vs expenses, category spending breakdown, net worth, and investment performance.",
        inputSchema: {
          month: z
            .string()
            .describe("Month to compare in YYYY-MM format (e.g., 2026-01)"),
        },
      },
      async (args, extra) => {
        const ctx = resolve(extra.sessionId);
        if (!ctx) return toolError("No user context");
        const check = requireScope(ctx.scopes, "reports");
        if (check.error) return check.result;

        try {
          const data = await this.reportsService.getMonthlyComparison(
            ctx.userId,
            args.month,
          );
          return toolResult(data);
        } catch (err: any) {
          return toolError(err.message);
        }
      },
    );

    server.registerTool(
      "get_anomalies",
      {
        description: "Find unusual transactions or spending patterns",
        inputSchema: {
          months: z
            .number()
            .optional()
            .default(3)
            .describe("Number of months to analyze (default 3)"),
        },
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
        } catch (err: any) {
          return toolError(err.message);
        }
      },
    );
  }
}
