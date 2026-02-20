import { Injectable, Logger } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { Budget } from "./entities/budget.entity";
import {
  BudgetCategory,
  CategoryGroup,
} from "./entities/budget-category.entity";
import { BudgetPeriod, PeriodStatus } from "./entities/budget-period.entity";
import { BudgetPeriodCategory } from "./entities/budget-period-category.entity";
import { Transaction } from "../transactions/entities/transaction.entity";
import { TransactionSplit } from "../transactions/entities/transaction-split.entity";
import { BudgetsService } from "./budgets.service";

export interface BudgetTrendPoint {
  month: string;
  budgeted: number;
  actual: number;
  variance: number;
  percentUsed: number;
}

export interface CategoryTrendPoint {
  month: string;
  categoryId: string;
  categoryName: string;
  budgeted: number;
  actual: number;
  variance: number;
  percentUsed: number;
}

export interface CategoryTrendSeries {
  categoryId: string;
  categoryName: string;
  data: Array<{
    month: string;
    budgeted: number;
    actual: number;
    variance: number;
    percentUsed: number;
  }>;
}

export interface HealthScoreResult {
  score: number;
  label: string;
  breakdown: {
    baseScore: number;
    overBudgetDeductions: number;
    underBudgetBonus: number;
    trendBonus: number;
    essentialWeightPenalty: number;
  };
  categoryScores: Array<{
    categoryId: string;
    categoryName: string;
    percentUsed: number;
    impact: number;
    categoryGroup: string | null;
  }>;
}

export interface SeasonalPattern {
  categoryId: string;
  categoryName: string;
  monthlyAverages: Array<{
    month: number;
    monthName: string;
    average: number;
  }>;
  highMonths: number[];
  typicalMonthlySpend: number;
}

export interface FlexGroupStatusResult {
  groupName: string;
  totalBudgeted: number;
  totalSpent: number;
  remaining: number;
  percentUsed: number;
  categories: Array<{
    categoryId: string;
    categoryName: string;
    budgeted: number;
    spent: number;
    percentUsed: number;
  }>;
}

export interface SavingsRatePoint {
  month: string;
  income: number;
  expenses: number;
  savings: number;
  savingsRate: number;
}

export interface HealthScoreHistoryPoint {
  month: string;
  score: number;
  label: string;
}

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
export class BudgetReportsService {
  private readonly logger = new Logger(BudgetReportsService.name);

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
            ? `${cat.parent.name} > ${cat.name}`
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

  async getHealthScore(
    userId: string,
    budgetId: string,
  ): Promise<HealthScoreResult> {
    const budget = await this.budgetsService.findOne(userId, budgetId);

    const summary = await this.budgetsService.getSummary(userId, budgetId);
    const expenseCategories = summary.categoryBreakdown.filter(
      (c) => !c.isIncome,
    );

    // Build a budget category lookup for categoryGroup
    const bcMap = new Map<string, BudgetCategory>();
    for (const bc of budget.categories || []) {
      bcMap.set(bc.id, bc);
    }

    const baseScore = 100;
    let overBudgetDeductions = 0;
    let underBudgetBonus = 0;
    let essentialWeightPenalty = 0;

    const categoryScores: HealthScoreResult["categoryScores"] = [];

    for (const cat of expenseCategories) {
      if (cat.budgeted <= 0) continue;

      const bc = bcMap.get(cat.budgetCategoryId);
      const group = bc?.categoryGroup || null;
      const isEssential = group === CategoryGroup.NEED;
      const weight = isEssential ? 1.5 : 1.0;

      let impact = 0;

      if (cat.percentUsed > 100) {
        // Over budget: deduct proportionally
        const overagePercent = cat.percentUsed - 100;
        const deduction = Math.min(overagePercent * 0.3 * weight, 15);
        overBudgetDeductions += deduction;
        impact = -deduction;

        if (isEssential) {
          // Extra penalty for essential categories over budget
          const extraPenalty = Math.min(overagePercent * 0.1, 5);
          essentialWeightPenalty += extraPenalty;
        }
      } else if (cat.percentUsed <= 80) {
        // Under budget: small bonus
        const bonus = Math.min((100 - cat.percentUsed) * 0.05, 3);
        underBudgetBonus += bonus;
        impact = bonus;
      }

      categoryScores.push({
        categoryId: cat.categoryId || "",
        categoryName: cat.categoryName,
        percentUsed: cat.percentUsed,
        impact: this.round(impact),
        categoryGroup: group,
      });
    }

    // Trend bonus: compare current vs previous period
    const trendBonus = await this.computeTrendBonus(userId, budget);

    const rawScore =
      baseScore -
      overBudgetDeductions -
      essentialWeightPenalty +
      underBudgetBonus +
      trendBonus;

    const score = Math.min(100, Math.max(0, Math.round(rawScore)));
    const label = this.getScoreLabel(score);

    return {
      score,
      label,
      breakdown: {
        baseScore,
        overBudgetDeductions: this.round(overBudgetDeductions),
        underBudgetBonus: this.round(underBudgetBonus),
        trendBonus: this.round(trendBonus),
        essentialWeightPenalty: this.round(essentialWeightPenalty),
      },
      categoryScores,
    };
  }

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
            ? `${cat.parent.name} > ${cat.name}`
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

