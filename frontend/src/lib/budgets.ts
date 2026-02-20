import apiClient from './api';
import {
  Budget,
  BudgetCategory,
  BudgetAlert,
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
import { getCached, setCache, invalidateCache } from './apiCache';

export const budgetsApi = {
  // Budget CRUD
  create: async (data: CreateBudgetData): Promise<Budget> => {
    const response = await apiClient.post<Budget>('/budgets', data);
    invalidateCache('budgets:');
    return response.data;
  },

  getAll: async (): Promise<Budget[]> => {
    const cached = getCached<Budget[]>('budgets:all');
    if (cached) return cached;
    const response = await apiClient.get<Budget[]>('/budgets');
    setCache('budgets:all', response.data);
    return response.data;
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

  // Alerts
  getAlerts: async (unreadOnly = false): Promise<BudgetAlert[]> => {
    const response = await apiClient.get<BudgetAlert[]>('/budgets/alerts', {
      params: { unreadOnly },
    });
    return response.data;
  },

  markAlertRead: async (alertId: string): Promise<BudgetAlert> => {
    const response = await apiClient.patch<BudgetAlert>(
      `/budgets/alerts/${alertId}/read`,
    );
    return response.data;
  },

  markAllAlertsRead: async (): Promise<{ updated: number }> => {
    const response = await apiClient.patch<{ updated: number }>(
      '/budgets/alerts/read-all',
    );
    return response.data;
  },

  deleteAlert: async (alertId: string): Promise<void> => {
    await apiClient.delete(`/budgets/alerts/${alertId}`);
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
    const cached = getCached<DashboardBudgetSummary | null>('budgets:dashboard');
    if (cached !== undefined) return cached;
    const response = await apiClient.get<DashboardBudgetSummary | null>(
      '/budgets/dashboard-summary',
    );
    setCache('budgets:dashboard', response.data);
    return response.data;
  },

  // Transaction context
  getCategoryBudgetStatus: async (
    categoryIds: string[],
  ): Promise<Record<string, CategoryBudgetStatus>> => {
    if (categoryIds.length === 0) return {};
    const sortedIds = [...categoryIds].sort();
    const cacheKey = `budgets:cat-status:${sortedIds.join(',')}`;
    const cached = getCached<Record<string, CategoryBudgetStatus>>(cacheKey);
    if (cached) return cached;
    const response = await apiClient.post<Record<string, CategoryBudgetStatus>>(
      '/budgets/category-budget-status',
      { categoryIds },
    );
    setCache(cacheKey, response.data, 60_000);
    return response.data;
  },
};
