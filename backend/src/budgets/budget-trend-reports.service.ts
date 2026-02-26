import { Injectable, Logger } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { Budget } from "./entities/budget.entity";
import { BudgetPeriod, PeriodStatus } from "./entities/budget-period.entity";
import { BudgetPeriodCategory } from "./entities/budget-period-category.entity";
import { Transaction } from "../transactions/entities/transaction.entity";
import { TransactionSplit } from "../transactions/entities/transaction-split.entity";
import { BudgetsService } from "./budgets.service";
import {
  BudgetTrendPoint,
  CategoryTrendSeries,
} from "./budget-reports.service";

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
export class BudgetTrendReportsService {
  private readonly logger = new Logger(BudgetTrendReportsService.name);

  constructor(
    @InjectRepository(BudgetPeriod)
    private periodsRepository: Repository<BudgetPeriod>,
    @InjectRepository(BudgetPeriodCategory)
    private periodCategoriesRepository: Repository<BudgetPeriodCategory>,
    @InjectRepository(Transaction)
    private transactionsRepository: Repository<Transaction>,
    @InjectRepository(TransactionSplit)
    private splitsRepository: Repository<TransactionSplit>,
    private budgetsService: BudgetsService,
  ) {}

  async getTrend(
    userId: string,
    budgetId: string,
    months: number,
  ): Promise<BudgetTrendPoint[]> {
    const budget = await this.budgetsService.findOne(userId, budgetId);

    const periods = await this.getClosedPeriods(budget.id, months);

    if (periods.length === 0) {
      return this.computeLiveTrendFromTransactions(userId, budget, months);
    }

    const result: BudgetTrendPoint[] = periods.map((period) => {
      const budgeted = Number(period.totalBudgeted) || 0;
      const actual = Number(period.actualExpenses) || 0;
      const variance = actual - budgeted;
      const percentUsed =
        budgeted > 0 ? this.round((actual / budgeted) * 100) : 0;

      return {
        month: this.formatPeriodMonth(period.periodStart),
        budgeted: this.round(budgeted),
        actual: this.round(actual),
        variance: this.round(variance),
        percentUsed,
      };
    });

    // Add current open period if it exists
    const currentPeriod = await this.getCurrentOpenPeriod(budget.id);
    if (currentPeriod) {
      const currentActuals = await this.computePeriodActuals(
        userId,
        budget,
        currentPeriod,
      );
      const budgeted = Number(currentPeriod.totalBudgeted) || 0;
      const variance = currentActuals - budgeted;
      const percentUsed =
        budgeted > 0 ? this.round((currentActuals / budgeted) * 100) : 0;

      result.push({
        month: this.formatPeriodMonth(currentPeriod.periodStart),
        budgeted: this.round(budgeted),
        actual: this.round(currentActuals),
        variance: this.round(variance),
        percentUsed,
      });
    }

    return result;
  }

  async getCategoryTrend(
    userId: string,
    budgetId: string,
    months: number,
    categoryIds?: string[],
  ): Promise<CategoryTrendSeries[]> {
    const budget = await this.budgetsService.findOne(userId, budgetId);

    const periods = await this.periodsRepository.find({
      where: { budgetId: budget.id },
      order: { periodStart: "ASC" },
      take: months,
      relations: [
        "periodCategories",
        "periodCategories.budgetCategory",
        "periodCategories.category",
        "periodCategories.category.parent",
      ],
    });

    if (periods.length === 0) {
      return this.computeLiveCategoryTrend(userId, budget, months, categoryIds);
    }

    // Build a map of category series
    const seriesMap = new Map<string, CategoryTrendSeries>();

    for (const period of periods) {
      const periodMonth = this.formatPeriodMonth(period.periodStart);
      const cats = period.periodCategories || [];

      for (const pc of cats) {
        const catId = pc.categoryId;
        if (!catId) continue;

        // Filter by requested category IDs if specified
        if (
          categoryIds &&
          categoryIds.length > 0 &&
          !categoryIds.includes(catId)
        ) {
          continue;
        }

        // Skip income categories
        if (pc.budgetCategory?.isIncome) continue;

        const cat = pc.category;
        const categoryName = cat
          ? cat.parent
            ? `${cat.parent.name}: ${cat.name}`
            : cat.name
          : "Uncategorized";

        if (!seriesMap.has(catId)) {
          seriesMap.set(catId, {
            categoryId: catId,
            categoryName,
            data: [],
          });
        }

        const budgeted = Number(pc.budgetedAmount) || 0;
        let actual = Number(pc.actualAmount) || 0;

        // For open periods, compute actuals from transactions
        if (period.status === PeriodStatus.OPEN) {
          actual = await this.computeCategoryActual(
            userId,
            catId,
            period.periodStart,
            period.periodEnd,
          );
        }

        const variance = actual - budgeted;
        const percentUsed =
          budgeted > 0 ? this.round((actual / budgeted) * 100) : 0;

        seriesMap.get(catId)!.data.push({
          month: periodMonth,
          budgeted: this.round(budgeted),
          actual: this.round(actual),
          variance: this.round(variance),
          percentUsed,
        });
      }
    }

    return Array.from(seriesMap.values());
  }

