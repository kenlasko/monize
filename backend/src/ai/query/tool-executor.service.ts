import {
  Injectable,
  Inject,
  forwardRef,
  Logger,
  HttpException,
} from "@nestjs/common";
import { AccountsService } from "../../accounts/accounts.service";
import { TransactionsService } from "../../transactions/transactions.service";
import { PayeesService } from "../../payees/payees.service";
import {
  PayeeToolPrepService,
  ManageCreatePayeeRow,
  ManageUpdatePayeeRow,
  ManageDeletePayeeRow,
} from "../../payees/payee-tool-prep.service";
import { AiActionBuilderService } from "../actions/ai-action-builder.service";
import { PendingAiAction } from "../actions/ai-action.types";
import {
  TransactionToolPrepService,
  CreateRowInput,
  TransferRowInput,
  UpdateRowInput,
} from "../../transactions/transaction-tool-prep.service";
import { AccountType } from "../../accounts/entities/account.entity";
import { CategoriesService } from "../../categories/categories.service";
import { TransactionAnalyticsService } from "../../transactions/transaction-analytics.service";
import { NetWorthService } from "../../net-worth/net-worth.service";
import { BudgetReportsService } from "../../budgets/budget-reports.service";
import { PortfolioService } from "../../securities/portfolio.service";
import { SecuritiesService } from "../../securities/securities.service";
import {
  InvestmentTransactionsService,
  InvestmentCreateRowInput,
  InvestmentUpdateRowInput,
  LlmCapitalGainsGroupBy,
  LlmInvestmentTxGroupBy,
} from "../../securities/investment-transactions.service";
import { InvestmentAction } from "../../securities/entities/investment-transaction.entity";
import {
  ScheduledTransactionsService,
  LlmScheduledKind,
} from "../../scheduled-transactions/scheduled-transactions.service";
import { validateToolInput } from "./tool-input-schemas";
import { executeCalculation, CalculateInput } from "./calculate-tool";
import { sanitizePromptValue } from "../../common/sanitization.util";
import {
  getDefaultDateRange,
  resolveComparePeriods,
} from "../../common/tool-schemas";

interface ToolResult {
  data: unknown;
  summary: string;
  sources: Array<{ type: string; description: string; dateRange?: string }>;
  isError?: boolean;
  // Sideband for human-in-the-loop write tools: the signed action descriptor +
  // preview the query service emits as a `pending_action` SSE event. Never fed
  // back to the model -- `data` carries the LLM-safe status instead.
  pendingAction?: PendingAiAction;
  // A single proposing tool result may carry MANY cards (e.g. individual-mode
  // bulk). The query service emits each entry as its own `pending_action` event.
  pendingActions?: PendingAiAction[];
}

/**
 * LLM-facing status returned by every write tool. It deliberately contains no
 * signature and tells the model the action is awaiting user approval so it does
 * not retry or claim success.
 */
const PENDING_ACTION_TOOL_RESULT = {
  status: "preview_shown",
  message:
    "A confirmation card has been shown to the user. The action has NOT been performed. Do not call this tool again or claim it was done; briefly ask the user to review and approve the card.",
};

@Injectable()
export class ToolExecutorService {
  private readonly logger = new Logger(ToolExecutorService.name);

  constructor(
    @Inject(forwardRef(() => AccountsService))
    private readonly accountsService: AccountsService,
    @Inject(forwardRef(() => CategoriesService))
    private readonly categoriesService: CategoriesService,
    @Inject(forwardRef(() => TransactionAnalyticsService))
    private readonly analyticsService: TransactionAnalyticsService,
    @Inject(forwardRef(() => NetWorthService))
    private readonly netWorthService: NetWorthService,
    @Inject(forwardRef(() => BudgetReportsService))
    private readonly budgetReportsService: BudgetReportsService,
    private readonly portfolioService: PortfolioService,
    private readonly securitiesService: SecuritiesService,
    private readonly investmentTransactionsService: InvestmentTransactionsService,
    @Inject(forwardRef(() => ScheduledTransactionsService))
    private readonly scheduledTransactionsService: ScheduledTransactionsService,
    @Inject(forwardRef(() => TransactionsService))
    private readonly transactionsService: TransactionsService,
    @Inject(forwardRef(() => PayeesService))
    private readonly payeesService: PayeesService,
    @Inject(forwardRef(() => PayeeToolPrepService))
    private readonly payeePrepService: PayeeToolPrepService,
    @Inject(forwardRef(() => TransactionToolPrepService))
    private readonly prepService: TransactionToolPrepService,
    private readonly actionBuilder: AiActionBuilderService,
  ) {}

  async execute(
    userId: string,
    toolName: string,
    input: Record<string, unknown>,
  ): Promise<ToolResult> {
    // LLM07-F1: Validate tool input against Zod schema
    const validation = validateToolInput(toolName, input);
    if (!validation.success) {
      this.logger.warn(
        `Tool ${toolName} input validation failed user=${userId}: ${validation.error}`,
      );
      return {
        data: { error: validation.error },
        summary: `Invalid input for ${toolName}: ${validation.error}`,
        sources: [],
        isError: true,
      };
    }
    const validatedInput = validation.data;

    const start = Date.now();
    this.logger.log(
      `execute tool=${toolName} user=${userId} inputKeys=[${Object.keys(validatedInput).join(",")}]`,
    );

    try {
      let result: ToolResult;
      switch (toolName) {
        case "list_transactions":
          result = await this.listTransactions(userId, validatedInput);
          break;
        case "list_accounts":
          result = await this.listAccounts(userId, validatedInput);
          break;
        case "get_categories":
          result = await this.getCategories(userId, validatedInput);
          break;
        case "get_net_worth_history":
          result = await this.getNetWorthHistory(userId, validatedInput);
          break;
        case "compare_periods":
          result = await this.comparePeriods(userId, validatedInput);
          break;
        case "get_portfolio_summary":
          result = await this.getPortfolioSummary(userId, validatedInput);
          break;
        case "list_investment_transactions":
          result = await this.listInvestmentTransactions(
            userId,
            validatedInput,
          );
          break;
        case "get_capital_gains":
          result = await this.getCapitalGains(userId, validatedInput);
          break;
        case "get_budget_status":
          result = await this.getBudgetStatus(userId, validatedInput);
          break;
        case "get_upcoming_bills":
          result = await this.getUpcomingBills(userId, validatedInput);
          break;
        case "calculate":
          result = this.calculate(validatedInput);
          break;
        case "render_chart":
          result = this.renderChart(validatedInput);
          break;
        case "manage_transactions":
          result = await this.manageTransactions(userId, validatedInput);
          break;
        case "manage_payees":
          result = await this.managePayees(userId, validatedInput);
          break;
        case "create_security":
          result = await this.createSecurityAction(userId, validatedInput);
          break;
        case "lookup_securities":
          result = await this.lookupSecuritiesAction(userId, validatedInput);
          break;
        case "manage_investment_transactions":
          result = await this.manageInvestmentTransactions(
            userId,
            validatedInput,
          );
          break;
        default:
          this.logger.warn(`execute unknown tool=${toolName} user=${userId}`);
          return {
            data: null,
            summary: `Unknown tool: ${toolName}`,
            sources: [],
          };
      }
      this.logger.log(
        `execute done tool=${toolName} user=${userId} ms=${Date.now() - start} sources=${result.sources.length}`,
      );
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      this.logger.error(
        `execute failed tool=${toolName} user=${userId} ms=${Date.now() - start}: ${message}`,
        error instanceof Error ? error.stack : undefined,
      );
      return {
        data: { error: "An error occurred while retrieving data." },
        summary: `Error executing ${toolName}: unable to retrieve data.`,
        sources: [],
        isError: true,
      };
    }
  }

