import { Injectable, Logger } from "@nestjs/common";
import { DataSource } from "typeorm";
import { withScopedDb } from "../common/db/scoped-db";
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
import { queryCategorySpendingBuckets } from "./budget-spending.util";
import { queryMonthlyCategorySpent } from "./budget-monthly-spending.util";
import { enumerateDaysYMD } from "../net-worth/series-dates.util";
import { roundMoney, roundToDecimals, sumMoney } from "../common/round.util";

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
          average: roundMoney(avg),
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
        typicalMonthlySpend: roundMoney(mean),
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
          amount: roundMoney(
            sumMoney(
              categories.map((bc) =>
                // Signed net, not the clamped `resolveCategorySpent`: a refund
                // day is negative so the days sum to the period net the budget
                // page shows.
                bc.isTransfer && bc.transferAccountId
                  ? spending.transferSpendingMap.get(bc.transferAccountId) || 0
                  : -(bc.categoryId
                      ? spending.spendingMap.get(bc.categoryId) || 0
                      : 0),
              ),
            ),
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
          ? roundToDecimals((data.totalSpent / data.totalBudgeted) * 100, 2)
          : 0;

      results.push({
        groupName,
        totalBudgeted: roundMoney(data.totalBudgeted),
        totalSpent: roundMoney(data.totalSpent),
        remaining: roundMoney(remaining),
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
