import { Injectable, BadRequestException } from "@nestjs/common";
import { tr } from "../i18n/translate";
import { In, DataSource } from "typeorm";
import { withScopedDb } from "../common/db/scoped-db";
import { Transaction } from "../transactions/entities/transaction.entity";
import { TransactionSplit } from "../transactions/entities/transaction-split.entity";
import { Category } from "../categories/entities/category.entity";
import { Budget } from "./entities/budget.entity";
import { BudgetCategory } from "./entities/budget-category.entity";
import {
  BudgetBucket,
  BudgetBucketTargetType,
} from "./entities/budget-bucket.entity";
import {
  MAX_BUCKETS_PER_BUDGET,
  checkBucketTarget,
  checkedBucketCarryCap,
  checkedBucketName,
} from "./budget-bucket-rules.util";
import { GenerateBudgetDto, BudgetProfile } from "./dto/generate-budget.dto";
import { ApplyGeneratedBudgetDto } from "./dto/apply-generated-budget.dto";
import { roundMoney, sumMoney } from "../common/round.util";
import {
  incomingParentTransfers,
  incomingSplitTransfers,
  outgoingParentTransfers,
  outgoingSplitTransfers,
  PARENT_TRANSFER_AMOUNT,
  SPLIT_TRANSFER_AMOUNT,
} from "./budget-spending.util";
import {
  assertOneTransferLinePerAccount,
  assertTransferAccountsOwned,
} from "./budget-transfer-lines.util";

export interface CategoryAnalysis {
  categoryId: string;
  categoryName: string;
  isIncome: boolean;
  average: number;
  median: number;
  p25: number;
  p75: number;
  min: number;
  max: number;
  stdDev: number;
  monthlyAmounts: number[];
  monthlyOccurrences: number;
  isFixed: boolean;
  seasonalMonths: number[];
  suggested: number;
}

export interface TransferAnalysis {
  accountId: string;
  accountName: string;
  accountType: string;
  average: number;
  median: number;
  p25: number;
  p75: number;
  min: number;
  max: number;
  stdDev: number;
  monthlyAmounts: number[];
  monthlyOccurrences: number;
  isFixed: boolean;
  seasonalMonths: number[];
  suggested: number;
}

export interface GenerateBudgetResult {
  categories: CategoryAnalysis[];
  transfers: TransferAnalysis[];
  /**
   * Per source account, the monthly net of the transfers in from it, for a
   * transfer income line (issue #2141). Not in `estimatedMonthlyIncome`: only
   * the user knows which source is a reserve.
   */
  incomeTransfers: TransferAnalysis[];
  estimatedMonthlyIncome: number;
  totalBudgeted: number;
  totalTransfers: number;
  projectedMonthlySavings: number;
  analysisWindow: {
    startDate: string;
    endDate: string;
    months: number;
  };
}

@Injectable()
export class BudgetGeneratorService {
  constructor(private dataSource: DataSource) {}

