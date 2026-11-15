import apiClient from './api';
import {
  Budget,
  BudgetCategory,
  BudgetPeriod,
  BudgetSummary,
  BudgetVelocity,
  BudgetTrendPoint,
  CategoryTrendSeries,
  HealthScoreResult,
  SeasonalPattern,
  FlexGroupStatus,
  DashboardBudgetSummary,
  CategoryBudgetStatus,
  SavingsRatePoint,
  HealthScoreHistoryPoint,
  CreateBudgetData,
  UpdateBudgetData,
  CreateBudgetCategoryData,
  UpdateBudgetCategoryData,
  CreateTransferIncomeLineData,
  GenerateBudgetRequest,
  GenerateBudgetResponse,
  ApplyGeneratedBudgetData,
  BudgetBucket,
  CreateBudgetBucketData,
  UpdateBudgetBucketData,
  BudgetBucketStatusResult,
} from '@/types/budget';
import { dedupe, invalidateCache } from './apiCache';

export const budgetsApi = {
  // Budget CRUD
  create: async (data: CreateBudgetData): Promise<Budget> => {
    const response = await apiClient.post<Budget>('/budgets', data);
    invalidateCache('budgets:');
    return response.data;
  },

  getAll: async (): Promise<Budget[]> => {
    return dedupe(
      'budgets:all',
      async () => {
        const response = await apiClient.get<Budget[]>('/budgets');
        return response.data;
      },
      120_000, // 2 min
    );
  },

  getById: async (id: string): Promise<Budget> => {
    const response = await apiClient.get<Budget>(`/budgets/${id}`);
    return response.data;
  },

  update: async (id: string, data: UpdateBudgetData): Promise<Budget> => {
    const response = await apiClient.patch<Budget>(`/budgets/${id}`, data);
    invalidateCache('budgets:');
    return response.data;
  },

  delete: async (id: string): Promise<void> => {
    await apiClient.delete(`/budgets/${id}`);
    invalidateCache('budgets:');
  },

  // Category management
  addCategory: async (
    budgetId: string,
    data: CreateBudgetCategoryData,
  ): Promise<BudgetCategory> => {
    const response = await apiClient.post<BudgetCategory>(
      `/budgets/${budgetId}/categories`,
      data,
    );
    invalidateCache('budgets:');
    return response.data;
  },

  addTransferIncomeLine: async (
    budgetId: string,
    data: CreateTransferIncomeLineData,
  ): Promise<BudgetCategory> => {
    const response = await apiClient.post<BudgetCategory>(
      `/budgets/${budgetId}/categories/transfer-income`,
      data,
    );
    invalidateCache('budgets:');
    return response.data;
  },

  updateCategory: async (
    budgetId: string,
    categoryId: string,
    data: UpdateBudgetCategoryData,
  ): Promise<BudgetCategory> => {
    const response = await apiClient.patch<BudgetCategory>(
      `/budgets/${budgetId}/categories/${categoryId}`,
      data,
    );
    invalidateCache('budgets:');
    return response.data;
  },

  removeCategory: async (
    budgetId: string,
    categoryId: string,
  ): Promise<void> => {
    await apiClient.delete(`/budgets/${budgetId}/categories/${categoryId}`);
    invalidateCache('budgets:');
  },

  bulkUpdateCategories: async (
    budgetId: string,
    categories: Array<{ id: string; amount?: number; bucketId?: string | null }>,
  ): Promise<BudgetCategory[]> => {
    const response = await apiClient.post<BudgetCategory[]>(
      `/budgets/${budgetId}/categories/bulk`,
      { categories },
    );
    invalidateCache('budgets:');
    return response.data;
  },

  // Buckets
  getBuckets: async (budgetId: string): Promise<BudgetBucket[]> => {
    const response = await apiClient.get<BudgetBucket[]>(
      `/budgets/${budgetId}/buckets`,
    );
    return response.data;
  },

  createBucket: async (
    budgetId: string,
    data: CreateBudgetBucketData,
  ): Promise<BudgetBucket> => {
    const response = await apiClient.post<BudgetBucket>(
      `/budgets/${budgetId}/buckets`,
      data,
    );
    invalidateCache('budgets:');
    return response.data;
  },

  updateBucket: async (
    budgetId: string,
    bucketId: string,
    data: UpdateBudgetBucketData,
  ): Promise<BudgetBucket> => {
    const response = await apiClient.patch<BudgetBucket>(
      `/budgets/${budgetId}/buckets/${bucketId}`,
      data,
    );
    invalidateCache('budgets:');
    return response.data;
  },

  deleteBucket: async (budgetId: string, bucketId: string): Promise<void> => {
    await apiClient.delete(`/budgets/${budgetId}/buckets/${bucketId}`);
    invalidateCache('budgets:');
  },

  getBucketStatus: async (
    budgetId: string,
  ): Promise<BudgetBucketStatusResult> => {
    const response = await apiClient.get<BudgetBucketStatusResult>(
      `/budgets/${budgetId}/reports/bucket-status`,
    );
    return response.data;
  },

  // Generator
  generate: async (
    data: GenerateBudgetRequest,
  ): Promise<GenerateBudgetResponse> => {
    const response = await apiClient.post<GenerateBudgetResponse>(
      '/budgets/generate',
      data,
    );
    return response.data;
  },

  applyGenerated: async (data: ApplyGeneratedBudgetData): Promise<Budget> => {
    const response = await apiClient.post<Budget>(
      '/budgets/generate/apply',
      data,
    );
    invalidateCache('budgets:');
    return response.data;
  },

  // Execution
  getSummary: async (budgetId: string): Promise<BudgetSummary> => {
    const response = await apiClient.get<BudgetSummary>(
      `/budgets/${budgetId}/summary`,
    );
    return response.data;
  },

  getVelocity: async (budgetId: string): Promise<BudgetVelocity> => {
    const response = await apiClient.get<BudgetVelocity>(
      `/budgets/${budgetId}/velocity`,
    );
    return response.data;
  },

  // Periods
  getPeriods: async (budgetId: string): Promise<BudgetPeriod[]> => {
    const response = await apiClient.get<BudgetPeriod[]>(
      `/budgets/${budgetId}/periods`,
    );
    return response.data;
  },

  getPeriodDetail: async (
    budgetId: string,
    periodId: string,
  ): Promise<BudgetPeriod> => {
    const response = await apiClient.get<BudgetPeriod>(
      `/budgets/${budgetId}/periods/${periodId}`,
    );
    return response.data;
  },

  closePeriod: async (budgetId: string): Promise<BudgetPeriod> => {
    const response = await apiClient.post<BudgetPeriod>(
      `/budgets/${budgetId}/periods/close`,
    );
    invalidateCache('budgets:');
    return response.data;
  },


  // Reports
  getTrend: async (
    budgetId: string,
    months = 6,
  ): Promise<BudgetTrendPoint[]> => {
    const response = await apiClient.get<BudgetTrendPoint[]>(
      `/budgets/${budgetId}/reports/trend`,
      { params: { months } },
    );
    return response.data;
  },

  getCategoryTrend: async (
    budgetId: string,
    months = 6,
    categoryIds?: string[],
  ): Promise<CategoryTrendSeries[]> => {
    const response = await apiClient.get<CategoryTrendSeries[]>(
      `/budgets/${budgetId}/reports/category-trend`,
      { params: { months, categoryIds } },
    );
    return response.data;
  },

  getHealthScore: async (budgetId: string): Promise<HealthScoreResult> => {
    const response = await apiClient.get<HealthScoreResult>(
      `/budgets/${budgetId}/reports/health-score`,
    );
    return response.data;
  },

  getSeasonalPatterns: async (
    budgetId: string,
  ): Promise<SeasonalPattern[]> => {
    const response = await apiClient.get<SeasonalPattern[]>(
      `/budgets/${budgetId}/reports/seasonal`,
    );
    return response.data;
  },

  getFlexGroupStatus: async (
    budgetId: string,
  ): Promise<FlexGroupStatus[]> => {
    const response = await apiClient.get<FlexGroupStatus[]>(
      `/budgets/${budgetId}/reports/flex-groups`,
    );
    return response.data;
  },

  getDailySpending: async (
    budgetId: string,
  ): Promise<Array<{ date: string; amount: number }>> => {
    const response = await apiClient.get<Array<{ date: string; amount: number }>>(
      `/budgets/${budgetId}/reports/daily-spending`,
    );
    return response.data;
  },

  getSavingsRate: async (
    budgetId: string,
    months = 12,
  ): Promise<SavingsRatePoint[]> => {
    const response = await apiClient.get<SavingsRatePoint[]>(
      `/budgets/${budgetId}/reports/savings-rate`,
      { params: { months } },
    );
    return response.data;
  },

  getHealthScoreHistory: async (
    budgetId: string,
    months = 12,
  ): Promise<HealthScoreHistoryPoint[]> => {
    const response = await apiClient.get<HealthScoreHistoryPoint[]>(
      `/budgets/${budgetId}/reports/health-score-history`,
      { params: { months } },
    );
    return response.data;
  },

  // Dashboard
  getDashboardSummary: async (): Promise<DashboardBudgetSummary | null> => {
    return dedupe<DashboardBudgetSummary | null>(
      'budgets:dashboard',
      async () => {
        const response = await apiClient.get<DashboardBudgetSummary | null>(
          '/budgets/dashboard-summary',
        );
        return response.data;
      },
    );
  },

  // Transaction context
  getCategoryBudgetStatus: async (
    categoryIds: string[],
  ): Promise<Record<string, CategoryBudgetStatus>> => {
    if (categoryIds.length === 0) return {};
    const sortedIds = [...categoryIds].sort();
    const cacheKey = `budgets:cat-status:${sortedIds.join(',')}`;
    return dedupe(cacheKey, async () => {
      const response = await apiClient.post<Record<string, CategoryBudgetStatus>>(
        '/budgets/category-budget-status',
        { categoryIds },
      );
      return response.data;
    }, 60_000);
  },
};