  // --- Private helpers ---

  private async getClosedPeriods(
    budgetId: string,
    months: number,
  ): Promise<BudgetPeriod[]> {
    return this.periodsRepository.find({
      where: { budgetId, status: PeriodStatus.CLOSED },
      order: { periodStart: "ASC" },
      take: months,
    });
  }

  private async getCurrentOpenPeriod(
    budgetId: string,
  ): Promise<BudgetPeriod | null> {
    return this.periodsRepository.findOne({
      where: { budgetId, status: PeriodStatus.OPEN },
    });
  }

  private async computePeriodActuals(
    userId: string,
    budget: Budget,
    period: BudgetPeriod,
  ): Promise<number> {
    const categories = (budget.categories || []).filter((bc) => !bc.isIncome);
    const categoryIds = categories
      .filter((bc) => bc.categoryId !== null && !bc.isTransfer)
      .map((bc) => bc.categoryId as string);

    const transferAccountIds = categories
      .filter((bc) => bc.isTransfer && bc.transferAccountId)
      .map((bc) => bc.transferAccountId as string);

    // Run all independent queries in parallel
    const queries: Promise<{ total: string } | undefined>[] = [];

    if (categoryIds.length > 0) {
      queries.push(
        this.transactionsRepository
          .createQueryBuilder("t")
          .select("COALESCE(SUM(ABS(t.amount)), 0)", "total")
          .where("t.user_id = :userId", { userId })
          .andWhere("t.category_id IN (:...categoryIds)", { categoryIds })
          .andWhere("t.transaction_date >= :start", {
            start: period.periodStart,
          })
          .andWhere("t.transaction_date <= :end", { end: period.periodEnd })
          .andWhere("t.status != :void", { void: "VOID" })
          .andWhere("t.is_split = false")
          .getRawOne(),
      );

      queries.push(
        this.splitsRepository
          .createQueryBuilder("s")
          .innerJoin("s.transaction", "t")
          .select("COALESCE(SUM(ABS(s.amount)), 0)", "total")
          .where("t.user_id = :userId", { userId })
          .andWhere("s.category_id IN (:...categoryIds)", { categoryIds })
          .andWhere("t.transaction_date >= :start", {
            start: period.periodStart,
          })
          .andWhere("t.transaction_date <= :end", { end: period.periodEnd })
          .andWhere("t.status != :void", { void: "VOID" })
          .getRawOne(),
      );
    }

    if (transferAccountIds.length > 0) {
      queries.push(
        this.transactionsRepository
          .createQueryBuilder("t")
          .innerJoin("t.linkedTransaction", "lt")
          .select("COALESCE(SUM(ABS(t.amount)), 0)", "total")
          .where("t.user_id = :userId", { userId })
          .andWhere("t.is_transfer = true")
          .andWhere("t.amount < 0")
          .andWhere("lt.account_id IN (:...transferAccountIds)", {
            transferAccountIds,
          })
          .andWhere("t.transaction_date >= :start", {
            start: period.periodStart,
          })
          .andWhere("t.transaction_date <= :end", { end: period.periodEnd })
          .andWhere("t.status != :void", { void: "VOID" })
          .getRawOne(),
      );
    }

    const results = await Promise.all(queries);
    let total = 0;
    for (const result of results) {
      total += parseFloat(result?.total || "0");
    }

    return total;
  }