  async generate(
    userId: string,
    dto: GenerateBudgetDto,
  ): Promise<GenerateBudgetResult> {
    const { analysisMonths, profile = BudgetProfile.ON_TRACK } = dto;

    const endDate = new Date();
    const startDate = new Date();
    startDate.setMonth(startDate.getMonth() - analysisMonths);

    const startDateStr = this.formatDate(startDate);
    const endDateStr = this.formatDate(endDate);

    const spending = await this.getSpendingByCategory(
      userId,
      startDateStr,
      endDateStr,
      analysisMonths,
      false,
    );

    const income = await this.getSpendingByCategory(
      userId,
      startDateStr,
      endDateStr,
      analysisMonths,
      true,
    );

    const expenseAnalysis = spending.map((cat) => ({
      ...cat,
      suggested: this.getSuggestedAmount(cat, profile),
    }));

    const incomeAnalysis = income.map((cat) => ({
      ...cat,
      suggested: this.getSuggestedAmount(cat, profile),
    }));

    // Deduplicate: a category may appear in both income & expense results
    // (e.g. refunds in an expense category). For expense categories the
    // expense query is authoritative; for income categories the income
    // query is authoritative.
    const categoryMap = new Map<string, CategoryAnalysis>();

    for (const cat of incomeAnalysis) {
      categoryMap.set(cat.categoryId, cat);
    }

    for (const cat of expenseAnalysis) {
      const existing = categoryMap.get(cat.categoryId);
      if (!existing || !cat.isIncome) {
        // New category, or an expense category — the expense query is
        // the authoritative source for expense categories.
        categoryMap.set(cat.categoryId, cat);
      }
    }
    const allCategories = Array.from(categoryMap.values());

    const transferAnalysisRaw = await this.getTransfersByDestination(
      userId,
      startDateStr,
      endDateStr,
      analysisMonths,
    );

    const transfers: TransferAnalysis[] = transferAnalysisRaw.map((t) => ({
      ...t,
      suggested: this.getSuggestedAmountFromStats(t, profile),
    }));

    const incomeTransfers: TransferAnalysis[] = (
      await this.getTransfersBySource(
        userId,
        startDateStr,
        endDateStr,
        analysisMonths,
      )
    ).map((t) => ({
      ...t,
      suggested: this.getSuggestedAmountFromStats(t, profile),
    }));

    const estimatedMonthlyIncome =
      incomeAnalysis.length > 0
        ? sumMoney(incomeAnalysis.map((i) => i.median))
        : 0;

    const totalBudgeted = sumMoney(expenseAnalysis.map((c) => c.suggested));

    const totalTransfers = sumMoney(transfers.map((t) => t.suggested));

    return {
      categories: allCategories,
      transfers,
      incomeTransfers,
      estimatedMonthlyIncome,
      totalBudgeted,
      totalTransfers,
      projectedMonthlySavings: roundMoney(
        estimatedMonthlyIncome - totalBudgeted - totalTransfers,
      ),
      analysisWindow: {
        startDate: startDateStr,
        endDate: endDateStr,
        months: analysisMonths,
      },
    };
  }

  /**
   * The whole apply is one `withScopedDb` transaction: the request's own
   * rules (one transfer line per account, a transfer income line naming one
   * of the user's accounts, issue #2141; the bucket rules) and the category
   * ownership check first, then the budget row, its
   * buckets, and its lines with each `bucketKey` resolved to the new bucket's
   * id. A refusal anywhere leaves nothing written (design 6.6).
   */
  async apply(userId: string, dto: ApplyGeneratedBudgetDto): Promise<Budget> {
    return withScopedDb(this.dataSource, async (m) => {
      const lines = dto.categories ?? [];
      const transferLines = lines.filter((cat) => cat.transferAccountId);
      assertOneTransferLinePerAccount(
        transferLines.map((cat) => cat.transferAccountId as string),
      );
      const incomeSources = transferLines
        .filter((cat) => cat.isIncome)
        .map((cat) => cat.transferAccountId as string);
      if (incomeSources.length > 0) {
        await assertTransferAccountsOwned(m, userId, incomeSources);
      }

      const buckets = this.checkedRequestBuckets(dto);
      const knownKeys = new Set(buckets.map((b) => b.key));
      for (const cat of lines) {
        if (cat.bucketKey === undefined) continue;
        if (cat.isIncome) {
          throw new BadRequestException(
            tr(
              "errors.budgets.bucketOnIncomeLine",
              "An income line cannot belong to a bucket",
            ),
          );
        }
        if (!knownKeys.has(cat.bucketKey)) {
          throw new BadRequestException(
            tr(
              "errors.budgets.bucketKeyUnknown",
              `No bucket in this request has the key "${cat.bucketKey}"`,
              { key: cat.bucketKey },
            ),
          );
        }
      }

      // M27: Validate that all categoryIds belong to the user
      const categoryIds = lines
        .filter((cat) => cat.categoryId && !cat.transferAccountId)
        .map((cat) => cat.categoryId as string);
      if (categoryIds.length > 0) {
        const uniqueIds = [...new Set(categoryIds)];
        const ownedCategories = await m.getRepository(Category).find({
          where: { id: In(uniqueIds), userId },
          select: ["id"],
        });
        const ownedIds = new Set(ownedCategories.map((c) => c.id));
        const invalidIds = uniqueIds.filter((id) => !ownedIds.has(id));
        if (invalidIds.length > 0) {
          throw new BadRequestException(
            tr(
              "errors.budgets.categoryIdsNotOwned",
              `Category IDs not found or not owned by user: ${invalidIds.join(", ")}`,
              { ids: invalidIds.join(", ") },
            ),
          );
        }
      }

      const budgetRepo = m.getRepository(Budget);
      const savedBudget = await budgetRepo.save(
        budgetRepo.create({
          userId,
          name: dto.name,
          description: dto.description ?? null,
          budgetType: dto.budgetType,
          periodStart: dto.periodStart,
          periodEnd: dto.periodEnd ?? null,
          baseIncome: dto.baseIncome ?? null,
          incomeLinked: dto.incomeLinked ?? false,
          strategy: dto.strategy,
          isActive: true,
          currencyCode: dto.currencyCode,
          config: dto.config ?? {},
        }),
      );

      const bucketIds = new Map<string, string>();
      if (buckets.length > 0) {
        const bucketRepo = m.getRepository(BudgetBucket);
        const savedBuckets = await bucketRepo.save(
          buckets.map((b, i) =>
            bucketRepo.create({
              budgetId: savedBudget.id,
              name: b.name,
              targetType: b.targetType,
              targetValue: b.targetValue,
              carryOver: b.carryOver,
              carryCap: b.carryCap,
              sortOrder: b.sortOrder ?? i,
            }),
          ),
        );
        buckets.forEach((b, i) => bucketIds.set(b.key, savedBuckets[i].id));
      }

      if (lines.length > 0) {
        const lineRepo = m.getRepository(BudgetCategory);
        await lineRepo.save(
          lines.map((cat) =>
            lineRepo.create({
              budgetId: savedBudget.id,
              categoryId: cat.transferAccountId
                ? null
                : (cat.categoryId ?? null),
              transferAccountId: cat.transferAccountId ?? null,
              isTransfer: !!cat.transferAccountId,
              amount: cat.amount,
              isIncome: cat.isIncome ?? false,
              categoryGroup: cat.categoryGroup ?? null,
              rolloverType: cat.rolloverType,
              rolloverCap: cat.rolloverCap ?? null,
              flexGroup: cat.flexGroup ?? null,
              alertWarnPercent: cat.alertWarnPercent ?? 80,
              alertCriticalPercent: cat.alertCriticalPercent ?? 95,
              notes: cat.notes ?? null,
              sortOrder: cat.sortOrder ?? 0,
              ...(cat.bucketKey !== undefined
                ? { bucketId: bucketIds.get(cat.bucketKey) }
                : {}),
            }),
          ),
        );
      }

      return (await budgetRepo.findOne({
        where: { id: savedBudget.id },
        relations: [
          "categories",
          "categories.category",
          "categories.transferAccount",
          "buckets",
        ],
        order: { buckets: { sortOrder: "ASC", name: "ASC" } },
      })) as Budget;
    });
  }

