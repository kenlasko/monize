import { Injectable } from "@nestjs/common";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { AccountsService } from "../../accounts/accounts.service";
import {
  UserContextResolver,
  requireScope,
  toolResult,
  toolError,
} from "../mcp-context";

@Injectable()
export class McpAccountsTools {
  constructor(private readonly accountsService: AccountsService) {}

  register(server: McpServer, resolve: UserContextResolver) {
    server.registerTool(
      "get_accounts",
      {
        description: "List all accounts with balances",
        inputSchema: {
          includeInactive: z
            .boolean()
            .optional()
            .describe("Include closed accounts"),
        },
      },
      async (args, extra) => {
        const ctx = resolve(extra.sessionId);
        if (!ctx) return toolError("No user context");
        const check = requireScope(ctx.scopes, "read");
        if (check.error) return check.result;

        try {
          const accounts = await this.accountsService.findAll(
            ctx.userId,
            args.includeInactive || false,
          );
          return toolResult(accounts);
        } catch (err: any) {
          return toolError(err.message);
        }
      },
    );

    server.registerTool(
      "get_account_balance",
      {
        description: "Get detailed balance for a specific account",
        inputSchema: {
          accountId: z.string().uuid().describe("Account ID"),
        },
      },
      async (args, extra) => {
        const ctx = resolve(extra.sessionId);
        if (!ctx) return toolError("No user context");
        const check = requireScope(ctx.scopes, "read");
        if (check.error) return check.result;

        try {
          const account = await this.accountsService.findOne(
            ctx.userId,
            args.accountId,
          );
          return toolResult({
            id: account.id,
            name: account.name,
            type: account.accountType,
            currentBalance: account.currentBalance,
            creditLimit: account.creditLimit,
            currencyCode: account.currencyCode,
          });
        } catch (err: any) {
          return toolError(err.message);
        }
      },
    );

    server.registerTool(
      "get_account_summary",
      {
        description:
          "Get total assets, liabilities, and net worth across all accounts",
        inputSchema: {},
      },
      async (_args, extra) => {
        const ctx = resolve(extra.sessionId);
        if (!ctx) return toolError("No user context");
        const check = requireScope(ctx.scopes, "read");
        if (check.error) return check.result;

        try {
          const summary = await this.accountsService.getSummary(ctx.userId);
          return toolResult(summary);
        } catch (err: any) {
          return toolError(err.message);
        }
      },
    );
  }
}