  private async computeCategoryActual(
    userId: string,
    categoryId: string,
    periodStart: string,
    periodEnd: string,
  ): Promise<number> {
    const [directResult, splitResult] = await Promise.all([
      this.transactionsRepository
        .createQueryBuilder("t")
        .select("COALESCE(SUM(ABS(t.amount)), 0)", "total")
        .where("t.user_id = :userId", { userId })
        .andWhere("t.category_id = :categoryId", { categoryId })
        .andWhere("t.transaction_date >= :start", { start: periodStart })
        .andWhere("t.transaction_date <= :end", { end: periodEnd })
        .andWhere("t.status != :void", { void: "VOID" })
        .andWhere("t.is_split = false")
        .getRawOne(),
      this.splitsRepository
        .createQueryBuilder("s")
        .innerJoin("s.transaction", "t")
        .select("COALESCE(SUM(ABS(s.amount)), 0)", "total")
        .where("t.user_id = :userId", { userId })
        .andWhere("s.category_id = :categoryId", { categoryId })
        .andWhere("t.transaction_date >= :start", { start: periodStart })
        .andWhere("t.transaction_date <= :end", { end: periodEnd })
        .andWhere("t.status != :void", { void: "VOID" })
        .getRawOne(),
    ]);

    return (
      parseFloat(directResult?.total || "0") +
      parseFloat(splitResult?.total || "0")
    );
  }