  /**
   * The request's buckets with every `BudgetBucketsService` rule applied
   * (shared pure functions) plus the key rule; nothing here touches the
   * database.
   */
  private checkedRequestBuckets(dto: ApplyGeneratedBudgetDto): Array<{
    key: string;
    name: string;
    targetType: BudgetBucketTargetType;
    targetValue: number;
    carryOver: boolean;
    carryCap: number | null;
    sortOrder?: number;
  }> {
    const requested = dto.buckets ?? [];
    if (requested.length > MAX_BUCKETS_PER_BUDGET) {
      throw new BadRequestException(
        tr(
          "errors.budgets.bucketLimit",
          `A budget can have at most ${MAX_BUCKETS_PER_BUDGET} buckets`,
          { max: MAX_BUCKETS_PER_BUDGET },
        ),
      );
    }
    const keys = new Set<string>();
    const accepted: Array<{ name: string }> = [];
    return requested.map((b) => {
      if (keys.has(b.key)) {
        throw new BadRequestException(
          tr(
            "errors.budgets.bucketKeyDuplicate",
            `The bucket key "${b.key}" is used more than once`,
            { key: b.key },
          ),
        );
      }
      keys.add(b.key);
      const name = checkedBucketName(b.name, accepted, null);
      accepted.push({ name });
      const carryOver = b.carryOver ?? false;
      checkBucketTarget(b.targetType, b.targetValue);
      const carryCap = checkedBucketCarryCap(carryOver, b.carryCap ?? null);
      return {
        key: b.key,
        name,
        targetType: b.targetType,
        targetValue: b.targetValue,
        carryOver,
        carryCap,
        sortOrder: b.sortOrder,
      };
    });
  }