  private async resolveAccountIds(
    userId: string,
    accountNames?: string[],
  ): Promise<string[] | undefined> {
    if (!accountNames || accountNames.length === 0) return undefined;

    const accounts = await this.accountsService.findAll(userId, false);
    const nameMap = new Map(accounts.map((a) => [a.name.toLowerCase(), a.id]));

    return accountNames
      .map((name) => nameMap.get(name.toLowerCase()))
      .filter((id): id is string => id !== undefined);
  }

  /**
   * Resolve a single account name to its id + currency. Returns undefined when
   * the name does not match any of the user's open accounts. Thin wrapper over
   * the shared AccountsService.resolveByName.
   */
  private async resolveAccountByName(
    userId: string,
    accountName: string,
  ): Promise<{ id: string; name: string; currencyCode: string } | undefined> {
    return this.accountsService.resolveByName(userId, accountName);
  }

  /**
   * Resolve a single category name to its id, failing loudly (returns null)
   * when it cannot be resolved so the caller surfaces a clear error rather than
   * silently dropping it.
   */
  private async resolveSingleCategoryId(
    userId: string,
    categoryName: string,
  ): Promise<string | null> {
    const resolved = await this.analyticsService.resolveLlmCategoryIds(userId, [
      categoryName,
    ]);
    return resolved.categoryIds[0] ?? null;
  }

  private toolError(message: string): ToolResult {
    return {
      data: { error: message },
      summary: message,
      sources: [],
      isError: true,
    };
  }

  /**
   * Map an exception from a write preview into a tool result. 4xx messages
   * (e.g. duplicate payee, transaction not found) are passed through so the
   * model can relay them; anything else becomes a generic error.
   */
  private toolErrorFromException(err: unknown, fallback: string): ToolResult {
    if (err instanceof HttpException) {
      const status = err.getStatus();
      if (status >= 400 && status < 500) {
        return this.toolError(err.message);
      }
    }
    this.logger.warn(
      `write preview failed: ${err instanceof Error ? err.message : err}`,
    );
    return this.toolError(fallback);
  }

  /**
   * Unified transaction list/aggregate tool. Replaces search_transactions,
   * query_transactions, and get_transfers: resolves account/category/payee
   * NAMES to ids, returns a rich summary (+ optional grouped breakdown and
   * transfer rollup), and only attaches the raw transaction rows when the
   * caller sets includeTransactions.
   */
  private async listTransactions(
    userId: string,
    input: Record<string, unknown>,
  ): Promise<ToolResult> {
    const defaults = getDefaultDateRange();
    const startDate = (input.startDate as string) ?? defaults.startDate;
    const endDate = (input.endDate as string) ?? defaults.endDate;
    const accountNames = input.accountNames as string[] | undefined;
    const categoryNames = input.categoryNames as string[] | undefined;
    const payeeNames = input.payeeNames as string[] | undefined;
    const searchText = input.searchText as string | undefined;
    const minAmount = input.minAmount as number | undefined;
    const maxAmount = input.maxAmount as number | undefined;
    const direction = input.direction as
      | "expenses"
      | "income"
      | "both"
      | undefined;
    const groupBy = input.groupBy as
      | "category"
      | "payee"
      | "year"
      | "month"
      | "week"
      | "none"
      | undefined;
    const transfersOnly = input.transfersOnly as boolean | undefined;
    const includeTransactions =
      (input.includeTransactions as boolean | undefined) ?? false;
    const limit = Math.min((input.limit as number | undefined) ?? 50, 100);
    const sortBy =
      (input.sortBy as "date" | "amount" | "payee" | undefined) ?? "date";
    const sortDirection =
      (input.sortDirection as "asc" | "desc" | undefined) ?? "desc";

    const accountIds = await this.resolveAccountIds(userId, accountNames);

    let categoryIds: string[] | undefined;
    if (categoryNames && categoryNames.length > 0) {
      const resolved = await this.analyticsService.resolveLlmCategoryIds(
        userId,
        categoryNames,
      );
      if (resolved.unresolved.length > 0) {
        return this.toolError(
          `Unknown categor${resolved.unresolved.length === 1 ? "y" : "ies"}: ${resolved.unresolved.join(", ")}. Call get_categories to look up valid names; subcategories can be referenced as "Parent: Child".`,
        );
      }
      categoryIds = resolved.categoryIds;
    }

    let payeeIds: string[] | undefined;
    if (payeeNames && payeeNames.length > 0) {
      const ids: string[] = [];
      const unresolved: string[] = [];
      for (const name of payeeNames) {
        const payee = await this.payeesService.findByName(userId, name);
        if (payee) ids.push(payee.id);
        else unresolved.push(name);
      }
      if (unresolved.length > 0) {
        return this.toolError(
          `Unknown payee${unresolved.length === 1 ? "" : "s"}: ${unresolved.join(", ")}. Call get_payees to look up valid names.`,
        );
      }
      payeeIds = ids;
    }

    const data = await this.analyticsService.getLlmListTransactions(userId, {
      startDate,
      endDate,
      accountIds,
      categoryIds,
      payeeIds,
      searchText,
      minAmount,
      maxAmount,
      direction,
      groupBy,
      transfersOnly,
    });

    let merged: Record<string, unknown> = data as unknown as Record<
      string,
      unknown
    >;
    if (includeTransactions) {
      const rows = await this.transactionsService.getLlmTransactionRows(
        userId,
        {
          accountId: accountIds?.[0],
          categoryId: categoryIds?.[0],
          payeeId: payeeIds?.[0],
          startDate,
          endDate,
          query: searchText,
          minAmount,
          maxAmount,
          limit,
          sortBy,
          sortDirection,
        },
      );
      merged = {
        ...merged,
        transactions: rows.transactions,
        total: rows.total,
        hasMore: rows.hasMore,
        truncatedTransactionList: rows.hasMore,
      };
    }

    const summaryParts = [
      `${data.transactionCount} transactions from ${startDate} to ${endDate}. Income: ${data.totalIncome.toFixed(2)}, Expenses: ${data.totalExpenses.toFixed(2)}, Net: ${data.netCashFlow.toFixed(2)}`,
    ];
    if (data.groupedBy !== "none") {
      summaryParts.push(`Grouped by ${data.groupedBy}.`);
    }
    if (data.transfers) {
      summaryParts.push(
        `Transfers: inbound ${data.transfers.totalInbound.toFixed(2)}, outbound ${data.transfers.totalOutbound.toFixed(2)}.`,
      );
    }
    if (includeTransactions) {
      summaryParts.push(
        `Included ${(merged.transactions as unknown[]).length} raw row${(merged.transactions as unknown[]).length === 1 ? "" : "s"}${merged.hasMore ? " (more available)" : ""}.`,
      );
    }

    return {
      data: merged,
      summary: summaryParts.join(" "),
      sources: [
        {
          type: "transactions",
          description: `Transaction summary${categoryNames ? ` for ${categoryNames.join(", ")}` : ""}${accountNames ? ` in ${accountNames.join(", ")}` : ""}`,
          dateRange: `${startDate} to ${endDate}`,
        },
      ],
    };
  }

  /**
   * Unified cash-transaction write handler. Resolves names + builds previews via
   * the shared prep service, then emits the right pending action(s) per
   * operation/approvalMode: a single item -> one single descriptor; bulk + bulk
   * mode -> one create_transactions (standard create) or batch_actions
   * (update/delete/transfer); bulk + individual mode -> an ARRAY of single
   * descriptors (one card per ok row).
   */
  private async manageTransactions(
    userId: string,
    input: Record<string, unknown>,
  ): Promise<ToolResult> {
    const operation = input.operation as "create" | "update" | "delete";
    const items = (input.items as Array<Record<string, unknown>>) ?? [];
    const approvalMode =
      (input.approvalMode as "bulk" | "individual" | undefined) ?? "bulk";
    const single = items.length === 1;

    if (operation === "create") {
      return this.manageCreate(userId, items, single, approvalMode);
    }
    if (operation === "update") {
      return this.manageUpdate(userId, items, single, approvalMode);
    }
    return this.manageDelete(userId, items, single, approvalMode);
  }

