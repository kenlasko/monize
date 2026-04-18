import { Injectable, Inject, forwardRef, Logger } from "@nestjs/common";
import { AccountsService } from "../../accounts/accounts.service";
import { TransactionAnalyticsService } from "../../transactions/transaction-analytics.service";
import { NetWorthService } from "../../net-worth/net-worth.service";
import { BudgetReportsService } from "../../budgets/budget-reports.service";
import { PortfolioService } from "../../securities/portfolio.service";
import {
  InvestmentTransactionsService,
  LlmInvestmentTxGroupBy,
} from "../../securities/investment-transactions.service";
import { InvestmentAction } from "../../securities/entities/investment-transaction.entity";
import { validateToolInput } from "./tool-input-schemas";
import { executeCalculation, CalculateInput } from "./calculate-tool";
import { sanitizePromptValue } from "../../common/sanitization.util";

interface ToolResult {
  data: unknown;
  summary: string;
  sources: Array<{ type: string; description: string; dateRange?: string }>;
  isError?: boolean;
}

@Injectable()
export class ToolExecutorService {
  private readonly logger = new Logger(ToolExecutorService.name);

  constructor(
    @Inject(forwardRef(() => AccountsService))
    private readonly accountsService: AccountsService,
    @Inject(forwardRef(() => TransactionAnalyticsService))
    private readonly analyticsService: TransactionAnalyticsService,
    @Inject(forwardRef(() => NetWorthService))
    private readonly netWorthService: NetWorthService,
    @Inject(forwardRef(() => BudgetReportsService))
    private readonly budgetReportsService: BudgetReportsService,
    private readonly portfolioService: PortfolioService,
    private readonly investmentTransactionsService: InvestmentTransactionsService,
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
        case "get_transfers":
          result = await this.getTransfers(userId, validatedInput);
          break;
        case "get_budget_status":
          result = await this.getBudgetStatus(userId, validatedInput);
          break;
        case "calculate":
          result = this.calculate(validatedInput);
          break;
        case "render_chart":
          result = this.renderChart(validatedInput);
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

  private async queryTransactions(
    userId: string,
    input: Record<string, unknown>,
  ): Promise<ToolResult> {
    const startDate = input.startDate as string;
    const endDate = input.endDate as string;
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
    const categoryIds = categoryNames
      ? await this.analyticsService.resolveLlmCategoryIds(userId, categoryNames)
      : undefined;

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

    const data = await this.accountsService.getLlmBalances(
      userId,
      accountNames,
    );

    return {
      data,
      summary: `${data.accounts.length} accounts. Net worth: ${data.netWorth.toFixed(2)}, Assets: ${data.totalAssets.toFixed(2)}, Liabilities: ${data.totalLiabilities.toFixed(2)}`,
      sources: [
        {
          type: "accounts",
          description: accountNames
            ? `Balances for ${accountNames.join(", ")}`
            : "All account balances",
        },
      ],
    };
  }

  private async getSpendingByCategory(
    userId: string,
    input: Record<string, unknown>,
  ): Promise<ToolResult> {
    const startDate = input.startDate as string;
    const endDate = input.endDate as string;
    const topN = input.topN as number | undefined;

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
    const startDate = input.startDate as string;
    const endDate = input.endDate as string;
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
      data: { months: history },
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
    const p1Start = input.period1Start as string;
    const p1End = input.period1End as string;
    const p2Start = input.period2Start as string;
    const p2End = input.period2End as string;
    const groupBy = (input.groupBy as "category" | "payee") || "category";
    const direction =
      (input.direction as "expenses" | "income" | "both") || "expenses";

    const data = await this.analyticsService.getLlmPeriodComparison(userId, {
      period1Start: p1Start,
      period1End: p1End,
      period2Start: p2Start,
      period2End: p2End,
      groupBy,
      direction,
    });

    return {
      data,
      summary: `Period 1 (${p1Start} to ${p1End}): ${data.period1.total.toFixed(2)}, Period 2 (${p2Start} to ${p2End}): ${data.period2.total.toFixed(2)}, Change: ${data.totalChange >= 0 ? "+" : ""}${data.totalChange.toFixed(2)} (${data.totalChangePercent >= 0 ? "+" : ""}${data.totalChangePercent}%)`,
      sources: [
        {
          type: "comparison",
          description: `Period comparison by ${groupBy}`,
          dateRange: `${p1Start}-${p1End} vs ${p2Start}-${p2End}`,
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
    const groupBy = input.groupBy as LlmInvestmentTxGroupBy | undefined;

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

  private async getTransfers(
    userId: string,
    input: Record<string, unknown>,
  ): Promise<ToolResult> {
    const startDate = input.startDate as string;
    const endDate = input.endDate as string;
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