  private async computeLiveCategoryTrend(
    userId: string,
    budget: Budget,
    months: number,
    categoryIds?: string[],
  ): Promise<CategoryTrendSeries[]> {
    const expenseCategories = (budget.categories || []).filter(
      (bc) => !bc.isIncome && !bc.isTransfer && bc.categoryId,
    );

    const filtered =
      categoryIds && categoryIds.length > 0
        ? expenseCategories.filter((bc) =>
            categoryIds.includes(bc.categoryId as string),
          )
        : expenseCategories;

    if (filtered.length === 0) return [];

    const filteredCategoryIds = filtered.map((bc) => bc.categoryId as string);
    const today = new Date();

    // Compute full date range
    const startD = new Date(
      today.getFullYear(),
      today.getMonth() - (months - 1),
      1,
    );
    const rangeStart = `${startD.getFullYear()}-${String(startD.getMonth() + 1).padStart(2, "0")}-01`;
    const lastDay = new Date(
      today.getFullYear(),
      today.getMonth() + 1,
      0,
    ).getDate();
    const rangeEnd = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(lastDay).padStart(2, "0")}`;

    // Batch query: per-category, per-month actuals in 2 parallel queries
    // Map<categoryId, Map<monthKey, amount>>
    const actualMap = new Map<string, Map<string, number>>();

    const [directRows, splitRows] = await Promise.all([
      this.transactionsRepository
        .createQueryBuilder("t")
        .select("t.category_id", "categoryId")
        .addSelect(
          "TO_CHAR(DATE_TRUNC('month', t.transaction_date), 'YYYY-MM')",
          "month",
        )
        .addSelect("COALESCE(SUM(ABS(t.amount)), 0)", "total")
        .where("t.user_id = :userId", { userId })
        .andWhere("t.category_id IN (:...filteredCategoryIds)", {
          filteredCategoryIds,
        })
        .andWhere("t.transaction_date >= :start", { start: rangeStart })
        .andWhere("t.transaction_date <= :end", { end: rangeEnd })
        .andWhere("t.status != :void", { void: "VOID" })
        .andWhere("t.is_split = false")
        .groupBy("t.category_id")
        .addGroupBy(
          "TO_CHAR(DATE_TRUNC('month', t.transaction_date), 'YYYY-MM')",
        )
        .getRawMany(),
      this.splitsRepository
        .createQueryBuilder("s")
        .innerJoin("s.transaction", "t")
        .select("s.category_id", "categoryId")
        .addSelect(
          "TO_CHAR(DATE_TRUNC('month', t.transaction_date), 'YYYY-MM')",
          "month",
        )
        .addSelect("COALESCE(SUM(ABS(s.amount)), 0)", "total")
        .where("t.user_id = :userId", { userId })
        .andWhere("s.category_id IN (:...filteredCategoryIds)", {
          filteredCategoryIds,
        })
        .andWhere("t.transaction_date >= :start", { start: rangeStart })
        .andWhere("t.transaction_date <= :end", { end: rangeEnd })
        .andWhere("t.status != :void", { void: "VOID" })
        .groupBy("s.category_id")
        .addGroupBy(
          "TO_CHAR(DATE_TRUNC('month', t.transaction_date), 'YYYY-MM')",
        )
        .getRawMany(),
    ]);

    for (const row of [...directRows, ...splitRows]) {
      const catId = row.categoryId as string;
      const monthKey = row.month as string;
      const total = parseFloat(row.total || "0");
      if (!actualMap.has(catId)) {
        actualMap.set(catId, new Map());
      }
      const monthMap = actualMap.get(catId)!;
      monthMap.set(monthKey, (monthMap.get(monthKey) || 0) + total);
    }

    // Build series
    const seriesMap = new Map<string, CategoryTrendSeries>();

    for (const bc of filtered) {
      const catId = bc.categoryId as string;
      const cat = bc.category;
      const categoryName = cat
        ? cat.parent
          ? `${cat.parent.name}: ${cat.name}`
          : cat.name
        : "Uncategorized";

      const data: CategoryTrendSeries["data"] = [];

      for (let i = months - 1; i >= 0; i--) {
        const d = new Date(today.getFullYear(), today.getMonth() - i, 1);
        const year = d.getFullYear();
        const month = d.getMonth();
        const monthKey = `${year}-${String(month + 1).padStart(2, "0")}`;
        const monthLabel = `${MONTH_NAMES[month].substring(0, 3)} ${year}`;

        const budgeted = Number(bc.amount) || 0;
        const actual = actualMap.get(catId)?.get(monthKey) || 0;
        const variance = actual - budgeted;
        const percentUsed =
          budgeted > 0 ? this.round((actual / budgeted) * 100) : 0;

        data.push({
          month: monthLabel,
          budgeted: this.round(budgeted),
          actual: this.round(actual),
          variance: this.round(variance),
          percentUsed,
        });
      }

      seriesMap.set(catId, { categoryId: catId, categoryName, data });
    }

    return Array.from(seriesMap.values());
  }

  private async computeLiveTrendFromTransactions(
    userId: string,
    budget: Budget,
    months: number,
  ): Promise<BudgetTrendPoint[]> {
    // When no closed periods exist, compute trend from transaction data
    const categories = (budget.categories || []).filter((bc) => !bc.isIncome);
    const categoryIds = categories
      .filter((bc) => bc.categoryId !== null && !bc.isTransfer)
      .map((bc) => bc.categoryId as string);

    const transferAccountIds = categories
      .filter((bc) => bc.isTransfer && bc.transferAccountId)
      .map((bc) => bc.transferAccountId as string);

    if (categoryIds.length === 0 && transferAccountIds.length === 0) return [];

    const totalBudgeted = categories.reduce(
      (sum, bc) => sum + Number(bc.amount),
      0,
    );

    const today = new Date();

    // Compute full date range
    const startD = new Date(
      today.getFullYear(),
      today.getMonth() - (months - 1),
      1,
    );
    const rangeStart = `${startD.getFullYear()}-${String(startD.getMonth() + 1).padStart(2, "0")}-01`;
    const lastDay = new Date(
      today.getFullYear(),
      today.getMonth() + 1,
      0,
    ).getDate();
    const rangeEnd = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(lastDay).padStart(2, "0")}`;

    // Batch queries grouped by month
    const actualByMonth = new Map<string, number>();
    const queries: Promise<void>[] = [];