  private isTransferRow(item: Record<string, unknown>): boolean {
    return item.toAccountName !== undefined;
  }

  private toCreateRow(item: Record<string, unknown>): CreateRowInput {
    return {
      accountName: item.accountName as string,
      amount: item.amount as number,
      date: item.date as string,
      payeeName: item.payeeName as string | undefined,
      categoryName: item.categoryName as string | undefined,
      description: item.description as string | undefined,
      createPayeeIfMissing: item.createPayeeIfMissing as boolean | undefined,
    };
  }

  private toTransferRow(item: Record<string, unknown>): TransferRowInput {
    return {
      fromAccountName: item.fromAccountName as string,
      toAccountName: item.toAccountName as string,
      amount: item.amount as number,
      date: item.date as string,
      description: item.description as string | undefined,
      payeeName: item.payeeName as string | undefined,
      createPayeeIfMissing: item.createPayeeIfMissing as boolean | undefined,
      exchangeRate: item.exchangeRate as number | undefined,
      toAmount: item.toAmount as number | undefined,
    };
  }

  private toUpdateRow(item: Record<string, unknown>): UpdateRowInput {
    return {
      transactionId: item.transactionId as string,
      amount: item.amount as number | undefined,
      date: item.date as string | undefined,
      payeeName: item.payeeName as string | undefined,
      categoryName: item.categoryName as string | undefined,
      description: item.description as string | undefined,
      createPayeeIfMissing: item.createPayeeIfMissing as boolean | undefined,
    };
  }

  private async manageCreate(
    userId: string,
    items: Array<Record<string, unknown>>,
    single: boolean,
    approvalMode: "bulk" | "individual",
  ): Promise<ToolResult> {
    if (single) {
      const item = items[0];
      try {
        if (this.isTransferRow(item)) {
          const preview = await this.prepService.prepareCreateTransferSingle(
            userId,
            this.toTransferRow(item),
          );
          const pendingAction = this.actionBuilder.buildCreateTransfer(
            userId,
            preview,
          );
          return {
            data: PENDING_ACTION_TOOL_RESULT,
            summary: `Prepared a transfer of ${preview.amount} ${preview.fromCurrencyCode} from ${preview.fromAccountName} to ${preview.toAccountName} dated ${preview.transactionDate}. Awaiting user confirmation.`,
            sources: [],
            pendingAction,
          };
        }
        const { preview } = await this.prepService.prepareCreateSingle(
          userId,
          this.toCreateRow(item),
        );
        const pendingAction = this.actionBuilder.buildCreateTransaction(
          userId,
          preview,
        );
        return {
          data: PENDING_ACTION_TOOL_RESULT,
          summary: `Prepared a transaction for ${preview.accountName} (${preview.amount} ${preview.currencyCode}) dated ${preview.transactionDate}.${preview.payeeWillBeCreated ? ` A new payee "${preview.payeeName}" will be created on approval.` : ""} Awaiting user confirmation.`,
          sources: [],
          pendingAction,
        };
      } catch (err) {
        return this.toolErrorFromException(
          err,
          "Could not prepare the transaction.",
        );
      }
    }

    // Bulk create. Standard and transfer rows are split; each builds the right
    // card(s). A batch may mix the two when in individual mode; in bulk mode the
    // standard rows go to a create_transactions card and the transfer rows to a
    // batch_actions(create_transfer) card.
    const standardItems = items.filter((i) => !this.isTransferRow(i));
    const transferItems = items.filter((i) => this.isTransferRow(i));

    const std = await this.prepService.prepareCreate(
      userId,
      standardItems.map((i) => this.toCreateRow(i)),
    );
    const xfer = await this.prepService.prepareCreateTransfer(
      userId,
      transferItems.map((i) => this.toTransferRow(i)),
    );

    const okCount = std.okPreviews.length + xfer.okPreviews.length;
    if (okCount === 0) {
      return this.toolError(
        "None of the transactions could be prepared. Check the account, category, and date for each row and try again.",
      );
    }

    if (approvalMode === "individual") {
      const pendingActions: PendingAiAction[] = [
        ...std.okPreviews.map((p) =>
          this.actionBuilder.buildCreateTransaction(userId, p),
        ),
        ...xfer.okPreviews.map((p) =>
          this.actionBuilder.buildCreateTransfer(userId, p),
        ),
      ];
      const skipped = std.skipped.length + xfer.skipped.length;
      return {
        data: PENDING_ACTION_TOOL_RESULT,
        summary: `Prepared ${pendingActions.length} individual card${pendingActions.length === 1 ? "" : "s"}${skipped ? ` (${skipped} skipped)` : ""}. Awaiting user confirmation.`,
        sources: [],
        pendingActions,
      };
    }

    // Bulk mode: one card per kind that has ok rows.
    const pendingActions: PendingAiAction[] = [];
    if (std.okPreviews.length > 0) {
      pendingActions.push(
        this.actionBuilder.buildCreateTransactions(
          userId,
          std.okPreviews,
          std.previewRows,
        ),
      );
    }
    if (xfer.okPreviews.length > 0) {
      pendingActions.push(
        this.actionBuilder.buildBatchActions(
          userId,
          "create_transfer",
          xfer.okPreviews.map((p) => this.prepService.transferToBatchRow(p)),
          xfer.previewRows,
        ),
      );
    }
    const skipped = std.skipped.length + xfer.skipped.length;
    return {
      data: PENDING_ACTION_TOOL_RESULT,
      summary: `Prepared ${okCount} transaction${okCount === 1 ? "" : "s"}${skipped ? ` (${skipped} skipped)` : ""}. Awaiting user confirmation.`,
      sources: [],
      pendingActions,
    };
  }

  private async manageUpdate(
    userId: string,
    items: Array<Record<string, unknown>>,
    single: boolean,
    approvalMode: "bulk" | "individual",
  ): Promise<ToolResult> {
    if (single) {
      try {
        const result = await this.prepService.prepareUpdate(
          userId,
          this.toUpdateRow(items[0]),
        );
        if (result.kind === "transfer") {
          const pendingAction = this.actionBuilder.buildUpdateTransfer(
            userId,
            result.preview,
          );
          return {
            data: PENDING_ACTION_TOOL_RESULT,
            summary: `Prepared an update to the transfer (${result.preview.amount} ${result.preview.fromCurrencyCode}) from ${result.preview.fromAccountName} to ${result.preview.toAccountName}. Awaiting user confirmation.`,
            sources: [],
            pendingAction,
          };
        }
        const pendingAction = this.actionBuilder.buildUpdateTransaction(
          userId,
          result.preview,
        );
        return {
          data: PENDING_ACTION_TOOL_RESULT,
          summary: `Prepared an update to the transaction in ${result.preview.accountName} (${result.preview.amount} ${result.preview.currencyCode}) dated ${result.preview.transactionDate}.${result.preview.payeeWillBeCreated ? ` A new payee "${result.preview.payeeName}" will be created on approval.` : ""} Awaiting user confirmation.`,
          sources: [],
          pendingAction,
        };
      } catch (err) {
        return this.toolErrorFromException(
          err,
          "Could not prepare the transaction edit.",
        );
      }
    }

    if (approvalMode === "individual") {
      const pendingActions: PendingAiAction[] = [];
      let skipped = 0;
      for (const item of items) {
        try {
          const result = await this.prepService.prepareUpdate(
            userId,
            this.toUpdateRow(item),
          );
          pendingActions.push(
            result.kind === "transfer"
              ? this.actionBuilder.buildUpdateTransfer(userId, result.preview)
              : this.actionBuilder.buildUpdateTransaction(
                  userId,
                  result.preview,
                ),
          );
        } catch {
          skipped++;
        }
      }
      if (pendingActions.length === 0) {
        return this.toolError(
          "None of the transaction edits could be prepared. Check each transactionId and the fields to change.",
        );
      }
      return {
        data: PENDING_ACTION_TOOL_RESULT,
        summary: `Prepared ${pendingActions.length} individual edit card${pendingActions.length === 1 ? "" : "s"}${skipped ? ` (${skipped} skipped)` : ""}. Awaiting user confirmation.`,
        sources: [],
        pendingActions,
      };
    }

    const bulk = await this.prepService.prepareUpdateBulk(
      userId,
      items.map((i) => this.toUpdateRow(i)),
    );
    if (bulk.okRows.length === 0) {
      return this.toolError(
        "None of the transaction edits could be prepared. Check each transactionId and the fields to change.",
      );
    }
    const pendingAction = this.actionBuilder.buildBatchActions(
      userId,
      "update",
      bulk.okRows,
      bulk.previewRows,
    );
    return {
      data: PENDING_ACTION_TOOL_RESULT,
      summary: `Prepared ${bulk.okRows.length} transaction edit${bulk.okRows.length === 1 ? "" : "s"}${bulk.skipped.length ? ` (${bulk.skipped.length} skipped)` : ""}. Awaiting user confirmation.`,
      sources: [],
      pendingAction,
    };
  }

