import { Injectable } from "@nestjs/common";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/server";
import { AccountsService } from "../../accounts/accounts.service";
import { AccountType } from "../../accounts/entities/account.entity";
import {
  resolveUserContext,
  requireScope,
  toolResult,
  toolError,
  safeToolError,
} from "../mcp-context";
import { listAccountsOutput } from "../tool-output-schemas";
import { READ_ONLY } from "../mcp-annotations";
import { uuidString } from "./schema-fragments";

@Injectable()
export class McpAccountsTools {
  constructor(private readonly accountsService: AccountsService) {}

  register(server: McpServer) {
    server.registerTool(
      "list_accounts",
      {
        title: "List accounts",
        annotations: READ_ONLY,
        description:
          "Cash-basis accounts and an assets / liabilities / net-worth summary " +
          "matching the dashboard. A brokerage account's `balance` is its " +
          "market value; others include future transactions (`currentBalance` " +
          "is through today). Both are also in `defaultCurrency` (the totals' " +
          "currency) as `balanceInDefaultCurrency` / " +
          "`currentBalanceInDefaultCurrency` at today's `exchangeRate`: quote " +
          "a foreign account in both, never convert yourself. A null balance " +
          "or total is withheld, not zero: say so, naming `missingRatePairs` " +
          "or `unpricedSymbols`. Loan and mortgage rows carry their schedule. " +
          "`totalAccounts` counts AFTER filtering.",
        inputSchema: z.object({
          basis: z.literal("cash").optional(),
          accountNames: z
            .array(z.string().max(100))
            .max(100)
            .optional()
            .describe("Exact account names, case-insensitive."),
          accountIds: z.array(uuidString()).optional().describe("Account ids."),
          nameQuery: z
            .string()
            .max(100)
            .optional()
            .describe("Case-insensitive substring of the account name."),
          status: z
            .enum(["open", "closed", "all"])
            .optional()
            .describe("Defaults to 'open'."),
          accountTypes: z
            .array(z.nativeEnum(AccountType))
            .max(10)
            .optional()
            .describe("Omit to include every type."),
        }),
        outputSchema: listAccountsOutput,
      },
      async (args, ctx) => {
        const user = resolveUserContext(ctx);
        if (!user) return toolError("No user context");
        const check = requireScope(user.scopes, "read");
        if (check.error) return check.result;

        try {
          // Service owns the "open" default so it stays in one place.
          const data = await this.accountsService.getLlmAccounts(user.userId, {
            accountNames: args.accountNames,
            accountIds: args.accountIds,
            nameQuery: args.nameQuery,
            status: args.status,
            accountTypes: args.accountTypes,
          });
          return toolResult(data);
        } catch (err: unknown) {
          return safeToolError(err);
        }
      },
    );
  }
}
