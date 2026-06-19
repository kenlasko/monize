import { Injectable } from "@nestjs/common";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { TransactionsService } from "../../transactions/transactions.service";
import { TransactionAnalyticsService } from "../../transactions/transaction-analytics.service";
import { AiRelayService } from "../../ai/relay/ai-relay.service";
import { AiActionBuilderService } from "../../ai/actions/ai-action-builder.service";
import { RELAY_PREVIEW_SHOWN } from "../mcp-relay-confirm";
import {
  UserContextResolver,
  requireScope,
  toolResult,
  toolError,
  safeToolError,
  confirmWrite,
} from "../mcp-context";
import { McpWriteLimiter } from "../mcp-write-limiter";
import {
  DEFAULT_TOP_N,
  getDefaultDateRange,
  resolveComparePeriods,
} from "../../common/tool-schemas";
import {
  searchTransactionsOutput,
  queryTransactionsOutput,
  getSpendingByCategoryOutput,
  getIncomeSummaryOutput,
  comparePeriodsOutput,
  getTransfersOutput,
  createTransactionOutput,
  categorizeTransactionOutput,
} from "../tool-output-schemas";
import { READ_ONLY, CREATE, UPDATE } from "../mcp-annotations";

@Injectable()
export class McpTransactionsTools {
  private readonly writeLimiter = new McpWriteLimiter();

  constructor(
    private readonly transactionsService: TransactionsService,
    private readonly analyticsService: TransactionAnalyticsService,
    private readonly relayService: AiRelayService,
    private readonly actionBuilder: AiActionBuilderService,
  ) {}