    if (categoryIds.length > 0) {
      queries.push(
        this.transactionsRepository
          .createQueryBuilder("t")
          .select(
            "TO_CHAR(DATE_TRUNC('month', t.transaction_date), 'YYYY-MM')",
            "month",
          )
          .addSelect("COALESCE(SUM(ABS(t.amount)), 0)", "total")
          .where("t.user_id = :userId", { userId })
          .andWhere("t.category_id IN (:...categoryIds)", { categoryIds })
          .andWhere("t.transaction_date >= :start", { start: rangeStart })
          .andWhere("t.transaction_date <= :end", { end: rangeEnd })
          .andWhere("t.status != :void", { void: "VOID" })
          .andWhere("t.is_split = false")
          .groupBy(
            "TO_CHAR(DATE_TRUNC('month', t.transaction_date), 'YYYY-MM')",
          )
          .getRawMany()
          .then((rows) => {
            for (const row of rows) {
              actualByMonth.set(
                row.month,
                (actualByMonth.get(row.month) || 0) +
                  parseFloat(row.total || "0"),
              );
            }
          }),
      );

      queries.push(
        this.splitsRepository
          .createQueryBuilder("s")
          .innerJoin("s.transaction", "t")
          .select(
            "TO_CHAR(DATE_TRUNC('month', t.transaction_date), 'YYYY-MM')",
            "month",
          )
          .addSelect("COALESCE(SUM(ABS(s.amount)), 0)", "total")
          .where("t.user_id = :userId", { userId })
          .andWhere("s.category_id IN (:...categoryIds)", { categoryIds })
          .andWhere("t.transaction_date >= :start", { start: rangeStart })
          .andWhere("t.transaction_date <= :end", { end: rangeEnd })
          .andWhere("t.status != :void", { void: "VOID" })
          .groupBy(
            "TO_CHAR(DATE_TRUNC('month', t.transaction_date), 'YYYY-MM')",
          )
          .getRawMany()
          .then((rows) => {
            for (const row of rows) {
              actualByMonth.set(
                row.month,
                (actualByMonth.get(row.month) || 0) +
                  parseFloat(row.total || "0"),
              );
            }
          }),
      );
    }

    if (transferAccountIds.length > 0) {
      queries.push(
        this.transactionsRepository
          .createQueryBuilder("t")
          .innerJoin("t.linkedTransaction", "lt")
          .select(
            "TO_CHAR(DATE_TRUNC('month', t.transaction_date), 'YYYY-MM')",
            "month",
          )
          .addSelect("COALESCE(SUM(ABS(t.amount)), 0)", "total")
          .where("t.user_id = :userId", { userId })
          .andWhere("t.is_transfer = true")
          .andWhere("t.amount < 0")
          .andWhere("lt.account_id IN (:...transferAccountIds)", {
            transferAccountIds,
          })
          .andWhere("t.transaction_date >= :start", { start: rangeStart })
          .andWhere("t.transaction_date <= :end", { end: rangeEnd })
          .andWhere("t.status != :void", { void: "VOID" })
          .groupBy(
            "TO_CHAR(DATE_TRUNC('month', t.transaction_date), 'YYYY-MM')",
          )
          .getRawMany()
          .then((rows) => {
            for (const row of rows) {
              actualByMonth.set(
                row.month,
                (actualByMonth.get(row.month) || 0) +
                  parseFloat(row.total || "0"),
              );
            }
          }),
      );
    }

    await Promise.all(queries);

    // Build result from aggregated monthly data
    const result: BudgetTrendPoint[] = [];

    for (let i = months - 1; i >= 0; i--) {
      const d = new Date(today.getFullYear(), today.getMonth() - i, 1);
      const year = d.getFullYear();
      const month = d.getMonth();
      const monthKey = `${year}-${String(month + 1).padStart(2, "0")}`;
      const monthLabel = `${MONTH_NAMES[month].substring(0, 3)} ${year}`;

      const actual = actualByMonth.get(monthKey) || 0;
      const variance = actual - totalBudgeted;
      const percentUsed =
        totalBudgeted > 0 ? this.round((actual / totalBudgeted) * 100) : 0;

      result.push({
        month: monthLabel,
        budgeted: this.round(totalBudgeted),
        actual: this.round(actual),
        variance: this.round(variance),
        percentUsed,
      });
    }

    return result;
  }

  private formatPeriodMonth(periodStart: string): string {
    const parts = periodStart.split("-");
    const year = parseInt(parts[0], 10);
    const month = parseInt(parts[1], 10);
    return `${MONTH_NAMES[month - 1].substring(0, 3)} ${year}`;
  }

  private round(value: number): number {
    return Math.round(value * 100) / 100;
  }
}
