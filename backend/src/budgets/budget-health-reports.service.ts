import { Injectable, Logger } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import {
  BudgetCategory,
  CategoryGroup,
} from "./entities/budget-category.entity";
import { BudgetPeriod, PeriodStatus } from "./entities/budget-period.entity";
import { Transaction } from "../transactions/entities/transaction.entity";
import { TransactionSplit } from "../transactions/entities/transaction-split.entity";
import { BudgetsService } from "./budgets.service";
import {
  HealthScoreResult,
  HealthScoreHistoryPoint,
  SavingsRatePoint,
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
export class BudgetHealthReportsService {
  private readonly logger = new Logger(BudgetHealthReportsService.name);

  constructor(
    @InjectRepository(BudgetPeriod)
    private periodsRepository: Repository<BudgetPeriod>,
    @InjectRepository(Transaction)
    private transactionsRepository: Repository<Transaction>,
    @InjectRepository(TransactionSplit)
    private splitsRepository: Repository<TransactionSplit>,
    private budgetsService: BudgetsService,
  ) {}

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

    // Compute full date range for all months at once
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

    // Batch queries: group by month across entire range
    const incomeByMonth = new Map<string, number>();
    const expenseByMonth = new Map<string, number>();

    const queries: Promise<void>[] = [];

    // Income query (batch)
    if (incomeCategoryIds.length > 0) {
      queries.push(
        this.transactionsRepository
          .createQueryBuilder("t")
          .select(
            "TO_CHAR(DATE_TRUNC('month', t.transaction_date), 'YYYY-MM')",
            "month",
          )
          .addSelect("COALESCE(SUM(t.amount), 0)", "total")
          .where("t.user_id = :userId", { userId })
          .andWhere("t.category_id IN (:...incomeCategoryIds)", {
            incomeCategoryIds,
          })
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
              incomeByMonth.set(
                row.month,
                (incomeByMonth.get(row.month) || 0) +
                  Math.abs(parseFloat(row.total || "0")),
              );
            }
          }),
      );

      // Income splits query (batch)
      queries.push(
        this.splitsRepository
          .createQueryBuilder("s")
          .innerJoin("s.transaction", "t")
          .select(
            "TO_CHAR(DATE_TRUNC('month', t.transaction_date), 'YYYY-MM')",
            "month",
          )
          .addSelect("COALESCE(SUM(s.amount), 0)", "total")
          .where("t.user_id = :userId", { userId })
          .andWhere("s.category_id IN (:...incomeCategoryIds)", {
            incomeCategoryIds,
          })
          .andWhere("t.transaction_date >= :start", { start: rangeStart })
          .andWhere("t.transaction_date <= :end", { end: rangeEnd })
          .andWhere("t.status != :void", { void: "VOID" })
          .andWhere("s.amount > 0")
          .groupBy(
            "TO_CHAR(DATE_TRUNC('month', t.transaction_date), 'YYYY-MM')",
          )
          .getRawMany()
          .then((rows) => {
            for (const row of rows) {
              incomeByMonth.set(
                row.month,
                (incomeByMonth.get(row.month) || 0) +
                  Math.abs(parseFloat(row.total || "0")),
              );
            }
          }),
      );
    } else {
      // No income categories: use all positive non-transfer transactions
      queries.push(
        this.transactionsRepository
          .createQueryBuilder("t")
          .select(
            "TO_CHAR(DATE_TRUNC('month', t.transaction_date), 'YYYY-MM')",
            "month",
          )
          .addSelect("COALESCE(SUM(t.amount), 0)", "total")
          .where("t.user_id = :userId", { userId })
          .andWhere("t.amount > 0")
          .andWhere("t.is_transfer = false")
          .andWhere("t.transaction_date >= :start", { start: rangeStart })
          .andWhere("t.transaction_date <= :end", { end: rangeEnd })
          .andWhere("t.status != :void", { void: "VOID" })
          .groupBy(
            "TO_CHAR(DATE_TRUNC('month', t.transaction_date), 'YYYY-MM')",
          )
          .getRawMany()
          .then((rows) => {
            for (const row of rows) {
              incomeByMonth.set(row.month, parseFloat(row.total || "0"));
            }
          }),
      );
    }

    // Expense queries (batch: direct + splits in parallel)
    if (expenseCategoryIds.length > 0) {
      queries.push(
        this.transactionsRepository
          .createQueryBuilder("t")
          .select(
            "TO_CHAR(DATE_TRUNC('month', t.transaction_date), 'YYYY-MM')",
            "month",
          )
          .addSelect("COALESCE(SUM(ABS(t.amount)), 0)", "total")
          .where("t.user_id = :userId", { userId })
          .andWhere("t.category_id IN (:...expenseCategoryIds)", {
            expenseCategoryIds,
          })
          .andWhere("t.transaction_date >= :start", { start: rangeStart })
          .andWhere("t.transaction_date <= :end", { end: rangeEnd })
          .andWhere("t.status != :void", { void: "VOID" })
          .andWhere("t.is_split = false")
          .andWhere("t.amount < 0")
          .groupBy(
            "TO_CHAR(DATE_TRUNC('month', t.transaction_date), 'YYYY-MM')",
          )
          .getRawMany()
          .then((rows) => {
            for (const row of rows) {
              expenseByMonth.set(
                row.month,
                (expenseByMonth.get(row.month) || 0) +
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
          .andWhere("s.category_id IN (:...expenseCategoryIds)", {
            expenseCategoryIds,
          })
          .andWhere("t.transaction_date >= :start", { start: rangeStart })
          .andWhere("t.transaction_date <= :end", { end: rangeEnd })
          .andWhere("t.status != :void", { void: "VOID" })
          .andWhere("s.amount < 0")
          .groupBy(
            "TO_CHAR(DATE_TRUNC('month', t.transaction_date), 'YYYY-MM')",
          )
          .getRawMany()
          .then((rows) => {
            for (const row of rows) {
              expenseByMonth.set(
                row.month,
                (expenseByMonth.get(row.month) || 0) +
                  parseFloat(row.total || "0"),
              );
            }
          }),
      );
    }

    await Promise.all(queries);

    // Build result from aggregated monthly data
    const result: SavingsRatePoint[] = [];

    for (let i = months - 1; i >= 0; i--) {
      const d = new Date(today.getFullYear(), today.getMonth() - i, 1);
      const year = d.getFullYear();
      const month = d.getMonth();
      const monthKey = `${year}-${String(month + 1).padStart(2, "0")}`;
      const monthLabel = `${MONTH_NAMES[month].substring(0, 3)} ${year}`;

      const income = incomeByMonth.get(monthKey) || 0;
      const expenses = expenseByMonth.get(monthKey) || 0;
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

  // --- Private helpers ---

  private async computeTrendBonus(
    userId: string,
    budget: { id: string },
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

  private round(value: number): number {
    return Math.round(value * 100) / 100;
  }
}
