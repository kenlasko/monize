import { categoryTypeOfOrUndefined } from "../categories/category-type.util";
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
import { roundToDecimals, sumMoney } from "../common/round.util";
import { reportPlacesOf } from "../common/report-figure";
import {
  budgetExcludedAccountIds,
  CategorySpending,
  excludeBudgetAccounts,
  queryCategorySpending,
  queryCategorySpendingBuckets,
  resolveCategorySpent,
  categoryExpenseActual,
  resolveOutsideTransferIncomeAggregate,
  isTransferIncomeLine,
  budgetTransfersInAsIncome,
} from "./budget-spending.util";
import { FxAggregate } from "../common/fx-aggregate";
import { investmentLinkedSplitExclusion } from "../common/investment-filter.util";
import {
  joinSplitsForAnalytics,
  SPLIT_AMOUNT,
} from "../common/transaction-split-query.util";
import {
  convertRatePartAggregates,
  RatePartRow,
  splitByRateBasis,
} from "../built-in-reports/rate-basis-parts";
import { Budget } from "./entities/budget.entity";

/** A transaction's calendar month, `YYYY-MM`. */
const MONTH_SQL = "TO_CHAR(DATE_TRUNC('month', t.transaction_date), 'YYYY-MM')";

/** What an income row is split by so each part converts at its own rate. */
const INCOME_RATE_BASIS = {
  currency: "t.currency_code",
  date: "t.transaction_date",
  originalCurrency: "t.original_currency_code",
  exchangeRate: "t.exchange_rate",
};

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

      // An open period has no frozen actuals: read the budget page's own,
      // converted into the budget's currency, once for the period.
      const openSpending =
        period.status === PeriodStatus.OPEN
          ? await this.periodSpending(userId, budget, period)
          : null;

      for (const pc of cats) {
        const budgeted = Number(pc.budgetedAmount) || 0;
        if (budgeted <= 0) continue;

        let actual = Number(pc.actualAmount) || 0;
        if (openSpending && pc.categoryId) {
          // A category with a row that had no rate has no known actual: it is
          // left out of the score rather than scored on its converted part.
          if (openSpending.incompleteCategoryIds.has(pc.categoryId)) continue;
          actual = categoryExpenseActual(
            openSpending.spendingMap,
            pc.categoryId,
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
    // Each figure leaves rounded once at the budget currency's places
    // (docs/specs/report-rounding-and-aggregation.md section 6).
    const places = await reportPlacesOf(this.dataSource, budget.currencyCode);

    const incomeCategories = (budget.categories || []).filter(
      (bc) => bc.isIncome,
    );
    const expenseCategories = (budget.categories || []).filter(
      (bc) => !bc.isIncome,
    );

    // A transfer income line is an income line too (issue #2141), so a budget
    // whose only income line is one reads its income from its lines, not the
    // all-deposits fallback below, as its summary does (spec section 5).
    const incomeLines = incomeCategories.filter(
      (bc) => bc.categoryId !== null || isTransferIncomeLine(bc),
    );
    // An outgoing line on a Transfer category moves money out of the budget
    // as a per-account outgoing transfer line does, so it is no spending
    // here either (docs/specs/transfer-categories.md section 6.1).
    const spendingLines = [
      ...incomeLines,
      ...expenseCategories.filter(
        (bc) =>
          bc.categoryId !== null &&
          !bc.isTransfer &&
          categoryTypeOfOrUndefined(bc.category) !== "transfer",
      ),
    ];

    const excludedAccountIds = budgetExcludedAccountIds(budget.config);
    const today = new Date();

    // No income categories: the income side is every positive non-transfer
    // transaction of the window, converted into the budget's currency at each
    // row's own rate or the market rate on its date (issue #2155). A month
    // with a foreign row that has no rate is reported incomplete and keeps
    // only its budget-currency income (`convertRatePartAggregates` withholds
    // the month's whole foreign figure); nothing is added 1:1. Each month is
    // one aggregate over its native rows and its converted foreign parts, read
    // once (`docs/specs/report-rounding-and-aggregation.md` rule 2).
    const incomeByMonth = new Map<string, FxAggregate>();
    const foreignIncomeMonths = new Set<string>();
    if (incomeLines.length === 0) {
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
      const { rows, converted } = await withScopedDb(
        this.dataSource,
        async (m) => {
          // Line grain: a split reads its lines, not its net, and its
          // transfer lines are left out (spec split-line-equivalence rules
          // 1, 4 and 5).
          const qb = excludeBudgetAccounts(
            m
              .getRepository(Transaction)
              .createQueryBuilder("t")
              .select(MONTH_SQL, "month")
              .addSelect("t.currency_code", "currencyCode")
              .addSelect(`COALESCE(SUM(${SPLIT_AMOUNT}), 0)`, "total")
              .where("t.user_id = :userId", { userId })
              .andWhere(`${SPLIT_AMOUNT} > 0`)
              .andWhere("t.is_transfer = false")
              .andWhere("t.transaction_date >= :start", { start: rangeStart })
              .andWhere("t.transaction_date <= :end", { end: rangeEnd })
              .andWhere("t.status != :void", { void: "VOID" }),
            excludedAccountIds,
          );
          // An embedded investment line is the trade's cash side, not income.
          joinSplitsForAnalytics(qb)
            .andWhere(investmentLinkedSplitExclusion("ts"))
            .groupBy(MONTH_SQL)
            .addGroupBy("t.currency_code");
          splitByRateBasis(qb, INCOME_RATE_BASIS, budget.currencyCode);
          const parts: RatePartRow[] = await qb.getRawMany();
          return {
            rows: parts,
            converted: await convertRatePartAggregates(
              (sql, params) => m.query(sql, params),
              parts,
              budget.currencyCode,
              (row) => row.month,
              { sums: ["total"], currency: "currencyCode" },
              this.logger,
            ),
          };
        },
      );
      const monthIncome = (month: string): FxAggregate => {
        let agg = incomeByMonth.get(month);
        if (!agg) {
          agg = new FxAggregate();
          incomeByMonth.set(month, agg);
        }
        return agg;
      };
      for (const row of rows) {
        if (row.currencyCode !== budget.currencyCode) continue;
        monthIncome(row.month).addConverted(parseFloat(row.total || "0"));
      }
      for (const [month, figures] of converted) {
        if (figures.total === null) {
          foreignIncomeMonths.add(month);
          continue;
        }
        monthIncome(month).merge(figures.total);
      }
    }

    // The budget page's own actuals in one query over the window, bucketed by
    // month: net within the category, converted into the budget's currency, the
    // budget's excluded accounts left out.
    // With no line on either side the read still runs for the transfers in
    // `config.transfersInAsIncome` counts, on the budget's other lines (it
    // needs one to name the budget); `sumSide` reads `spendingLines` only.
    const queryLines =
      spendingLines.length > 0 || !budgetTransfersInAsIncome(budget.config)
        ? spendingLines
        : budget.categories || [];
    const spendingByMonth =
      queryLines.length > 0
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
                queryLines,
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
                    spending.transferIncomeMap,
                  ),
                ),
            )
          : 0;

      // `config.transfersInAsIncome` adds to either side's income, folded
      // from its aggregate rather than its four-place reading (rule 2).
      const income = new FxAggregate();
      if (incomeLines.length > 0) {
        income.addConverted(sumSide(true));
      } else {
        const native = incomeByMonth.get(monthKey);
        if (native) income.merge(native);
      }
      if (spending) {
        income.merge(resolveOutsideTransferIncomeAggregate(spending));
      }
      const expenses = new FxAggregate();
      expenses.addConverted(sumSide(false));
      const savings = FxAggregate.difference(income, expenses);
      // A ratio of the unrounded figures, rounded once (rule 8), over an
      // income that reads as money: dust that shows as 0 has no rate.
      const savingsRate =
        income.knownSubtotalAt(places) > 0
          ? roundToDecimals(
              (savings.unroundedSubtotal / income.unroundedSubtotal) * 100,
              2,
            )
          : 0;

      result.push({
        monthKey,
        income: income.knownSubtotalAt(places),
        expenses: expenses.knownSubtotalAt(places),
        savings: savings.knownSubtotalAt(places),
        savingsRate,
        valuationComplete:
          !foreignIncomeMonths.has(monthKey) &&
          (spending?.incompleteCategoryIds.size ?? 0) === 0 &&
          (spending?.incompleteTransferIncomeAccountIds.size ?? 0) === 0 &&
          spending?.outsideTransferIncomeComplete !== false,
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

  /**
   * The expense actuals of one period through `queryCategorySpending`: net
   * within each category, converted into the budget's currency at each row's
   * own rate or date, the budget's excluded accounts left out. Before issue
   * #2155 an open period summed raw amounts across currencies.
   */
  private periodSpending(
    userId: string,
    budget: Budget,
    period: BudgetPeriod,
  ): Promise<CategorySpending> {
    const lines = (budget.categories || []).filter(
      (bc) => !bc.isIncome && !bc.isTransfer && bc.categoryId !== null,
    );
    return withScopedDb(this.dataSource, (m) =>
      queryCategorySpending(
        m.getRepository(Transaction),
        m.getRepository(TransactionSplit),
        userId,
        lines,
        period.periodStart,
        period.periodEnd,
      ),
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
