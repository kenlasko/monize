import { Injectable } from "@nestjs/common";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { PortfolioService } from "../../securities/portfolio.service";
import { HoldingsService } from "../../securities/holdings.service";
import {
  InvestmentTransactionsService,
  LlmInvestmentTxGroupBy,
} from "../../securities/investment-transactions.service";
import { InvestmentAction } from "../../securities/entities/investment-transaction.entity";
import {
  UserContextResolver,
  requireScope,
  toolResult,
  toolError,
  safeToolError,
} from "../mcp-context";

@Injectable()
export class McpInvestmentsTools {
  constructor(
    private readonly portfolioService: PortfolioService,
    private readonly holdingsService: HoldingsService,
    private readonly investmentTransactionsService: InvestmentTransactionsService,
  ) {}

  register(server: McpServer, resolve: UserContextResolver) {
    server.registerTool(
      "get_portfolio_summary",
      {
        description:
          "Get investment portfolio overview with holdings, gains/losses, and allocation. Returns the same compact, LLM-friendly shape as the AI Assistant's tool.",
        inputSchema: {
          accountIds: z
            .array(z.string().uuid())
            .max(50)
            .optional()
            .describe(
              "Optional investment account IDs to filter to. Omit to cover all investment accounts.",
            ),
        },
      },
      async (args, extra) => {
        const ctx = resolve(extra.sessionId);
        if (!ctx) return toolError("No user context");
        const check = requireScope(ctx.scopes, "read");
        if (check.error) return check.result;

        try {
          const summary = await this.portfolioService.getLlmSummary(
            ctx.userId,
            args.accountIds,
          );
          return toolResult(summary);
        } catch (err: unknown) {
          return safeToolError(err);
        }
      },
    );

    server.registerTool(
      "query_investment_transactions",
      {
        description:
          "Query brokerage investment-account transactions (buys, sells, dividends, interest, capital gains, splits, transfers, reinvestments, share adjustments). Filter by account, security symbol, action, and date; optionally group by account, date, security, or action. Returns the same compact, LLM-friendly shape as the AI Assistant's tool.",
        inputSchema: {
          startDate: z
            .string()
            .max(10)
            .optional()
            .describe("Optional start date (YYYY-MM-DD)"),
          endDate: z
            .string()
            .max(10)
            .optional()
            .describe("Optional end date (YYYY-MM-DD)"),
          accountIds: z
            .array(z.string().uuid())
            .max(50)
            .optional()
            .describe("Optional investment account IDs."),
          symbols: z
            .array(z.string().min(1).max(20))
            .max(50)
            .optional()
            .describe("Optional security ticker symbols (case insensitive)."),
          actions: z
            .array(z.nativeEnum(InvestmentAction))
            .max(11)
            .optional()
            .describe(
              "Optional transaction types (BUY, SELL, DIVIDEND, INTEREST, CAPITAL_GAIN, SPLIT, TRANSFER_IN, TRANSFER_OUT, REINVEST, ADD_SHARES, REMOVE_SHARES).",
            ),
          groupBy: z
            .enum(["account", "date", "security", "action"])
            .optional()
            .describe(
              "Optional grouping: by account name, transaction date, security symbol, or action type.",
            ),
        },
      },
      async (args, extra) => {
        const ctx = resolve(extra.sessionId);
        if (!ctx) return toolError("No user context");
        const check = requireScope(ctx.scopes, "read");
        if (check.error) return check.result;

        try {
          const result =
            await this.investmentTransactionsService.getLlmInvestmentTransactions(
              ctx.userId,
              {
                startDate: args.startDate,
                endDate: args.endDate,
                accountIds: args.accountIds,
                symbols: args.symbols,
                actions: args.actions,
                groupBy: args.groupBy as LlmInvestmentTxGroupBy | undefined,
              },
            );
          return toolResult(result);
        } catch (err: unknown) {
          return safeToolError(err);
        }
      },
    );

    server.registerTool(
      "get_holding_details",
      {
        description: "Get details for holdings in a specific account",
        inputSchema: {
          accountId: z
            .string()
            .uuid()
            .optional()
            .describe("Account ID to filter holdings"),
        },
      },
      async (args, extra) => {
        const ctx = resolve(extra.sessionId);
        if (!ctx) return toolError("No user context");
        const check = requireScope(ctx.scopes, "read");
        if (check.error) return check.result;

        try {
          const holdings = await this.holdingsService.findAll(
            ctx.userId,
            args.accountId,
          );
          return toolResult(holdings);
        } catch (err: unknown) {
          return safeToolError(err);
        }
      },
    );
  }
}
