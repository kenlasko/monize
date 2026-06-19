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
import { AiActionBuilderService } from "../actions/ai-action-builder.service";
import { PendingAiAction } from "../actions/ai-action.types";
import { AccountType } from "../../accounts/entities/account.entity";
import { CategoriesService } from "../../categories/categories.service";
import { TransactionAnalyticsService } from "../../transactions/transaction-analytics.service";
import { NetWorthService } from "../../net-worth/net-worth.service";
import { BudgetReportsService } from "../../budgets/budget-reports.service";
import { PortfolioService } from "../../securities/portfolio.service";
import {
  InvestmentTransactionsService,
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
  DEFAULT_TOP_N,
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
    private readonly investmentTransactionsService: InvestmentTransactionsService,
    @Inject(forwardRef(() => ScheduledTransactionsService))
    private readonly scheduledTransactionsService: ScheduledTransactionsService,
    @Inject(forwardRef(() => TransactionsService))
    private readonly transactionsService: TransactionsService,
    @Inject(forwardRef(() => PayeesService))
    private readonly payeesService: PayeesService,
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
        case "query_transactions":
          result = await this.queryTransactions(userId, validatedInput);
          break;
        case "get_account_balances":
          result = await this.getAccountBalances(userId, validatedInput);
          break;
        case "get_categories":
          result = await this.getCategories(userId, validatedInput);
          break;
        case "get_spending_by_category":
          result = await this.getSpendingByCategory(userId, validatedInput);
          break;
        case "get_income_summary":
          result = await this.getIncomeSummary(userId, validatedInput);
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
        case "query_investment_transactions":
          result = await this.queryInvestmentTransactions(
            userId,
            validatedInput,
          );
          break;
        case "get_capital_gains":
          result = await this.getCapitalGains(userId, validatedInput);
          break;
        case "get_transfers":
          result = await this.getTransfers(userId, validatedInput);
          break;
        case "get_budget_status":
          result = await this.getBudgetStatus(userId, validatedInput);
          break;
        case "get_upcoming_bills":
          result = await this.getUpcomingBills(userId, validatedInput);
          break;
        case "get_scheduled_transactions":
          result = await this.getScheduledTransactions(userId, validatedInput);
          break;
        case "calculate":
          result = this.calculate(validatedInput);
          break;
        case "render_chart":
          result = this.renderChart(validatedInput);
          break;
        case "search_transactions":
          result = await this.searchTransactions(userId, validatedInput);
          break;
        case "create_transaction":
          result = await this.createTransactionAction(userId, validatedInput);
          break;
        case "categorize_transaction":
          result = await this.categorizeTransactionAction(
            userId,
            validatedInput,
          );
          break;
        case "create_payee":
          result = await this.createPayeeAction(userId, validatedInput);
          break;
        case "create_investment_transaction":
          result = await this.createInvestmentTransactionAction(
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
   * the name does not match any of the user's accounts.
   */
  private async resolveAccountByName(
    userId: string,
    accountName: string,
  ): Promise<{ id: string; name: string; currencyCode: string } | undefined> {
    const accounts = await this.accountsService.findAll(userId, false);
    const match = accounts.find(
      (a) => a.name.toLowerCase() === accountName.toLowerCase(),
    );
    return match
      ? { id: match.id, name: match.name, currencyCode: match.currencyCode }
      : undefined;
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

  private async searchTransactions(
    userId: string,
    input: Record<string, unknown>,
  ): Promise<ToolResult> {
    const searchText = input.searchText as string | undefined;
    const startDate = input.startDate as string | undefined;
    const endDate = input.endDate as string | undefined;
    const accountName = input.accountName as string | undefined;
    const categoryName = input.categoryName as string | undefined;
    const minAmount = input.minAmount as number | undefined;
    const maxAmount = input.maxAmount as number | undefined;
    const limit = Math.min((input.limit as number | undefined) ?? 25, 25);

    let accountId: string | undefined;
    if (accountName) {
      const account = await this.resolveAccountByName(userId, accountName);
      if (!account) {
        return this.toolError(
          `Unknown account: ${accountName}. Use an exact name from the user's account list.`,
        );
      }
      accountId = account.id;
    }

    let categoryId: string | undefined;
    if (categoryName) {
      const resolved = await this.resolveSingleCategoryId(userId, categoryName);
      if (!resolved) {
        return this.toolError(
          `Unknown category: ${categoryName}. Call get_categories to look up valid names; subcategories can be referenced as "Parent: Child".`,
        );
      }
      categoryId = resolved;
    }

    const data = await this.transactionsService.getLlmTransactionRows(userId, {
      accountId,
      categoryId,
      startDate,
      endDate,
      query: searchText,
      minAmount,
      maxAmount,
      limit,
    });

    return {
      data,
      summary: `Found ${data.transactions.length} transaction${
        data.transactions.length === 1 ? "" : "s"
      }${data.hasMore ? " (more available; narrow the search)" : ""}.`,
      sources: [
        {
          type: "transactions",
          description: "Transaction search results",
        },
      ],
    };
  }

  private async createTransactionAction(
    userId: string,
    input: Record<string, unknown>,
  ): Promise<ToolResult> {
    const accountName = input.accountName as string;
    const amount = input.amount as number;
    const date = input.date as string;
    const payeeName = input.payeeName as string | undefined;
    const categoryName = input.categoryName as string | undefined;
    const description = input.description as string | undefined;
    // Default to creating a payee for an unmatched name; the user can opt out
    // ("don't create a payee for this one-time transaction") to keep it free text.
    const createPayeeIfMissing =
      (input.createPayeeIfMissing as boolean | undefined) ?? true;

    const account = await this.resolveAccountByName(userId, accountName);
    if (!account) {
      return this.toolError(
        `Unknown account: ${accountName}. Use an exact name from the user's account list.`,
      );
    }

    let categoryId: string | undefined;
    if (categoryName) {
      const resolved = await this.resolveSingleCategoryId(userId, categoryName);
      if (!resolved) {
        return this.toolError(
          `Unknown category: ${categoryName}. Call get_categories to look up valid names; subcategories can be referenced as "Parent: Child".`,
        );
      }
      categoryId = resolved;
    }

    let preview;
    try {
      preview = await this.transactionsService.previewCreate(userId, {
        accountId: account.id,
        amount,
        transactionDate: date,
        payeeName,
        categoryId,
        description,
        createPayeeIfMissing,
      });
    } catch (err) {
      return this.toolErrorFromException(
        err,
        "Could not prepare the transaction.",
      );
    }

    const pendingAction = this.actionBuilder.buildCreateTransaction(
      userId,
      preview,
    );

    // When the name does not match an existing payee, tell the model whether a
    // new payee will be created (default) or it will be stored as free text so
    // it can describe the card accurately without leaking the signature.
    const data =
      preview.payeeName && !preview.payeeMatched
        ? {
            ...PENDING_ACTION_TOOL_RESULT,
            payeeNote: preview.payeeWillBeCreated
              ? `"${preview.payeeName}" is not an existing payee; a new payee will be created and linked when the user approves the card.`
              : `"${preview.payeeName}" is not an existing payee; it will be recorded as a free-text payee name (no payee record created) because createPayeeIfMissing was disabled.`,
          }
        : PENDING_ACTION_TOOL_RESULT;

    return {
      data,
      summary: `Prepared a transaction for ${preview.accountName} (${preview.amount} ${preview.currencyCode}) dated ${preview.transactionDate}.${preview.payeeWillBeCreated ? ` A new payee "${preview.payeeName}" will be created on approval.` : ""} Awaiting user confirmation.`,
      sources: [],
      pendingAction,
    };
  }

  private async categorizeTransactionAction(
    userId: string,
    input: Record<string, unknown>,
  ): Promise<ToolResult> {
    const transactionId = input.transactionId as string;
    const categoryName = input.categoryName as string;

    const categoryId = await this.resolveSingleCategoryId(userId, categoryName);
    if (!categoryId) {
      return this.toolError(
        `Unknown category: ${categoryName}. Call get_categories to look up valid names; subcategories can be referenced as "Parent: Child".`,
      );
    }

    let preview;
    try {
      preview = await this.transactionsService.previewCategorize(
        userId,
        transactionId,
        categoryId,
      );
    } catch (err) {
      return this.toolErrorFromException(
        err,
        "Could not prepare the categorization.",
      );
    }

    const pendingAction = this.actionBuilder.buildCategorizeTransaction(
      userId,
      preview,
    );

    return {
      data: PENDING_ACTION_TOOL_RESULT,
      summary: `Prepared to categorize the transaction as "${preview.newCategoryName}". Awaiting user confirmation.`,
      sources: [],
      pendingAction,
    };
  }

  private async createPayeeAction(
    userId: string,
    input: Record<string, unknown>,
  ): Promise<ToolResult> {
    const name = input.name as string;
    const defaultCategoryName = input.defaultCategoryName as string | undefined;

    let defaultCategoryId: string | undefined;
    if (defaultCategoryName) {
      const resolved = await this.resolveSingleCategoryId(
        userId,
        defaultCategoryName,
      );
      if (!resolved) {
        return this.toolError(
          `Unknown category: ${defaultCategoryName}. Call get_categories to look up valid names.`,
        );
      }
      defaultCategoryId = resolved;
    }

    let preview;
    try {
      preview = await this.payeesService.previewCreate(userId, {
        name,
        defaultCategoryId,
      });
    } catch (err) {
      return this.toolErrorFromException(err, "Could not prepare the payee.");
    }

    const pendingAction = this.actionBuilder.buildCreatePayee(userId, preview);

    return {
      data: PENDING_ACTION_TOOL_RESULT,
      summary: `Prepared to create payee "${preview.name}". Awaiting user confirmation.`,
      sources: [],
      pendingAction,
    };
  }

  private async createInvestmentTransactionAction(
    userId: string,
    input: Record<string, unknown>,
  ): Promise<ToolResult> {
    const accountName = input.accountName as string;
    const action = input.action as InvestmentAction;
    const date = input.date as string;
    const securityQuery = input.security as string | undefined;
    const quantity = input.quantity as number | undefined;
    const price = input.price as number | undefined;
    const commission = input.commission as number | undefined;
    const fundingAccountName = input.fundingAccountName as string | undefined;
    const description = input.description as string | undefined;

    const account = await this.resolveAccountByName(userId, accountName);
    if (!account) {
      return this.toolError(
        `Unknown account: ${accountName}. Use an exact name from the user's account list.`,
      );
    }

    let fundingAccountId: string | undefined;
    if (fundingAccountName) {
      const funding = await this.resolveAccountByName(
        userId,
        fundingAccountName,
      );
      if (!funding) {
        return this.toolError(
          `Unknown funding account: ${fundingAccountName}. Use an exact name from the user's account list.`,
        );
      }
      fundingAccountId = funding.id;
    }

    let preview;
    try {
      preview =
        await this.investmentTransactionsService.previewCreateInvestmentTransaction(
          userId,
          {
            accountId: account.id,
            action,
            transactionDate: date,
            securityQuery,
            quantity,
            price,
            commission,
            fundingAccountId,
            description,
          },
        );
    } catch (err) {
      return this.toolErrorFromException(
        err,
        "Could not prepare the investment transaction.",
      );
    }

    const pendingAction = this.actionBuilder.buildCreateInvestmentTransaction(
      userId,
      preview,
    );

    const securityLabel = preview.symbol
      ? ` of ${preview.symbol}`
      : preview.securityName
        ? ` of ${preview.securityName}`
        : "";
    return {
      data: PENDING_ACTION_TOOL_RESULT,
      summary: `Prepared a ${preview.action} investment transaction${securityLabel} in ${preview.accountName} dated ${preview.transactionDate}. Awaiting user confirmation.`,
      sources: [],
      pendingAction,
    };
  }

  private async queryTransactions(
    userId: string,
    input: Record<string, unknown>,
  ): Promise<ToolResult> {
    const defaults = getDefaultDateRange();
    const startDate = (input.startDate as string) ?? defaults.startDate;
    const endDate = (input.endDate as string) ?? defaults.endDate;
    const categoryNames = input.categoryNames as string[] | undefined;
    const accountNames = input.accountNames as string[] | undefined;
    const searchText = input.searchText as string | undefined;
    const groupBy = input.groupBy as
      | "category"
      | "payee"
      | "year"
      | "month"
      | "week"
      | undefined;
    const direction = input.direction as
      | "expenses"
      | "income"
      | "both"
      | undefined;

    const accountIds = await this.resolveAccountIds(userId, accountNames);
    let categoryIds: string[] | undefined;
    if (categoryNames && categoryNames.length > 0) {
      const resolved = await this.analyticsService.resolveLlmCategoryIds(
        userId,
        categoryNames,
      );
      if (resolved.unresolved.length > 0) {
        // Fail loudly instead of silently dropping the filter -- otherwise
        // the user sees "all transactions" when they asked for a specific
        // (mistyped or subcategory-shaped) category.
        const list = resolved.unresolved.join(", ");
        return {
          data: {
            error: `Unknown categor${resolved.unresolved.length === 1 ? "y" : "ies"}: ${list}. Call get_categories to look up valid names; subcategories can be referenced as "Parent: Child".`,
            unresolvedCategoryNames: resolved.unresolved,
          },
          summary: `Could not resolve categor${resolved.unresolved.length === 1 ? "y" : "ies"}: ${list}.`,
          sources: [],
          isError: true,
        };
      }
      categoryIds = resolved.categoryIds;
    }

    const data = await this.analyticsService.getLlmQueryTransactions(userId, {
      startDate,
      endDate,
      accountIds,
      categoryIds,
      searchText,
      groupBy,
      direction,
    });

    return {
      data,
      summary: `Found ${data.transactionCount} transactions from ${startDate} to ${endDate}. Income: ${data.totalIncome.toFixed(2)}, Expenses: ${data.totalExpenses.toFixed(2)}, Net: ${data.netCashFlow.toFixed(2)}`,
      sources: [
        {
          type: "transactions",
          description: `Transaction summary${categoryNames ? ` for ${categoryNames.join(", ")}` : ""}${accountNames ? ` in ${accountNames.join(", ")}` : ""}`,
          dateRange: `${startDate} to ${endDate}`,
        },
      ],
    };
  }

  private async getAccountBalances(
    userId: string,
    input: Record<string, unknown>,
  ): Promise<ToolResult> {
    const accountNames = input.accountNames as string[] | undefined;
    const status =
      (input.status as "open" | "closed" | "all" | undefined) ?? "open";
    const accountTypes = input.accountTypes as AccountType[] | undefined;

    const data = await this.accountsService.getLlmBalances(
      userId,
      accountNames,
      status,
      accountTypes,
    );

    const filterDescParts: string[] = [];
    if (accountNames?.length) filterDescParts.push(accountNames.join(", "));
    if (accountTypes?.length) filterDescParts.push(accountTypes.join(", "));
    const descriptionBase =
      filterDescParts.length > 0
        ? `Balances for ${filterDescParts.join("; ")}`
        : "All account balances";
    const description =
      status === "open" ? descriptionBase : `${descriptionBase} (${status})`;

    return {
      data,
      summary: `${data.accounts.length} accounts. Net worth: ${data.netWorth.toFixed(2)}, Assets: ${data.totalAssets.toFixed(2)}, Liabilities: ${data.totalLiabilities.toFixed(2)}`,
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

  private async getSpendingByCategory(
    userId: string,
    input: Record<string, unknown>,
  ): Promise<ToolResult> {
    const defaults = getDefaultDateRange();
    const startDate = (input.startDate as string) ?? defaults.startDate;
    const endDate = (input.endDate as string) ?? defaults.endDate;
    const topN = (input.topN as number | undefined) ?? DEFAULT_TOP_N;

    const data = await this.analyticsService.getLlmSpendingByCategory(
      userId,
      startDate,
      endDate,
      topN,
    );

    return {
      data,
      summary: `Total spending: ${data.totalSpending.toFixed(2)} across ${data.categories.length} categories from ${startDate} to ${endDate}`,
      sources: [
        {
          type: "spending",
          description: "Spending breakdown by category",
          dateRange: `${startDate} to ${endDate}`,
        },
      ],
    };
  }

  private async getIncomeSummary(
    userId: string,
    input: Record<string, unknown>,
  ): Promise<ToolResult> {
    const defaults = getDefaultDateRange();
    const startDate = (input.startDate as string) ?? defaults.startDate;
    const endDate = (input.endDate as string) ?? defaults.endDate;
    const groupBy =
      (input.groupBy as "category" | "payee" | "month") || "category";

    const data = await this.analyticsService.getLlmIncomeSummary(
      userId,
      startDate,
      endDate,
      groupBy,
    );

    return {
      data,
      summary: `Total income: ${data.totalIncome.toFixed(2)} from ${startDate} to ${endDate}, grouped by ${groupBy}`,
      sources: [
        {
          type: "income",
          description: `Income summary by ${groupBy}`,
          dateRange: `${startDate} to ${endDate}`,
        },
      ],
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

  private async queryInvestmentTransactions(
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

  private async getTransfers(
    userId: string,
    input: Record<string, unknown>,
  ): Promise<ToolResult> {
    const defaults = getDefaultDateRange();
    const startDate = (input.startDate as string) ?? defaults.startDate;
    const endDate = (input.endDate as string) ?? defaults.endDate;
    const accountNames = input.accountNames as string[] | undefined;
    const accountIds = await this.resolveAccountIds(userId, accountNames);

    const data = await this.analyticsService.getTransfersByAccount(
      userId,
      startDate,
      endDate,
      accountIds,
    );

    return {
      data,
      summary: `${data.transferCount} transfer transactions across ${data.accounts.length} account${data.accounts.length === 1 ? "" : "s"} from ${startDate} to ${endDate}. Inbound: ${data.totalInbound.toFixed(2)}, Outbound: ${data.totalOutbound.toFixed(2)}.`,
      sources: [
        {
          type: "transfers",
          description: accountNames
            ? `Transfer activity for ${accountNames.join(", ")}`
            : "Transfer activity across all accounts",
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

  private async getScheduledTransactions(
    userId: string,
    input: Record<string, unknown>,
  ): Promise<ToolResult> {
    const kind = input.kind as LlmScheduledKind | "all" | undefined;
    const accountNames = input.accountNames as string[] | undefined;
    const isActive = input.isActive as boolean | undefined;
    const accountIds = await this.resolveAccountIds(userId, accountNames);

    const data = await this.scheduledTransactionsService.getLlmScheduledList(
      userId,
      { kind, accountIds, isActive },
    );

    const kindDesc =
      !kind || kind === "all" ? "scheduled transactions" : `scheduled ${kind}s`;
    const statusDesc =
      isActive === true ? " active" : isActive === false ? " paused" : "";
    return {
      data,
      summary: `${data.totalCount}${statusDesc} ${kindDesc} (${data.activeCount} active, ${data.autoPostCount} auto-posting, ${data.billCount} bills, ${data.depositCount} deposits).`,
      sources: [
        {
          type: "scheduled_transactions",
          description: accountNames
            ? `Scheduled ${kindDesc} for ${accountNames.join(", ")}`
            : `All scheduled ${kindDesc}`,
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
