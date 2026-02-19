import { Injectable } from "@nestjs/common";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { TransactionsService } from "../../transactions/transactions.service";
import { AccountsService } from "../../accounts/accounts.service";
import {
  UserContextResolver,
  requireScope,
  toolResult,
  toolError,
} from "../mcp-context";

@Injectable()
export class McpTransactionsTools {
  constructor(
    private readonly transactionsService: TransactionsService,
    private readonly accountsService: AccountsService,
  ) {}

  register(server: McpServer, resolve: UserContextResolver) {
    server.registerTool(
      "search_transactions",
      {
        description: "Search and filter transactions",
        inputSchema: {
          query: z.string().optional().describe("Search text"),
          accountId: z
            .string()
            .uuid()
            .optional()
            .describe("Filter by account ID"),
          categoryId: z
            .string()
            .uuid()
            .optional()
            .describe("Filter by category ID"),
          payeeId: z.string().uuid().optional().describe("Filter by payee ID"),
          startDate: z.string().optional().describe("Start date (YYYY-MM-DD)"),
          endDate: z.string().optional().describe("End date (YYYY-MM-DD)"),
          minAmount: z.number().optional().describe("Minimum amount"),
          maxAmount: z.number().optional().describe("Maximum amount"),
          limit: z
            .number()
            .optional()
            .default(50)
            .describe("Max results (default 50, max 100)"),
        },
      },
      async (args, extra) => {
        const ctx = resolve(extra.sessionId);
        if (!ctx) return toolError("No user context");
        const check = requireScope(ctx.scopes, "read");
        if (check.error) return check.result;

        try {
          const limit = Math.min(args.limit || 50, 100);
          const result = await this.transactionsService.findAll(
            ctx.userId,
            args.accountId ? [args.accountId] : undefined,
            args.startDate,
            args.endDate,
            args.categoryId ? [args.categoryId] : undefined,
            args.payeeId ? [args.payeeId] : undefined,
            1,
            limit,
            false,
            args.query,
          );
          const transactions = result.data
            .filter((t: any) => {
              if (args.minAmount !== undefined && t.amount < args.minAmount)
                return false;
              if (args.maxAmount !== undefined && t.amount > args.maxAmount)
                return false;
              return true;
            })
            .map((t: any) => ({
              id: t.id,
              date: t.transactionDate,
              payeeName: t.payeeName,
              categoryName: t.category?.name,
              amount: t.amount,
              accountName: t.account?.name,
              description: t.description,
              status: t.status,
            }));
          return toolResult({
            transactions,
            total: result.pagination.total,
            hasMore: result.pagination.hasMore,
          });
        } catch (err: any) {
          return toolError(err.message);
        }
      },
    );

    server.registerTool(
      "create_transaction",
      {
        description: "Create a new transaction",
        inputSchema: {
          accountId: z.string().uuid().describe("Account ID"),
          amount: z
            .number()
            .describe("Amount (positive for income, negative for expenses)"),
          date: z.string().describe("Transaction date (YYYY-MM-DD)"),
          payeeName: z.string().optional().describe("Payee name"),
          categoryId: z.string().uuid().optional().describe("Category ID"),
          description: z.string().optional().describe("Description or memo"),
        },
      },
      async (args, extra) => {
        const ctx = resolve(extra.sessionId);
        if (!ctx) return toolError("No user context");
        const check = requireScope(ctx.scopes, "write");
        if (check.error) return check.result;

        try {
          const account = await this.accountsService.findOne(
            ctx.userId,
            args.accountId,
          );
          const transaction = await this.transactionsService.create(
            ctx.userId,
            {
              accountId: args.accountId,
              amount: args.amount,
              transactionDate: args.date,
              payeeName: args.payeeName,
              categoryId: args.categoryId,
              description: args.description,
              currencyCode: account.currencyCode,
            },
          );
          return toolResult({
            id: transaction.id,
            date: transaction.transactionDate,
            amount: transaction.amount,
            payeeName: transaction.payeeName,
            status: transaction.status,
          });
        } catch (err: any) {
          return toolError(err.message);
        }
      },
    );

    server.registerTool(
      "categorize_transaction",
      {
        description: "Assign a category to a transaction",
        inputSchema: {
          transactionId: z.string().uuid().describe("Transaction ID"),
          categoryId: z.string().uuid().describe("Category ID"),
        },
      },
      async (args, extra) => {
        const ctx = resolve(extra.sessionId);
        if (!ctx) return toolError("No user context");
        const check = requireScope(ctx.scopes, "write");
        if (check.error) return check.result;

        try {
          const transaction = await this.transactionsService.update(
            ctx.userId,
            args.transactionId,
            { categoryId: args.categoryId },
          );
          return toolResult({
            id: transaction.id,
            categoryId: transaction.categoryId,
            message: "Transaction categorized successfully",
          });
        } catch (err: any) {
          return toolError(err.message);
        }
      },
    );
  }
}
