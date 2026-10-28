import { Injectable } from "@nestjs/common";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/server";
import { BuiltInReportsService } from "../../built-in-reports/built-in-reports.service";
import {
  resolveUserContext,
  requireScope,
  toolResult,
  toolError,
  safeToolError,
} from "../mcp-context";
import { numberArg } from "../../common/tool-schemas";
import { REPORT_TOOL_TYPES } from "../../built-in-reports/report-tool.types";
import { generateReportOutput } from "../tool-output-schemas";
import { READ_ONLY } from "../mcp-annotations";

@Injectable()
export class McpReportsTools {
  constructor(private readonly reportsService: BuiltInReportsService) {}

  register(server: McpServer) {
    server.registerTool(
      "generate_report",
      {
        title: "Generate report",
        annotations: READ_ONLY,
        description:
          "Run a built-in financial report, which returns a ready aggregate. " +
          "Prefer it over list_transactions for any breakdown, anomaly or " +
          "month-comparison question. The `type` field says what each report " +
          "answers and which of the date parameters it reads. For an arbitrary " +
          "pair of ranges use compare_periods instead. Returns basis, currency and result; anomalies are cash-only.",
        inputSchema: z.object({
          basis: z
            .enum(["cash", "accrual"])
            .optional()
            .describe("Omit for your reporting preference."),
          type: z
            .enum(REPORT_TOOL_TYPES)
            .describe(
              "Which report to run, exactly one of the listed values. The five totals reports (by category, by payee, income vs expenses, monthly trend, income by source) read startDate/endDate, default the last 30 days. net_worth_history reads them too, defaulting to 12 months. spending_anomalies reads months and finds transactions statistically large for their category -- an empty list means nothing was unusual, not a problem. month_comparison reads month and covers income, category changes, net worth and investments.",
            ),
          startDate: z
            .string()
            .max(10)
            .optional()
            .describe("Start date. See `type` for the per-report default."),
          endDate: z
            .string()
            .max(10)
            .optional()
            .describe("End date. Defaults to today."),
          months: numberArg(z.number().min(1).max(24))
            .optional()
            .describe("spending_anomalies: months of history. Default 6."),
          month: z
            .string()
            .max(7)
            .optional()
            .describe(
              "month_comparison: YYYY-MM. Defaults to the previous complete month.",
            ),
        }),
        outputSchema: generateReportOutput,
      },
      async (args, ctx) => {
        const user = resolveUserContext(ctx);
        if (!user) return toolError("No user context");
        const check = requireScope(user.scopes, "read");
        if (check.error) return check.result;

        try {
          const data = await this.reportsService.getLlmReport(
            user.userId,
            args,
          );
          return toolResult(data);
        } catch (err: unknown) {
          return safeToolError(err);
        }
      },
    );
  }
}
