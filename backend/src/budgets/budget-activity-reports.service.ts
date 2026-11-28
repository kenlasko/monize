import { Injectable, Logger } from "@nestjs/common";
import { DataSource } from "typeorm";
import { withScopedDb } from "../common/db/scoped-db";
import { BudgetCategory } from "./entities/budget-category.entity";
import { BudgetPeriod, PeriodStatus } from "./entities/budget-period.entity";
import { Transaction } from "../transactions/entities/transaction.entity";
import { TransactionSplit } from "../transactions/entities/transaction-split.entity";
import { BudgetsService, lineUnknownPairs } from "./budgets.service";
import {
  SeasonalPattern,
  FlexGroupStatusResult,
} from "./budget-reports.service";
import { formatDateYMD } from "../common/date-utils";
import {
  queryCategorySpendingBuckets,
  resolveCategorySpent,
} from "./budget-spending.util";
import { queryMonthlyCategorySpent } from "./budget-monthly-spending.util";
import { enumerateDaysYMD } from "../net-worth/series-dates.util";
import { roundToDecimals, sumMoney } from "../common/round.util";
import { reportFigure, reportPlacesOf } from "../common/report-figure";

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
    private dataSource: DataSource,
    private budgetsService: BudgetsService,
  ) {}

  async getSeasonalPatterns(
    userId: string,
    budgetId: string,
  ): Promise<SeasonalPattern[]> {
    const budget = await this.budgetsService.findOne(userId, budgetId);
    // Each figure leaves rounded once at the budget currency's places
    // (docs/specs/report-rounding-and-aggregation.md section 6).
    const places = await reportPlacesOf(this.dataSource, budget.currencyCode);

    const categories = (budget.categories || []).filter((bc) => !bc.isIncome);
    const categoryIds = categories
      .filter((bc) => bc.categoryId !== null)
      .map((bc) => bc.categoryId as string);

    if (categoryIds.length === 0) {
      return [];
    }

    // Net, converted and account-filtered like the budget page, per month.
    const { byCategory: spendingMap, incompleteCategoryIds } =
      await withScopedDb(this.dataSource, (m) =>
        queryMonthlyCategorySpent(
          m,
          userId,
          categories.filter((bc) => !bc.isTransfer),
        ),
      );

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
          average: reportFigure(avg, places),
        });
      }

      const nonZero = amounts.filter((a) => a > 0);
      const mean = nonZero.length > 0 ? sumMoney(nonZero) / nonZero.length : 0;
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
        typicalMonthlySpend: reportFigure(mean, places),
        valuationComplete: !incompleteCategoryIds.has(catId),
      });
    }

    return results;
  }

  async getDailySpending(
    userId: string,
    budgetId: string,
  ): Promise<
    Array<{ date: string; amount: number; valuationComplete: boolean }>
  > {
    const budget = await this.budgetsService.findOne(userId, budgetId);
    const places = await reportPlacesOf(this.dataSource, budget.currencyCode);

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
    if (categories.length === 0) return [];

    // One query over the period, bucketed by day: net within each category,
    // converted at the row's own date, the budget's excluded accounts left out.
    // A day with a row that had no rate carries what converted and says so.
    const days = await withScopedDb(this.dataSource, async (m) => {
      const { buckets } = await queryCategorySpendingBuckets(
        m.getRepository(Transaction),
        m.getRepository(TransactionSplit),
        userId,
        categories,
        periodStart,
        periodEnd,
        (txDate) => txDate,
      );
      const out: Array<{ date: string; amount: number; complete: boolean }> =
        [];
      for (const date of enumerateDaysYMD(periodStart, periodEnd)) {
        const spending = buckets.get(date);
        if (!spending) continue;
        const complete =
          spending.incompleteCategoryIds.size === 0 &&
          spending.incompleteTransferAccountIds.size === 0;
        out.push({
          date,
          amount: reportFigure(
            sumMoney(
              categories.map((bc) =>
                resolveCategorySpent(
                  bc,
                  spending.spendingMap,
                  spending.transferSpendingMap,
                  spending.transferIncomeMap,
                ),
              ),
            ),
            places,
          ),
          complete,
        });
      }
      return out;
    });

    return days.map(({ date, amount, complete }) => ({
      date,
      amount,
      valuationComplete: complete,
    }));
  }

  async getFlexGroupStatus(
    userId: string,
    budgetId: string,
  ): Promise<FlexGroupStatusResult[]> {
    const summary = await this.budgetsService.getSummary(userId, budgetId);
    const budget = summary.budget;
    const places = await reportPlacesOf(this.dataSource, budget.currencyCode);

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
        valuationComplete: boolean;
        budgetedComplete: boolean;
        pairs: Set<string>;
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
          valuationComplete: true,
          budgetedComplete: true,
          pairs: new Set(),
          categories: [],
        });
      }

      const group = groupMap.get(flexGroup)!;
      group.totalBudgeted += cat.budgeted;
      group.totalSpent += cat.spent;
      if (!cat.valuationComplete) group.valuationComplete = false;
      if (!cat.budgetedComplete) group.budgetedComplete = false;
      for (const pair of lineUnknownPairs(cat)) group.pairs.add(pair);
      group.categories.push({
        categoryId: cat.categoryId || "",
        categoryName: cat.categoryName,
        budgeted: reportFigure(cat.budgeted, places),
        spent: reportFigure(cat.spent, places),
        percentUsed: cat.percentUsed,
        valuationComplete: cat.valuationComplete,
        budgetedComplete: cat.budgetedComplete,
        missingRatePairs: lineUnknownPairs(cat),
      });
    }

    const results: FlexGroupStatusResult[] = [];

    for (const [groupName, data] of groupMap.entries()) {
      const remaining = data.totalBudgeted - data.totalSpent;
      const percentUsed =
        data.totalBudgeted > 0
          ? roundToDecimals((data.totalSpent / data.totalBudgeted) * 100, 2)
          : 0;
      // The spent total needs every member's spent; what is left and the
      // percent also need the budget ("A subtotal is not a total").
      const figuresKnown = data.valuationComplete && data.budgetedComplete;

      results.push({
        groupName,
        totalBudgeted: reportFigure(data.totalBudgeted, places),
        totalSpent: data.valuationComplete
          ? reportFigure(data.totalSpent, places)
          : null,
        knownTotalSpent: reportFigure(data.totalSpent, places),
        remaining: figuresKnown ? reportFigure(remaining, places) : null,
        percentUsed: figuresKnown ? percentUsed : null,
        valuationComplete: data.valuationComplete,
        budgetedComplete: data.budgetedComplete,
        missingRatePairs: [...data.pairs].sort(),
        categories: data.categories,
      });
    }

    // Sort by percentUsed descending; a group with no percent goes last.
    results.sort(
      (a, b) =>
        Number(b.percentUsed !== null) - Number(a.percentUsed !== null) ||
        (b.percentUsed ?? 0) - (a.percentUsed ?? 0),
    );

    return results;
  }

  // --- Private helpers ---

  private async getCurrentOpenPeriod(
    budgetId: string,
  ): Promise<BudgetPeriod | null> {
    return withScopedDb(this.dataSource, (m) =>
      m.getRepository(BudgetPeriod).findOne({
        where: { budgetId, status: PeriodStatus.OPEN },
      }),
    );
  }

  private standardDeviation(values: number[]): number {
    if (values.length <= 1) return 0;
    const avg = values.reduce((s, v) => s + v, 0) / values.length;
    const squaredDiffs = values.map((v) => (v - avg) ** 2);
    const variance = squaredDiffs.reduce((s, v) => s + v, 0) / values.length;
    return Math.sqrt(variance);
  }
}
