import {
  reportingMoneyMany,
  reportingMoneyOne,
} from "../accruals/reporting-money";
import { ReportingRead } from "../accruals/reporting-basis";
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
import { roundMoney, roundToDecimals, sumMoney } from "../common/round.util";
import {
  budgetExcludedAccountIds,
  excludeBudgetAccounts,
  outgoingParentTransfers,
  outgoingSplitTransfers,
  PARENT_TRANSFER_AMOUNT,
  SPLIT_TRANSFER_AMOUNT,
} from "./budget-spending.util";

@Injectable()
export class BudgetTrendReportsService {
  private readonly logger = new Logger(BudgetTrendReportsService.name);

  constructor(
    private dataSource: DataSource,
    private budgetsService: BudgetsService,
  ) {}

  @ReportingRead()
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

    const result: BudgetTrendPoint[] = [];
    for (const period of periods) {
      const budgeted = Number(period.totalBudgeted) || 0;
      const actual = await this.computePeriodActuals(userId, budget, period);
      const variance = actual - budgeted;
      const percentUsed =
        budgeted > 0 ? roundToDecimals((actual / budgeted) * 100, 2) : 0;

      result.push({
        monthKey: this.formatPeriodMonthKey(period.periodStart),
        budgeted: roundMoney(budgeted),
        actual: roundMoney(actual),
        variance: roundMoney(variance),
        percentUsed,
      });
    }

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
        budgeted > 0
          ? roundToDecimals((currentActuals / budgeted) * 100, 2)
          : 0;