  register(server: McpServer, resolve: UserContextResolver) {
    server.registerTool(
      "search_transactions",
      {
        title: "Search transactions",
        annotations: READ_ONLY,
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
        outputSchema: searchTransactionsOutput,
      },
      async (args, extra) => {
        const ctx = resolve(extra.sessionId);
        if (!ctx) return toolError("No user context");
        const check = requireScope(ctx.scopes, "read");
        if (check.error) return check.result;

        try {
          // Split-expansion + amount filtering live on the domain service so
          // this tool stays a thin adapter and any AI Assistant equivalent
          // returns the same shape.
          const result = await this.transactionsService.getLlmTransactionRows(
            ctx.userId,
            {
              accountId: args.accountId,
              categoryId: args.categoryId,
              payeeId: args.payeeId,
              startDate: args.startDate,
              endDate: args.endDate,
              query: args.query,
              minAmount: args.minAmount,
              maxAmount: args.maxAmount,
              limit: args.limit,
            },
          );
          return toolResult(result);
        } catch (err: unknown) {
          return safeToolError(err);
        }
      },
    );

    server.registerTool(
      "query_transactions",
      {
        title: "Query transaction totals",
        annotations: READ_ONLY,
        description:
          "Search and aggregate transaction data. Returns totals, counts, and optional grouped breakdowns (category, payee, year, month, week) - never individual transaction details. Returns the same shape as the AI Assistant's query_transactions tool.",
        inputSchema: {
          startDate: z
            .string()
            .max(10)
            .optional()
            .describe("Start date (YYYY-MM-DD). Defaults to 30 days ago."),
          endDate: z
            .string()
            .max(10)
            .optional()
            .describe("End date (YYYY-MM-DD). Defaults to today."),
          accountIds: z
            .array(z.string().uuid())
            .max(50)
            .optional()
            .describe("Optional account IDs to filter to"),
          categoryIds: z
            .array(z.string().uuid())
            .max(100)
            .optional()
            .describe("Optional category IDs to filter to"),
          searchText: z
            .string()
            .max(200)
            .optional()
            .describe("Search payee names or transaction descriptions"),
          groupBy: z
            .enum(["category", "payee", "year", "month", "week"])
            .optional()
            .describe("How to group results for breakdown"),
          direction: z
            .enum(["expenses", "income", "both"])
            .optional()
            .describe("Filter by direction"),
        },
        outputSchema: queryTransactionsOutput,
      },
      async (args, extra) => {
        const ctx = resolve(extra.sessionId);
        if (!ctx) return toolError("No user context");
        const check = requireScope(ctx.scopes, "read");
        if (check.error) return check.result;

        try {
          const defaults = getDefaultDateRange();
          const data = await this.analyticsService.getLlmQueryTransactions(
            ctx.userId,
            {
              startDate: args.startDate ?? defaults.startDate,
              endDate: args.endDate ?? defaults.endDate,
              accountIds: args.accountIds,
              categoryIds: args.categoryIds,
              searchText: args.searchText,
              groupBy: args.groupBy,
              direction: args.direction,
            },
          );
          return toolResult(data);
        } catch (err: unknown) {
          return safeToolError(err);
        }
      },
    );

    server.registerTool(
      "get_spending_by_category",
      {
        title: "Spending by category",
        annotations: READ_ONLY,
        description:
          "Spending breakdown by category for a date range. Returns each category with total amount, percentage of total spending, and transaction count. Sorted by amount descending. Returns the same shape as the AI Assistant's get_spending_by_category tool.",
        inputSchema: {
          startDate: z
            .string()
            .max(10)
            .optional()
            .describe("Start date (YYYY-MM-DD). Defaults to 30 days ago."),
          endDate: z
            .string()
            .max(10)
            .optional()
            .describe("End date (YYYY-MM-DD). Defaults to today."),
          topN: z
            .number()
            .int()
            .min(1)
            .max(50)
            .optional()
            .describe(
              `Limit to top N categories by amount. Defaults to ${DEFAULT_TOP_N}.`,
            ),
        },
        outputSchema: getSpendingByCategoryOutput,
      },
      async (args, extra) => {
        const ctx = resolve(extra.sessionId);
        if (!ctx) return toolError("No user context");
        const check = requireScope(ctx.scopes, "read");
        if (check.error) return check.result;

        try {
          const defaults = getDefaultDateRange();
          const data = await this.analyticsService.getLlmSpendingByCategory(
            ctx.userId,
            args.startDate ?? defaults.startDate,
            args.endDate ?? defaults.endDate,
            args.topN ?? DEFAULT_TOP_N,
          );
          return toolResult(data);
        } catch (err: unknown) {
          return safeToolError(err);
        }
      },
    );

    server.registerTool(
      "get_income_summary",
      {
        title: "Income summary",
        annotations: READ_ONLY,
        description:
          "Income summary for a date range, grouped by category, payee, or month. Returns the same shape as the AI Assistant's get_income_summary tool.",
        inputSchema: {
          startDate: z
            .string()
            .max(10)
            .optional()
            .describe("Start date (YYYY-MM-DD). Defaults to 30 days ago."),
          endDate: z
            .string()
            .max(10)
            .optional()
            .describe("End date (YYYY-MM-DD). Defaults to today."),
          groupBy: z
            .enum(["category", "payee", "month"])
            .optional()
            .describe("How to group income (default: category)"),
        },
        outputSchema: getIncomeSummaryOutput,
      },
      async (args, extra) => {
        const ctx = resolve(extra.sessionId);
        if (!ctx) return toolError("No user context");
        const check = requireScope(ctx.scopes, "read");
        if (check.error) return check.result;

        try {
          const defaults = getDefaultDateRange();
          const data = await this.analyticsService.getLlmIncomeSummary(
            ctx.userId,
            args.startDate ?? defaults.startDate,
            args.endDate ?? defaults.endDate,
            args.groupBy ?? "category",
          );
          return toolResult(data);
        } catch (err: unknown) {
          return safeToolError(err);
        }
      },
    );

    server.registerTool(
      "compare_periods",
      {
        title: "Compare periods",
        annotations: READ_ONLY,
        description:
          "Compare spending or income between two time periods. Returns side-by-side comparison showing absolute and percentage changes per group. If any of the four period dates are omitted, defaults to the previous full month (period1) vs the current month-to-date (period2). Returns the same shape as the AI Assistant's compare_periods tool.",
        inputSchema: {
          period1Start: z
            .string()
            .max(10)
            .optional()
            .describe(
              "First period start (YYYY-MM-DD). Defaults to the start of last month.",
            ),
          period1End: z
            .string()
            .max(10)
            .optional()
            .describe(
              "First period end (YYYY-MM-DD). Defaults to the last day of last month.",
            ),
          period2Start: z
            .string()
            .max(10)
            .optional()
            .describe(
              "Second period start (YYYY-MM-DD). Defaults to the start of the current month.",
            ),
          period2End: z
            .string()
            .max(10)
            .optional()
            .describe("Second period end (YYYY-MM-DD). Defaults to today."),
          groupBy: z
            .enum(["category", "payee"])
            .optional()
            .describe("How to group comparison (default: category)"),
          direction: z
            .enum(["expenses", "income", "both"])
            .optional()
            .describe("Filter by direction (default: expenses)"),
        },
        outputSchema: comparePeriodsOutput,
      },
      async (args, extra) => {
        const ctx = resolve(extra.sessionId);
        if (!ctx) return toolError("No user context");
        const check = requireScope(ctx.scopes, "read");
        if (check.error) return check.result;

        try {
          const periods = resolveComparePeriods({
            period1Start: args.period1Start,
            period1End: args.period1End,
            period2Start: args.period2Start,
            period2End: args.period2End,
          });
          const data = await this.analyticsService.getLlmPeriodComparison(
            ctx.userId,
            {
              period1Start: periods.period1Start,
              period1End: periods.period1End,
              period2Start: periods.period2Start,
              period2End: periods.period2End,
              groupBy: args.groupBy,
              direction: args.direction,
            },
          );
          return toolResult(data);
        } catch (err: unknown) {
          return safeToolError(err);
        }
      },
    );

    server.registerTool(
      "get_transfers",
      {
        title: "Get transfers",
        annotations: READ_ONLY,
        description:
          "Get transfer activity between the user's own accounts for a date range. Returns per-account inbound, outbound, net, and count. Transfers are deliberately excluded from other transaction queries because they net to zero across accounts. Returns the same shape as the AI Assistant's get_transfers tool.",
        inputSchema: {
          startDate: z
            .string()
            .max(10)
            .optional()
            .describe("Start date (YYYY-MM-DD). Defaults to 30 days ago."),
          endDate: z
            .string()
            .max(10)
            .optional()
            .describe("End date (YYYY-MM-DD). Defaults to today."),
          accountIds: z
            .array(z.string().uuid())
            .max(50)
            .optional()
            .describe(
              "Optional account IDs to filter to. Omit to cover all accounts.",
            ),
        },
        outputSchema: getTransfersOutput,
      },
      async (args, extra) => {
        const ctx = resolve(extra.sessionId);
        if (!ctx) return toolError("No user context");
        const check = requireScope(ctx.scopes, "read");
        if (check.error) return check.result;

        try {
          const defaults = getDefaultDateRange();
          const result = await this.analyticsService.getTransfersByAccount(
            ctx.userId,
            args.startDate ?? defaults.startDate,
            args.endDate ?? defaults.endDate,
            args.accountIds,
          );
          return toolResult(result);
        } catch (err: unknown) {
          return safeToolError(err);
        }
      },
    );

    server.registerTool(
      "create_transaction",
      {
        title: "Create transaction",
        annotations: CREATE,
        description:
          "Create a new transaction. The payee name is matched to an existing payee (by name, case-insensitive, or alias) and the transaction is linked to it, inheriting its default category when no category is given. If no payee matches, a new payee is created by default; set createPayeeIfMissing=false to instead record the name as free text without creating a payee (e.g. for a one-time payee). Set dryRun=true to preview (the preview reports payeeMatched and payeeWillBeCreated) without saving. When dryRun is false, the user is asked to confirm before the transaction is saved (clients that support it show a confirmation dialog).",
        inputSchema: {
          accountId: z.string().uuid().describe("Account ID"),
          amount: z
            .number()
            .min(-999999999999)
            .max(999999999999)
            .describe("Amount (positive for income, negative for expenses)"),
          date: z.string().max(10).describe("Transaction date (YYYY-MM-DD)"),
          payeeName: z
            .string()
            .max(100)
            .optional()
            .describe(
              "Payee name. Matched to an existing payee when one exists; otherwise recorded as a new free-text name.",
            ),
          categoryId: z.string().uuid().optional().describe("Category ID"),
          description: z
            .string()
            .max(500)
            .optional()
            .describe("Description or memo"),
          createPayeeIfMissing: z
            .boolean()
            .optional()
            .default(true)
            .describe(
              "When the payee name matches no existing payee, create a new payee (true, the default) or record the name as free text without creating a payee (false). Ignored when the name matches an existing payee.",
            ),
          dryRun: z
            .boolean()
            .optional()
            .default(false)
            .describe(
              "If true, validate and return a preview without creating the transaction",
            ),
        },
        outputSchema: createTransactionOutput,
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
          // Default to creating a payee for an unmatched name (the SDK applies
          // the same schema default; this keeps direct callers/tests consistent).
          const createPayeeIfMissing = args.createPayeeIfMissing ?? true;

          // Shared preview: validates account + category ownership, resolves
          // names, and sanitizes strings (matches @SanitizeHtml() DTO behavior)
          // identically to the AI Assistant confirmation flow.
          const preview = await this.transactionsService.previewCreate(
            ctx.userId,
            {
              accountId: args.accountId,
              amount: args.amount,
              transactionDate: args.date,
              payeeName: args.payeeName,
              categoryId: args.categoryId,
              description: args.description,
              createPayeeIfMissing,
            },
          );

          // Surface whether the payee resolved to an existing record and, when
          // it did not, whether a new payee will be created or the name kept as
          // free text -- so the model can describe what will happen.
          const payeeMessage =
            preview.payeeName && !preview.payeeMatched
              ? preview.payeeWillBeCreated
                ? ` No existing payee matches "${preview.payeeName}" -- a new payee will be created and linked. Pass createPayeeIfMissing=false to keep it as a free-text name instead.`
                : ` No existing payee matches "${preview.payeeName}" -- it will be recorded as a free-text name (no payee created).`
              : "";

          // Dry-run mode: return preview without persisting
          if (args.dryRun) {
            return toolResult({
              dryRun: true,
              preview: {
                accountId: preview.accountId,
                accountName: preview.accountName,
                amount: preview.amount,
                date: preview.transactionDate,
                payeeId: preview.payeeId,
                payeeName: preview.payeeName,
                payeeMatched: preview.payeeMatched,
                payeeWillBeCreated: preview.payeeWillBeCreated,
                categoryId: preview.categoryId,
                categoryName: preview.categoryName,
                description: preview.description,
                currencyCode: preview.currencyCode,
              },
              message:
                "This is a preview. Call again with dryRun=false to create the transaction." +
                payeeMessage,
            });
          }

          // When this call is serving a prompt the user typed in the Monize web
          // chat (reverse relay), confirm there with the same approve/reject
          // card the native AI Assistant uses, instead of an elicitation in the
          // agent's MCP client. The browser commits on approval; nothing is
          // written here.
          const pendingAction = this.actionBuilder.buildCreateTransaction(
            ctx.userId,
            preview,
          );
          if (this.relayService.emitPendingAction(ctx.userId, pendingAction)) {
            return toolResult(RELAY_PREVIEW_SHOWN);
          }

          // Ask the client to confirm before persisting (AI Assistant parity).
          // Falls through to the write only when the client cannot show a dialog.
          const confirmLines = [
            "Create this transaction?",
            `Account: ${preview.accountName}`,
            `Amount: ${preview.amount} ${preview.currencyCode}`,
            `Date: ${preview.transactionDate}`,
          ];
          if (preview.payeeName) {
            const payeeSuffix = preview.payeeMatched
              ? ""
              : preview.payeeWillBeCreated
                ? " (new payee)"
                : " (free text)";
            confirmLines.push(`Payee: ${preview.payeeName}${payeeSuffix}`);
          }
          if (preview.categoryName) {
            confirmLines.push(`Category: ${preview.categoryName}`);
          }
          const confirmation = await confirmWrite(
            server,
            confirmLines.join("\n"),
            extra.requestId,
          );
          if (confirmation === "declined") {
            return toolError(
              "Cancelled: the confirmation was declined, so no transaction was created. Do not retry unless the user asks again.",
            );
          }

          const transaction = await this.transactionsService.create(
            ctx.userId,
            {
              accountId: preview.accountId,
              amount: preview.amount,
              transactionDate: preview.transactionDate,
              payeeId: preview.payeeId ?? undefined,
              payeeName: preview.payeeName ?? undefined,
              categoryId: preview.categoryId ?? undefined,
              description: preview.description ?? undefined,
              currencyCode: preview.currencyCode,
            },
            { createPayeeIfMissing },
          );

          this.writeLimiter.record(ctx.userId, "create_transaction");

          return toolResult({
            id: transaction.id,
            date: transaction.transactionDate,
            // amount is a decimal column with no numeric transformer, so the
            // entity carries it as a string; coerce to a number so it satisfies
            // the tool's output schema (and matches the dry-run preview).
            amount: Number(transaction.amount),
            payeeId: transaction.payeeId,
            payeeName: transaction.payeeName,
            payeeMatched: preview.payeeMatched,
            // True when an unmatched name resulted in a newly linked payee.
            payeeCreated: !preview.payeeMatched && Boolean(transaction.payeeId),
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
        title: "Categorize transaction",
        annotations: UPDATE,
        description:
          "Assign a category to a transaction. The user is asked to confirm before the change is saved (clients that support it show a confirmation dialog).",
        inputSchema: {
          transactionId: z.string().uuid().describe("Transaction ID"),
          categoryId: z.string().uuid().describe("Category ID"),
        },
        outputSchema: categorizeTransactionOutput,
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
          // Resolve friendly details (and validate ownership) so the client's
          // confirmation dialog shows what is changing, mirroring the AI
          // Assistant card.
          const preview = await this.transactionsService.previewCategorize(
            ctx.userId,
            args.transactionId,
            args.categoryId,
          );
          // Relay path: show the approve/reject card in the web chat (see
          // create_transaction). Nothing is written here on success.
          const pendingAction = this.actionBuilder.buildCategorizeTransaction(
            ctx.userId,
            preview,
          );
          if (this.relayService.emitPendingAction(ctx.userId, pendingAction)) {
            return toolResult(RELAY_PREVIEW_SHOWN);
          }

          const confirmLines = [
            "Apply this category change?",
            preview.payeeName ? `Payee: ${preview.payeeName}` : null,
            `Amount: ${preview.amount}`,
            `Date: ${preview.transactionDate}`,
            `Category: ${preview.currentCategoryName ?? "Uncategorized"} -> ${preview.newCategoryName}`,
          ].filter((line): line is string => line !== null);
          const confirmation = await confirmWrite(
            server,
            confirmLines.join("\n"),
            extra.requestId,
          );
          if (confirmation === "declined") {
            return toolError(
              "Cancelled: the confirmation was declined, so the category was not changed. Do not retry unless the user asks again.",
            );
          }

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