  private async manageDelete(
    userId: string,
    items: Array<Record<string, unknown>>,
    single: boolean,
    approvalMode: "bulk" | "individual",
  ): Promise<ToolResult> {
    if (single) {
      try {
        const preview = await this.prepService.prepareDelete(
          userId,
          items[0].transactionId as string,
        );
        const pendingAction = this.actionBuilder.buildDeleteTransaction(
          userId,
          preview,
        );
        return {
          data: PENDING_ACTION_TOOL_RESULT,
          summary: `Prepared to delete the transaction in ${preview.accountName} (${preview.amount} ${preview.currencyCode}) dated ${preview.transactionDate}${preview.payeeName ? ` for ${preview.payeeName}` : ""}. Awaiting user confirmation.`,
          sources: [],
          pendingAction,
        };
      } catch (err) {
        return this.toolErrorFromException(
          err,
          "Could not prepare the transaction deletion.",
        );
      }
    }

    if (approvalMode === "individual") {
      const pendingActions: PendingAiAction[] = [];
      let skipped = 0;
      for (const item of items) {
        try {
          const preview = await this.prepService.prepareDelete(
            userId,
            item.transactionId as string,
          );
          pendingActions.push(
            this.actionBuilder.buildDeleteTransaction(userId, preview),
          );
        } catch {
          skipped++;
        }
      }
      if (pendingActions.length === 0) {
        return this.toolError(
          "None of the transactions could be prepared for deletion. Check each transactionId.",
        );
      }
      return {
        data: PENDING_ACTION_TOOL_RESULT,
        summary: `Prepared ${pendingActions.length} individual delete card${pendingActions.length === 1 ? "" : "s"}${skipped ? ` (${skipped} skipped)` : ""}. Awaiting user confirmation.`,
        sources: [],
        pendingActions,
      };
    }

    const bulk = await this.prepService.prepareDeleteBulk(
      userId,
      items.map((i) => i.transactionId as string),
    );
    if (bulk.okRows.length === 0) {
      return this.toolError(
        "None of the transactions could be prepared for deletion. Check each transactionId.",
      );
    }
    const pendingAction = this.actionBuilder.buildBatchActions(
      userId,
      "delete",
      bulk.okRows,
      bulk.previewRows,
    );
    return {
      data: PENDING_ACTION_TOOL_RESULT,
      summary: `Prepared to delete ${bulk.okRows.length} transaction${bulk.okRows.length === 1 ? "" : "s"}${bulk.skipped.length ? ` (${bulk.skipped.length} skipped)` : ""}. Awaiting user confirmation.`,
      sources: [],
      pendingAction,
    };
  }

  /**
   * Unified payee write handler. Mirrors manageTransactions: resolves names +
   * builds previews via the shared PayeeToolPrepService, then emits the right
   * pending action(s) per operation/approvalMode (single -> one card; bulk +
   * bulk mode -> one batch card; bulk + individual -> an array of single cards).
   */
  private async managePayees(
    userId: string,
    input: Record<string, unknown>,
  ): Promise<ToolResult> {
    const operation = input.operation as "create" | "update" | "delete";
    const items = (input.items as Array<Record<string, unknown>>) ?? [];
    const approvalMode =
      (input.approvalMode as "bulk" | "individual" | undefined) ?? "bulk";
    const single = items.length === 1;

    if (operation === "create") {
      return this.managePayeeCreate(userId, items, single, approvalMode);
    }
    if (operation === "update") {
      return this.managePayeeUpdate(userId, items, single, approvalMode);
    }
    return this.managePayeeDelete(userId, items, single, approvalMode);
  }

  private toPayeeCreateRow(
    item: Record<string, unknown>,
  ): ManageCreatePayeeRow {
    return {
      name: item.name as string,
      categoryName: item.categoryName as string | undefined,
    };
  }

  private toPayeeUpdateRow(
    item: Record<string, unknown>,
  ): ManageUpdatePayeeRow {
    return {
      name: item.name as string,
      newName: item.newName as string | undefined,
      categoryName: item.categoryName as string | undefined,
    };
  }

  private toPayeeDeleteRow(
    item: Record<string, unknown>,
  ): ManageDeletePayeeRow {
    return { name: item.name as string };
  }

  private async managePayeeCreate(
    userId: string,
    items: Array<Record<string, unknown>>,
    single: boolean,
    approvalMode: "bulk" | "individual",
  ): Promise<ToolResult> {
    if (single) {
      try {
        const preview = await this.payeePrepService.prepareCreatePayeeSingle(
          userId,
          this.toPayeeCreateRow(items[0]),
        );
        return {
          data: PENDING_ACTION_TOOL_RESULT,
          summary: `Prepared to create payee "${preview.name}"${preview.defaultCategoryName ? ` with default category ${preview.defaultCategoryName}` : ""}. Awaiting user confirmation.`,
          sources: [],
          pendingAction: this.actionBuilder.buildCreatePayee(userId, preview),
        };
      } catch (err) {
        return this.toolErrorFromException(err, "Could not prepare the payee.");
      }
    }

    const prep = await this.payeePrepService.prepareCreatePayees(
      userId,
      items.map((i) => this.toPayeeCreateRow(i)),
    );
    if (prep.okPreviews.length === 0) {
      return this.toolError(
        "None of the payees could be prepared. Check the name and category for each row.",
      );
    }
    if (approvalMode === "individual") {
      return {
        data: PENDING_ACTION_TOOL_RESULT,
        summary: `Prepared ${prep.okPreviews.length} individual payee card${prep.okPreviews.length === 1 ? "" : "s"}${prep.skipped.length ? ` (${prep.skipped.length} skipped)` : ""}. Awaiting user confirmation.`,
        sources: [],
        pendingActions: prep.okPreviews.map((p) =>
          this.actionBuilder.buildCreatePayee(userId, p),
        ),
      };
    }
    return {
      data: PENDING_ACTION_TOOL_RESULT,
      summary: `Prepared ${prep.okPreviews.length} payee${prep.okPreviews.length === 1 ? "" : "s"}${prep.skipped.length ? ` (${prep.skipped.length} skipped)` : ""}. Awaiting user confirmation.`,
      sources: [],
      pendingAction: this.actionBuilder.buildBatchActions(
        userId,
        "create_payee",
        prep.okRows,
        prep.previewRows,
      ),
    };
  }

