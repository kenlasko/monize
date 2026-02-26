import { Injectable, Logger } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { BudgetCategory } from "./entities/budget-category.entity";
import { BudgetPeriod, PeriodStatus } from "./entities/budget-period.entity";
import { Transaction } from "../transactions/entities/transaction.entity";
import { TransactionSplit } from "../transactions/entities/transaction-split.entity";
import { BudgetsService } from "./budgets.service";
import {
  SeasonalPattern,
  FlexGroupStatusResult,
} from "./budget-reports.service";
import { formatDateYMD } from "../common/date-utils";

const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

@Injectable()
export class BudgetActivityReportsService {
  private readonly logger = new Logger(BudgetActivityReportsService.name);

  constructor(
    @InjectRepository(BudgetPeriod)
    private periodsRepository: Repository<BudgetPeriod>,
    @InjectRepository(Transaction)
    private transactionsRepository: Repository<Transaction>,
    @InjectRepository(TransactionSplit)
    private splitsRepository: Repository<TransactionSplit>,
    private budgetsService: BudgetsService,
  ) {}

  async getSeasonalPatterns(
    userId: string,
    budgetId: string,
  ): Promise<SeasonalPattern[]> {
    const budget = await this.budgetsService.findOne(userId, budgetId);

    const categories = (budget.categories || []).filter((bc) => !bc.isIncome);
    const categoryIds = categories
      .filter((bc) => bc.categoryId !== null)
      .map((bc) => bc.categoryId as string);

    if (categoryIds.length === 0) {
      return [];
    }

    // Get 12 months of transaction data
    const endDate = new Date();
    const startDate = new Date();
    startDate.setMonth(startDate.getMonth() - 12);
    const startStr = `${startDate.getFullYear()}-${String(startDate.getMonth() + 1).padStart(2, "0")}-01`;
    const endStr = `${endDate.getFullYear()}-${String(endDate.getMonth() + 1).padStart(2, "0")}-${String(new Date(endDate.getFullYear(), endDate.getMonth() + 1, 0).getDate()).padStart(2, "0")}`;

    // Query monthly spending per category
    const directSpending = await this.transactionsRepository
      .createQueryBuilder("t")
      .select("t.category_id", "categoryId")
      .addSelect("EXTRACT(YEAR FROM t.transaction_date)::int", "year")
      .addSelect("EXTRACT(MONTH FROM t.transaction_date)::int", "month")
      .addSelect("COALESCE(SUM(ABS(t.amount)), 0)", "total")
      .where("t.user_id = :userId", { userId })
      .andWhere("t.category_id IN (:...categoryIds)", { categoryIds })
      .andWhere("t.transaction_date >= :startStr", { startStr })
      .andWhere("t.transaction_date <= :endStr", { endStr })
      .andWhere("t.status != :void", { void: "VOID" })
      .andWhere("t.is_split = false")
      .andWhere("t.amount < 0")
      .groupBy("t.category_id")
      .addGroupBy("EXTRACT(YEAR FROM t.transaction_date)")
      .addGroupBy("EXTRACT(MONTH FROM t.transaction_date)")
      .getRawMany();

    const splitSpending = await this.splitsRepository
      .createQueryBuilder("s")
      .innerJoin("s.transaction", "t")
      .select("s.category_id", "categoryId")
      .addSelect("EXTRACT(YEAR FROM t.transaction_date)::int", "year")
      .addSelect("EXTRACT(MONTH FROM t.transaction_date)::int", "month")
      .addSelect("COALESCE(SUM(ABS(s.amount)), 0)", "total")
      .where("t.user_id = :userId", { userId })
      .andWhere("s.category_id IN (:...categoryIds)", { categoryIds })
      .andWhere("t.transaction_date >= :startStr", { startStr })
      .andWhere("t.transaction_date <= :endStr", { endStr })
      .andWhere("t.status != :void", { void: "VOID" })
      .andWhere("s.amount < 0")
      .groupBy("s.category_id")
      .addGroupBy("EXTRACT(YEAR FROM t.transaction_date)")
      .addGroupBy("EXTRACT(MONTH FROM t.transaction_date)")
      .getRawMany();

    // Merge direct + split spending into: Map<categoryId, Map<month, total>>
    const spendingMap = new Map<string, Map<number, number>>();

    for (const row of [...directSpending, ...splitSpending]) {
      const catId = row.categoryId as string;
      const month = Number(row.month);
      const total = parseFloat(row.total || "0");

      if (!spendingMap.has(catId)) {
        spendingMap.set(catId, new Map());
      }
      const monthMap = spendingMap.get(catId)!;
      monthMap.set(month, (monthMap.get(month) || 0) + total);
    }

    // Build category name lookup
    const categoryNameMap = new Map<string, string>();
    for (const bc of categories) {
      if (bc.categoryId) {
        const cat = bc.category;
        const name = cat
          ? cat.parent
            ? `${cat.parent.name}: ${cat.name}`
            : cat.name
          : "Uncategorized";
        categoryNameMap.set(bc.categoryId, name);
      }
    }

    const results: SeasonalPattern[] = [];

    for (const [catId, monthMap] of spendingMap.entries()) {
      const monthlyAverages: SeasonalPattern["monthlyAverages"] = [];
      const amounts: number[] = [];

      for (let m = 1; m <= 12; m++) {
        const avg = monthMap.get(m) || 0;
        amounts.push(avg);
        monthlyAverages.push({
          month: m,
          monthName: MONTH_NAMES[m - 1],
          average: this.round(avg),
        });
      }

      const nonZero = amounts.filter((a) => a > 0);
      const mean =
        nonZero.length > 0
          ? nonZero.reduce((s, v) => s + v, 0) / nonZero.length
          : 0;
      const stdDev = this.standardDeviation(nonZero);

      // High months: > mean + 1.5 * stdDev
      const threshold = mean + 1.5 * stdDev;
      const highMonths = amounts
        .map((a, i) => (a > threshold ? i + 1 : 0))
        .filter((m) => m > 0);

      results.push({
        categoryId: catId,
        categoryName: categoryNameMap.get(catId) || "Unknown",
        monthlyAverages,
        highMonths,
        typicalMonthlySpend: this.round(mean),
      });
    }

    return results;
  }

