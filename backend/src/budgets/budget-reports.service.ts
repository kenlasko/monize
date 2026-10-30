import { Injectable, Logger } from "@nestjs/common";
import { BudgetTrendReportsService } from "./budget-trend-reports.service";
import { BudgetHealthReportsService } from "./budget-health-reports.service";
import { BudgetActivityReportsService } from "./budget-activity-reports.service";
import { BudgetsService } from "./budgets.service";
import {
  getCurrentMonthPeriodDates,
  getPreviousMonthPeriodDates,
  parsePeriodFromYYYYMM,
} from "./budget-date.utils";

export interface BudgetTrendPoint {
  monthKey: string;
  budgeted: number;
  actual: number;
  variance: number;
  percentUsed: number;
}

export interface CategoryTrendPoint {
  monthKey: string;
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
    monthKey: string;
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
  /** `false` when a row had no rate to the budget currency: figures are subtotals. */
  valuationComplete: boolean;
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
  /**
   * The month as structure (`YYYY-MM`), not as a label. A server-formatted
   * `Mmm YYYY` shipped English to every locale and, being a label, sorted
   * alphabetically at the client -- Apr, Aug, Dec, Feb... The client renders
   * this through its own date preference and orders on the key.
   */
  monthKey: string;
  income: number;
  expenses: number;
  savings: number;
  savingsRate: number;
  /** `false` when a row of the month had no rate: the figures are subtotals. */
  valuationComplete: boolean;
}

export interface HealthScoreHistoryPoint {
  /** `YYYY-MM` -- see `SavingsRatePoint.monthKey`. */
  monthKey: string;
  score: number;
  label: string;
}

export interface LlmBudgetStatusResult {
  budgetName: string;
  strategy: string;
  period: { start: string; end: string };
  totalBudgeted: number;
  totalSpent: number;
  totalIncome: number;
  remaining: number;
  percentUsed: number;
  overBudgetCategories: Array<{
    category: string;
    budgeted: number;
    spent: number;
    percentUsed: number;
  }>;
  nearLimitCategories: Array<{
    category: string;
    budgeted: number;
    spent: number;
    remaining: number;
    percentUsed: number;
  }>;
  categoryCount: number;
  velocity?: {
    dailyBurnRate: number;
    /**
     * `null` when an upcoming bill's current amount could not be determined, so
     * "what is truly available" -- and therefore what is safe to spend per day
     * -- is unknown rather than larger (issue #1247). `upcomingBillsComplete`
     * says why; never read a null here as zero.
     */
    safeDailySpend: number | null;
    upcomingBillsComplete: boolean;
    projectedTotal: number;
    projectedVariance: number;
    daysRemaining: number;
    paceStatus: "under" | "on_track" | "over";
  };
  healthScore?: {
    score: number;
    label: string;
  };
}

export interface LlmBudgetStatusError {
  error: string;
  availableBudgets?: string[];
}

@Injectable()
export class BudgetReportsService {
  private readonly logger = new Logger(BudgetReportsService.name);

  constructor(
    private readonly trendReports: BudgetTrendReportsService,
    private readonly healthReports: BudgetHealthReportsService,
    private readonly activityReports: BudgetActivityReportsService,
    private readonly budgetsService: BudgetsService,
  ) {}

  getTrend(
    userId: string,
    budgetId: string,
    months: number,
  ): Promise<BudgetTrendPoint[]> {
    return this.trendReports.getTrend(userId, budgetId, months);
  }

  getCategoryTrend(
    userId: string,
    budgetId: string,
    months: number,
    categoryIds?: string[],
  ): Promise<CategoryTrendSeries[]> {
    return this.trendReports.getCategoryTrend(
      userId,
      budgetId,
      months,
      categoryIds,
    );
  }

  getHealthScore(userId: string, budgetId: string): Promise<HealthScoreResult> {
    return this.healthReports.getHealthScore(userId, budgetId);
  }

  getHealthScoreHistory(
    userId: string,
    budgetId: string,
    months: number,
  ): Promise<HealthScoreHistoryPoint[]> {
    return this.healthReports.getHealthScoreHistory(userId, budgetId, months);
  }

  getSavingsRate(
    userId: string,
    budgetId: string,
    months: number,
  ): Promise<SavingsRatePoint[]> {
    return this.healthReports.getSavingsRate(userId, budgetId, months);
  }

  getSeasonalPatterns(
    userId: string,
    budgetId: string,
  ): Promise<SeasonalPattern[]> {
    return this.activityReports.getSeasonalPatterns(userId, budgetId);
  }

  getDailySpending(
    userId: string,
    budgetId: string,
  ): Promise<Array<{ date: string; amount: number }>> {
    return this.activityReports.getDailySpending(userId, budgetId);
  }