  async getSavingsRate(
    userId: string,
    budgetId: string,
    months: number,
  ): Promise<SavingsRatePoint[]> {
    const budget = await this.budgetsService.findOne(userId, budgetId);

    const incomeCategories = (budget.categories || []).filter(
      (bc) => bc.isIncome,
    );
    const expenseCategories = (budget.categories || []).filter(
      (bc) => !bc.isIncome,
    );

    const incomeCategoryIds = incomeCategories
      .filter((bc) => bc.categoryId !== null)
      .map((bc) => bc.categoryId as string);
    const expenseCategoryIds = expenseCategories
      .filter((bc) => bc.categoryId !== null && !bc.isTransfer)
      .map((bc) => bc.categoryId as string);

    const today = new Date();
    const result: SavingsRatePoint[] = [];

    for (let i = months - 1; i >= 0; i--) {
      const d = new Date(today.getFullYear(), today.getMonth() - i, 1);
      const year = d.getFullYear();
      const month = d.getMonth();

      const periodStart = `${year}-${String(month + 1).padStart(2, "0")}-01`;
      const lastDay = new Date(year, month + 1, 0).getDate();
      const periodEnd = `${year}-${String(month + 1).padStart(2, "0")}-${String(lastDay).padStart(2, "0")}`;
      const monthLabel = `${MONTH_NAMES[month].substring(0, 3)} ${year}`;

      let income = 0;
      let expenses = 0;

      // Compute income from income-category transactions
      if (incomeCategoryIds.length > 0) {
        const incomeResult = await this.transactionsRepository
          .createQueryBuilder("t")
          .select("COALESCE(SUM(t.amount), 0)", "total")
          .where("t.user_id = :userId", { userId })
          .andWhere("t.category_id IN (:...incomeCategoryIds)", {
            incomeCategoryIds,
          })
          .andWhere("t.transaction_date >= :start", { start: periodStart })
          .andWhere("t.transaction_date <= :end", { end: periodEnd })
          .andWhere("t.status != :void", { void: "VOID" })
          .andWhere("t.is_split = false")
          .getRawOne();

        income += Math.abs(parseFloat(incomeResult?.total || "0"));
      }

      // Compute expenses from expense-category transactions
      if (expenseCategoryIds.length > 0) {
        const directResult = await this.transactionsRepository
          .createQueryBuilder("t")
          .select("COALESCE(SUM(ABS(t.amount)), 0)", "total")
          .where("t.user_id = :userId", { userId })
          .andWhere("t.category_id IN (:...expenseCategoryIds)", {
            expenseCategoryIds,
          })
          .andWhere("t.transaction_date >= :start", { start: periodStart })
          .andWhere("t.transaction_date <= :end", { end: periodEnd })
          .andWhere("t.status != :void", { void: "VOID" })
          .andWhere("t.is_split = false")
          .andWhere("t.amount < 0")
          .getRawOne();

        const splitResult = await this.splitsRepository
          .createQueryBuilder("s")
          .innerJoin("s.transaction", "t")
          .select("COALESCE(SUM(ABS(s.amount)), 0)", "total")
          .where("t.user_id = :userId", { userId })
          .andWhere("s.category_id IN (:...expenseCategoryIds)", {
            expenseCategoryIds,
          })
          .andWhere("t.transaction_date >= :start", { start: periodStart })
          .andWhere("t.transaction_date <= :end", { end: periodEnd })
          .andWhere("t.status != :void", { void: "VOID" })
          .andWhere("s.amount < 0")
          .getRawOne();

        expenses +=
          parseFloat(directResult?.total || "0") +
          parseFloat(splitResult?.total || "0");
      }

      // If no income categories in budget, compute income from all positive transactions
      if (incomeCategoryIds.length === 0) {
        const allIncomeResult = await this.transactionsRepository
          .createQueryBuilder("t")
          .select("COALESCE(SUM(t.amount), 0)", "total")
          .where("t.user_id = :userId", { userId })
          .andWhere("t.amount > 0")
          .andWhere("t.is_transfer = false")
          .andWhere("t.transaction_date >= :start", { start: periodStart })
          .andWhere("t.transaction_date <= :end", { end: periodEnd })
          .andWhere("t.status != :void", { void: "VOID" })
          .getRawOne();

        income = parseFloat(allIncomeResult?.total || "0");
      }

      const savings = income - expenses;
      const savingsRate = income > 0 ? this.round((savings / income) * 100) : 0;

      result.push({
        month: monthLabel,
        income: this.round(income),
        expenses: this.round(expenses),
        savings: this.round(savings),
        savingsRate,
      });
    }

    return result;
  }

