import { Injectable, Logger } from "@nestjs/common";
import { DataSource } from "typeorm";
import { withScopedDb } from "../common/db/scoped-db";
import { Budget } from "./entities/budget.entity";
import { BudgetPeriod, PeriodStatus } from "./entities/budget-period.entity";
import { formatMonthKey, getMonthEndYMD } from "../common/date-utils";
import { Transaction } from "../transactions/entities/transaction.entity";
import { TransactionSplit } from "../transactions/entities/transaction-split.entity";
import { BudgetsService } from "./budgets.service";
import {
  BudgetTrendPoint,
  CategoryTrendSeries,
} from "./budget-reports.service";
import { roundToDecimals, sumMoney } from "../common/round.util";
import { reportFigure, reportPlacesOf } from "../common/report-figure";
import {
  CategorySpending,
  categoryExpenseActual,
  queryCategorySpending,
  queryCategorySpendingBuckets,
  resolveCategorySpent,
} from "./budget-spending.util";
import { BudgetCategory } from "./entities/budget-category.entity";

/**
 * Whether one category's figure in `spending` is complete and, when it is not,
 * the pairs with no rate, so the reader learns what to add.
 */
function lineCompleteness(
  spending: CategorySpending,
  categoryId: string,
): { valuationComplete: boolean; missingRatePairs: string[] } {
  const complete = !spending.incompleteCategoryIds.has(categoryId);
  return {
    valuationComplete: complete,
    missingRatePairs: complete ? [] : spending.missingRatePairs,
  };
}

/** Signed expense actual plus outgoing transfer funding for one period. */
function netExpenseActual(
  lines: readonly BudgetCategory[],
  spending: CategorySpending,
): { actual: number; complete: boolean } {
  const categoryIds = new Set(
    lines
      .filter((bc) => bc.categoryId !== null && !bc.isTransfer)
      .map((bc) => bc.categoryId as string),
  );
  const destinations = new Set(
    lines
      .filter((bc) => bc.isTransfer && bc.transferAccountId && !bc.isIncome)
      .map((bc) => bc.transferAccountId as string),
  );
  const net = sumMoney([
    ...[...categoryIds].map((id) =>
      categoryExpenseActual(spending.spendingMap, id),
    ),
    ...[...destinations].map((id) => spending.transferSpendingMap.get(id) ?? 0),
  ]);
  const complete =
    ![...categoryIds].some((id) => spending.incompleteCategoryIds.has(id)) &&
    ![...destinations].some((id) =>
      spending.incompleteTransferAccountIds.has(id),
    );
  return { actual: net, complete };
}

@Injectable()
export class BudgetTrendReportsService {
  private readonly logger = new Logger(BudgetTrendReportsService.name);

  constructor(
    private dataSource: DataSource,
    private budgetsService: BudgetsService,
  ) {}

