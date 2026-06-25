import { Injectable } from "@nestjs/common";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { BuiltInReportsService } from "../../built-in-reports/built-in-reports.service";
import { NetWorthService } from "../../net-worth/net-worth.service";
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
import { generateReportOutput } from "../tool-output-schemas";
import { READ_ONLY } from "../mcp-annotations";

@Injectable()
export class McpReportsTools {
  constructor(
    private readonly reportsService: BuiltInReportsService,
    private readonly netWorthService: NetWorthService,
  ) {}

  register(server: McpServer, resolve: UserContextResolver) {
    server.registerTool(
      "generate_report",
      {
        title: "Generate report",
        annotations: READ_ONLY,
        description:
          "Run a built-in financial report. Prefer this over list_transactions for spending/income breakdown, anomaly, and month-comparison questions because it returns a ready aggregated result. Types: 'spending_by_category' (expense totals grouped by category), 'spending_by_payee' (expense totals grouped by payee), 'income_vs_expenses' (period income, expenses, and net), 'monthly_trend' (spending per month over the range -- use this for trend questions instead of fetching transactions month by month), 'income_by_source' (income grouped by source), 'spending_anomalies' (transactions that are statistically large for their category vs recent history -- use for 'any unusual spending?'; may return an empty list for sparse data, in which case report that nothing was unusual rather than implying a problem), 'month_comparison' (one month vs the previous month: income vs expenses, category spending changes, net worth, and investment performance -- use for 'how am I doing this month?'), and 'net_worth_history' (monthly assets, liabilities, and net worth over time -- use for net-worth trend questions about overall financial health). Parameters apply per type: the five aggregation types use startDate/endDate (default last 30 days); 'net_worth_history' uses startDate/endDate (default last 12 months); 'spending_anomalies' uses months; 'month_comparison' uses month. For an arbitrary pair of date ranges use compare_periods instead.",
        inputSchema: {
          type: z
            .enum([
              "spending_by_category",
              "spending_by_payee",
              "income_vs_expenses",
              "monthly_trend",
              "income_by_source",
              "spending_anomalies",
              "month_comparison",
              "net_worth_history",
            ])
            .describe(
              "Which report to run. MUST be exactly one of the listed values.",
            ),
          startDate: z
            .string()
            .max(10)
            .optional()
            .describe(
              "Start date (YYYY-MM-DD) for the five aggregation types (default 30 days ago) and net_worth_history (default 12 months ago).",
            ),
          endDate: z
            .string()
            .max(10)
            .optional()
            .describe(
              "End date (YYYY-MM-DD) for the five aggregation types and net_worth_history. Defaults to today.",
            ),
          months: z
            .number()
            .min(1)
            .max(24)
            .optional()
            .describe(
              "spending_anomalies only: months of recent history to analyze (default 3).",
            ),
          month: z
            .string()
            .max(7)
            .optional()
            .describe(
              "month_comparison only: month in YYYY-MM format (e.g. 2026-01). Defaults to the previous complete month.",
            ),
        },
        outputSchema: generateReportOutput,
      },
      async (args, extra) => {
        const ctx = resolve(extra.sessionId);
        if (!ctx) return toolError("No user context");
        const check = requireScope(ctx.scopes, "reports");
        if (check.error) return check.result;

        try {
          if (args.type === "spending_anomalies") {
            const data = await this.reportsService.getSpendingAnomalies(
              ctx.userId,
              args.months ?? 3,
            );
            return toolResult(data);
          }
          if (args.type === "month_comparison") {
            const data = await this.reportsService.getMonthlyComparison(
              ctx.userId,
              args.month ?? getDefaultPreviousMonth(),
            );
            return toolResult(data);
          }
          if (args.type === "net_worth_history") {
            // Dates omitted -> getLlmHistory defaults to the last 12 months.
            const data = await this.netWorthService.getLlmHistory(
              ctx.userId,
              args.startDate,
              args.endDate,
            );
            return toolResult(data);
          }

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
  }
}