  async getDailySpending(
    userId: string,
    budgetId: string,
  ): Promise<Array<{ date: string; amount: number }>> {
    const budget = await this.budgetsService.findOne(userId, budgetId);

    // Determine period range
    const currentPeriod = await this.getCurrentOpenPeriod(budget.id);
    let periodStart: string;
    let periodEnd: string;

    if (currentPeriod) {
      periodStart = currentPeriod.periodStart;
      periodEnd = currentPeriod.periodEnd;
    } else {
      // Fall back to computing from budget start
      periodStart = budget.periodStart;
      const startDate = new Date(periodStart + "T00:00:00");
      const endDate = new Date(
        startDate.getFullYear(),
        startDate.getMonth() + 1,
        0,
      );
      periodEnd = formatDateYMD(endDate);
    }

    const categories = (budget.categories || []).filter((bc) => !bc.isIncome);
    const categoryIds = categories
      .filter((bc) => bc.categoryId !== null && !bc.isTransfer)
      .map((bc) => bc.categoryId as string);

    const transferAccountIds = categories
      .filter((bc) => bc.isTransfer && bc.transferAccountId)
      .map((bc) => bc.transferAccountId as string);

    const spendingMap = new Map<string, number>();

    // Run all independent queries in parallel
    const queries: Promise<Array<{ date: string; total: string }>>[] = [];

    if (categoryIds.length > 0) {
      queries.push(
        this.transactionsRepository
          .createQueryBuilder("t")
          .select("DATE(t.transaction_date)", "date")
          .addSelect("COALESCE(SUM(ABS(t.amount)), 0)", "total")
          .where("t.user_id = :userId", { userId })
          .andWhere("t.category_id IN (:...categoryIds)", { categoryIds })
          .andWhere("t.transaction_date >= :start", { start: periodStart })
          .andWhere("t.transaction_date <= :end", { end: periodEnd })
          .andWhere("t.status != :void", { void: "VOID" })
          .andWhere("t.is_split = false")
          .groupBy("DATE(t.transaction_date)")
          .getRawMany(),
      );

      queries.push(
        this.splitsRepository
          .createQueryBuilder("s")
          .innerJoin("s.transaction", "t")
          .select("DATE(t.transaction_date)", "date")
          .addSelect("COALESCE(SUM(ABS(s.amount)), 0)", "total")
          .where("t.user_id = :userId", { userId })
          .andWhere("s.category_id IN (:...categoryIds)", { categoryIds })
          .andWhere("t.transaction_date >= :start", { start: periodStart })
          .andWhere("t.transaction_date <= :end", { end: periodEnd })
          .andWhere("t.status != :void", { void: "VOID" })
          .groupBy("DATE(t.transaction_date)")
          .getRawMany(),
      );
    }

    if (transferAccountIds.length > 0) {
      queries.push(
        this.transactionsRepository
          .createQueryBuilder("t")
          .innerJoin("t.linkedTransaction", "lt")
          .select("DATE(t.transaction_date)", "date")
          .addSelect("COALESCE(SUM(ABS(t.amount)), 0)", "total")
          .where("t.user_id = :userId", { userId })
          .andWhere("t.is_transfer = true")
          .andWhere("t.amount < 0")
          .andWhere("lt.account_id IN (:...transferAccountIds)", {
            transferAccountIds,
          })
          .andWhere("t.transaction_date >= :start", { start: periodStart })
          .andWhere("t.transaction_date <= :end", { end: periodEnd })
          .andWhere("t.status != :void", { void: "VOID" })
          .groupBy("DATE(t.transaction_date)")
          .getRawMany(),
      );
    }

    const allResults = await Promise.all(queries);

    for (const rows of allResults) {
      for (const row of rows) {
        const dateStr = String(row.date).substring(0, 10);
        spendingMap.set(
          dateStr,
          (spendingMap.get(dateStr) || 0) + parseFloat(row.total || "0"),
        );
      }
    }

    // Convert map to sorted array
    return Array.from(spendingMap.entries())
      .map(([date, amount]) => ({ date, amount: this.round(amount) }))
      .sort((a, b) => a.date.localeCompare(b.date));
  }

