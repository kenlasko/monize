import { Injectable } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { Transaction } from "../transactions/entities/transaction.entity";
import { TransactionSplit } from "../transactions/entities/transaction-split.entity";
import { Category } from "../categories/entities/category.entity";
import { Budget } from "./entities/budget.entity";
import { BudgetCategory } from "./entities/budget-category.entity";
import { GenerateBudgetDto, BudgetProfile } from "./dto/generate-budget.dto";
import { ApplyGeneratedBudgetDto } from "./dto/apply-generated-budget.dto";

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

export interface GenerateBudgetResult {
  categories: CategoryAnalysis[];
  estimatedMonthlyIncome: number;
  totalBudgeted: number;
  projectedMonthlySavings: number;
  analysisWindow: {
    startDate: string;
    endDate: string;
    months: number;
  };
}

@Injectable()
export class BudgetGeneratorService {
  constructor(
    @InjectRepository(Transaction)
    private transactionsRepository: Repository<Transaction>,
    @InjectRepository(TransactionSplit)
    private splitsRepository: Repository<TransactionSplit>,
    @InjectRepository(Category)
    private categoriesRepository: Repository<Category>,
    @InjectRepository(Budget)
    private budgetsRepository: Repository<Budget>,
    @InjectRepository(BudgetCategory)
    private budgetCategoriesRepository: Repository<BudgetCategory>,
  ) {}

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

    const allCategories = [...incomeAnalysis, ...expenseAnalysis];

    const estimatedMonthlyIncome =
      incomeAnalysis.length > 0
        ? this.mean(incomeAnalysis.map((i) => i.median))
        : 0;

    const totalBudgeted = expenseAnalysis.reduce(
      (sum, c) => sum + c.suggested,
      0,
    );

    return {
      categories: allCategories,
      estimatedMonthlyIncome,
      totalBudgeted,
      projectedMonthlySavings: estimatedMonthlyIncome - totalBudgeted,
      analysisWindow: {
        startDate: startDateStr,
        endDate: endDateStr,
        months: analysisMonths,
      },
    };
  }

  async apply(userId: string, dto: ApplyGeneratedBudgetDto): Promise<Budget> {
    const budget = this.budgetsRepository.create({
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
    });

    const savedBudget = await this.budgetsRepository.save(budget);

    if (dto.categories && dto.categories.length > 0) {
      const budgetCategories = dto.categories.map((cat) =>
        this.budgetCategoriesRepository.create({
          budgetId: savedBudget.id,
          categoryId: cat.categoryId,
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
        }),
      );

      await this.budgetCategoriesRepository.save(budgetCategories);
    }

    return this.budgetsRepository.findOne({
      where: { id: savedBudget.id },
      relations: ["categories", "categories.category"],
    }) as Promise<Budget>;
  }

  private async getSpendingByCategory(
    userId: string,
    startDate: string,
    endDate: string,
    analysisMonths: number,
    isIncome: boolean,
  ): Promise<Omit<CategoryAnalysis, "suggested">[]> {
    const amountCondition = isIncome ? "t.amount > 0" : "t.amount < 0";

    const directSpending = await this.transactionsRepository
      .createQueryBuilder("t")
      .innerJoin("t.category", "c")
      .select("t.category_id", "categoryId")
      .addSelect("c.name", "categoryName")
      .addSelect("c.is_income", "isIncome")
      .addSelect("EXTRACT(YEAR FROM t.transaction_date)::int", "year")
      .addSelect("EXTRACT(MONTH FROM t.transaction_date)::int", "month")
      .addSelect("SUM(ABS(t.amount))", "total")
      .where("t.user_id = :userId", { userId })
      .andWhere("t.transaction_date >= :startDate", { startDate })
      .andWhere("t.transaction_date <= :endDate", { endDate })
      .andWhere("t.status != :void", { void: "VOID" })
      .andWhere("t.is_split = false")
      .andWhere("t.category_id IS NOT NULL")
      .andWhere(amountCondition)
      .groupBy("t.category_id")
      .addGroupBy("c.name")
      .addGroupBy("c.is_income")
      .addGroupBy("EXTRACT(YEAR FROM t.transaction_date)")
      .addGroupBy("EXTRACT(MONTH FROM t.transaction_date)")
      .getRawMany();

    const splitSpending = await this.splitsRepository
      .createQueryBuilder("s")
      .innerJoin("s.transaction", "t")
      .innerJoin("s.category", "c")
      .select("s.category_id", "categoryId")
      .addSelect("c.name", "categoryName")
      .addSelect("c.is_income", "isIncome")
      .addSelect("EXTRACT(YEAR FROM t.transaction_date)::int", "year")
      .addSelect("EXTRACT(MONTH FROM t.transaction_date)::int", "month")
      .addSelect("SUM(ABS(s.amount))", "total")
      .where("t.user_id = :userId", { userId })
      .andWhere("t.transaction_date >= :startDate", { startDate })
      .andWhere("t.transaction_date <= :endDate", { endDate })
      .andWhere("t.status != :void", { void: "VOID" })
      .andWhere("s.category_id IS NOT NULL")
      .andWhere(isIncome ? "s.amount > 0" : "s.amount < 0")
      .groupBy("s.category_id")
      .addGroupBy("c.name")
      .addGroupBy("c.is_income")
      .addGroupBy("EXTRACT(YEAR FROM t.transaction_date)")
      .addGroupBy("EXTRACT(MONTH FROM t.transaction_date)")
      .getRawMany();

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

      const sorted = [...monthlyAmounts].sort((a, b) => a - b);
      const nonZeroMonths = monthlyAmounts.filter((m) => m > 0).length;

      results.push({
        categoryId: entry.categoryId,
        categoryName: entry.categoryName,
        isIncome: entry.isIncome,
        average: this.round(this.mean(monthlyAmounts)),
        median: this.round(this.percentile(sorted, 50)),
        p25: this.round(this.percentile(sorted, 25)),
        p75: this.round(this.percentile(sorted, 75)),
        min: this.round(sorted[0] ?? 0),
        max: this.round(sorted[sorted.length - 1] ?? 0),
        stdDev: this.round(this.standardDeviation(monthlyAmounts)),
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
    switch (profile) {
      case BudgetProfile.COMFORTABLE:
        return this.round(cat.p75);
      case BudgetProfile.AGGRESSIVE:
        return this.round(cat.p25);
      case BudgetProfile.ON_TRACK:
      default:
        return this.round(cat.median);
    }
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

  private round(value: number): number {
    return Math.round(value * 100) / 100;
  }

  private formatDate(date: Date): string {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  }
}