  private async getSpendingByCategory(
    userId: string,
    startDate: string,
    endDate: string,
    analysisMonths: number,
    isIncome: boolean,
  ): Promise<Omit<CategoryAnalysis, "suggested">[]> {
    const amountCondition = isIncome ? "t.amount > 0" : "t.amount < 0";

    const directSpending = await withScopedDb(this.dataSource, (m) =>
      m
        .getRepository(Transaction)
        .createQueryBuilder("t")
        .innerJoin("t.category", "c")
        .leftJoin("c.parent", "p")
        .select("t.category_id", "categoryId")
        .addSelect(
          "CASE WHEN p.name IS NOT NULL THEN p.name || ': ' || c.name ELSE c.name END",
          "categoryName",
        )
        .addSelect("c.is_income", "isIncome")
        .addSelect("EXTRACT(YEAR FROM t.transaction_date)::int", "year")
        .addSelect("EXTRACT(MONTH FROM t.transaction_date)::int", "month")
        .addSelect("ABS(SUM(t.amount))", "total")
        .where("t.user_id = :userId", { userId })
        .andWhere("t.transaction_date >= :startDate", { startDate })
        .andWhere("t.transaction_date <= :endDate", { endDate })
        .andWhere("t.status != :void", { void: "VOID" })
        .andWhere("t.is_split = false")
        .andWhere("t.is_transfer = false")
        .andWhere("t.category_id IS NOT NULL")
        .andWhere(amountCondition)
        .groupBy("t.category_id")
        .addGroupBy("c.name")
        .addGroupBy("p.name")
        .addGroupBy("c.is_income")
        .addGroupBy("EXTRACT(YEAR FROM t.transaction_date)")
        .addGroupBy("EXTRACT(MONTH FROM t.transaction_date)")
        .getRawMany(),
    );

    const splitSpending = await withScopedDb(this.dataSource, (m) =>
      m
        .getRepository(TransactionSplit)
        .createQueryBuilder("s")
        .innerJoin("s.transaction", "t")
        .innerJoin("s.category", "c")
        .leftJoin("c.parent", "p")
        .select("s.category_id", "categoryId")
        .addSelect(
          "CASE WHEN p.name IS NOT NULL THEN p.name || ': ' || c.name ELSE c.name END",
          "categoryName",
        )
        .addSelect("c.is_income", "isIncome")
        .addSelect("EXTRACT(YEAR FROM t.transaction_date)::int", "year")
        .addSelect("EXTRACT(MONTH FROM t.transaction_date)::int", "month")
        .addSelect("ABS(SUM(s.amount))", "total")
        .where("t.user_id = :userId", { userId })
        .andWhere("t.transaction_date >= :startDate", { startDate })
        .andWhere("t.transaction_date <= :endDate", { endDate })
        .andWhere("t.status != :void", { void: "VOID" })
        .andWhere("t.is_transfer = false")
        .andWhere("s.category_id IS NOT NULL")
        .andWhere(isIncome ? "s.amount > 0" : "s.amount < 0")
        .groupBy("s.category_id")
        .addGroupBy("c.name")
        .addGroupBy("p.name")
        .addGroupBy("c.is_income")
        .addGroupBy("EXTRACT(YEAR FROM t.transaction_date)")
        .addGroupBy("EXTRACT(MONTH FROM t.transaction_date)")
        .getRawMany(),
    );

    const categoryMap = new Map<
      string,
      {
        categoryId: string;
        categoryName: string;
        isIncome: boolean;
        monthlyTotals: Map<string, number>;
      }
    >();

    for (const row of [...directSpending, ...splitSpending]) {
      const key = row.categoryId;
      if (!categoryMap.has(key)) {
        categoryMap.set(key, {
          categoryId: row.categoryId,
          categoryName: row.categoryName,
          isIncome: row.isIncome,
          monthlyTotals: new Map(),
        });
      }

      const entry = categoryMap.get(key)!;
      const monthKey = `${row.year}-${String(row.month).padStart(2, "0")}`;
      const existing = entry.monthlyTotals.get(monthKey) || 0;
      entry.monthlyTotals.set(
        monthKey,
        existing + parseFloat(row.total || "0"),
      );
    }

    const results: Omit<CategoryAnalysis, "suggested">[] = [];

    for (const entry of categoryMap.values()) {
      const monthlyAmounts = this.buildMonthlyArray(
        entry.monthlyTotals,
        analysisMonths,
      );

      const nonZeroMonths = monthlyAmounts.filter((m) => m > 0).length;

      const sortedForPercentiles = [...monthlyAmounts].sort((a, b) => a - b);
      const sortedAll = sortedForPercentiles;

      results.push({
        categoryId: entry.categoryId,
        categoryName: entry.categoryName,
        isIncome: entry.isIncome,
        average: roundMoney(this.mean(monthlyAmounts)),
        median: roundMoney(this.percentile(sortedForPercentiles, 50)),
        p25: roundMoney(this.percentile(sortedForPercentiles, 25)),
        p75: roundMoney(this.percentile(sortedForPercentiles, 75)),
        min: roundMoney(sortedAll[0] ?? 0),
        max: roundMoney(sortedAll[sortedAll.length - 1] ?? 0),
        stdDev: roundMoney(this.standardDeviation(monthlyAmounts)),
        monthlyAmounts,
        monthlyOccurrences: nonZeroMonths,
        isFixed: this.isFixedExpense(monthlyAmounts),
        seasonalMonths: this.detectSeasonalPeaks(monthlyAmounts),
      });
    }

    return results.sort((a, b) => b.median - a.median);
  }