  async getTrend(
    userId: string,
    budgetId: string,
    months: number,
  ): Promise<BudgetTrendPoint[]> {
    const budget = await this.budgetsService.findOne(userId, budgetId);
    // Each figure leaves rounded once at the budget currency's places
    // (docs/specs/report-rounding-and-aggregation.md section 6).
    const places = await reportPlacesOf(this.dataSource, budget.currencyCode);

    const periods = await this.getClosedPeriods(budget.id, months);

    if (periods.length === 0) {
      return this.computeLiveTrendFromTransactions(
        userId,
        budget,
        months,
        places,
      );
    }

    const result: BudgetTrendPoint[] = periods.map((period) => {
      const budgeted = Number(period.totalBudgeted) || 0;
      const actual = Number(period.actualExpenses) || 0;
      const variance = actual - budgeted;
      const percentUsed =
        budgeted > 0 ? roundToDecimals((actual / budgeted) * 100, 2) : 0;

      return {
        monthKey: this.formatPeriodMonthKey(period.periodStart),
        budgeted: reportFigure(budgeted, places),
        actual: reportFigure(actual, places),
        variance: reportFigure(variance, places),
        percentUsed,
      };
    });

    // Add current open period if it exists
    const currentPeriod = await this.getCurrentOpenPeriod(budget.id);
    if (currentPeriod) {
      const expenseLines = (budget.categories || []).filter(
        (bc) => !bc.isIncome,
      );
      const currentSpending = await this.periodSpending(
        userId,
        expenseLines,
        currentPeriod,
      );
      const current = netExpenseActual(expenseLines, currentSpending);
      const budgeted = Number(currentPeriod.totalBudgeted) || 0;
      const variance = current.actual - budgeted;
      const percentUsed =
        budgeted > 0
          ? roundToDecimals((current.actual / budgeted) * 100, 2)
          : 0;

      result.push({
        monthKey: this.formatPeriodMonthKey(currentPeriod.periodStart),
        budgeted: reportFigure(budgeted, places),
        actual: reportFigure(current.actual, places),
        variance: reportFigure(variance, places),
        percentUsed,
        valuationComplete: current.complete,
        missingRatePairs: current.complete
          ? []
          : currentSpending.missingRatePairs,
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
    const places = await reportPlacesOf(this.dataSource, budget.currencyCode);

    // The newest `months` periods, read newest first so `take` keeps the
    // latest rather than the earliest, then put back in calendar order.
    const newestFirst = await withScopedDb(this.dataSource, (m) =>
      m.getRepository(BudgetPeriod).find({
        where: { budgetId: budget.id },
        order: { periodStart: "DESC" },
        take: months,
        relations: [
          "periodCategories",
          "periodCategories.budgetCategory",
          "periodCategories.category",
          "periodCategories.category.parent",
        ],
      }),
    );
    const periods = [...newestFirst].reverse();

    if (periods.length === 0) {
      return this.computeLiveCategoryTrend(
        userId,
        budget,
        months,
        places,
        categoryIds,
      );
    }

    // Build a map of category series
    const seriesMap = new Map<string, CategoryTrendSeries>();
    const expenseLines = (budget.categories || []).filter(
      (bc) => !bc.isIncome && !bc.isTransfer && bc.categoryId !== null,
    );

    for (const period of periods) {
      const periodMonthKey = this.formatPeriodMonthKey(period.periodStart);
      const cats = period.periodCategories || [];
      // An open period has no frozen actuals: one converted read for it.
      const openSpending =
        period.status === PeriodStatus.OPEN
          ? await this.periodSpending(userId, expenseLines, period)
          : null;

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
        // A closed period's frozen actual carries no completeness either way.
        let completeness:
          | { valuationComplete: boolean; missingRatePairs: string[] }
          | undefined;

        if (openSpending) {
          actual = categoryExpenseActual(openSpending.spendingMap, catId);
          completeness = lineCompleteness(openSpending, catId);
        }

        const variance = actual - budgeted;
        const percentUsed =
          budgeted > 0 ? roundToDecimals((actual / budgeted) * 100, 2) : 0;

        seriesMap.get(catId)!.data.push({
          monthKey: periodMonthKey,
          budgeted: reportFigure(budgeted, places),
          actual: reportFigure(actual, places),
          variance: reportFigure(variance, places),
          percentUsed,
          ...(completeness ?? {}),
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
    // Newest first so `take` keeps the latest closed periods, then returned
    // in calendar order.
    const newestFirst = await withScopedDb(this.dataSource, (m) =>
      m.getRepository(BudgetPeriod).find({
        where: { budgetId, status: PeriodStatus.CLOSED },
        order: { periodStart: "DESC" },
        take: months,
      }),
    );
    return [...newestFirst].reverse();
  }

  private async getCurrentOpenPeriod(
    budgetId: string,
  ): Promise<BudgetPeriod | null> {
    return withScopedDb(this.dataSource, (m) =>
      m.getRepository(BudgetPeriod).findOne({
        where: { budgetId, status: PeriodStatus.OPEN },
      }),
    );
  }

  /**
   * One period's actuals for `lines` through `queryCategorySpending`, the
   * budget page's own read: converted into the budget's currency at each
   * row's own rate or date, the budget's excluded accounts left out. Before
   * issue #2155 these sums added raw amounts across currencies.
   */
  private periodSpending(
    userId: string,
    lines: BudgetCategory[],
    period: BudgetPeriod,
  ): Promise<CategorySpending> {
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

  /** `lines`' actuals over a window, bucketed by `YYYY-MM`. */
  private async monthlySpending(
    userId: string,
    lines: BudgetCategory[],
    rangeStart: string,
    rangeEnd: string,
  ): Promise<Map<string, CategorySpending>> {
    const { buckets } = await withScopedDb(this.dataSource, (m) =>
      queryCategorySpendingBuckets(
        m.getRepository(Transaction),
        m.getRepository(TransactionSplit),
        userId,
        lines,
        rangeStart,
        rangeEnd,
        (txDate) => txDate.slice(0, 7),
      ),
    );
    return buckets;
  }

  private async computeLiveCategoryTrend(
    userId: string,
    budget: Budget,
    months: number,
    places: number,
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

    // Compute full date range
    const startD = new Date(
      today.getFullYear(),
      today.getMonth() - (months - 1),
      1,
    );
    const rangeStart = `${startD.getFullYear()}-${String(startD.getMonth() + 1).padStart(2, "0")}-01`;
    const rangeEnd = getMonthEndYMD(today.getFullYear(), today.getMonth() + 1);

    // One converted read over the window, bucketed by month.
    const byMonth = await this.monthlySpending(
      userId,
      filtered,
      rangeStart,
      rangeEnd,
    );

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
        const monthKey = formatMonthKey(year, month + 1);

        const budgeted = Number(bc.amount) || 0;
        const spending = byMonth.get(monthKey);
        const actual = spending
          ? resolveCategorySpent(
              bc,
              spending.spendingMap,
              spending.transferSpendingMap,
              spending.transferIncomeMap,
            )
          : 0;
        const variance = actual - budgeted;
        const percentUsed =
          budgeted > 0 ? roundToDecimals((actual / budgeted) * 100, 2) : 0;

        data.push({
          monthKey,
          budgeted: reportFigure(budgeted, places),
          actual: reportFigure(actual, places),
          variance: reportFigure(variance, places),
          percentUsed,
          ...(spending
            ? lineCompleteness(spending, catId)
            : { valuationComplete: true, missingRatePairs: [] }),
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
    places: number,
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

    const totalBudgeted = sumMoney(categories.map((bc) => Number(bc.amount)));
    const today = new Date();

    // Compute full date range
    const startD = new Date(
      today.getFullYear(),
      today.getMonth() - (months - 1),
      1,
    );
    const rangeStart = `${startD.getFullYear()}-${String(startD.getMonth() + 1).padStart(2, "0")}-01`;
    const rangeEnd = getMonthEndYMD(today.getFullYear(), today.getMonth() + 1);

    // One converted read over the window, bucketed by month.
    const byMonth = await this.monthlySpending(
      userId,
      categories,
      rangeStart,
      rangeEnd,
    );

    // Build result from aggregated monthly data
    const result: BudgetTrendPoint[] = [];

    for (let i = months - 1; i >= 0; i--) {
      const d = new Date(today.getFullYear(), today.getMonth() - i, 1);
      const year = d.getFullYear();
      const month = d.getMonth();
      const monthKey = formatMonthKey(year, month + 1);

      const spending = byMonth.get(monthKey);
      const { actual, complete } = spending
        ? netExpenseActual(categories, spending)
        : { actual: 0, complete: true };
      const variance = actual - totalBudgeted;
      const percentUsed =
        totalBudgeted > 0
          ? roundToDecimals((actual / totalBudgeted) * 100, 2)
          : 0;

      result.push({
        monthKey,
        budgeted: reportFigure(totalBudgeted, places),
        actual: reportFigure(actual, places),
        variance: reportFigure(variance, places),
        percentUsed,
        valuationComplete: complete,
        missingRatePairs:
          complete || !spending ? [] : spending.missingRatePairs,
      });
    }

    return result;
  }

  private formatPeriodMonthKey(periodStart: string): string {
    const parts = periodStart.split("-");
    const year = parseInt(parts[0], 10);
    const month = parseInt(parts[1], 10);
    return formatMonthKey(year, month);
  }
}
