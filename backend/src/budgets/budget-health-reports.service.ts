import { Injectable, Logger } from "@nestjs/common";
import { DataSource } from "typeorm";
import { withScopedDb } from "../common/db/scoped-db";
import {
  BudgetCategory,
  CategoryGroup,
} from "./entities/budget-category.entity";
import { BudgetPeriod, PeriodStatus } from "./entities/budget-period.entity";
import { Transaction } from "../transactions/entities/transaction.entity";
import { TransactionSplit } from "../transactions/entities/transaction-split.entity";
import { BudgetsService } from "./budgets.service";
import { formatMonthKey, getMonthEndYMD } from "../common/date-utils";
import {
  HealthScoreResult,
  HealthScoreHistoryPoint,
  SavingsRatePoint,
} from "./budget-reports.service";
import { roundMoney, roundToDecimals, sumMoney } from "../common/round.util";
import {
  budgetExcludedAccountIds,
  excludeBudgetAccounts,
  queryCategorySpendingBuckets,
  resolveCategorySpent,
} from "./budget-spending.util";

@Injectable()
export class BudgetHealthReportsService {
  private readonly logger = new Logger(BudgetHealthReportsService.name);

  constructor(
    private dataSource: DataSource,
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
        impact: roundToDecimals(impact, 2),
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
        overBudgetDeductions: roundToDecimals(overBudgetDeductions, 2),
        underBudgetBonus: roundToDecimals(underBudgetBonus, 2),
        trendBonus: roundToDecimals(trendBonus, 2),
        essentialWeightPenalty: roundToDecimals(essentialWeightPenalty, 2),
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

    const periods = await withScopedDb(this.dataSource, (m) =>
      m.getRepository(BudgetPeriod).find({
        where: { budgetId: budget.id },
        order: { periodStart: "ASC" },
        take: months,
        relations: ["periodCategories", "periodCategories.budgetCategory"],
      }),
    );

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
            budgetExcludedAccountIds(budget.config),
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
        monthKey: this.formatPeriodMonthKey(period.periodStart),
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
    const spendingLines = [
      ...incomeCategories,
      ...expenseCategories.filter(
        (bc) => bc.categoryId !== null && !bc.isTransfer,
      ),
    ].filter((bc) => bc.categoryId !== null);

    const excludedAccountIds = budgetExcludedAccountIds(budget.config);
    const today = new Date();

    // No income categories: the income side is every positive non-transfer
    // transaction of the window. Only rows in the budget's currency are known;
    // a month holding another currency is reported incomplete, never added 1:1.
    const incomeByMonth = new Map<string, number>();
    const foreignIncomeMonths = new Set<string>();
    if (incomeCategoryIds.length === 0) {
      const startD = new Date(
        today.getFullYear(),
        today.getMonth() - (months - 1),
        1,
      );
      const rangeStart = `${startD.getFullYear()}-${String(startD.getMonth() + 1).padStart(2, "0")}-01`;
      const rangeEnd = getMonthEndYMD(
        today.getFullYear(),
        today.getMonth() + 1,
      );
      const rows = await withScopedDb(this.dataSource, (m) =>
        excludeBudgetAccounts(
          m
            .getRepository(Transaction)
            .createQueryBuilder("t")
            .select(
              "TO_CHAR(DATE_TRUNC('month', t.transaction_date), 'YYYY-MM')",
              "month",
            )
            .addSelect("t.currency_code", "currencyCode")
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
            .addGroupBy("t.currency_code"),
          excludedAccountIds,
        ).getRawMany(),
      );
      for (const row of rows) {
        if (row.currencyCode !== budget.currencyCode) {
          foreignIncomeMonths.add(row.month);
          continue;
        }
        incomeByMonth.set(
          row.month,
          (incomeByMonth.get(row.month) || 0) + parseFloat(row.total || "0"),
        );
      }
    }

    // The budget page's own actuals in one query over the window, bucketed by
    // month: net within the category, converted into the budget's currency, the
    // budget's excluded accounts left out.
    const spendingByMonth =
      spendingLines.length > 0
        ? (
            await withScopedDb(this.dataSource, (m) => {
              const first = new Date(
                today.getFullYear(),
                today.getMonth() - (months - 1),
                1,
              );
              return queryCategorySpendingBuckets(
                m.getRepository(Transaction),
                m.getRepository(TransactionSplit),
                userId,
                spendingLines,
                formatMonthKey(first.getFullYear(), first.getMonth() + 1) +
                  "-01",
                getMonthEndYMD(today.getFullYear(), today.getMonth() + 1),
                (txDate) => txDate.slice(0, 7),
              );
            })
          ).buckets
        : null;

    const result: SavingsRatePoint[] = [];

    for (let i = months - 1; i >= 0; i--) {
      const d = new Date(today.getFullYear(), today.getMonth() - i, 1);
      const year = d.getFullYear();
      const month = d.getMonth();
      const monthKey = formatMonthKey(year, month + 1);

      const spending = spendingByMonth?.get(monthKey) ?? null;
      const sumSide = (isIncome: boolean): number =>
        spending
          ? sumMoney(
              spendingLines
                .filter((bc) => bc.isIncome === isIncome)
                .map((bc) =>
                  resolveCategorySpent(
                    bc,
                    spending.spendingMap,
                    spending.transferSpendingMap,
                  ),
                ),
            )
          : 0;

      const income =
        incomeCategoryIds.length > 0
          ? sumSide(true)
          : incomeByMonth.get(monthKey) || 0;
      const expenses = sumSide(false);
      const savings = income - expenses;
      const savingsRate =
        income > 0 ? roundToDecimals((savings / income) * 100, 2) : 0;

      result.push({
        monthKey,
        income: roundMoney(income),
        expenses: roundMoney(expenses),
        savings: roundMoney(savings),
        savingsRate,
        valuationComplete:
          !foreignIncomeMonths.has(monthKey) &&
          (spending?.incompleteCategoryIds.size ?? 0) === 0,
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
    const recentPeriods = await withScopedDb(this.dataSource, (m) =>
      m.getRepository(BudgetPeriod).find({
        where: { budgetId: budget.id, status: PeriodStatus.CLOSED },
        order: { periodStart: "DESC" },
        take: 2,
      }),
    );

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
    excludedAccountIds: readonly string[],
  ): Promise<number> {
    const [directResult, splitResult] = await Promise.all([
      withScopedDb(this.dataSource, (m) =>
        excludeBudgetAccounts(
          m
            .getRepository(Transaction)
            .createQueryBuilder("t")
            .select("COALESCE(SUM(t.amount), 0)", "total")
            .where("t.user_id = :userId", { userId })
            .andWhere("t.category_id = :categoryId", { categoryId })
            .andWhere("t.transaction_date >= :start", { start: periodStart })
            .andWhere("t.transaction_date <= :end", { end: periodEnd })
            .andWhere("t.status != :void", { void: "VOID" })
            .andWhere("t.is_split = false"),
          excludedAccountIds,
        ).getRawOne(),
      ),
      withScopedDb(this.dataSource, (m) =>
        excludeBudgetAccounts(
          m
            .getRepository(TransactionSplit)
            .createQueryBuilder("s")
            .innerJoin("s.transaction", "t")
            .select("COALESCE(SUM(s.amount), 0)", "total")
            .where("t.user_id = :userId", { userId })
            .andWhere("s.category_id = :categoryId", { categoryId })
            .andWhere("t.transaction_date >= :start", { start: periodStart })
            .andWhere("t.transaction_date <= :end", { end: periodEnd })
            .andWhere("t.status != :void", { void: "VOID" }),
          excludedAccountIds,
        ).getRawOne(),
      ),
    ]);

    // Expenses are negative; negate to get positive spending, clamp to 0
    return Math.max(
      -(
        parseFloat(directResult?.total || "0") +
        parseFloat(splitResult?.total || "0")
      ),
      0,
    );
  }

  private getScoreLabel(score: number): string {
    if (score >= 90) return "Excellent";
    if (score >= 70) return "Good";
    if (score >= 50) return "Needs Attention";
    return "Off Track";
  }

  private formatPeriodMonthKey(periodStart: string): string {
    const parts = periodStart.split("-");
    const year = parseInt(parts[0], 10);
    const month = parseInt(parts[1], 10);
    return formatMonthKey(year, month);
  }
}
