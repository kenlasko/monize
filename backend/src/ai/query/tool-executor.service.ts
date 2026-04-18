import { Injectable, Inject, forwardRef, Logger } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { AccountsService } from "../../accounts/accounts.service";
import { CategoriesService } from "../../categories/categories.service";
import { TransactionAnalyticsService } from "../../transactions/transaction-analytics.service";
import { NetWorthService } from "../../net-worth/net-worth.service";
import { BudgetsService } from "../../budgets/budgets.service";
import { BudgetReportsService } from "../../budgets/budget-reports.service";
import { PortfolioService } from "../../securities/portfolio.service";
import { AccountSubType } from "../../accounts/entities/account.entity";
import {
  getCurrentMonthPeriodDates,
  getPreviousMonthPeriodDates,
  parsePeriodFromYYYYMM,
} from "../../budgets/budget-date.utils";
import { Transaction } from "../../transactions/entities/transaction.entity";
import { Category } from "../../categories/entities/category.entity";
import { validateToolInput } from "./tool-input-schemas";
import { executeCalculation, CalculateInput } from "./calculate-tool";
import { sanitizePromptValue } from "../../common/sanitization.util";
import { applyInvestmentTransactionFilters } from "../../common/investment-filter.util";
import { getAllCategoryIdsWithChildren } from "../../common/category-tree.util";
import {
  joinSplitsForAnalytics,
  SPLIT_AMOUNT,
  SPLIT_CATEGORY_NAME,
} from "../../common/transaction-split-query.util";

/**
 * Safe money summation using integer arithmetic (4 decimal places)
 * to avoid floating-point accumulation drift. See CLAUDE.md Financial Math.
 */
function sumMoney(values: number[]): number {
  const total = values.reduce((sum, v) => sum + Math.round(v * 10000), 0);
  return total / 10000;
}

