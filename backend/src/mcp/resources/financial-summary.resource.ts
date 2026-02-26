import { Injectable } from "@nestjs/common";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { AccountsService } from "../../accounts/accounts.service";
import { TransactionAnalyticsService } from "../../transactions/transaction-analytics.service";
import { UserContextResolver, hasScope } from "../mcp-context";

@Injectable()
export class McpFinancialSummaryResource {
  constructor(
    private readonly accountsService: AccountsService,
    private readonly analyticsService: TransactionAnalyticsService,
  ) {}

  register(server: McpServer, resolve: UserContextResolver) {
    server.registerResource(
      "financial-summary",
      "monize://financial-summary",
      {
        description:
          "High-level financial snapshot: income, expenses, net worth",
      },
      async (_uri, extra) => {
        const ctx = resolve(extra.sessionId);
        if (!ctx) {
          return {
            contents: [
              {
                uri: "monize://financial-summary",
                text: "Error: No user context",
              },
            ],
          };
        }
        if (!hasScope(ctx.scopes, "read")) {
          return {
            contents: [
              {
                uri: "monize://financial-summary",
                text: 'Error: Insufficient scope. Requires "read" scope.',
              },
            ],
          };
        }

        try {
          const now = new Date();
          const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1)
            .toISOString()
            .split("T")[0];
          const endDate = now.toISOString().split("T")[0];

          const [accountSummary, monthSummary] = await Promise.all([
            this.accountsService.getSummary(ctx.userId),
            this.analyticsService.getSummary(
              ctx.userId,
              undefined,
              startOfMonth,
              endDate,
            ),
          ]);

          return {
            contents: [
              {
                uri: "monize://financial-summary",
                mimeType: "application/json",
                text: JSON.stringify(
                  {
                    netWorth: accountSummary,
                    currentMonth: {
                      period: { startDate: startOfMonth, endDate },
                      ...monthSummary,
                    },
                  },
                  null,
                  2,
                ),
              },
            ],
          };
        } catch {
          return {
            contents: [
              {
                uri: "monize://financial-summary",
                text: "Error: An error occurred while loading financial summary",
              },
            ],
          };
        }
      },
    );
  }
}