  getFlexGroupStatus(
    userId: string,
    budgetId: string,
  ): Promise<FlexGroupStatusResult[]> {
    return this.activityReports.getFlexGroupStatus(userId, budgetId);
  }

  /**
   * Budget status shaped for LLM tools. Shared by the AI Assistant's
   * `get_budget_status` tool and the MCP server's matching tool so both
   * surfaces return the same data.
   *
   * Period accepts "CURRENT" (default), "PREVIOUS", or a specific YYYY-MM.
   * When `budgetName` is omitted, picks the first active budget; returns an
   * error payload when the named budget is not found.
   */
  async getLlmBudgetStatus(
    userId: string,
    period: string = "CURRENT",
    budgetName?: string,
  ): Promise<LlmBudgetStatusResult | LlmBudgetStatusError> {
    const allBudgets = await this.budgetsService.findAll(userId);
    const activeBudgets = allBudgets.filter((b) => b.isActive);

    if (activeBudgets.length === 0) {
      return { error: "No active budgets found" };
    }

    const budget = budgetName
      ? activeBudgets.find(
          (b) => b.name.toLowerCase() === budgetName.toLowerCase(),
        )
      : activeBudgets[0];

    if (!budget) {
      return {
        error: `Budget "${budgetName}" not found`,
        availableBudgets: activeBudgets.map((b) => b.name),
      };
    }

    const { periodStart, periodEnd } = this.resolvePeriodDates(period);

    let summary: Awaited<ReturnType<BudgetsService["getSummary"]>>;
    try {
      summary = await this.budgetsService.getSummary(userId, budget.id);
    } catch (err) {
      this.logger.warn(
        `Failed to retrieve budget summary for ${budget.id}: ${err instanceof Error ? err.message : err}`,
      );
      return { error: "Failed to retrieve budget summary" };
    }

    let velocity: Awaited<ReturnType<BudgetsService["getVelocity"]>> | null;
    try {
      velocity = await this.budgetsService.getVelocity(userId, budget.id);
    } catch (err) {
      this.logger.warn(
        `Failed to compute budget velocity for ${budget.id}: ${err instanceof Error ? err.message : err}`,
      );
      velocity = null;
    }

    let healthScore: HealthScoreResult | null;
    try {
      healthScore = await this.getHealthScore(userId, budget.id);
    } catch (err) {
      this.logger.warn(
        `Failed to compute budget health score for ${budget.id}: ${err instanceof Error ? err.message : err}`,
      );
      healthScore = null;
    }

    const overBudgetCategories = summary.categoryBreakdown
      .filter((c) => !c.isIncome && c.percentUsed > 100)
      .map((c) => ({
        category: c.categoryName,
        budgeted: c.budgeted,
        spent: c.spent,
        percentUsed: c.percentUsed,
      }));

    const nearLimitCategories = summary.categoryBreakdown
      .filter((c) => !c.isIncome && c.percentUsed >= 80 && c.percentUsed <= 100)
      .map((c) => ({
        category: c.categoryName,
        budgeted: c.budgeted,
        spent: c.spent,
        remaining: c.remaining,
        percentUsed: c.percentUsed,
      }));

    const result: LlmBudgetStatusResult = {
      budgetName: budget.name,
      strategy: budget.strategy,
      period: { start: periodStart, end: periodEnd },
      totalBudgeted: summary.totalBudgeted,
      totalSpent: summary.totalSpent,
      totalIncome: summary.totalIncome,
      remaining: summary.remaining,
      percentUsed: summary.percentUsed,
      overBudgetCategories,
      nearLimitCategories,
      categoryCount: summary.categoryBreakdown.filter((c) => !c.isIncome)
        .length,
    };

    if (velocity) {
      result.velocity = {
        dailyBurnRate: velocity.dailyBurnRate,
        safeDailySpend: velocity.safeDailySpend,
        upcomingBillsComplete: velocity.upcomingBillsComplete,
        projectedTotal: velocity.projectedTotal,
        projectedVariance: velocity.projectedVariance,
        daysRemaining: velocity.daysRemaining,
        paceStatus: velocity.paceStatus,
      };
    }

    if (healthScore) {
      result.healthScore = {
        score: healthScore.score,
        label: healthScore.label,
      };
    }

    return result;
  }

  private resolvePeriodDates(period: string): {
    periodStart: string;
    periodEnd: string;
  } {
    if (period === "PREVIOUS") {
      return getPreviousMonthPeriodDates();
    }

    const parsed = parsePeriodFromYYYYMM(period);
    if (parsed) {
      return parsed;
    }

    return getCurrentMonthPeriodDates();
  }
}
