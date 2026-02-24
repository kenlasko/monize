import apiClient from './api';
import {
  SpendingByCategoryResponse,
  SpendingByPayeeResponse,
  IncomeBySourceResponse,
  MonthlySpendingTrendResponse,
  IncomeVsExpensesResponse,
  ReportQueryParams,
  YearOverYearResponse,
  WeekendVsWeekdayResponse,
  SpendingAnomaliesResponse,
  TaxSummaryResponse,
  RecurringExpensesResponse,
  BillPaymentHistoryResponse,
  UncategorizedTransactionsResponse,
  DuplicateTransactionsResponse,
} from '@/types/built-in-reports';
import { MonthlyComparisonResponse } from '@/types/monthly-comparison';

export const builtInReportsApi = {
  getSpendingByCategory: async (
    params: ReportQueryParams,
  ): Promise<SpendingByCategoryResponse> => {
    const response = await apiClient.get<SpendingByCategoryResponse>(
      '/built-in-reports/spending-by-category',
      { params },
    );
    return response.data;
  },

  getSpendingByPayee: async (
    params: ReportQueryParams,
  ): Promise<SpendingByPayeeResponse> => {
    const response = await apiClient.get<SpendingByPayeeResponse>(
      '/built-in-reports/spending-by-payee',
      { params },
    );
    return response.data;
  },

  getIncomeBySource: async (
    params: ReportQueryParams,
  ): Promise<IncomeBySourceResponse> => {
    const response = await apiClient.get<IncomeBySourceResponse>(
      '/built-in-reports/income-by-source',
      { params },
    );
    return response.data;
  },

  getMonthlySpendingTrend: async (
    params: ReportQueryParams,
  ): Promise<MonthlySpendingTrendResponse> => {
    const response = await apiClient.get<MonthlySpendingTrendResponse>(
      '/built-in-reports/monthly-spending-trend',
      { params },
    );
    return response.data;
  },

  getIncomeVsExpenses: async (
    params: ReportQueryParams,
  ): Promise<IncomeVsExpensesResponse> => {
    const response = await apiClient.get<IncomeVsExpensesResponse>(
      '/built-in-reports/income-vs-expenses',
      { params },
    );
    return response.data;
  },

  getCashFlow: async (
    params: ReportQueryParams,
  ): Promise<IncomeVsExpensesResponse> => {
    const response = await apiClient.get<IncomeVsExpensesResponse>(
      '/built-in-reports/cash-flow',
      { params },
    );
    return response.data;
  },

  getYearOverYear: async (
    yearsToCompare: number = 2,
  ): Promise<YearOverYearResponse> => {
    const response = await apiClient.get<YearOverYearResponse>(
      '/built-in-reports/year-over-year',
      { params: { yearsToCompare } },
    );
    return response.data;
  },

  getWeekendVsWeekday: async (
    params: ReportQueryParams,
  ): Promise<WeekendVsWeekdayResponse> => {
    const response = await apiClient.get<WeekendVsWeekdayResponse>(
      '/built-in-reports/weekend-vs-weekday',
      { params },
    );
    return response.data;
  },

  getSpendingAnomalies: async (
    threshold: number = 2,
  ): Promise<SpendingAnomaliesResponse> => {
    const response = await apiClient.get<SpendingAnomaliesResponse>(
      '/built-in-reports/spending-anomalies',
      { params: { threshold } },
    );
    return response.data;
  },

  getTaxSummary: async (
    year: number,
  ): Promise<TaxSummaryResponse> => {
    const response = await apiClient.get<TaxSummaryResponse>(
      '/built-in-reports/tax-summary',
      { params: { year } },
    );
    return response.data;
  },

  getRecurringExpenses: async (
    minOccurrences: number = 3,
  ): Promise<RecurringExpensesResponse> => {
    const response = await apiClient.get<RecurringExpensesResponse>(
      '/built-in-reports/recurring-expenses',
      { params: { minOccurrences } },
    );
    return response.data;
  },

  getBillPaymentHistory: async (
    params: ReportQueryParams,
  ): Promise<BillPaymentHistoryResponse> => {
    const response = await apiClient.get<BillPaymentHistoryResponse>(
      '/built-in-reports/bill-payment-history',
      { params },
    );
    return response.data;
  },

  getUncategorizedTransactions: async (
    params: ReportQueryParams & { limit?: number },
  ): Promise<UncategorizedTransactionsResponse> => {
    const response = await apiClient.get<UncategorizedTransactionsResponse>(
      '/built-in-reports/uncategorized-transactions',
      { params },
    );
    return response.data;
  },

  getDuplicateTransactions: async (
    params: ReportQueryParams & { sensitivity?: 'high' | 'medium' | 'low' },
  ): Promise<DuplicateTransactionsResponse> => {
    const response = await apiClient.get<DuplicateTransactionsResponse>(
      '/built-in-reports/duplicate-transactions',
      { params },
    );
    return response.data;
  },

  getMonthlyComparison: async (
    month: string,
  ): Promise<MonthlyComparisonResponse> => {
    const response = await apiClient.get<MonthlyComparisonResponse>(
      '/built-in-reports/monthly-comparison',
      { params: { month } },
    );
    return response.data;
  },
};