      result.push({
        monthKey: this.formatPeriodMonthKey(currentPeriod.periodStart),
        budgeted: roundMoney(budgeted),
        actual: roundMoney(currentActuals),
        variance: roundMoney(variance),
        percentUsed,
      });
    }

    return result;
  }

  @ReportingRead()
  async getCategoryTrend(
    userId: string,
    budgetId: string,
    months: number,
    categoryIds?: string[],
  ): Promise<CategoryTrendSeries[]> {
    const budget = await this.budgetsService.findOne(userId, budgetId);

    const periods = await withScopedDb(this.dataSource, (m) =>
      m.getRepository(BudgetPeriod).find({
        where: { budgetId: budget.id },
        order: { periodStart: "ASC" },
        take: months,
        relations: [
          "periodCategories",
          "periodCategories.budgetCategory",
          "periodCategories.category",
          "periodCategories.category.parent",
        ],
      }),
    );

    if (periods.length === 0) {
      return this.computeLiveCategoryTrend(userId, budget, months, categoryIds);
    }

    // Build a map of category series
    const seriesMap = new Map<string, CategoryTrendSeries>();

    for (const period of periods) {
      const periodMonthKey = this.formatPeriodMonthKey(period.periodStart);
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
        // Closed periods retain their plan, but actuals follow the selected basis
        // and current source revisions just like open periods.
        const actual = await this.computeCategoryActual(
          userId,
          catId,
          period.periodStart,
          period.periodEnd,
          budget.currencyCode,
          budgetExcludedAccountIds(budget.config),
        );

        const variance = actual - budgeted;
        const percentUsed =
          budgeted > 0 ? roundToDecimals((actual / budgeted) * 100, 2) : 0;

        seriesMap.get(catId)!.data.push({
          monthKey: periodMonthKey,
          budgeted: roundMoney(budgeted),
          actual: roundMoney(actual),
          variance: roundMoney(variance),
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
    return withScopedDb(this.dataSource, (m) =>
      m.getRepository(BudgetPeriod).find({
        where: { budgetId, status: PeriodStatus.CLOSED },
        order: { periodStart: "ASC" },
        take: months,
      }),
    );
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

    const excludedAccountIds = budgetExcludedAccountIds(budget.config);

    // Run all independent queries in parallel
    const queries: Promise<{ total: string } | undefined>[] = [];

    if (categoryIds.length > 0) {
      queries.push(
        withScopedDb(this.dataSource, (m) =>
          reportingMoneyOne(
            m,
            userId,
            excludeBudgetAccounts(
              m
                .getRepository(Transaction)
                .createQueryBuilder("t")
                .select("COALESCE(SUM(t.amount), 0)", "total")
                .where("t.user_id = :userId", { userId })
                .andWhere("t.category_id IN (:...categoryIds)", { categoryIds })
                .andWhere("t.transaction_date >= :start", {
                  start: period.periodStart,
                })
                .andWhere("t.transaction_date <= :end", {
                  end: period.periodEnd,
                })
                .andWhere("t.status != :void", { void: "VOID" })
                .andWhere("t.is_split = false"),
              excludedAccountIds,
            ),
            budget.currencyCode,
            false,
          ),
        ),
      );

      queries.push(
        withScopedDb(this.dataSource, (m) =>
          reportingMoneyOne(
            m,
            userId,
            excludeBudgetAccounts(
              m
                .getRepository(TransactionSplit)
                .createQueryBuilder("s")
                .innerJoin("s.transaction", "t")
                .select("COALESCE(SUM(s.amount), 0)", "total")
                .where("t.user_id = :userId", { userId })
                .andWhere("s.category_id IN (:...categoryIds)", { categoryIds })
                .andWhere("t.transaction_date >= :start", {
                  start: period.periodStart,
                })
                .andWhere("t.transaction_date <= :end", {
                  end: period.periodEnd,
                })
                .andWhere("t.status != :void", { void: "VOID" }),
              excludedAccountIds,
            ),
            budget.currencyCode,
            false,
          ),
        ),
      );
    }

    if (transferAccountIds.length > 0) {
      const window = {
        userId,
        periodStart: period.periodStart,
        periodEnd: period.periodEnd,
        transferAccountIds,
        excludedAccountIds,
      };
      // Both transfer shapes: whole-row transfers and split lines carrying a
      // transfer_account_id (review #1131).
      queries.push(
        withScopedDb(this.dataSource, (m) =>
          reportingMoneyOne(
            m,
            userId,
            excludeBudgetAccounts(
              outgoingParentTransfers(
                m.getRepository(Transaction),
                window,
              ).select(`COALESCE(SUM(${PARENT_TRANSFER_AMOUNT}), 0)`, "total"),
              excludedAccountIds,
            ),
            budget.currencyCode,
            false,
          ),
        ),
      );
      queries.push(
        withScopedDb(this.dataSource, (m) =>
          reportingMoneyOne(
            m,
            userId,
            excludeBudgetAccounts(
              outgoingSplitTransfers(
                m.getRepository(TransactionSplit),
                window,
              ).select(`COALESCE(SUM(${SPLIT_TRANSFER_AMOUNT}), 0)`, "total"),
              excludedAccountIds,
            ),
            budget.currencyCode,
            false,
          ),
        ),
      );
    }

    const results = await Promise.all(queries);
    let total = 0;
    for (const result of results) {
      total += parseFloat(result?.total || "0");
    }

    // All queries return signed sums (expenses and transfers are negative);
    // negate to get positive spending.  Clamp to 0 so net-refund periods
    // don't show negative spending.
    return Math.max(-total, 0);
  }

  private async computeCategoryActual(
    userId: string,
    categoryId: string,
    periodStart: string,
    periodEnd: string,
    currencyCode: string,
    excludedAccountIds: readonly string[],
  ): Promise<number> {
    const [directResult, splitResult] = await Promise.all([
      withScopedDb(this.dataSource, (m) =>
        reportingMoneyOne(
          m,
          userId,
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
          ),
          currencyCode,
          false,
        ),
      ),
      withScopedDb(this.dataSource, (m) =>
        reportingMoneyOne(
          m,
          userId,
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
          ),
          currencyCode,
          false,
        ),
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
    const excludedAccountIds = budgetExcludedAccountIds(budget.config);
    const today = new Date();

    // Compute full date range
    const startD = new Date(
      today.getFullYear(),
      today.getMonth() - (months - 1),
      1,
    );
    const rangeStart = `${startD.getFullYear()}-${String(startD.getMonth() + 1).padStart(2, "0")}-01`;
    const rangeEnd = getMonthEndYMD(today.getFullYear(), today.getMonth() + 1);

    // Batch query: per-category, per-month actuals in 2 parallel queries
    // Map<categoryId, Map<monthKey, amount>>
    const actualMap = new Map<string, Map<string, number>>();

    const [directRows, splitRows] = await Promise.all([
      withScopedDb(this.dataSource, (m) =>
        reportingMoneyMany(
          m,
          userId,
          excludeBudgetAccounts(
            m
              .getRepository(Transaction)
              .createQueryBuilder("t")
              .select("t.category_id", "categoryId")
              .addSelect(
                "TO_CHAR(DATE_TRUNC('month', t.transaction_date), 'YYYY-MM')",
                "month",
              )
              .addSelect("COALESCE(SUM(t.amount), 0)", "total")
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
              ),
            excludedAccountIds,
          ),
          budget.currencyCode,
          false,
        ),
      ),
      withScopedDb(this.dataSource, (m) =>
        reportingMoneyMany(
          m,
          userId,
          excludeBudgetAccounts(
            m
              .getRepository(TransactionSplit)
              .createQueryBuilder("s")
              .innerJoin("s.transaction", "t")
              .select("s.category_id", "categoryId")
              .addSelect(
                "TO_CHAR(DATE_TRUNC('month', t.transaction_date), 'YYYY-MM')",
                "month",
              )
              .addSelect("COALESCE(SUM(s.amount), 0)", "total")
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
              ),
            excludedAccountIds,
          ),
          budget.currencyCode,
          false,
        ),
      ),
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
        const monthKey = formatMonthKey(year, month + 1);

        const budgeted = Number(bc.amount) || 0;
        const actual = Math.max(-(actualMap.get(catId)?.get(monthKey) || 0), 0);
        const variance = actual - budgeted;
        const percentUsed =
          budgeted > 0 ? roundToDecimals((actual / budgeted) * 100, 2) : 0;

        data.push({
          monthKey,
          budgeted: roundMoney(budgeted),
          actual: roundMoney(actual),
          variance: roundMoney(variance),
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

    const totalBudgeted = sumMoney(categories.map((bc) => Number(bc.amount)));
    const excludedAccountIds = budgetExcludedAccountIds(budget.config);

    const today = new Date();

    // Compute full date range
    const startD = new Date(
      today.getFullYear(),
      today.getMonth() - (months - 1),
      1,
    );
    const rangeStart = `${startD.getFullYear()}-${String(startD.getMonth() + 1).padStart(2, "0")}-01`;
    const rangeEnd = getMonthEndYMD(today.getFullYear(), today.getMonth() + 1);

    // Batch queries grouped by month
    const actualByMonth = new Map<string, number>();
    const queries: Promise<void>[] = [];

    if (categoryIds.length > 0) {
      queries.push(
        withScopedDb(this.dataSource, (m) =>
          reportingMoneyMany(
            m,
            userId,
            excludeBudgetAccounts(
              m
                .getRepository(Transaction)
                .createQueryBuilder("t")
                .select(
                  "TO_CHAR(DATE_TRUNC('month', t.transaction_date), 'YYYY-MM')",
                  "month",
                )
                .addSelect("COALESCE(SUM(t.amount), 0)", "total")
                .where("t.user_id = :userId", { userId })
                .andWhere("t.category_id IN (:...categoryIds)", { categoryIds })
                .andWhere("t.transaction_date >= :start", { start: rangeStart })
                .andWhere("t.transaction_date <= :end", { end: rangeEnd })
                .andWhere("t.status != :void", { void: "VOID" })
                .andWhere("t.is_split = false")
                .groupBy(
                  "TO_CHAR(DATE_TRUNC('month', t.transaction_date), 'YYYY-MM')",
                ),
              excludedAccountIds,
            ),
            budget.currencyCode,
            false,
          ).then((rows) => {
            for (const row of rows) {
              actualByMonth.set(
                row.month,
                (actualByMonth.get(row.month) || 0) +
                  parseFloat(row.total || "0"),
              );
            }
          }),
        ),
      );

      queries.push(
        withScopedDb(this.dataSource, (m) =>
          reportingMoneyMany(
            m,
            userId,
            excludeBudgetAccounts(
              m
                .getRepository(TransactionSplit)
                .createQueryBuilder("s")
                .innerJoin("s.transaction", "t")
                .select(
                  "TO_CHAR(DATE_TRUNC('month', t.transaction_date), 'YYYY-MM')",
                  "month",
                )
                .addSelect("COALESCE(SUM(s.amount), 0)", "total")
                .where("t.user_id = :userId", { userId })
                .andWhere("s.category_id IN (:...categoryIds)", { categoryIds })
                .andWhere("t.transaction_date >= :start", { start: rangeStart })
                .andWhere("t.transaction_date <= :end", { end: rangeEnd })
                .andWhere("t.status != :void", { void: "VOID" })
                .groupBy(
                  "TO_CHAR(DATE_TRUNC('month', t.transaction_date), 'YYYY-MM')",
                ),
              excludedAccountIds,
            ),
            budget.currencyCode,
            false,
          ).then((rows) => {
            for (const row of rows) {
              actualByMonth.set(
                row.month,
                (actualByMonth.get(row.month) || 0) +
                  parseFloat(row.total || "0"),
              );
            }
          }),
        ),
      );
    }

    if (transferAccountIds.length > 0) {
      const window = {
        userId,
        periodStart: rangeStart,
        periodEnd: rangeEnd,
        transferAccountIds,
        excludedAccountIds,
      };
      const collectMonthly = (
        rows: Array<{ month: string; total: string }>,
      ) => {
        for (const row of rows) {
          actualByMonth.set(
            row.month,
            (actualByMonth.get(row.month) || 0) + parseFloat(row.total || "0"),
          );
        }
      };
      // Both transfer shapes: whole-row transfers and split lines carrying a
      // transfer_account_id (review #1131).
      queries.push(
        withScopedDb(this.dataSource, (m) =>
          reportingMoneyMany(
            m,
            userId,
            excludeBudgetAccounts(
              outgoingParentTransfers(m.getRepository(Transaction), window)
                .select(
                  "TO_CHAR(DATE_TRUNC('month', t.transaction_date), 'YYYY-MM')",
                  "month",
                )
                .addSelect(
                  `COALESCE(SUM(${PARENT_TRANSFER_AMOUNT}), 0)`,
                  "total",
                )
                .groupBy(
                  "TO_CHAR(DATE_TRUNC('month', t.transaction_date), 'YYYY-MM')",
                ),
              excludedAccountIds,
            ),
            budget.currencyCode,
            false,
          ).then(collectMonthly),
        ),
      );
      queries.push(
        withScopedDb(this.dataSource, (m) =>
          reportingMoneyMany(
            m,
            userId,
            excludeBudgetAccounts(
              outgoingSplitTransfers(m.getRepository(TransactionSplit), window)
                .select(
                  "TO_CHAR(DATE_TRUNC('month', t.transaction_date), 'YYYY-MM')",
                  "month",
                )
                .addSelect(
                  `COALESCE(SUM(${SPLIT_TRANSFER_AMOUNT}), 0)`,
                  "total",
                )
                .groupBy(
                  "TO_CHAR(DATE_TRUNC('month', t.transaction_date), 'YYYY-MM')",
                ),
              excludedAccountIds,
            ),
            budget.currencyCode,
            false,
          ).then(collectMonthly),
        ),
      );
    }

    await Promise.all(queries);

    // Build result from aggregated monthly data
    const result: BudgetTrendPoint[] = [];

    for (let i = months - 1; i >= 0; i--) {
      const d = new Date(today.getFullYear(), today.getMonth() - i, 1);
      const year = d.getFullYear();
      const month = d.getMonth();
      const monthKey = formatMonthKey(year, month + 1);

      const actual = Math.max(-(actualByMonth.get(monthKey) || 0), 0);
      const variance = actual - totalBudgeted;
      const percentUsed =
        totalBudgeted > 0
          ? roundToDecimals((actual / totalBudgeted) * 100, 2)
          : 0;

      result.push({
        monthKey,
        budgeted: roundMoney(totalBudgeted),
        actual: roundMoney(actual),
        variance: roundMoney(variance),
        percentUsed,
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