  async getHealthScoreHistory(
    userId: string,
    budgetId: string,
    months: number,
  ): Promise<HealthScoreHistoryPoint[]> {
    const budget = await this.budgetsService.findOne(userId, budgetId);

    const periods = await this.periodsRepository.find({
      where: { budgetId: budget.id },
      order: { periodStart: "ASC" },
      take: months,
      relations: ["periodCategories", "periodCategories.budgetCategory"],
    });

    if (periods.length === 0) {
      return [];
    }

    // Build a budget category lookup for categoryGroup
    const bcMap = new Map<string, BudgetCategory>();
    for (const bc of budget.categories || []) {
      bcMap.set(bc.id, bc);
    }

    const result: HealthScoreHistoryPoint[] = [];

    for (const period of periods) {
      const cats = (period.periodCategories || []).filter(
        (pc) => !pc.budgetCategory?.isIncome,
      );

      let overBudgetDeductions = 0;
      let underBudgetBonus = 0;
      let essentialWeightPenalty = 0;

      for (const pc of cats) {
        const budgeted = Number(pc.budgetedAmount) || 0;
        if (budgeted <= 0) continue;

        let actual = Number(pc.actualAmount) || 0;
        // For open periods, compute actuals from transactions
        if (period.status === PeriodStatus.OPEN && pc.categoryId) {
          actual = await this.computeCategoryActual(
            userId,
            pc.categoryId,
            period.periodStart,
            period.periodEnd,
          );
        }

        const percentUsed = (actual / budgeted) * 100;

        const bc = pc.budgetCategory
          ? bcMap.get(pc.budgetCategory.id)
          : undefined;
        const isEssential = bc?.categoryGroup === CategoryGroup.NEED;
        const weight = isEssential ? 1.5 : 1.0;

        if (percentUsed > 100) {
          const overagePercent = percentUsed - 100;
          const deduction = Math.min(overagePercent * 0.3 * weight, 15);
          overBudgetDeductions += deduction;
          if (isEssential) {
            essentialWeightPenalty += Math.min(overagePercent * 0.1, 5);
          }
        } else if (percentUsed <= 80) {
          const bonus = Math.min((100 - percentUsed) * 0.05, 3);
          underBudgetBonus += bonus;
        }
      }

      const rawScore =
        100 - overBudgetDeductions - essentialWeightPenalty + underBudgetBonus;
      const score = Math.min(100, Math.max(0, Math.round(rawScore)));

      result.push({
        month: this.formatPeriodMonth(period.periodStart),
        score,
        label: this.getScoreLabel(score),
      });
    }

    return result;
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
      periodEnd = endDate.toISOString().split("T")[0];
    }