  private async managePayeeUpdate(
    userId: string,
    items: Array<Record<string, unknown>>,
    single: boolean,
    approvalMode: "bulk" | "individual",
  ): Promise<ToolResult> {
    if (single) {
      try {
        const preview = await this.payeePrepService.prepareUpdatePayeeSingle(
          userId,
          this.toPayeeUpdateRow(items[0]),
        );
        return {
          data: PENDING_ACTION_TOOL_RESULT,
          summary: `Prepared an edit to payee "${preview.name}" (default category ${preview.defaultCategoryName ?? "none"}). Awaiting user confirmation.`,
          sources: [],
          pendingAction: this.actionBuilder.buildUpdatePayee(userId, preview),
        };
      } catch (err) {
        return this.toolErrorFromException(
          err,
          "Could not prepare the payee edit.",
        );
      }
    }

    const prep = await this.payeePrepService.prepareUpdatePayees(
      userId,
      items.map((i) => this.toPayeeUpdateRow(i)),
    );
    if (prep.okPreviews.length === 0) {
      return this.toolError("None of the payee edits could be prepared.");
    }
    if (approvalMode === "individual") {
      return {
        data: PENDING_ACTION_TOOL_RESULT,
        summary: `Prepared ${prep.okPreviews.length} individual payee edit card${prep.okPreviews.length === 1 ? "" : "s"}${prep.skipped.length ? ` (${prep.skipped.length} skipped)` : ""}. Awaiting user confirmation.`,
        sources: [],
        pendingActions: prep.okPreviews.map((p) =>
          this.actionBuilder.buildUpdatePayee(userId, p),
        ),
      };
    }
    return {
      data: PENDING_ACTION_TOOL_RESULT,
      summary: `Prepared ${prep.okPreviews.length} payee edit${prep.okPreviews.length === 1 ? "" : "s"}${prep.skipped.length ? ` (${prep.skipped.length} skipped)` : ""}. Awaiting user confirmation.`,
      sources: [],
      pendingAction: this.actionBuilder.buildBatchActions(
        userId,
        "update_payee",
        prep.okRows,
        prep.previewRows,
      ),
    };
  }

  private async managePayeeDelete(
    userId: string,
    items: Array<Record<string, unknown>>,
    single: boolean,
    approvalMode: "bulk" | "individual",
  ): Promise<ToolResult> {
    if (single) {
      try {
        const preview = await this.payeePrepService.prepareDeletePayeeSingle(
          userId,
          this.toPayeeDeleteRow(items[0]),
        );
        return {
          data: PENDING_ACTION_TOOL_RESULT,
          summary: `Prepared to delete payee "${preview.name}". Awaiting user confirmation.`,
          sources: [],
          pendingAction: this.actionBuilder.buildDeletePayee(userId, preview),
        };
      } catch (err) {
        return this.toolErrorFromException(
          err,
          "Could not prepare the payee deletion.",
        );
      }
    }

    const prep = await this.payeePrepService.prepareDeletePayees(
      userId,
      items.map((i) => this.toPayeeDeleteRow(i)),
    );
    if (prep.okPreviews.length === 0) {
      return this.toolError(
        "None of the payees could be prepared for deletion.",
      );
    }
    if (approvalMode === "individual") {
      return {
        data: PENDING_ACTION_TOOL_RESULT,
        summary: `Prepared ${prep.okPreviews.length} individual payee delete card${prep.okPreviews.length === 1 ? "" : "s"}${prep.skipped.length ? ` (${prep.skipped.length} skipped)` : ""}. Awaiting user confirmation.`,
        sources: [],
        pendingActions: prep.okPreviews.map((p) =>
          this.actionBuilder.buildDeletePayee(userId, p),
        ),
      };
    }
    return {
      data: PENDING_ACTION_TOOL_RESULT,
      summary: `Prepared to delete ${prep.okPreviews.length} payee${prep.okPreviews.length === 1 ? "" : "s"}${prep.skipped.length ? ` (${prep.skipped.length} skipped)` : ""}. Awaiting user confirmation.`,
      sources: [],
      pendingAction: this.actionBuilder.buildBatchActions(
        userId,
        "delete_payee",
        prep.okRows,
        prep.previewRows,
      ),
    };
  }

  private async createSecurityAction(
    userId: string,
    input: Record<string, unknown>,
  ): Promise<ToolResult> {
    const query = input.query as string;
    const exchange = input.exchange as string | undefined;
    const securityType = input.securityType as string | undefined;
    const isFavourite = input.isFavourite as boolean | undefined;
    const currencyCode = input.currencyCode as string | undefined;

    let preview;
    try {
      preview = await this.securitiesService.previewCreateSecurity(userId, {
        query,
        exchange,
        securityType,
        isFavourite,
        currencyCode,
      });
    } catch (err) {
      return this.toolErrorFromException(
        err,
        "Could not prepare the security.",
      );
    }

    const pendingAction = this.actionBuilder.buildCreateSecurity(
      userId,
      preview,
    );

    return {
      data: PENDING_ACTION_TOOL_RESULT,
      summary: `Prepared to create security ${preview.symbol} (${preview.name})${preview.exchange ? ` on ${preview.exchange}` : ""}. Awaiting user confirmation.`,
      sources: [],
      pendingAction,
    };
  }

  private async lookupSecuritiesAction(
    userId: string,
    input: Record<string, unknown>,
  ): Promise<ToolResult> {
    const query = input.query as string;
    const exchange = input.exchange as string | undefined;
    const provider = input.provider as "yahoo" | "msn" | "auto" | undefined;

    let data;
    try {
      data = await this.securitiesService.lookupSecuritiesForLlm(userId, {
        query,
        exchange,
        provider,
      });
    } catch (err) {
      return this.toolErrorFromException(err, "Could not look up securities.");
    }

    return {
      data,
      summary: `Found ${data.count} security match${data.count === 1 ? "" : "es"} for "${data.query}".${data.count > 1 ? " Ask the user which one to use before adding it." : ""}`,
      sources: [
        {
          type: "security_lookup",
          description: `Security lookup for "${data.query}"`,
        },
      ],
    };
  }

  private toInvestmentCreateRow(
    item: Record<string, unknown>,
  ): InvestmentCreateRowInput {
    return {
      accountName: item.accountName as string,
      action: item.action as InvestmentAction,
      date: item.date as string,
      securityQuery: item.security as string | undefined,
      quantity: item.quantity as number | undefined,
      price: item.price as number | undefined,
      commission: item.commission as number | undefined,
      fundingAccountName: item.fundingAccountName as string | undefined,
      description: item.description as string | undefined,
    };
  }

  private toInvestmentUpdateRow(
    item: Record<string, unknown>,
  ): InvestmentUpdateRowInput {
    return {
      transactionId: item.transactionId as string,
      action: item.action as InvestmentAction | undefined,
      date: item.date as string | undefined,
      securityQuery: item.security as string | undefined,
      quantity: item.quantity as number | undefined,
      price: item.price as number | undefined,
      commission: item.commission as number | undefined,
      description: item.description as string | undefined,
    };
  }

  private investmentSecurityLabel(preview: {
    symbol?: string | null;
    securityName?: string | null;
  }): string {
    return preview.symbol
      ? ` of ${preview.symbol}`
      : preview.securityName
        ? ` of ${preview.securityName}`
        : "";
  }