  async getFlexGroupStatus(
    userId: string,
    budgetId: string,
  ): Promise<FlexGroupStatusResult[]> {
    const summary = await this.budgetsService.getSummary(userId, budgetId);
    const budget = summary.budget;

    // Build a map of budget categories by ID
    const bcMap = new Map<string, BudgetCategory>();
    for (const bc of budget.categories || []) {
      bcMap.set(bc.id, bc);
    }

    // Group categories by flex group
    const groupMap = new Map<
      string,
      {
        totalBudgeted: number;
        totalSpent: number;
        categories: FlexGroupStatusResult["categories"];
      }
    >();

    for (const cat of summary.categoryBreakdown) {
      if (cat.isIncome) continue;

      const bc = bcMap.get(cat.budgetCategoryId);
      const flexGroup = bc?.flexGroup;
      if (!flexGroup) continue;

      if (!groupMap.has(flexGroup)) {
        groupMap.set(flexGroup, {
          totalBudgeted: 0,
          totalSpent: 0,
          categories: [],
        });
      }

      const group = groupMap.get(flexGroup)!;
      group.totalBudgeted += cat.budgeted;
      group.totalSpent += cat.spent;
      group.categories.push({
        categoryId: cat.categoryId || "",
        categoryName: cat.categoryName,
        budgeted: cat.budgeted,
        spent: cat.spent,
        percentUsed: cat.percentUsed,
      });
    }

    const results: FlexGroupStatusResult[] = [];

    for (const [groupName, data] of groupMap.entries()) {
      const remaining = data.totalBudgeted - data.totalSpent;
      const percentUsed =
        data.totalBudgeted > 0
          ? this.round((data.totalSpent / data.totalBudgeted) * 100)
          : 0;

      results.push({
        groupName,
        totalBudgeted: this.round(data.totalBudgeted),
        totalSpent: this.round(data.totalSpent),
        remaining: this.round(remaining),
        percentUsed,
        categories: data.categories,
      });
    }

    // Sort by percentUsed descending
    results.sort((a, b) => b.percentUsed - a.percentUsed);

    return results;
  }

  // --- Private helpers ---

  private async getCurrentOpenPeriod(
    budgetId: string,
  ): Promise<BudgetPeriod | null> {
    return this.periodsRepository.findOne({
      where: { budgetId, status: PeriodStatus.OPEN },
    });
  }

  private standardDeviation(values: number[]): number {
    if (values.length <= 1) return 0;
    const avg = values.reduce((s, v) => s + v, 0) / values.length;
    const squaredDiffs = values.map((v) => (v - avg) ** 2);
    const variance = squaredDiffs.reduce((s, v) => s + v, 0) / values.length;
    return Math.sqrt(variance);
  }

  private round(value: number): number {
    return Math.round(value * 100) / 100;
  }
}