    const categories = (budget.categories || []).filter((bc) => !bc.isIncome);
    const categoryIds = categories
      .filter((bc) => bc.categoryId !== null && !bc.isTransfer)
      .map((bc) => bc.categoryId as string);

    const transferAccountIds = categories
      .filter((bc) => bc.isTransfer && bc.transferAccountId)
      .map((bc) => bc.transferAccountId as string);

    const spendingMap = new Map<string, number>();

    // Direct category transactions grouped by date
    if (categoryIds.length > 0) {
      const directRows: Array<{ date: string; total: string }> =
        await this.transactionsRepository
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
          .getRawMany();

      for (const row of directRows) {
        const dateStr = String(row.date).substring(0, 10);
        spendingMap.set(
          dateStr,
          (spendingMap.get(dateStr) || 0) + parseFloat(row.total || "0"),
        );
      }

      // Split transactions
      const splitRows: Array<{ date: string; total: string }> =
        await this.splitsRepository
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
          .getRawMany();

      for (const row of splitRows) {
        const dateStr = String(row.date).substring(0, 10);
        spendingMap.set(
          dateStr,
          (spendingMap.get(dateStr) || 0) + parseFloat(row.total || "0"),
        );
      }
    }

    // Transfer transactions grouped by date
    if (transferAccountIds.length > 0) {
      const transferRows: Array<{ date: string; total: string }> =
        await this.transactionsRepository
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
          .getRawMany();

      for (const row of transferRows) {
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

    let total = 0;

    if (categoryIds.length > 0) {
      const directResult = await this.transactionsRepository
        .createQueryBuilder("t")
        .select("COALESCE(SUM(ABS(t.amount)), 0)", "total")
        .where("t.user_id = :userId", { userId })
        .andWhere("t.category_id IN (:...categoryIds)", { categoryIds })
        .andWhere("t.transaction_date >= :start", { start: period.periodStart })
        .andWhere("t.transaction_date <= :end", { end: period.periodEnd })
        .andWhere("t.status != :void", { void: "VOID" })
        .andWhere("t.is_split = false")
        .getRawOne();

      const splitResult = await this.splitsRepository
        .createQueryBuilder("s")
        .innerJoin("s.transaction", "t")
        .select("COALESCE(SUM(ABS(s.amount)), 0)", "total")
        .where("t.user_id = :userId", { userId })
        .andWhere("s.category_id IN (:...categoryIds)", { categoryIds })
        .andWhere("t.transaction_date >= :start", { start: period.periodStart })
        .andWhere("t.transaction_date <= :end", { end: period.periodEnd })
        .andWhere("t.status != :void", { void: "VOID" })
        .getRawOne();

      total +=
        parseFloat(directResult?.total || "0") +
        parseFloat(splitResult?.total || "0");
    }

    // Transfer actuals
    const transferAccountIds = categories
      .filter((bc) => bc.isTransfer && bc.transferAccountId)
      .map((bc) => bc.transferAccountId as string);

    if (transferAccountIds.length > 0) {
      const transferResult = await this.transactionsRepository
        .createQueryBuilder("t")
        .innerJoin("t.linkedTransaction", "lt")
        .select("COALESCE(SUM(ABS(t.amount)), 0)", "total")
        .where("t.user_id = :userId", { userId })
        .andWhere("t.is_transfer = true")
        .andWhere("t.amount < 0")
        .andWhere("lt.account_id IN (:...transferAccountIds)", {
          transferAccountIds,
        })
        .andWhere("t.transaction_date >= :start", { start: period.periodStart })
        .andWhere("t.transaction_date <= :end", { end: period.periodEnd })
        .andWhere("t.status != :void", { void: "VOID" })
        .getRawOne();

      total += parseFloat(transferResult?.total || "0");
    }

    return total;
  }

  private async computeCategoryActual(
    userId: string,
    categoryId: string,
    periodStart: string,
    periodEnd: string,
  ): Promise<number> {
    const directResult = await this.transactionsRepository
      .createQueryBuilder("t")
      .select("COALESCE(SUM(ABS(t.amount)), 0)", "total")
      .where("t.user_id = :userId", { userId })
      .andWhere("t.category_id = :categoryId", { categoryId })
      .andWhere("t.transaction_date >= :start", { start: periodStart })
      .andWhere("t.transaction_date <= :end", { end: periodEnd })
      .andWhere("t.status != :void", { void: "VOID" })
      .andWhere("t.is_split = false")
      .getRawOne();

    const splitResult = await this.splitsRepository
      .createQueryBuilder("s")
      .innerJoin("s.transaction", "t")
      .select("COALESCE(SUM(ABS(s.amount)), 0)", "total")
      .where("t.user_id = :userId", { userId })
      .andWhere("s.category_id = :categoryId", { categoryId })
      .andWhere("t.transaction_date >= :start", { start: periodStart })
      .andWhere("t.transaction_date <= :end", { end: periodEnd })
      .andWhere("t.status != :void", { void: "VOID" })
      .getRawOne();

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

    const today = new Date();
    const seriesMap = new Map<string, CategoryTrendSeries>();

    // Initialize series for each category
    for (const bc of filtered) {
      const cat = bc.category;
      const categoryName = cat
        ? cat.parent
          ? `${cat.parent.name} > ${cat.name}`
          : cat.name
        : "Uncategorized";

      seriesMap.set(bc.categoryId as string, {
        categoryId: bc.categoryId as string,
        categoryName,
        data: [],
      });
    }

    // Compute per-category actuals for each month
    for (let i = months - 1; i >= 0; i--) {
      const d = new Date(today.getFullYear(), today.getMonth() - i, 1);
      const year = d.getFullYear();
      const month = d.getMonth();

      const periodStart = `${year}-${String(month + 1).padStart(2, "0")}-01`;
      const lastDay = new Date(year, month + 1, 0).getDate();
      const periodEnd = `${year}-${String(month + 1).padStart(2, "0")}-${String(lastDay).padStart(2, "0")}`;
      const monthLabel = `${MONTH_NAMES[month].substring(0, 3)} ${year}`;

      for (const bc of filtered) {
        const catId = bc.categoryId as string;
        const budgeted = Number(bc.amount) || 0;
        const actual = await this.computeCategoryActual(
          userId,
          catId,
          periodStart,
          periodEnd,
        );

        const variance = actual - budgeted;
        const percentUsed =
          budgeted > 0 ? this.round((actual / budgeted) * 100) : 0;

        seriesMap.get(catId)!.data.push({
          month: monthLabel,
          budgeted: this.round(budgeted),
          actual: this.round(actual),
          variance: this.round(variance),
          percentUsed,
        });
      }
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
    const result: BudgetTrendPoint[] = [];

    for (let i = months - 1; i >= 0; i--) {
      const d = new Date(today.getFullYear(), today.getMonth() - i, 1);
      const year = d.getFullYear();
      const month = d.getMonth();

      const periodStart = `${year}-${String(month + 1).padStart(2, "0")}-01`;
      const lastDay = new Date(year, month + 1, 0).getDate();
      const periodEnd = `${year}-${String(month + 1).padStart(2, "0")}-${String(lastDay).padStart(2, "0")}`;

      let actual = 0;

      if (categoryIds.length > 0) {
        const directResult = await this.transactionsRepository
          .createQueryBuilder("t")
          .select("COALESCE(SUM(ABS(t.amount)), 0)", "total")
          .where("t.user_id = :userId", { userId })
          .andWhere("t.category_id IN (:...categoryIds)", { categoryIds })
          .andWhere("t.transaction_date >= :start", { start: periodStart })
          .andWhere("t.transaction_date <= :end", { end: periodEnd })
          .andWhere("t.status != :void", { void: "VOID" })
          .andWhere("t.is_split = false")
          .getRawOne();

        const splitResult = await this.splitsRepository
          .createQueryBuilder("s")
          .innerJoin("s.transaction", "t")
          .select("COALESCE(SUM(ABS(s.amount)), 0)", "total")
          .where("t.user_id = :userId", { userId })
          .andWhere("s.category_id IN (:...categoryIds)", { categoryIds })
          .andWhere("t.transaction_date >= :start", { start: periodStart })
          .andWhere("t.transaction_date <= :end", { end: periodEnd })
          .andWhere("t.status != :void", { void: "VOID" })
          .getRawOne();

        actual +=
          parseFloat(directResult?.total || "0") +
          parseFloat(splitResult?.total || "0");
      }

      if (transferAccountIds.length > 0) {
        const transferResult = await this.transactionsRepository
          .createQueryBuilder("t")
          .innerJoin("t.linkedTransaction", "lt")
          .select("COALESCE(SUM(ABS(t.amount)), 0)", "total")
          .where("t.user_id = :userId", { userId })
          .andWhere("t.is_transfer = true")
          .andWhere("t.amount < 0")
          .andWhere("lt.account_id IN (:...transferAccountIds)", {
            transferAccountIds,
          })
          .andWhere("t.transaction_date >= :start", { start: periodStart })
          .andWhere("t.transaction_date <= :end", { end: periodEnd })
          .andWhere("t.status != :void", { void: "VOID" })
          .getRawOne();

        actual += parseFloat(transferResult?.total || "0");
      }

      const variance = actual - totalBudgeted;
      const percentUsed =
        totalBudgeted > 0 ? this.round((actual / totalBudgeted) * 100) : 0;

      const monthLabel = `${MONTH_NAMES[month].substring(0, 3)} ${year}`;

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

  private async computeTrendBonus(
    userId: string,
    budget: Budget,
  ): Promise<number> {
    // Get the last 2 closed periods for trend comparison
    const recentPeriods = await this.periodsRepository.find({
      where: { budgetId: budget.id, status: PeriodStatus.CLOSED },
      order: { periodStart: "DESC" },
      take: 2,
    });

    if (recentPeriods.length < 2) return 0;

    const [latest, previous] = recentPeriods;
    const latestBudgeted = Number(latest.totalBudgeted) || 1;
    const previousBudgeted = Number(previous.totalBudgeted) || 1;

    const latestPercent =
      (Number(latest.actualExpenses) / latestBudgeted) * 100;
    const previousPercent =
      (Number(previous.actualExpenses) / previousBudgeted) * 100;

    // Improving = spending less of budget than previous month
    if (latestPercent < previousPercent) {
      return Math.min((previousPercent - latestPercent) * 0.2, 5);
    }

    return 0;
  }

  private getScoreLabel(score: number): string {
    if (score >= 90) return "Excellent";
    if (score >= 70) return "Good";
    if (score >= 50) return "Needs Attention";
    return "Off Track";
  }

  private formatPeriodMonth(periodStart: string): string {
    const parts = periodStart.split("-");
    const year = parseInt(parts[0], 10);
    const month = parseInt(parts[1], 10);
    return `${MONTH_NAMES[month - 1].substring(0, 3)} ${year}`;
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