  /**
   * Unified investment-transaction write handler. Mirrors manageTransactions:
   * resolves names + builds previews via the shared investment prep methods,
   * then emits the right pending action(s) per operation/approvalMode (single ->
   * one card; bulk + bulk mode -> one batch card; bulk + individual -> an array
   * of single cards).
   */
  private async manageInvestmentTransactions(
    userId: string,
    input: Record<string, unknown>,
  ): Promise<ToolResult> {
    const operation = input.operation as "create" | "update" | "delete";
    const items = (input.items as Array<Record<string, unknown>>) ?? [];
    const approvalMode =
      (input.approvalMode as "bulk" | "individual" | undefined) ?? "bulk";
    const single = items.length === 1;

    if (operation === "create") {
      return this.manageInvestmentCreate(userId, items, single, approvalMode);
    }
    if (operation === "update") {
      return this.manageInvestmentUpdate(userId, items, single, approvalMode);
    }
    return this.manageInvestmentDelete(userId, items, single, approvalMode);
  }

  private async manageInvestmentCreate(
    userId: string,
    items: Array<Record<string, unknown>>,
    single: boolean,
    approvalMode: "bulk" | "individual",
  ): Promise<ToolResult> {
    if (single) {
      try {
        const preview =
          await this.investmentTransactionsService.prepareCreateInvestmentSingle(
            userId,
            this.toInvestmentCreateRow(items[0]),
          );
        const pendingAction =
          this.actionBuilder.buildCreateInvestmentTransaction(userId, preview);
        return {
          data: PENDING_ACTION_TOOL_RESULT,
          summary: `Prepared a ${preview.action} investment transaction${this.investmentSecurityLabel(preview)} in ${preview.accountName} dated ${preview.transactionDate}. Awaiting user confirmation.`,
          sources: [],
          pendingAction,
        };
      } catch (err) {
        return this.toolErrorFromException(
          err,
          "Could not prepare the investment transaction.",
        );
      }
    }

    const bulk =
      await this.investmentTransactionsService.prepareCreateInvestmentBulk(
        userId,
        items.map((i) => this.toInvestmentCreateRow(i)),
      );
    if (bulk.okPreviews.length === 0) {
      return this.toolError(
        "None of the investment transactions could be prepared. Check the account, security, action, and date for each row and try again.",
      );
    }

    if (approvalMode === "individual") {
      const pendingActions: PendingAiAction[] = bulk.okPreviews.map((p) =>
        this.actionBuilder.buildCreateInvestmentTransaction(userId, p),
      );
      return {
        data: PENDING_ACTION_TOOL_RESULT,
        summary: `Prepared ${pendingActions.length} individual investment card${pendingActions.length === 1 ? "" : "s"}${bulk.skipped.length ? ` (${bulk.skipped.length} skipped)` : ""}. Awaiting user confirmation.`,
        sources: [],
        pendingActions,
      };
    }

    const pendingAction = this.actionBuilder.buildCreateInvestmentTransactions(
      userId,
      bulk.okPreviews,
      bulk.previewRows,
    );
    return {
      data: PENDING_ACTION_TOOL_RESULT,
      summary: `Prepared ${bulk.okPreviews.length} investment transaction${bulk.okPreviews.length === 1 ? "" : "s"}${bulk.skipped.length ? ` (${bulk.skipped.length} skipped)` : ""}. Awaiting user confirmation.`,
      sources: [],
      pendingAction,
    };
  }

  private async manageInvestmentUpdate(
    userId: string,
    items: Array<Record<string, unknown>>,
    single: boolean,
    approvalMode: "bulk" | "individual",
  ): Promise<ToolResult> {
    if (single) {
      const row = this.toInvestmentUpdateRow(items[0]);
      try {
        const preview =
          await this.investmentTransactionsService.previewUpdateInvestmentTransaction(
            userId,
            row.transactionId,
            {
              action: row.action,
              transactionDate: row.date,
              securityQuery: row.securityQuery,
              quantity: row.quantity,
              price: row.price,
              commission: row.commission,
              description: row.description,
            },
          );
        const pendingAction =
          this.actionBuilder.buildUpdateInvestmentTransaction(userId, preview);
        return {
          data: PENDING_ACTION_TOOL_RESULT,
          summary: `Prepared an update to a ${preview.action} investment transaction${this.investmentSecurityLabel(preview)} in ${preview.accountName} dated ${preview.transactionDate}. Awaiting user confirmation.`,
          sources: [],
          pendingAction,
        };
      } catch (err) {
        return this.toolErrorFromException(
          err,
          "Could not prepare the investment transaction edit.",
        );
      }
    }

    if (approvalMode === "individual") {
      const pendingActions: PendingAiAction[] = [];
      let skipped = 0;
      for (const item of items) {
        const row = this.toInvestmentUpdateRow(item);
        try {
          const preview =
            await this.investmentTransactionsService.previewUpdateInvestmentTransaction(
              userId,
              row.transactionId,
              {
                action: row.action,
                transactionDate: row.date,
                securityQuery: row.securityQuery,
                quantity: row.quantity,
                price: row.price,
                commission: row.commission,
                description: row.description,
              },
            );
          pendingActions.push(
            this.actionBuilder.buildUpdateInvestmentTransaction(
              userId,
              preview,
            ),
          );
        } catch {
          skipped++;
        }
      }
      if (pendingActions.length === 0) {
        return this.toolError(
          "None of the investment transaction edits could be prepared. Check each transactionId and the fields to change.",
        );
      }
      return {
        data: PENDING_ACTION_TOOL_RESULT,
        summary: `Prepared ${pendingActions.length} individual investment edit card${pendingActions.length === 1 ? "" : "s"}${skipped ? ` (${skipped} skipped)` : ""}. Awaiting user confirmation.`,
        sources: [],
        pendingActions,
      };
    }

    const bulk =
      await this.investmentTransactionsService.prepareUpdateInvestmentBulk(
        userId,
        items.map((i) => this.toInvestmentUpdateRow(i)),
      );
    if (bulk.okRows.length === 0) {
      return this.toolError(
        "None of the investment transaction edits could be prepared. Check each transactionId and the fields to change.",
      );
    }
    const pendingAction =
      this.actionBuilder.buildBatchUpdateInvestmentTransactions(
        userId,
        bulk.okRows,
        bulk.previewRows,
      );
    return {
      data: PENDING_ACTION_TOOL_RESULT,
      summary: `Prepared ${bulk.okRows.length} investment transaction edit${bulk.okRows.length === 1 ? "" : "s"}${bulk.skipped.length ? ` (${bulk.skipped.length} skipped)` : ""}. Awaiting user confirmation.`,
      sources: [],
      pendingAction,
    };
  }