  private buildMonthlyArray(
    monthlyTotals: Map<string, number>,
    analysisMonths: number,
  ): number[] {
    const result: number[] = [];
    const now = new Date();

    for (let i = analysisMonths; i >= 1; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
      result.push(monthlyTotals.get(key) || 0);
    }

    return result;
  }

  getSuggestedAmount(
    cat: Omit<CategoryAnalysis, "suggested">,
    profile: BudgetProfile,
  ): number {
    let base: number;
    switch (profile) {
      case BudgetProfile.COMFORTABLE:
        base = cat.p75;
        break;
      case BudgetProfile.AGGRESSIVE:
        base = cat.p25;
        break;
      case BudgetProfile.ON_TRACK:
      default:
        base = cat.median;
    }

    // Fall back to average when the percentile is zero but there is spending.
    // This handles categories that don't occur every month -- the average
    // distributes total spending across all months in the analysis window.
    if (base === 0 && cat.average > 0) {
      return roundMoney(cat.average);
    }

    return roundMoney(base);
  }

  percentile(sorted: number[], p: number): number {
    if (sorted.length === 0) return 0;
    if (sorted.length === 1) return sorted[0];

    const index = (p / 100) * (sorted.length - 1);
    const lower = Math.floor(index);
    const upper = Math.ceil(index);
    const fraction = index - lower;

    if (lower === upper) return sorted[lower];
    return sorted[lower] + fraction * (sorted[upper] - sorted[lower]);
  }

  mean(values: number[]): number {
    if (values.length === 0) return 0;
    return values.reduce((sum, v) => sum + v, 0) / values.length;
  }

  standardDeviation(values: number[]): number {
    if (values.length <= 1) return 0;
    const avg = this.mean(values);
    const squaredDiffs = values.map((v) => (v - avg) ** 2);
    const variance =
      squaredDiffs.reduce((sum, v) => sum + v, 0) / values.length;
    return Math.sqrt(variance);
  }

  isFixedExpense(monthlyAmounts: number[]): boolean {
    const nonZero = monthlyAmounts.filter((m) => m > 0);
    if (nonZero.length < 2) return false;

    const avg = this.mean(nonZero);
    if (avg === 0) return false;

    const cv = this.standardDeviation(nonZero) / avg;
    return cv < 0.1;
  }

  detectSeasonalPeaks(monthlyAmounts: number[]): number[] {
    if (monthlyAmounts.length < 3) return [];

    const avg = this.mean(monthlyAmounts);
    const stdDev = this.standardDeviation(monthlyAmounts);

    if (stdDev === 0 || avg === 0) return [];

    const threshold = avg + 1.5 * stdDev;
    const peaks: number[] = [];

    const now = new Date();
    for (let i = 0; i < monthlyAmounts.length; i++) {
      if (monthlyAmounts[i] > threshold) {
        const monthDate = new Date(
          now.getFullYear(),
          now.getMonth() - (monthlyAmounts.length - i),
          1,
        );
        peaks.push(monthDate.getMonth() + 1);
      }
    }

    return peaks;
  }

