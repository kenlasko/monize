import { Injectable } from "@nestjs/common";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { AccountsService } from "../../accounts/accounts.service";
import { AccountType } from "../../accounts/entities/account.entity";
import {
  UserContextResolver,
  requireScope,
  toolResult,
  toolError,
  safeToolError,
} from "../mcp-context";
import {
  getAccountsOutput,
  getAccountBalanceOutput,
  getAccountBalancesOutput,
} from "../tool-output-schemas";
import { READ_ONLY } from "../mcp-annotations";

@Injectable()
export class McpAccountsTools {
  constructor(private readonly accountsService: AccountsService) {}

  register(server: McpServer, resolve: UserContextResolver) {
    server.registerTool(
      "get_accounts",
      {
        title: "List accounts",
        annotations: READ_ONLY,
        description: "List all accounts with balances",
        inputSchema: {
          includeInactive: z
            .boolean()
            .optional()
            .describe("Include closed accounts"),
        },
        outputSchema: getAccountsOutput,
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
        } catch (err: unknown) {
          return safeToolError(err);
        }
      },
    );

    server.registerTool(
      "get_account_balance",
      {
        title: "Get account balance",
        annotations: READ_ONLY,
        description: "Get detailed balance for a specific account",
        inputSchema: {
          accountId: z.string().uuid().describe("Account ID"),
        },
        outputSchema: getAccountBalanceOutput,
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
        } catch (err: unknown) {
          return safeToolError(err);
        }
      },
    );

    server.registerTool(
      "get_account_balances",
      {
        title: "Get account balances",
        annotations: READ_ONLY,
        description:
          "Get current account balances with per-account type and currency, plus total assets, total liabilities, and net worth. Returns the same shape as the AI Assistant's get_account_balances tool. Brokerage accounts show market value; every other account shows currentBalance + futureTransactionsSum. Totals match the dashboard Net Worth widget.",
        inputSchema: {
          accountNames: z
            .array(z.string().max(100))
            .max(50)
            .optional()
            .describe(
              "Optional: filter to specific account names. Omit to cover all accounts.",
            ),
          status: z
            .enum(["open", "closed", "all"])
            .optional()
            .describe(
              "Which accounts to include by status. Defaults to 'open'.",
            ),
          accountTypes: z
            .array(z.nativeEnum(AccountType))
            .max(10)
            .optional()
            .describe(
              "Optional: filter to specific account types (CHEQUING, SAVINGS, CREDIT_CARD, LOAN, MORTGAGE, INVESTMENT, CASH, LINE_OF_CREDIT, ASSET, OTHER). Omit to include all types.",
            ),
        },
        outputSchema: getAccountBalancesOutput,
      },
      async (args, extra) => {
        const ctx = resolve(extra.sessionId);
        if (!ctx) return toolError("No user context");
        const check = requireScope(ctx.scopes, "read");
        if (check.error) return check.result;

        try {
          // Service owns the "open" default so it stays in one place.
          const data = await this.accountsService.getLlmBalances(
            ctx.userId,
            args.accountNames,
            args.status,
            args.accountTypes,
          );
          return toolResult(data);
        } catch (err: unknown) {
          return safeToolError(err);
        }
      },
    );
  }
}
