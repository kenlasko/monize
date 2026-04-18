import { Injectable } from "@nestjs/common";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { PortfolioService } from "../../securities/portfolio.service";
import { HoldingsService } from "../../securities/holdings.service";
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