  private async manageInvestmentDelete(
    userId: string,
    items: Array<Record<string, unknown>>,
    single: boolean,
    approvalMode: "bulk" | "individual",
  ): Promise<ToolResult> {
    if (single) {
      try {
        const preview =
          await this.investmentTransactionsService.previewDeleteInvestmentTransaction(
            userId,
            items[0].transactionId as string,
          );
        const pendingAction =
          this.actionBuilder.buildDeleteInvestmentTransaction(userId, preview);
        return {
          data: PENDING_ACTION_TOOL_RESULT,
          summary: `Prepared to delete a ${preview.action} investment transaction${this.investmentSecurityLabel(preview)} in ${preview.accountName} dated ${preview.transactionDate}. Awaiting user confirmation.`,
          sources: [],
          pendingAction,
        };
      } catch (err) {
        return this.toolErrorFromException(
          err,
          "Could not prepare the investment transaction deletion.",
        );
      }
    }

    if (approvalMode === "individual") {
      const pendingActions: PendingAiAction[] = [];
      let skipped = 0;
      for (const item of items) {
        try {
          const preview =
            await this.investmentTransactionsService.previewDeleteInvestmentTransaction(
              userId,
              item.transactionId as string,
            );
          pendingActions.push(
            this.actionBuilder.buildDeleteInvestmentTransaction(
              userId,
              preview,
            ),
          );
        } catch {
          skipped++;
        }
      }
      if (pendingActions.length === 0) {
        return this.toolError(
          "None of the investment transactions could be prepared for deletion. Check each transactionId.",
        );
      }
      return {
        data: PENDING_ACTION_TOOL_RESULT,
        summary: `Prepared ${pendingActions.length} individual investment delete card${pendingActions.length === 1 ? "" : "s"}${skipped ? ` (${skipped} skipped)` : ""}. Awaiting user confirmation.`,
        sources: [],
        pendingActions,
      };
    }

    const bulk =
      await this.investmentTransactionsService.prepareDeleteInvestmentBulk(
        userId,
        items.map((i) => i.transactionId as string),
      );
    if (bulk.okRows.length === 0) {
      return this.toolError(
        "None of the investment transactions could be prepared for deletion. Check each transactionId.",
      );
    }
    const pendingAction =
      this.actionBuilder.buildBatchDeleteInvestmentTransactions(
        userId,
        bulk.okRows,
        bulk.previewRows,
      );
    return {
      data: PENDING_ACTION_TOOL_RESULT,
      summary: `Prepared to delete ${bulk.okRows.length} investment transaction${bulk.okRows.length === 1 ? "" : "s"}${bulk.skipped.length ? ` (${bulk.skipped.length} skipped)` : ""}. Awaiting user confirmation.`,
      sources: [],
      pendingAction,
    };
  }

  private async listAccounts(
    userId: string,
    input: Record<string, unknown>,
  ): Promise<ToolResult> {
    const accountNames = input.accountNames as string[] | undefined;
    const accountIds = input.accountIds as string[] | undefined;
    const nameQuery = input.nameQuery as string | undefined;
    const status =
      (input.status as "open" | "closed" | "all" | undefined) ?? "open";
    const accountTypes = input.accountTypes as AccountType[] | undefined;

    const data = await this.accountsService.getLlmAccounts(userId, {
      accountNames,
      accountIds,
      nameQuery,
      status,
      accountTypes,
    });

    const filterDescParts: string[] = [];
    if (accountNames?.length) filterDescParts.push(accountNames.join(", "));
    if (nameQuery) filterDescParts.push(`"${nameQuery}"`);
    if (accountTypes?.length) filterDescParts.push(accountTypes.join(", "));
    const descriptionBase =
      filterDescParts.length > 0
        ? `Accounts for ${filterDescParts.join("; ")}`
        : "All accounts";
    const description =
      status === "open" ? descriptionBase : `${descriptionBase} (${status})`;

    return {
      data,
      summary: `${data.totalAccounts} accounts. Net worth: ${data.netWorth.toFixed(2)}, Assets: ${data.totalAssets.toFixed(2)}, Liabilities: ${data.totalLiabilities.toFixed(2)}`,
      sources: [
        {
          type: "accounts",
          description,
        },
      ],
    };
  }

  private async getCategories(
    userId: string,
    input: Record<string, unknown>,
  ): Promise<ToolResult> {
    const type = input.type as "expense" | "income" | "all" | undefined;
    const search = input.search as string | undefined;

    const data = await this.categoriesService.getLlmCategories(userId, {
      type,
      search,
    });

    const effectiveType = type ?? "all";
    const descriptionParts: string[] = [];
    if (effectiveType !== "all") descriptionParts.push(effectiveType);
    if (search) descriptionParts.push(`matching "${search}"`);
    const description =
      descriptionParts.length > 0
        ? `Categories (${descriptionParts.join(", ")})`
        : "All categories";

    return {
      data,
      summary: `${data.totalCount} categor${data.totalCount === 1 ? "y" : "ies"}${
        descriptionParts.length > 0 ? ` ${descriptionParts.join(", ")}` : ""
      }.`,
      sources: [{ type: "categories", description }],
    };
  }

  private async getNetWorthHistory(
    userId: string,
    input: Record<string, unknown>,
  ): Promise<ToolResult> {
    const startDate = input.startDate as string | undefined;
    const endDate = input.endDate as string | undefined;

    const history = await this.netWorthService.getLlmHistory(
      userId,
      startDate,
      endDate,
    );

    const start =
      startDate ??
      (history.length > 0
        ? history[0].month
        : new Date().toISOString().substring(0, 10));
    const end =
      endDate ??
      (history.length > 0
        ? history[history.length - 1].month
        : new Date().toISOString().substring(0, 10));

    return {
      // Return the bare array so this matches the MCP server's
      // get_net_worth_history payload exactly (shared-tool data-shape parity).
      data: history,
      summary: `Net worth history: ${history.length} months from ${start} to ${end}`,
      sources: [
        {
          type: "net_worth",
          description: "Monthly net worth history",
          dateRange: `${start} to ${end}`,
        },
      ],
    };
  }

  private async comparePeriods(
    userId: string,
    input: Record<string, unknown>,
  ): Promise<ToolResult> {
    const { period1Start, period1End, period2Start, period2End } =
      resolveComparePeriods({
        period1Start: input.period1Start as string | undefined,
        period1End: input.period1End as string | undefined,
        period2Start: input.period2Start as string | undefined,
        period2End: input.period2End as string | undefined,
      });
    const groupBy = (input.groupBy as "category" | "payee") || "category";
    const direction =
      (input.direction as "expenses" | "income" | "both") || "expenses";

    const data = await this.analyticsService.getLlmPeriodComparison(userId, {
      period1Start,
      period1End,
      period2Start,
      period2End,
      groupBy,
      direction,
    });

    return {
      data,
      summary: `Period 1 (${period1Start} to ${period1End}): ${data.period1.total.toFixed(2)}, Period 2 (${period2Start} to ${period2End}): ${data.period2.total.toFixed(2)}, Change: ${data.totalChange >= 0 ? "+" : ""}${data.totalChange.toFixed(2)} (${data.totalChangePercent >= 0 ? "+" : ""}${data.totalChangePercent}%)`,
      sources: [
        {
          type: "comparison",
          description: `Period comparison by ${groupBy}`,
          dateRange: `${period1Start}-${period1End} vs ${period2Start}-${period2End}`,
        },
      ],
    };
  }

  private async getPortfolioSummary(
    userId: string,
    input: Record<string, unknown>,
  ): Promise<ToolResult> {
    const accountNames = input.accountNames as string[] | undefined;
    const accountIds = await this.resolveAccountIds(userId, accountNames);

    const data = await this.portfolioService.getLlmSummary(userId, accountIds);

    const sign = data.totalGainLoss >= 0 ? "+" : "";
    return {
      data,
      summary: `${data.holdingCount} holding${data.holdingCount === 1 ? "" : "s"}, total portfolio value ${data.totalPortfolioValue.toFixed(2)}, unrealized gain/loss ${sign}${data.totalGainLoss.toFixed(2)} (${sign}${data.totalGainLossPercent.toFixed(2)}%).`,
      sources: [
        {
          type: "portfolio",
          description: accountNames
            ? `Portfolio summary for ${accountNames.join(", ")}`
            : "Portfolio summary across all investment accounts",
        },
      ],
    };
  }