  private async getTransfersByDestination(
    userId: string,
    startDate: string,
    endDate: string,
    analysisMonths: number,
  ): Promise<Omit<TransferAnalysis, "suggested">[]> {
    // No destination filter: this sweeps every account transfers land in.
    // Both transfer shapes -- whole-row transfers and split lines carrying a
    // transfer_account_id -- or a savings habit recorded inside a split
    // paycheque never surfaces as a suggested budget (review #1131).
    const window = { userId, periodStart: startDate, periodEnd: endDate };
    const [parentRows, splitRows] = await withScopedDb(
      this.dataSource,
      async (m) => {
        const parents = await outgoingParentTransfers(
          m.getRepository(Transaction),
          window,
        )
          .innerJoin("lt.account", "a")
          .select("a.id", "accountId")
          .addSelect("a.name", "accountName")
          .addSelect("a.account_type", "accountType")
          .addSelect("EXTRACT(YEAR FROM t.transaction_date)::int", "year")
          .addSelect("EXTRACT(MONTH FROM t.transaction_date)::int", "month")
          .addSelect(`ABS(SUM(${PARENT_TRANSFER_AMOUNT}))`, "total")
          .groupBy("a.id")
          .addGroupBy("a.name")
          .addGroupBy("a.account_type")
          .addGroupBy("EXTRACT(YEAR FROM t.transaction_date)")
          .addGroupBy("EXTRACT(MONTH FROM t.transaction_date)")
          .getRawMany();
        const splits = await outgoingSplitTransfers(
          m.getRepository(TransactionSplit),
          window,
        )
          .innerJoin("s.transferAccount", "a")
          .select("a.id", "accountId")
          .addSelect("a.name", "accountName")
          .addSelect("a.account_type", "accountType")
          .addSelect("EXTRACT(YEAR FROM t.transaction_date)::int", "year")
          .addSelect("EXTRACT(MONTH FROM t.transaction_date)::int", "month")
          .addSelect(`ABS(SUM(${SPLIT_TRANSFER_AMOUNT}))`, "total")
          .groupBy("a.id")
          .addGroupBy("a.name")
          .addGroupBy("a.account_type")
          .addGroupBy("EXTRACT(YEAR FROM t.transaction_date)")
          .addGroupBy("EXTRACT(MONTH FROM t.transaction_date)")
          .getRawMany();
        return [parents, splits] as const;
      },
    );
    return this.toTransferAnalyses(
      [...parentRows, ...splitRows],
      analysisMonths,
    );
  }

  /**
   * The sources of the user's transfers in, per month: the signed net of the
   * legs in their other accounts whose counterpart is the source, through the
   * builders a transfer income line reads (`incomingParentTransfers`). Each
   * month is clamped at zero, as a period's actual is, and a source that never
   * paid in is left out. Only the user's own accounts: `apply` refuses any
   * other as a source.
   *
   * A suggestion is a starting amount, not a forecast of the line's actual.
   * The analysis runs before the wizard knows the budget's excluded accounts,
   * so a leg into an account the budget will exclude (HISA -> RRSP with both
   * excluded) is still counted here, though the line will never count it. And
   * like the outgoing analysis, legs into accounts of different currencies are
   * summed as raw amounts, unconverted.
   */
  private async getTransfersBySource(
    userId: string,
    startDate: string,
    endDate: string,
    analysisMonths: number,
  ): Promise<Omit<TransferAnalysis, "suggested">[]> {
    const window = { userId, periodStart: startDate, periodEnd: endDate };
    const [parentRows, splitRows] = await withScopedDb(
      this.dataSource,
      async (m) => {
        const parents = await incomingParentTransfers(
          m.getRepository(Transaction),
          window,
        )
          .innerJoin("lt.account", "a")
          .andWhere("a.user_id = :userId")
          .select("a.id", "accountId")
          .addSelect("a.name", "accountName")
          .addSelect("a.account_type", "accountType")
          .addSelect("EXTRACT(YEAR FROM t.transaction_date)::int", "year")
          .addSelect("EXTRACT(MONTH FROM t.transaction_date)::int", "month")
          .addSelect(`SUM(${PARENT_TRANSFER_AMOUNT})`, "total")
          .groupBy("a.id")
          .addGroupBy("a.name")
          .addGroupBy("a.account_type")
          .addGroupBy("EXTRACT(YEAR FROM t.transaction_date)")
          .addGroupBy("EXTRACT(MONTH FROM t.transaction_date)")
          .getRawMany();
        const splits = await incomingSplitTransfers(
          m.getRepository(TransactionSplit),
          window,
        )
          .innerJoin("s.transferAccount", "a")
          .andWhere("a.user_id = :userId")
          .select("a.id", "accountId")
          .addSelect("a.name", "accountName")
          .addSelect("a.account_type", "accountType")
          .addSelect("EXTRACT(YEAR FROM t.transaction_date)::int", "year")
          .addSelect("EXTRACT(MONTH FROM t.transaction_date)::int", "month")
          .addSelect(`SUM(${SPLIT_TRANSFER_AMOUNT})`, "total")
          .groupBy("a.id")
          .addGroupBy("a.name")
          .addGroupBy("a.account_type")
          .addGroupBy("EXTRACT(YEAR FROM t.transaction_date)")
          .addGroupBy("EXTRACT(MONTH FROM t.transaction_date)")
          .getRawMany();
        return [parents, splits] as const;
      },
    );
    return this.toTransferAnalyses(
      [...parentRows, ...splitRows],
      analysisMonths,
      { clampMonthsAtZero: true },
    ).filter((t) => t.monthlyOccurrences > 0);
  }

