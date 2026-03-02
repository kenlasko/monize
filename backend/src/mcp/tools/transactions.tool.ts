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
  safeToolError,
} from "../mcp-context";
import { McpWriteLimiter } from "../mcp-write-limiter";

/**
 * LLM07-F3: Strip HTML angle brackets from string values.
 * MCP tools bypass the DTO layer's @SanitizeHtml() decorator,
 * so we apply the same sanitization inline.
 */
function stripHtml(value: string | undefined): string | undefined {
  if (value === undefined || value === null) return value;
  return value.replace(/[<>]/g, "");
}

@Injectable()
export class McpTransactionsTools {
  private readonly writeLimiter = new McpWriteLimiter();

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
          query: z.string().max(200).optional().describe("Search text"),
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
          startDate: z
            .string()
            .max(10)
            .optional()
            .describe("Start date (YYYY-MM-DD)"),
          endDate: z
            .string()
            .max(10)
            .optional()
            .describe("End date (YYYY-MM-DD)"),
          minAmount: z
            .number()
            .min(-999999999999)
            .max(999999999999)
            .optional()
            .describe("Minimum amount"),
          maxAmount: z
            .number()
            .min(-999999999999)
            .max(999999999999)
            .optional()
            .describe("Maximum amount"),
          limit: z
            .number()
            .min(1)
            .max(100)
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
        } catch (err: unknown) {
          return safeToolError(err);
        }
      },
    );

    server.registerTool(
      "create_transaction",
      {
        description:
          "Create a new transaction. Set dryRun=true to preview without saving.",
        inputSchema: {
          accountId: z.string().uuid().describe("Account ID"),
          amount: z
            .number()
            .min(-999999999999)
            .max(999999999999)
            .describe("Amount (positive for income, negative for expenses)"),
          date: z.string().max(10).describe("Transaction date (YYYY-MM-DD)"),
          payeeName: z.string().max(100).optional().describe("Payee name"),
          categoryId: z.string().uuid().optional().describe("Category ID"),
          description: z
            .string()
            .max(500)
            .optional()
            .describe("Description or memo"),
          dryRun: z
            .boolean()
            .optional()
            .default(false)
            .describe(
              "If true, validate and return a preview without creating the transaction",
            ),
        },
      },
      async (args, extra) => {
        const ctx = resolve(extra.sessionId);
        if (!ctx) return toolError("No user context");
        const check = requireScope(ctx.scopes, "write");
        if (check.error) return check.result;

        // Rate limit check
        const limitCheck = this.writeLimiter.checkLimit(ctx.userId);
        if (!limitCheck.allowed) {
          return toolError(
            `Daily write limit reached (${limitCheck.limit} operations per day). Try again tomorrow.`,
          );
        }

        try {
          const account = await this.accountsService.findOne(
            ctx.userId,
            args.accountId,
          );

          // Dry-run mode: return preview without persisting
          if (args.dryRun) {
            return toolResult({
              dryRun: true,
              preview: {
                accountId: args.accountId,
                accountName: account.name,
                amount: args.amount,
                date: args.date,
                payeeName: stripHtml(args.payeeName) || null,
                categoryId: args.categoryId || null,
                description: stripHtml(args.description) || null,
                currencyCode: account.currencyCode,
              },
              message:
                "This is a preview. Call again with dryRun=false to create the transaction.",
            });
          }

          // LLM07-F3: Sanitize user-controlled strings (matches @SanitizeHtml() DTO behavior)
          const transaction = await this.transactionsService.create(
            ctx.userId,
            {
              accountId: args.accountId,
              amount: args.amount,
              transactionDate: args.date,
              payeeName: stripHtml(args.payeeName),
              categoryId: args.categoryId,
              description: stripHtml(args.description),
              currencyCode: account.currencyCode,
            },
          );

          this.writeLimiter.record(ctx.userId, "create_transaction");

          return toolResult({
            id: transaction.id,
            date: transaction.transactionDate,
            amount: transaction.amount,
            payeeName: transaction.payeeName,
            status: transaction.status,
          });
        } catch (err: unknown) {
          return safeToolError(err);
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

        // Rate limit check
        const limitCheck = this.writeLimiter.checkLimit(ctx.userId);
        if (!limitCheck.allowed) {
          return toolError(
            `Daily write limit reached (${limitCheck.limit} operations per day). Try again tomorrow.`,
          );
        }

        try {
          const transaction = await this.transactionsService.update(
            ctx.userId,
            args.transactionId,
            { categoryId: args.categoryId },
          );

          this.writeLimiter.record(ctx.userId, "categorize_transaction");

          return toolResult({
            id: transaction.id,
            categoryId: transaction.categoryId,
            message: "Transaction categorized successfully",
          });
        } catch (err: unknown) {
          return safeToolError(err);
        }
      },
    );
  }
}
