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
  GenerateBudgetRequest,
  GenerateBudgetResponse,
  ApplyGeneratedBudgetData,
} from '@/types/budget';
import { dedupe, invalidateCache } from './apiCache';

export const budgetsApi = {
  // Budget CRUD
  create: async (data: CreateBudgetData): Promise<Budget> => {
    const response = await apiClient.post<Budget>('/budgets', data);
    invalidateCache('budgets:');
    return response.data;
  },

  getAll: async (basis?: 'cash' | 'accrual'): Promise<Budget[]> => {
    return dedupe(
      basis ? `budgets:all:${basis}` : 'budgets:all',
      async () => {
        const response = await apiClient.get<Budget[]>('/budgets', ...(basis ? [{params:{basis}}] as const : []));
        return response.data;
      },
      120_000, // 2 min
    );
  },

  getById: async (id: string, basis?: 'cash' | 'accrual'): Promise<Budget> => {
    const response = await apiClient.get<Budget>(`/budgets/${id}`, ...(basis ? [{params:{basis}}] as const : []));
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
    categories: Array<{ id: string; amount: number }>,
  ): Promise<BudgetCategory[]> => {
    const response = await apiClient.post<BudgetCategory[]>(
      `/budgets/${budgetId}/categories/bulk`,
      { categories },
    );
    invalidateCache('budgets:');
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
  getSummary: async (budgetId: string, basis?: 'cash' | 'accrual'): Promise<BudgetSummary> => {
    const response = await apiClient.get<BudgetSummary>(
      `/budgets/${budgetId}/summary`,
      ...(basis ? [{ params: { basis } }] as const : []),
    );
    return response.data;
  },

  getVelocity: async (budgetId: string, basis?: 'cash' | 'accrual'): Promise<BudgetVelocity> => {
    const response = await apiClient.get<BudgetVelocity>(
      `/budgets/${budgetId}/velocity`,
      ...(basis ? [{ params: { basis } }] as const : []),
    );
    return response.data;
  },

  // Periods
  getPeriods: async (budgetId: string): Promise<BudgetPeriod[]> => {
    const response = await apiClient.get<BudgetPeriod[]>(
      `/budgets/${budgetId}/periods`,
      { params: { basis: 'cash' } },
    );
    return response.data;
  },

  getPeriodDetail: async (
    budgetId: string,
    periodId: string,
  ): Promise<BudgetPeriod> => {
    const response = await apiClient.get<BudgetPeriod>(
      `/budgets/${budgetId}/periods/${periodId}`,
      { params: { basis: 'cash' } },
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
    months = 6, basis?: 'cash' | 'accrual'): Promise<BudgetTrendPoint[]> => {
    const response = await apiClient.get<BudgetTrendPoint[]>(
      `/budgets/${budgetId}/reports/trend`,
      { params: { months, ...(basis ? { basis } : {}) } },
    );
    return response.data;
  },

  getCategoryTrend: async (
    budgetId: string,
    months = 6,
    categoryIds?: string[], basis?: 'cash' | 'accrual'): Promise<CategoryTrendSeries[]> => {
    const response = await apiClient.get<CategoryTrendSeries[]>(
      `/budgets/${budgetId}/reports/category-trend`,
      { params: { months, categoryIds, ...(basis ? { basis } : {}) } },
    );
    return response.data;
  },

  getHealthScore: async (budgetId: string, basis?: 'cash' | 'accrual'): Promise<HealthScoreResult> => {
    const response = await apiClient.get<HealthScoreResult>(
      `/budgets/${budgetId}/reports/health-score`,
      ...(basis ? [{ params: { basis } }] as const : []),
    );
    return response.data;
  },

  getSeasonalPatterns: async (
    budgetId: string, basis?: 'cash' | 'accrual'): Promise<SeasonalPattern[]> => {
    const response = await apiClient.get<SeasonalPattern[]>(
      `/budgets/${budgetId}/reports/seasonal`,
      ...(basis ? [{ params: { basis } }] as const : []),
    );
    return response.data;
  },

  getFlexGroupStatus: async (
    budgetId: string, basis?: 'cash' | 'accrual'): Promise<FlexGroupStatus[]> => {
    const response = await apiClient.get<FlexGroupStatus[]>(
      `/budgets/${budgetId}/reports/flex-groups`,
      ...(basis ? [{ params: { basis } }] as const : []),
    );
    return response.data;
  },

  getDailySpending: async (
    budgetId: string, basis?: 'cash' | 'accrual'): Promise<Array<{ date: string; amount: number }>> => {
    const response = await apiClient.get<Array<{ date: string; amount: number }>>(
      `/budgets/${budgetId}/reports/daily-spending`,
      ...(basis ? [{ params: { basis } }] as const : []),
    );
    return response.data;
  },

  getSavingsRate: async (
    budgetId: string,
    months = 12, basis?: 'cash' | 'accrual'): Promise<SavingsRatePoint[]> => {
    const response = await apiClient.get<SavingsRatePoint[]>(
      `/budgets/${budgetId}/reports/savings-rate`,
      { params: { months, ...(basis ? { basis } : {}) } },
    );
    return response.data;
  },

  getHealthScoreHistory: async (
    budgetId: string,
    months = 12, basis?: 'cash' | 'accrual'): Promise<HealthScoreHistoryPoint[]> => {
    const response = await apiClient.get<HealthScoreHistoryPoint[]>(
      `/budgets/${budgetId}/reports/health-score-history`,
      { params: { months, ...(basis ? { basis } : {}) } },
    );
    return response.data;
  },

  // Dashboard
  getDashboardSummary: async (basis?: 'cash' | 'accrual'): Promise<DashboardBudgetSummary | null> => {
    return dedupe<DashboardBudgetSummary | null>(
      basis ? `budgets:dashboard:${basis}` : 'budgets:dashboard',
      async () => {
        const response = await apiClient.get<DashboardBudgetSummary | null>(
          '/budgets/dashboard-summary',
      ...(basis ? [{ params: { basis } }] as const : []),
        );
        return response.data;
      },
    );
  },

  // Transaction context
  getCategoryBudgetStatus: async (
    categoryIds: string[], basis?: 'cash'|'accrual',
  ): Promise<Record<string, CategoryBudgetStatus>> => {
    if (categoryIds.length === 0) return {};
    const sortedIds = [...categoryIds].sort();
    const cacheKey = `budgets:cat-status:${sortedIds.join(',')}${basis ? ':' + basis : ''}`;
    return dedupe(cacheKey, async () => {
      const response = await apiClient.post<Record<string, CategoryBudgetStatus>>(
        '/budgets/category-budget-status',
        { categoryIds },
        ...(basis ? [{ params: { basis } }] as const : []),
      );
      return response.data;
    }, 60_000);
  },
};
