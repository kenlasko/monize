import { Injectable } from "@nestjs/common";
import { BudgetTrendReportsService } from "./budget-trend-reports.service";
import { BudgetHealthReportsService } from "./budget-health-reports.service";
import { BudgetActivityReportsService } from "./budget-activity-reports.service";

export interface BudgetTrendPoint {
  month: string;
  budgeted: number;
  actual: number;
  variance: number;
  percentUsed: number;
}

export interface CategoryTrendPoint {
  month: string;
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
    month: string;
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
  month: string;
  income: number;
  expenses: number;
  savings: number;
  savingsRate: number;
}

export interface HealthScoreHistoryPoint {
  month: string;
  score: number;
  label: string;
}

@Injectable()
export class BudgetReportsService {
  constructor(
    private readonly trendReports: BudgetTrendReportsService,
    private readonly healthReports: BudgetHealthReportsService,
    private readonly activityReports: BudgetActivityReportsService,
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
}