  /** Per-account monthly statistics of transfer rows grouped by month. */
  private toTransferAnalyses(
    rows: Array<{
      accountId: string;
      accountName: string;
      accountType: string;
      year: number;
      month: number;
      total: string | null;
    }>,
    analysisMonths: number,
    { clampMonthsAtZero = false }: { clampMonthsAtZero?: boolean } = {},
  ): Omit<TransferAnalysis, "suggested">[] {
    const accountMap = new Map<
      string,
      {
        accountId: string;
        accountName: string;
        accountType: string;
        monthlyTotals: Map<string, number>;
      }
    >();

    for (const row of rows) {
      const key = row.accountId;
      if (!accountMap.has(key)) {
        accountMap.set(key, {
          accountId: row.accountId,
          accountName: row.accountName,
          accountType: row.accountType,
          monthlyTotals: new Map(),
        });
      }

      const entry = accountMap.get(key)!;
      const monthKey = `${row.year}-${String(row.month).padStart(2, "0")}`;
      const existing = entry.monthlyTotals.get(monthKey) || 0;
      entry.monthlyTotals.set(
        monthKey,
        roundMoney(existing + parseFloat(row.total || "0")),
      );
    }

    const results: Omit<TransferAnalysis, "suggested">[] = [];

    for (const entry of accountMap.values()) {
      const monthlyAmounts = this.buildMonthlyArray(
        entry.monthlyTotals,
        analysisMonths,
      ).map((amount) => (clampMonthsAtZero ? Math.max(amount, 0) : amount));

      const nonZeroMonths = monthlyAmounts.filter((m) => m > 0).length;
      const sortedForPercentiles = [...monthlyAmounts].sort((a, b) => a - b);

      results.push({
        accountId: entry.accountId,
        accountName: entry.accountName,
        accountType: entry.accountType,
        average: roundMoney(this.mean(monthlyAmounts)),
        median: roundMoney(this.percentile(sortedForPercentiles, 50)),
        p25: roundMoney(this.percentile(sortedForPercentiles, 25)),
        p75: roundMoney(this.percentile(sortedForPercentiles, 75)),
        min: roundMoney(sortedForPercentiles[0] ?? 0),
        max: roundMoney(
          sortedForPercentiles[sortedForPercentiles.length - 1] ?? 0,
        ),
        stdDev: roundMoney(this.standardDeviation(monthlyAmounts)),
        monthlyAmounts,
        monthlyOccurrences: nonZeroMonths,
        isFixed: this.isFixedExpense(monthlyAmounts),
        seasonalMonths: this.detectSeasonalPeaks(monthlyAmounts),
      });
    }

    return results.sort((a, b) => b.median - a.median);
  }

  private getSuggestedAmountFromStats(
    stats: { p25: number; median: number; p75: number; average: number },
    profile: BudgetProfile,
  ): number {
    let base: number;
    switch (profile) {
      case BudgetProfile.COMFORTABLE:
        base = stats.p75;
        break;
      case BudgetProfile.AGGRESSIVE:
        base = stats.p25;
        break;
      case BudgetProfile.ON_TRACK:
      default:
        base = stats.median;
    }

    if (base === 0 && stats.average > 0) {
      return roundMoney(stats.average);
    }

    return roundMoney(base);
  }

  private formatDate(date: Date): string {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  }
}
