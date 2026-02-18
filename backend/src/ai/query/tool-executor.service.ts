import { Injectable, Inject, forwardRef, Logger } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { AccountsService } from "../../accounts/accounts.service";
import { CategoriesService } from "../../categories/categories.service";
import { TransactionAnalyticsService } from "../../transactions/transaction-analytics.service";
import { NetWorthService } from "../../net-worth/net-worth.service";
import { Transaction } from "../../transactions/entities/transaction.entity";
import { Category } from "../../categories/entities/category.entity";

interface ToolResult {
  data: unknown;
  summary: string;
  sources: Array<{ type: string; description: string; dateRange?: string }>;
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
    try {
      switch (toolName) {
        case "query_transactions":
          return await this.queryTransactions(userId, input);
        case "get_account_balances":
          return await this.getAccountBalances(userId, input);
        case "get_spending_by_category":
          return await this.getSpendingByCategory(userId, input);
        case "get_income_summary":
          return await this.getIncomeSummary(userId, input);
        case "get_net_worth_history":
          return await this.getNetWorthHistory(userId, input);
        case "compare_periods":
          return await this.comparePeriods(userId, input);
        default:
          return {
            data: null,
            summary: `Unknown tool: ${toolName}`,
            sources: [],
          };
      }
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Unknown error";
      this.logger.warn(`Tool ${toolName} failed: ${message}`);
      return {
        data: { error: message },
        summary: `Error executing ${toolName}: ${message}`,
        sources: [],
      };
    }
  }

  private async resolveAccountIds(
    userId: string,
    accountNames?: string[],
  ): Promise<string[] | undefined> {
    if (!accountNames || accountNames.length === 0) return undefined;

    const accounts = await this.accountsService.findAll(userId, false);
    const nameMap = new Map(
      accounts.map((a) => [a.name.toLowerCase(), a.id]),
    );

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

    return categoryNames
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
    const groupBy = input.groupBy as string | undefined;
    const direction = input.direction as string | undefined;

    const accountIds = await this.resolveAccountIds(userId, accountNames);
    const categoryIds = await this.resolveCategoryIds(userId, categoryNames);

    // Get summary totals
    const summary = await this.analyticsService.getSummary(
      userId,
      accountIds,
      startDate,
      endDate,
      categoryIds,
      undefined,
      searchText,
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
        searchText,
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
    const qb = this.transactionRepo
      .createQueryBuilder("t")
      .where("t.userId = :userId", { userId })
      .andWhere("t.transactionDate >= :startDate", { startDate })
      .andWhere("t.transactionDate <= :endDate", { endDate })
      .andWhere("t.status != 'VOID'")
      .andWhere("t.isTransfer = false")
      .andWhere("t.parentTransactionId IS NULL");

    if (direction === "expenses") {
      qb.andWhere("t.amount < 0");
    } else if (direction === "income") {
      qb.andWhere("t.amount > 0");
    }

    if (accountIds && accountIds.length > 0) {
      qb.andWhere("t.accountId IN (:...accountIds)", { accountIds });
    }

    if (categoryIds && categoryIds.length > 0) {
      qb.andWhere("t.categoryId IN (:...categoryIds)", { categoryIds });
    }

    if (searchText) {
      qb.andWhere(
        "(t.description ILIKE :search OR t.payeeName ILIKE :search)",
        { search: `%${searchText}%` },
      );
    }

    switch (groupBy) {
      case "category": {
        qb.leftJoin("t.category", "cat")
          .select("COALESCE(cat.name, 'Uncategorized')", "label")
          .addSelect("SUM(ABS(t.amount))", "total")
          .addSelect("COUNT(*)", "count")
          .groupBy("cat.name");

        const rows = await qb.getRawMany();
        return rows
          .map((r) => ({
            category: r.label,
            total: Number(r.total),
            count: Number(r.count),
          }))
          .sort((a, b) => b.total - a.total);
      }

      case "payee": {
        qb.select("COALESCE(t.payeeName, 'Unknown')", "label")
          .addSelect("SUM(ABS(t.amount))", "total")
          .addSelect("COUNT(*)", "count")
          .groupBy("t.payeeName");

        const rows = await qb.getRawMany();
        return rows
          .map((r) => ({
            payee: r.label,
            total: Number(r.total),
            count: Number(r.count),
          }))
          .sort((a, b) => b.total - a.total);
      }

      case "month": {
        qb.select("TO_CHAR(t.transactionDate, 'YYYY-MM')", "month")
          .addSelect("SUM(ABS(t.amount))", "total")
          .addSelect("COUNT(*)", "count")
          .groupBy("TO_CHAR(t.transactionDate, 'YYYY-MM')")
          .orderBy("month", "ASC");

        const rows = await qb.getRawMany();
        return rows.map((r) => ({
          month: r.month,
          total: Number(r.total),
          count: Number(r.count),
        }));
      }

      case "week": {
        qb.select(
          "TO_CHAR(DATE_TRUNC('week', t.transactionDate), 'YYYY-MM-DD')",
          "week",
        )
          .addSelect("SUM(ABS(t.amount))", "total")
          .addSelect("COUNT(*)", "count")
          .groupBy(
            "DATE_TRUNC('week', t.transactionDate)",
          )
          .orderBy("week", "ASC");

        const rows = await qb.getRawMany();
        return rows.map((r) => ({
          week: r.week,
          total: Number(r.total),
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
    const summary = await this.accountsService.getSummary(userId);

    let accounts = allAccounts;
    if (accountNames && accountNames.length > 0) {
      const lowerNames = new Set(accountNames.map((n) => n.toLowerCase()));
      accounts = allAccounts.filter((a) =>
        lowerNames.has(a.name.toLowerCase()),
      );
    }

    const accountList = accounts.map((a) => ({
      name: a.name,
      type: a.accountType,
      balance: Number(a.currentBalance),
      currency: a.currencyCode,
    }));

    const data = {
      accounts: accountList,
      totalAssets: summary.totalAssets,
      totalLiabilities: summary.totalLiabilities,
      netWorth: summary.netWorth,
      totalAccounts: summary.totalAccounts,
    };

    return {
      data,
      summary: `${accounts.length} accounts. Net worth: ${summary.netWorth.toFixed(2)}, Assets: ${summary.totalAssets.toFixed(2)}, Liabilities: ${summary.totalLiabilities.toFixed(2)}`,
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
      .select("COALESCE(cat.name, 'Uncategorized')", "category")
      .addSelect("SUM(ABS(t.amount))", "total")
      .addSelect("COUNT(*)", "count")
      .where("t.userId = :userId", { userId })
      .andWhere("t.transactionDate >= :startDate", { startDate })
      .andWhere("t.transactionDate <= :endDate", { endDate })
      .andWhere("t.amount < 0")
      .andWhere("t.status != 'VOID'")
      .andWhere("t.isTransfer = false")
      .andWhere("t.parentTransactionId IS NULL")
      .groupBy("cat.name")
      .orderBy("total", "DESC");

    const rows = await qb.getRawMany();
    const totalSpending = rows.reduce(
      (sum, r) => sum + Number(r.total),
      0,
    );

    let categories = rows.map((r) => ({
      category: r.category,
      amount: Number(r.total),
      percentage:
        totalSpending > 0
          ? Math.round((Number(r.total) / totalSpending) * 10000) / 100
          : 0,
      transactionCount: Number(r.count),
    }));

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
      .where("t.userId = :userId", { userId })
      .andWhere("t.transactionDate >= :startDate", { startDate })
      .andWhere("t.transactionDate <= :endDate", { endDate })
      .andWhere("t.amount > 0")
      .andWhere("t.status != 'VOID'")
      .andWhere("t.isTransfer = false")
      .andWhere("t.parentTransactionId IS NULL");

    let items: { label: string; amount: number; count: number }[];

    switch (groupBy) {
      case "payee": {
        qb.select("COALESCE(t.payeeName, 'Unknown')", "label")
          .addSelect("SUM(t.amount)", "total")
          .addSelect("COUNT(*)", "count")
          .groupBy("t.payeeName")
          .orderBy("total", "DESC");
        const rows = await qb.getRawMany();
        items = rows.map((r) => ({
          label: r.label,
          amount: Number(r.total),
          count: Number(r.count),
        }));
        break;
      }
      case "month": {
        qb.select("TO_CHAR(t.transactionDate, 'YYYY-MM')", "label")
          .addSelect("SUM(t.amount)", "total")
          .addSelect("COUNT(*)", "count")
          .groupBy("TO_CHAR(t.transactionDate, 'YYYY-MM')")
          .orderBy("label", "ASC");
        const rows = await qb.getRawMany();
        items = rows.map((r) => ({
          label: r.label,
          amount: Number(r.total),
          count: Number(r.count),
        }));
        break;
      }
      default: {
        // category
        qb.leftJoin("t.category", "cat")
          .select("COALESCE(cat.name, 'Uncategorized')", "label")
          .addSelect("SUM(t.amount)", "total")
          .addSelect("COUNT(*)", "count")
          .groupBy("cat.name")
          .orderBy("total", "DESC");
        const rows = await qb.getRawMany();
        items = rows.map((r) => ({
          label: r.label,
          amount: Number(r.total),
          count: Number(r.count),
        }));
        break;
      }
    }

    const totalIncome = items.reduce((sum, i) => sum + i.amount, 0);

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
    const defaultStart = new Date(
      today.getFullYear() - 1,
      today.getMonth(),
      1,
    )
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
      const p1Amount = p1Map.get(label) || 0;
      const p2Amount = p2Map.get(label) || 0;
      const change = p2Amount - p1Amount;
      const changePercent =
        p1Amount !== 0
          ? Math.round((change / p1Amount) * 10000) / 100
          : p2Amount !== 0
            ? 100
            : 0;

      return { label, period1Amount: p1Amount, period2Amount: p2Amount, change, changePercent };
    });

    comparison.sort(
      (a, b) => Math.abs(b.change) - Math.abs(a.change),
    );

    const p1Total = period1.reduce((sum, i) => sum + i.total, 0);
    const p2Total = period2.reduce((sum, i) => sum + i.total, 0);
    const totalChange = p2Total - p1Total;
    const totalChangePercent =
      p1Total !== 0
        ? Math.round((totalChange / p1Total) * 10000) / 100
        : 0;

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
      .where("t.userId = :userId", { userId })
      .andWhere("t.transactionDate >= :startDate", { startDate })
      .andWhere("t.transactionDate <= :endDate", { endDate })
      .andWhere("t.status != 'VOID'")
      .andWhere("t.isTransfer = false")
      .andWhere("t.parentTransactionId IS NULL");

    if (direction === "expenses") {
      qb.andWhere("t.amount < 0");
    } else if (direction === "income") {
      qb.andWhere("t.amount > 0");
    }

    if (groupBy === "payee") {
      qb.select("COALESCE(t.payeeName, 'Unknown')", "label")
        .addSelect("SUM(ABS(t.amount))", "total")
        .groupBy("t.payeeName")
        .orderBy("total", "DESC");
    } else {
      qb.leftJoin("t.category", "cat")
        .select("COALESCE(cat.name, 'Uncategorized')", "label")
        .addSelect("SUM(ABS(t.amount))", "total")
        .groupBy("cat.name")
        .orderBy("total", "DESC");
    }

    const rows = await qb.getRawMany();
    return rows.map((r) => ({
      label: r.label,
      total: Number(r.total),
    }));
  }
}
