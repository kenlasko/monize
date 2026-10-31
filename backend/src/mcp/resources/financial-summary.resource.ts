import { SharedReviewService } from "../../shared-expenses/shared-review.service";
import { Injectable } from "@nestjs/common";
import { McpServer } from "@modelcontextprotocol/server";
import { AccountsService } from "../../accounts/accounts.service";
import { TransactionAnalyticsService } from "../../transactions/transaction-analytics.service";
import { resolveUserContext, hasScope } from "../mcp-context";
import { formatDateYMD, todayYMD } from "../../common/date-utils";

@Injectable()
export class McpFinancialSummaryResource {
  constructor(
    private readonly sharedReview: SharedReviewService,
    private readonly accountsService: AccountsService,
    private readonly analyticsService: TransactionAnalyticsService,
  ) {}

  register(server: McpServer) {
    server.registerResource(
      "financial-summary",
      "monize://financial-summary",
      {
        // Live data: a cached answer here is a stale figure, not a stale name.
        cacheHint: { ttlMs: 0, cacheScope: "private" },
        title: "Financial summary",
        description:
          "High-level financial snapshot: income, expenses, net worth",
      },
      async (_uri, ctx) => {
        const user = resolveUserContext(ctx);
        if (!user) {
          return {
            contents: [
              {
                uri: "monize://financial-summary",
                text: "Error: No user context",
              },
            ],
          };
        }
        if (!hasScope(user.scopes, "read")) {
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
          const startOfMonth = formatDateYMD(
            new Date(now.getFullYear(), now.getMonth(), 1),
          );
          const endDate = todayYMD();

          const [accountSummary, monthSummary, monthTotals] = await Promise.all(
            [
              this.accountsService.getSummary(user.userId),
              // Exclude investment-linked cash transactions so the MCP
              // financial snapshot's income/expense totals reflect real
              // spending -- not BUY/SELL/DIVIDEND cash movements that
              // live in the linked cash account.
              this.analyticsService.getSummary(
                user.userId,
                undefined,
                startOfMonth,
                endDate,
                undefined,
                undefined,
                undefined,
                undefined,
                undefined,
                true,
              ),
              // `getSummary` adds each currency's numbers as they stand; these
              // are the same rows converted into the default currency at their
              // own dates, withheld (null) while a pair has no rate.
              this.analyticsService.getLlmFlowTotals(user.userId, {
                startDate: startOfMonth,
                endDate,
                excludeTransfers: false,
              }),
            ],
          );

          return {
            contents: [
              {
                uri: "monize://financial-summary",
                mimeType: "application/json",
                text: JSON.stringify(
                  await this.sharedReview.annotate(user.userId, {
                    netWorth: accountSummary,
                    currentMonth: {
                      period: { startDate: startOfMonth, endDate },
                      ...monthSummary,
                      ...monthTotals,
                    },
                  }),
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
