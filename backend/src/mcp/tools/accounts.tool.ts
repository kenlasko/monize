import { SharedReviewService } from "../../shared-expenses/shared-review.service";
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
  constructor(
    private readonly accountsService: AccountsService,
    private readonly sharedReview: SharedReviewService,
  ) {}

  register(server: McpServer) {
    server.registerTool(
      "list_accounts",
      {
        title: "List accounts",
        annotations: READ_ONLY,
        description:
          "Accounts and dashboard assets/liabilities/net worth. Brokerage `balance` " +
          "is market value; other balances include future transactions, while " +
          "`currentBalance` ends today. `balanceInDefaultCurrency` and " +
          "`currentBalanceInDefaultCurrency` use today's `exchangeRate` and the " +
          "totals' `defaultCurrency`: quote foreign accounts in both currencies, " +
          "never convert yourself. Null means withheld, not zero: name " +
          "`missingRatePairs` or `unpricedSymbols`. Loans/mortgages include their " +
          "schedule. `totalAccounts` counts filtered accounts.",
        inputSchema: z.object({
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
          return toolResult(
            await this.sharedReview.annotate(user.userId, data),
          );
        } catch (err: unknown) {
          return safeToolError(err);
        }
      },
    );
  }
}