/** Round a monetary value to 2 decimal places. */
function roundMoney(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * LLM06-F2: Minimum number of transactions required per group
 * when returning payee-level breakdowns. Groups below this threshold
 * are aggregated into an "Other" bucket to prevent revealing
 * individual transaction amounts through targeted queries.
 */
export const MIN_AGGREGATION_COUNT = 3;

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
    @Inject(forwardRef(() => CategoriesService))
    private readonly categoriesService: CategoriesService,
    @Inject(forwardRef(() => TransactionAnalyticsService))
    private readonly analyticsService: TransactionAnalyticsService,
    @Inject(forwardRef(() => NetWorthService))
    private readonly netWorthService: NetWorthService,
    @Inject(forwardRef(() => BudgetsService))
    private readonly budgetsService: BudgetsService,
    @Inject(forwardRef(() => BudgetReportsService))
    private readonly budgetReportsService: BudgetReportsService,
    private readonly portfolioService: PortfolioService,
    @InjectRepository(Transaction)
    private readonly transactionRepo: Repository<Transaction>,
    @InjectRepository(Category)
    private readonly categoryRepo: Repository<Category>,
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

  private async resolveCategoryIds(
    userId: string,
    categoryNames?: string[],
  ): Promise<string[] | undefined> {
    if (!categoryNames || categoryNames.length === 0) return undefined;

    const allCategories = await this.categoryRepo.find({
      where: { userId },
      select: ["id", "name"],
    });
    const nameMap = new Map(
      allCategories.map((c) => [c.name.toLowerCase(), c.id]),
    );

    const matchedIds = categoryNames
      .map((name) => nameMap.get(name.toLowerCase()))
      .filter((id): id is string => id !== undefined);

    if (matchedIds.length === 0) return matchedIds;

    // Expand parents to include their descendants. When the user asks about
    // "Food" and Food has subcategories (Groceries, Dining Out), the
    // grouped breakdown's `IN (:...categoryIds)` filter would otherwise
    // skip every transaction tagged with the subcategory. `getSummary`
    // does its own expansion; passing the expanded list there is a no-op.
    return getAllCategoryIdsWithChildren(this.categoryRepo, userId, matchedIds);
  }

  private async queryTransactions(
    userId: string,
    input: Record<string, unknown>,
  ): Promise<ToolResult> {
    const startDate = input.startDate as string;
    const endDate = input.endDate as string;
    const categoryNames = input.categoryNames as string[] | undefined;
    const accountNames = input.accountNames as string[] | undefined;
    const rawSearchText = input.searchText as string | undefined;
    // Escape backslash first, then the LIKE wildcards. Escaping only the
    // wildcards would leave backslashes unescaped, letting an attacker submit
    // '\%' and neutralise the escaping (CWE-20).
    const sanitizedSearchText = rawSearchText
      ? rawSearchText
          .substring(0, 200)
          .replace(/\\/g, "\\\\")
          .replace(/[%_]/g, "\\$&")
      : undefined;
    const groupBy = input.groupBy as string | undefined;
    const direction = input.direction as string | undefined;

    const accountIds = await this.resolveAccountIds(userId, accountNames);
    const categoryIds = await this.resolveCategoryIds(userId, categoryNames);

    // Get summary totals. Exclude investment-linked cash transactions so
    // BUY/SELL/DIVIDEND cash movements don't appear as "expenses" or
    // "income" -- they're transfers between cash and securities, not
    // spending. Also exclude transfers so the summary matches the
    // grouped breakdown, which already filters `isTransfer = false`.
    const summary = await this.analyticsService.getSummary(
      userId,
      accountIds,
      startDate,
      endDate,
      categoryIds,
      undefined,
      sanitizedSearchText,
      undefined,
      undefined,
      true,
      true,
    );

    let breakdown: unknown = null;

    if (groupBy) {
      breakdown = await this.getGroupedBreakdown(
        userId,
        startDate,
        endDate,
        groupBy,
        direction,
        accountIds,
        categoryIds,
        sanitizedSearchText,
      );
    }

    const data: Record<string, unknown> = {
      totalIncome: summary.totalIncome,
      totalExpenses: summary.totalExpenses,
      netCashFlow: summary.netCashFlow,
      transactionCount: summary.transactionCount,
    };

    if (Object.keys(summary.byCurrency).length > 1) {
      data.byCurrency = summary.byCurrency;
    }

    if (breakdown) {
      data.breakdown = breakdown;
    }

    return {
      data,
      summary: `Found ${summary.transactionCount} transactions from ${startDate} to ${endDate}. Income: ${summary.totalIncome.toFixed(2)}, Expenses: ${summary.totalExpenses.toFixed(2)}, Net: ${summary.netCashFlow.toFixed(2)}`,
      sources: [
        {
          type: "transactions",
          description: `Transaction summary${categoryNames ? ` for ${categoryNames.join(", ")}` : ""}${accountNames ? ` in ${accountNames.join(", ")}` : ""}`,
          dateRange: `${startDate} to ${endDate}`,
        },
      ],
    };
  }

  private async getGroupedBreakdown(
    userId: string,
    startDate: string,
    endDate: string,
    groupBy: string,
    direction: string | undefined,
    accountIds?: string[],
    categoryIds?: string[],
    searchText?: string,
  ): Promise<unknown> {
    // Escape backslash first, then the LIKE wildcards (see above).
    const safeSearchText = searchText
      ? searchText
          .substring(0, 200)
          .replace(/\\/g, "\\\\")
          .replace(/[%_]/g, "\\$&")
      : undefined;

    const qb = this.transactionRepo
      .createQueryBuilder("t")
      .leftJoin("t.account", "breakdownAccount")
      .where("t.userId = :userId", { userId })
      .andWhere("t.transactionDate >= :startDate", { startDate })
      .andWhere("t.transactionDate <= :endDate", { endDate })
      .andWhere("t.status != 'VOID'")
      .andWhere("t.isTransfer = false")
      .andWhere("t.parentTransactionId IS NULL");

    joinSplitsForAnalytics(qb);
    applyInvestmentTransactionFilters(qb, "breakdownAccount", "t");

    if (direction === "expenses") {
      qb.andWhere(`${SPLIT_AMOUNT} < 0`);
    } else if (direction === "income") {
      qb.andWhere(`${SPLIT_AMOUNT} > 0`);
    }

    if (accountIds && accountIds.length > 0) {
      qb.andWhere("t.accountId IN (:...accountIds)", { accountIds });
    }

    if (categoryIds && categoryIds.length > 0) {
      qb.andWhere(
        "COALESCE(ts.categoryId, t.categoryId) IN (:...categoryIds)",
        {
          categoryIds,
        },
      );
    }

    if (safeSearchText) {
      qb.andWhere(
        "(t.description ILIKE :search OR t.payeeName ILIKE :search OR ts.memo ILIKE :search)",
        { search: `%${safeSearchText}%` },
      );
    }

    switch (groupBy) {
      case "category": {
        qb.leftJoin("t.category", "cat")
          .select(SPLIT_CATEGORY_NAME, "label")
          .addSelect(`SUM(ABS(${SPLIT_AMOUNT}))`, "total")
          .addSelect("COUNT(*)", "count")
          .groupBy(SPLIT_CATEGORY_NAME);

        const rows = await qb.getRawMany();
        return rows
          .map((r) => ({
            category: r.label,
            total: roundMoney(Number(r.total)),
            count: Number(r.count),
          }))
          .sort((a, b) => b.total - a.total);
      }

      case "payee": {
        qb.select("COALESCE(t.payeeName, 'Unknown')", "label")
          .addSelect(`SUM(ABS(${SPLIT_AMOUNT}))`, "total")
          .addSelect("COUNT(*)", "count")
          .groupBy("t.payeeName");

        const rows = await qb.getRawMany();
        return this.enforceAggregationThreshold(
          rows.map((r) => ({
            payee: r.label,
            total: roundMoney(Number(r.total)),
            count: Number(r.count),
          })),
        );
      }

      case "year": {
        qb.select("TO_CHAR(t.transactionDate, 'YYYY')", "year")
          .addSelect(`SUM(ABS(${SPLIT_AMOUNT}))`, "total")
          .addSelect("COUNT(*)", "count")
          .groupBy("TO_CHAR(t.transactionDate, 'YYYY')")
          .orderBy("year", "ASC");

        const rows = await qb.getRawMany();
        return rows.map((r) => ({
          year: r.year,
          total: roundMoney(Number(r.total)),
          count: Number(r.count),
        }));
      }

      case "month": {
        qb.select("TO_CHAR(t.transactionDate, 'YYYY-MM')", "month")
          .addSelect(`SUM(ABS(${SPLIT_AMOUNT}))`, "total")
          .addSelect("COUNT(*)", "count")
          .groupBy("TO_CHAR(t.transactionDate, 'YYYY-MM')")
          .orderBy("month", "ASC");

        const rows = await qb.getRawMany();
        return rows.map((r) => ({
          month: r.month,
          total: roundMoney(Number(r.total)),
          count: Number(r.count),
        }));
      }

      case "week": {
        qb.select(
          "TO_CHAR(DATE_TRUNC('week', t.transactionDate), 'YYYY-MM-DD')",
          "week",
        )
          .addSelect(`SUM(ABS(${SPLIT_AMOUNT}))`, "total")
          .addSelect("COUNT(*)", "count")
          .groupBy("DATE_TRUNC('week', t.transactionDate)")
          .orderBy("week", "ASC");

        const rows = await qb.getRawMany();
        return rows.map((r) => ({
          week: r.week,
          total: roundMoney(Number(r.total)),
          count: Number(r.count),
        }));
      }

      default:
        return null;
    }
  }

  private async getAccountBalances(
    userId: string,
    input: Record<string, unknown>,
  ): Promise<ToolResult> {
    const accountNames = input.accountNames as string[] | undefined;

    const allAccounts = await this.accountsService.findAll(userId, false);

    // Brokerage accounts carry securities, not cash, so `currentBalance` is 0
    // for them — the real value lives in `holdings.quantity * latest price`.
    // Pull per-account market values to mirror the Account List UI.
    const marketValues =
      await this.portfolioService.getAccountMarketValues(userId);

    let accounts = allAccounts;
    if (accountNames && accountNames.length > 0) {
      const lowerNames = new Set(accountNames.map((n) => n.toLowerCase()));
      accounts = allAccounts.filter((a) =>
        lowerNames.has(a.name.toLowerCase()),
      );
    }

    // Match the Account List / Account Balances report per-account balance:
    // - INVESTMENT_BROKERAGE shows market value of holdings
    // - Every other account shows currentBalance + futureTransactionsSum
    const accountList = accounts.map((a) => {
      const balance =
        a.accountSubType === AccountSubType.INVESTMENT_BROKERAGE
          ? (marketValues.get(a.id) ?? 0)
          : Number(a.currentBalance) + Number(a.futureTransactionsSum ?? 0);
      return {
        name: a.name,
        type: a.accountType,
        balance: roundMoney(balance),
        currency: a.currencyCode,
      };
    });

    // Use the same source as the dashboard Net Worth widget and Net Worth
    // report so all three surfaces agree. getMonthlyNetWorth reads from
    // monthly_account_balances, respects excludeFromNetWorth, applies
    // currency conversion to the user's default currency, and handles
    // brokerage vs standalone investment accounts correctly. The latest
    // month's snapshot is what the widget/report display as "current".
    const monthly = await this.netWorthService.getMonthlyNetWorth(userId);
    const latest = monthly[monthly.length - 1];
    const totalAssets = roundMoney(latest?.assets ?? 0);
    const totalLiabilities = roundMoney(latest?.liabilities ?? 0);
    const netWorth = roundMoney(latest?.netWorth ?? 0);

    const data = {
      accounts: accountList,
      totalAssets,
      totalLiabilities,
      netWorth,
      totalAccounts: allAccounts.length,
    };

    return {
      data,
      summary: `${accounts.length} accounts. Net worth: ${netWorth.toFixed(2)}, Assets: ${totalAssets.toFixed(2)}, Liabilities: ${totalLiabilities.toFixed(2)}`,
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

    const qb = this.transactionRepo
      .createQueryBuilder("t")
      .leftJoin("t.category", "cat")
      .leftJoin("t.account", "spendingAccount")
      .select(SPLIT_CATEGORY_NAME, "category")
      .addSelect(`SUM(ABS(${SPLIT_AMOUNT}))`, "total")
      .addSelect("COUNT(*)", "count")
      .where("t.userId = :userId", { userId })
      .andWhere("t.transactionDate >= :startDate", { startDate })
      .andWhere("t.transactionDate <= :endDate", { endDate })
      .andWhere(`${SPLIT_AMOUNT} < 0`)
      .andWhere("t.status != 'VOID'")
      .andWhere("t.isTransfer = false")
      .andWhere("t.parentTransactionId IS NULL")
      .groupBy(SPLIT_CATEGORY_NAME)
      .orderBy("total", "DESC");

    joinSplitsForAnalytics(qb);
    applyInvestmentTransactionFilters(qb, "spendingAccount", "t");

    const rows = await qb.getRawMany();
    const totalSpending = sumMoney(rows.map((r) => Number(r.total)));

    let categories = rows.map((r) => {
      const amount = roundMoney(Number(r.total));
      return {
        category: r.category,
        amount,
        percentage:
          totalSpending > 0
            ? Math.round((amount / totalSpending) * 10000) / 100
            : 0,
        transactionCount: Number(r.count),
      };
    });

    if (topN && topN > 0) {
      categories = categories.slice(0, topN);
    }

    return {
      data: { categories, totalSpending },
      summary: `Total spending: ${totalSpending.toFixed(2)} across ${rows.length} categories from ${startDate} to ${endDate}`,
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
    const groupBy = (input.groupBy as string) || "category";

    const qb = this.transactionRepo
      .createQueryBuilder("t")
      .leftJoin("t.account", "incomeAccount")
      .where("t.userId = :userId", { userId })
      .andWhere("t.transactionDate >= :startDate", { startDate })
      .andWhere("t.transactionDate <= :endDate", { endDate })
      .andWhere(`${SPLIT_AMOUNT} > 0`)
      .andWhere("t.status != 'VOID'")
      .andWhere("t.isTransfer = false")
      .andWhere("t.parentTransactionId IS NULL");

    joinSplitsForAnalytics(qb);
    applyInvestmentTransactionFilters(qb, "incomeAccount", "t");

    let items: { label: string; amount: number; count: number }[];

    switch (groupBy) {
      case "payee": {
        qb.select("COALESCE(t.payeeName, 'Unknown')", "label")
          .addSelect(`SUM(${SPLIT_AMOUNT})`, "total")
          .addSelect("COUNT(*)", "count")
          .groupBy("t.payeeName")
          .orderBy("total", "DESC");
        const rows = await qb.getRawMany();
        const payeeItems = rows.map((r) => ({
          label: r.label,
          amount: roundMoney(Number(r.total)),
          count: Number(r.count),
        }));
        items = this.enforceAggregationThresholdLabeled(payeeItems);
        break;
      }
      case "month": {
        qb.select("TO_CHAR(t.transactionDate, 'YYYY-MM')", "label")
          .addSelect(`SUM(${SPLIT_AMOUNT})`, "total")
          .addSelect("COUNT(*)", "count")
          .groupBy("TO_CHAR(t.transactionDate, 'YYYY-MM')")
          .orderBy("label", "ASC");
        const rows = await qb.getRawMany();
        items = rows.map((r) => ({
          label: r.label,
          amount: roundMoney(Number(r.total)),
          count: Number(r.count),
        }));
        break;
      }
      default: {
        qb.leftJoin("t.category", "cat")
          .select(SPLIT_CATEGORY_NAME, "label")
          .addSelect(`SUM(${SPLIT_AMOUNT})`, "total")
          .addSelect("COUNT(*)", "count")
          .groupBy(SPLIT_CATEGORY_NAME)
          .orderBy("total", "DESC");
        const rows = await qb.getRawMany();
        items = rows.map((r) => ({
          label: r.label,
          amount: roundMoney(Number(r.total)),
          count: Number(r.count),
        }));
        break;
      }
    }

    const totalIncome = sumMoney(items.map((i) => i.amount));

    return {
      data: { items, totalIncome, groupedBy: groupBy },
      summary: `Total income: ${totalIncome.toFixed(2)} from ${startDate} to ${endDate}, grouped by ${groupBy}`,
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
    const today = new Date();
    const defaultStart = new Date(today.getFullYear() - 1, today.getMonth(), 1)
      .toISOString()
      .substring(0, 10);

    const startDate = (input.startDate as string) || defaultStart;
    const endDate =
      (input.endDate as string) || today.toISOString().substring(0, 10);

    const history = await this.netWorthService.getMonthlyNetWorth(
      userId,
      startDate,
      endDate,
    );

    return {
      data: { months: history },
      summary: `Net worth history: ${history.length} months from ${startDate} to ${endDate}`,
      sources: [
        {
          type: "net_worth",
          description: "Monthly net worth history",
          dateRange: `${startDate} to ${endDate}`,
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
    const groupBy = (input.groupBy as string) || "category";
    const direction = (input.direction as string) || "expenses";

    const [period1, period2] = await Promise.all([
      this.getPeriodData(userId, p1Start, p1End, groupBy, direction),
      this.getPeriodData(userId, p2Start, p2End, groupBy, direction),
    ]);

    // Merge labels from both periods
    const allLabels = new Set([
      ...period1.map((i) => i.label),
      ...period2.map((i) => i.label),
    ]);

    const p1Map = new Map(period1.map((i) => [i.label, i.total]));
    const p2Map = new Map(period2.map((i) => [i.label, i.total]));

    const comparison = Array.from(allLabels).map((label) => {
      const p1Amount = roundMoney(p1Map.get(label) || 0);
      const p2Amount = roundMoney(p2Map.get(label) || 0);
      const change = roundMoney(p2Amount - p1Amount);
      const changePercent =
        p1Amount !== 0
          ? Math.round((change / p1Amount) * 10000) / 100
          : p2Amount !== 0
            ? 100
            : 0;

      return {
        label,
        period1Amount: p1Amount,
        period2Amount: p2Amount,
        change,
        changePercent,
      };
    });

    comparison.sort((a, b) => Math.abs(b.change) - Math.abs(a.change));

    const p1Total = sumMoney(period1.map((i) => i.total));
    const p2Total = sumMoney(period2.map((i) => i.total));
    const totalChange = roundMoney(p2Total - p1Total);
    const totalChangePercent =
      p1Total !== 0 ? Math.round((totalChange / p1Total) * 10000) / 100 : 0;

    return {
      data: {
        period1: { start: p1Start, end: p1End, total: p1Total },
        period2: { start: p2Start, end: p2End, total: p2Total },
        totalChange,
        totalChangePercent,
        comparison,
      },
      summary: `Period 1 (${p1Start} to ${p1End}): ${p1Total.toFixed(2)}, Period 2 (${p2Start} to ${p2End}): ${p2Total.toFixed(2)}, Change: ${totalChange >= 0 ? "+" : ""}${totalChange.toFixed(2)} (${totalChangePercent >= 0 ? "+" : ""}${totalChangePercent}%)`,
      sources: [
        {
          type: "comparison",
          description: `Period comparison by ${groupBy}`,
          dateRange: `${p1Start}–${p1End} vs ${p2Start}–${p2End}`,
        },
      ],
    };
  }

  private async getPeriodData(
    userId: string,
    startDate: string,
    endDate: string,
    groupBy: string,
    direction: string,
  ): Promise<{ label: string; total: number }[]> {
    const qb = this.transactionRepo
      .createQueryBuilder("t")
      .leftJoin("t.account", "periodAccount")
      .where("t.userId = :userId", { userId })
      .andWhere("t.transactionDate >= :startDate", { startDate })
      .andWhere("t.transactionDate <= :endDate", { endDate })
      .andWhere("t.status != 'VOID'")
      .andWhere("t.isTransfer = false")
      .andWhere("t.parentTransactionId IS NULL");

    joinSplitsForAnalytics(qb);
    applyInvestmentTransactionFilters(qb, "periodAccount", "t");

    if (direction === "expenses") {
      qb.andWhere(`${SPLIT_AMOUNT} < 0`);
    } else if (direction === "income") {
      qb.andWhere(`${SPLIT_AMOUNT} > 0`);
    }

    if (groupBy === "payee") {
      qb.select("COALESCE(t.payeeName, 'Unknown')", "label")
        .addSelect(`SUM(ABS(${SPLIT_AMOUNT}))`, "total")
        .addSelect("COUNT(*)", "count")
        .groupBy("t.payeeName")
        .orderBy("total", "DESC");
    } else {
      qb.leftJoin("t.category", "cat")
        .select(SPLIT_CATEGORY_NAME, "label")
        .addSelect(`SUM(ABS(${SPLIT_AMOUNT}))`, "total")
        .addSelect("COUNT(*)", "count")
        .groupBy(SPLIT_CATEGORY_NAME)
        .orderBy("total", "DESC");
    }

    const rows = await qb.getRawMany();
    const items = rows.map((r) => ({
      label: r.label,
      total: roundMoney(Number(r.total)),
      count: Number(r.count),
    }));

    // Enforce aggregation threshold for payee-level comparisons
    if (groupBy === "payee") {
      const aboveThreshold = items.filter(
        (i) => i.count >= MIN_AGGREGATION_COUNT,
      );
      const belowThreshold = items.filter(
        (i) => i.count < MIN_AGGREGATION_COUNT,
      );
      if (belowThreshold.length > 0) {
        const otherTotal = sumMoney(belowThreshold.map((i) => i.total));
        const otherCount = belowThreshold.reduce((s, i) => s + i.count, 0);
        aboveThreshold.push({
          label: "Other (aggregated)",
          total: otherTotal,
          count: otherCount,
        });
      }
      return aboveThreshold.map((i) => ({ label: i.label, total: i.total }));
    }

    return items.map((r) => ({ label: r.label, total: r.total }));
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

    const allBudgets = await this.budgetsService.findAll(userId);
    const activeBudgets = allBudgets.filter((b) => b.isActive);

    if (activeBudgets.length === 0) {
      return {
        data: { error: "No active budgets found" },
        summary: "No active budgets found for this user.",
        sources: [],
      };
    }

    const budget = budgetName
      ? activeBudgets.find(
          (b) => b.name.toLowerCase() === budgetName.toLowerCase(),
        )
      : activeBudgets[0];

    if (!budget) {
      return {
        data: {
          error: `Budget "${budgetName}" not found`,
          availableBudgets: activeBudgets.map((b) => b.name),
        },
        summary: `Budget "${budgetName}" not found. Available budgets: ${activeBudgets.map((b) => b.name).join(", ")}`,
        sources: [],
      };
    }

    const { periodStart, periodEnd } = this.resolvePeriodDates(period);

    let summary;
    try {
      summary = await this.budgetsService.getSummary(userId, budget.id);
    } catch {
      return {
        data: { error: "Failed to retrieve budget summary" },
        summary: "Could not retrieve budget data for the requested period.",
        sources: [],
      };
    }

    let velocity;
    try {
      velocity = await this.budgetsService.getVelocity(userId, budget.id);
    } catch {
      velocity = null;
    }

    let healthScore;
    try {
      healthScore = await this.budgetReportsService.getHealthScore(
        userId,
        budget.id,
      );
    } catch {
      healthScore = null;
    }

    const overBudgetCategories = summary.categoryBreakdown
      .filter((c) => !c.isIncome && c.percentUsed > 100)
      .map((c) => ({
        category: c.categoryName,
        budgeted: c.budgeted,
        spent: c.spent,
        percentUsed: c.percentUsed,
      }));

    const nearLimitCategories = summary.categoryBreakdown
      .filter((c) => !c.isIncome && c.percentUsed >= 80 && c.percentUsed <= 100)
      .map((c) => ({
        category: c.categoryName,
        budgeted: c.budgeted,
        spent: c.spent,
        remaining: c.remaining,
        percentUsed: c.percentUsed,
      }));

    const data: Record<string, unknown> = {
      budgetName: budget.name,
      strategy: budget.strategy,
      period: { start: periodStart, end: periodEnd },
      totalBudgeted: summary.totalBudgeted,
      totalSpent: summary.totalSpent,
      totalIncome: summary.totalIncome,
      remaining: summary.remaining,
      percentUsed: summary.percentUsed,
      overBudgetCategories,
      nearLimitCategories,
      categoryCount: summary.categoryBreakdown.filter((c) => !c.isIncome)
        .length,
    };

    if (velocity) {
      data.velocity = {
        dailyBurnRate: velocity.dailyBurnRate,
        safeDailySpend: velocity.safeDailySpend,
        projectedTotal: velocity.projectedTotal,
        projectedVariance: velocity.projectedVariance,
        daysRemaining: velocity.daysRemaining,
        paceStatus: velocity.paceStatus,
      };
    }

    if (healthScore) {
      data.healthScore = {
        score: healthScore.score,
        label: healthScore.label,
      };
    }

    const summaryParts = [
      `Budget "${budget.name}": ${summary.percentUsed.toFixed(1)}% used ($${summary.totalSpent.toFixed(2)} of $${summary.totalBudgeted.toFixed(2)})`,
    ];

    if (velocity) {
      summaryParts.push(
        `Safe daily spend: $${velocity.safeDailySpend.toFixed(2)}, ${velocity.daysRemaining} days remaining`,
      );
    }

    if (overBudgetCategories.length > 0) {
      summaryParts.push(
        `${overBudgetCategories.length} categories over budget`,
      );
    }

    if (healthScore) {
      summaryParts.push(
        `Health score: ${healthScore.score}/100 (${healthScore.label})`,
      );
    }

    return {
      data,
      summary: summaryParts.join(". "),
      sources: [
        {
          type: "budget",
          description: `Budget status for "${budget.name}"`,
          dateRange: `${periodStart} to ${periodEnd}`,
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

  private resolvePeriodDates(period: string): {
    periodStart: string;
    periodEnd: string;
  } {
    if (period === "PREVIOUS") {
      return getPreviousMonthPeriodDates();
    }

    const parsed = parsePeriodFromYYYYMM(period);
    if (parsed) {
      return parsed;
    }

    // Default: CURRENT
    return getCurrentMonthPeriodDates();
  }

  /**
   * LLM06-F2: Enforce minimum aggregation threshold for payee-level data.
   * Groups with fewer than MIN_AGGREGATION_COUNT transactions are merged
   * into an "Other (aggregated)" bucket to prevent revealing individual
   * transaction amounts through targeted queries.
   */
  private enforceAggregationThreshold(
    rows: Array<{ payee: string; total: number; count: number }>,
  ): Array<{ payee: string; total: number; count: number }> {
    const aboveThreshold = rows.filter((r) => r.count >= MIN_AGGREGATION_COUNT);
    const belowThreshold = rows.filter((r) => r.count < MIN_AGGREGATION_COUNT);

    if (belowThreshold.length > 0) {
      const otherTotal = sumMoney(belowThreshold.map((r) => r.total));
      const otherCount = belowThreshold.reduce((sum, r) => sum + r.count, 0);
      aboveThreshold.push({
        payee: "Other (aggregated)",
        total: otherTotal,
        count: otherCount,
      });
    }

    return aboveThreshold.sort((a, b) => b.total - a.total);
  }

  /**
   * Same as enforceAggregationThreshold but for the { label, amount, count }
   * shape used in income summary and period comparisons.
   */
  private enforceAggregationThresholdLabeled(
    items: Array<{ label: string; amount: number; count: number }>,
  ): Array<{ label: string; amount: number; count: number }> {
    const aboveThreshold = items.filter(
      (i) => i.count >= MIN_AGGREGATION_COUNT,
    );
    const belowThreshold = items.filter((i) => i.count < MIN_AGGREGATION_COUNT);

    if (belowThreshold.length > 0) {
      const otherAmount = sumMoney(belowThreshold.map((i) => i.amount));
      const otherCount = belowThreshold.reduce((s, i) => s + i.count, 0);
      aboveThreshold.push({
        label: "Other (aggregated)",
        amount: otherAmount,
        count: otherCount,
      });
    }

    return aboveThreshold;
  }
}