  private async listInvestmentTransactions(
    userId: string,
    input: Record<string, unknown>,
  ): Promise<ToolResult> {
    const startDate = input.startDate as string | undefined;
    const endDate = input.endDate as string | undefined;
    const accountNames = input.accountNames as string[] | undefined;
    const symbols = input.symbols as string[] | undefined;
    const actions = input.actions as InvestmentAction[] | undefined;
    const groupBy =
      (input.groupBy as LlmInvestmentTxGroupBy | undefined) ?? "security";

    const accountIds = await this.resolveAccountIds(userId, accountNames);

    const data =
      await this.investmentTransactionsService.getLlmInvestmentTransactions(
        userId,
        { startDate, endDate, accountIds, symbols, actions, groupBy },
      );

    const rangeParts: string[] = [];
    if (startDate && endDate) rangeParts.push(`${startDate} to ${endDate}`);
    else if (startDate) rangeParts.push(`from ${startDate}`);
    else if (endDate) rangeParts.push(`through ${endDate}`);
    const range = rangeParts.length > 0 ? rangeParts[0] : "all dates";

    const filterDescParts: string[] = [];
    if (accountNames?.length) filterDescParts.push(accountNames.join(", "));
    if (symbols?.length) filterDescParts.push(symbols.join(", "));
    if (actions?.length) filterDescParts.push(actions.join(", "));
    const filterDesc =
      filterDescParts.length > 0 ? ` (${filterDescParts.join("; ")})` : "";

    const summaryParts = [
      `${data.transactionCount} investment transaction${data.transactionCount === 1 ? "" : "s"}${filterDesc}`,
      `total amount ${data.totalAmount.toFixed(2)}`,
      `commissions ${data.totalCommission.toFixed(2)}`,
    ];
    if (groupBy && data.groups) {
      summaryParts.push(`grouped by ${groupBy} (${data.groups.length} groups)`);
    }

    return {
      data,
      summary: `${summaryParts.join(", ")}.`,
      sources: [
        {
          type: "investment_transactions",
          description: `Investment transactions${filterDesc}`,
          dateRange: range,
        },
      ],
    };
  }

  private async getCapitalGains(
    userId: string,
    input: Record<string, unknown>,
  ): Promise<ToolResult> {
    const startDate = input.startDate as string;
    const endDate = input.endDate as string;
    const accountNames = input.accountNames as string[] | undefined;
    const symbols = input.symbols as string[] | undefined;
    const groupBy =
      (input.groupBy as LlmCapitalGainsGroupBy | undefined) ?? "month";

    const accountIds = await this.resolveAccountIds(userId, accountNames);

    const data = await this.investmentTransactionsService.getLlmCapitalGains(
      userId,
      { startDate, endDate, accountIds, symbols, groupBy },
    );

    const filterParts: string[] = [];
    if (accountNames?.length) filterParts.push(accountNames.join(", "));
    if (symbols?.length) filterParts.push(symbols.join(", "));
    const filterDesc =
      filterParts.length > 0 ? ` (${filterParts.join("; ")})` : "";

    const summaryParts = [
      `capital gains ${data.totals.totalCapitalGain.toFixed(2)}${filterDesc}`,
      `realized ${data.totals.realizedGain.toFixed(2)}`,
      `unrealized ${data.totals.unrealizedGain.toFixed(2)}`,
      `grouped by ${groupBy} (${data.entryCount} ${
        data.entryCount === 1 ? "entry" : "entries"
      })`,
    ];

    return {
      data,
      summary: `${summaryParts.join(", ")}.`,
      sources: [
        {
          type: "investment_capital_gains",
          description: `Capital gains${filterDesc}`,
          dateRange: `${startDate} to ${endDate}`,
        },
      ],
    };
  }

  private async getBudgetStatus(
    userId: string,
    input: Record<string, unknown>,
  ): Promise<ToolResult> {
    const period = (input.period as string) || "CURRENT";
    const budgetName = input.budgetName as string | undefined;

    const data = await this.budgetReportsService.getLlmBudgetStatus(
      userId,
      period,
      budgetName,
    );

    if ("error" in data) {
      return {
        data,
        summary: data.availableBudgets
          ? `Budget "${budgetName}" not found. Available budgets: ${data.availableBudgets.join(", ")}`
          : data.error,
        sources: [],
      };
    }

    const summaryParts = [
      `Budget "${data.budgetName}": ${data.percentUsed.toFixed(1)}% used ($${data.totalSpent.toFixed(2)} of $${data.totalBudgeted.toFixed(2)})`,
    ];

    if (data.velocity) {
      summaryParts.push(
        `Safe daily spend: $${data.velocity.safeDailySpend.toFixed(2)}, ${data.velocity.daysRemaining} days remaining`,
      );
    }

    if (data.overBudgetCategories.length > 0) {
      summaryParts.push(
        `${data.overBudgetCategories.length} categories over budget`,
      );
    }

    if (data.healthScore) {
      summaryParts.push(
        `Health score: ${data.healthScore.score}/100 (${data.healthScore.label})`,
      );
    }

    return {
      data,
      summary: summaryParts.join(". "),
      sources: [
        {
          type: "budget",
          description: `Budget status for "${data.budgetName}"`,
          dateRange: `${data.period.start} to ${data.period.end}`,
        },
      ],
    };
  }

  private async getUpcomingBills(
    userId: string,
    input: Record<string, unknown>,
  ): Promise<ToolResult> {
    const days = (input.days as number | undefined) ?? 30;
    const kind = input.kind as LlmScheduledKind | "all" | undefined;
    const accountNames = input.accountNames as string[] | undefined;
    const accountIds = await this.resolveAccountIds(userId, accountNames);

    const data =
      await this.scheduledTransactionsService.getLlmUpcomingBillsAndDeposits(
        userId,
        { days, kind, accountIds },
      );

    const kindDesc =
      !kind || kind === "all" ? "bills and deposits" : `${kind}s`;
    const overduePart =
      data.overdueCount > 0 ? `, ${data.overdueCount} overdue` : "";
    return {
      data,
      summary: `${data.itemCount} upcoming ${kindDesc} in the next ${days} day${days === 1 ? "" : "s"}${overduePart}. Bills: ${data.totalUpcomingBills.toFixed(2)}, Deposits: ${data.totalUpcomingDeposits.toFixed(2)}.`,
      sources: [
        {
          type: "scheduled_transactions",
          description: accountNames
            ? `Upcoming ${kindDesc} for ${accountNames.join(", ")}`
            : `Upcoming ${kindDesc}`,
          dateRange: `next ${days} day${days === 1 ? "" : "s"}`,
        },
      ],
    };
  }

  private calculate(input: Record<string, unknown>): ToolResult {
    const calcResult = executeCalculation(input as unknown as CalculateInput);

    if ("error" in calcResult) {
      return {
        data: { error: calcResult.error },
        summary: calcResult.error,
        sources: [],
        isError: true,
      };
    }

    return {
      data: calcResult,
      summary: `Calculated ${calcResult.operation}: ${calcResult.formattedResult}${calcResult.label ? ` (${calcResult.label})` : ""}`,
      sources: [
        {
          type: "calculation",
          description: `${calcResult.operation} calculation`,
        },
      ],
    };
  }

  /**
   * render_chart is a presentation-only tool: it does not touch the database
   * and simply echoes the LLM-assembled payload back. The query service picks
   * up the returned data and emits it as a dedicated `chart` SSE event so the
   * frontend can render it with recharts. Zod has already validated shape and
   * caps; we additionally sanitize label and title strings because this data
   * flows straight to the browser, bypassing the main tool-result sanitization
   * step in ai-query.service.ts.
   */
  private renderChart(input: Record<string, unknown>): ToolResult {
    const type = input.type as "bar" | "pie" | "line" | "area";
    const rawTitle = input.title as string;
    const rawData = input.data as Array<{ label: string; value: number }>;

    const title = sanitizePromptValue(rawTitle);
    const data = rawData.map((point) => ({
      label: sanitizePromptValue(point.label),
      value: point.value,
    }));

    return {
      data: { type, title, data },
      summary: `Rendered ${type} chart "${title}" with ${data.length} data point${data.length === 1 ? "" : "s"}.`,
      sources: [],
    };
  }
}
