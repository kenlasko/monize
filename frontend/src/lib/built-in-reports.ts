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
  RecurringExpenseRange,
  BillPaymentHistoryResponse,
  UncategorizedTransactionsResponse,
  DuplicateTransactionsResponse,
  MonthlyCategoryBreakdownResponse,
  SpendingByCategoryParams,
  IncomeVsExpensesParams,
  CashFlowParams,
  CashFlowSankeyParams,
  CashFlowSankeyResponse,
  IncomeBySourceParams,
  MonthlyCategoryBreakdownParams,
} from '@/types/built-in-reports';
import { MonthlyComparisonResponse } from '@/types/monthly-comparison';

/**
 * The server takes each account-id list (the filter, and the tagged-transfer
 * boundary of spec 10.8.1) as one comma-separated value; an empty list means
 * "none given", so it is left off entirely.
 */
function serializeAccountIds<
  T extends { accountIds?: string[]; transferScopeAccountIds?: string[] },
>(
  params: T,
): Omit<T, 'accountIds' | 'transferScopeAccountIds'> & {
  accountIds?: string;
  transferScopeAccountIds?: string;
} {
  const { accountIds, transferScopeAccountIds, ...rest } = params;
  return {
    ...rest,
    ...(accountIds && accountIds.length > 0
      ? { accountIds: accountIds.join(',') }
      : {}),
    ...(transferScopeAccountIds && transferScopeAccountIds.length > 0
      ? { transferScopeAccountIds: transferScopeAccountIds.join(',') }
      : {}),
  };
}

export const builtInReportsApi = {
  getSpendingByCategory: async (
    params: SpendingByCategoryParams,
  ): Promise<SpendingByCategoryResponse> => {
    const response = await apiClient.get<SpendingByCategoryResponse>(
      '/built-in-reports/spending-by-category',
      { params: serializeAccountIds(params) },
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
    params: IncomeBySourceParams,
  ): Promise<IncomeBySourceResponse> => {
    const response = await apiClient.get<IncomeBySourceResponse>(
      '/built-in-reports/income-by-source',
      { params: serializeAccountIds(params) },
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
    params: IncomeVsExpensesParams,
  ): Promise<IncomeVsExpensesResponse> => {
    const response = await apiClient.get<IncomeVsExpensesResponse>(
      '/built-in-reports/income-vs-expenses',
      { params: serializeAccountIds(params) },
    );
    return response.data;
  },

  getCashFlow: async (
    params: CashFlowParams,
  ): Promise<IncomeVsExpensesResponse> => {
    const response = await apiClient.get<IncomeVsExpensesResponse>(
      '/built-in-reports/cash-flow',
      { params: serializeAccountIds(params) },
    );
    return response.data;
  },

  getYearOverYear: async (
    yearsToCompare: number = 2,
    basis?: 'cash' | 'accrual',
  ): Promise<YearOverYearResponse> => {
    const response = await apiClient.get<YearOverYearResponse>(
      '/built-in-reports/year-over-year',
      { params: { yearsToCompare, ...(basis ? { basis } : {}) } },
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
    range?: RecurringExpenseRange,
  ): Promise<RecurringExpensesResponse> => {
    const response = await apiClient.get<RecurringExpensesResponse>(
      '/built-in-reports/recurring-expenses',
      { params: range ? { minOccurrences, range } : { minOccurrences } },
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
    basis?: 'cash' | 'accrual',
  ): Promise<MonthlyComparisonResponse> => {
    const response = await apiClient.get<MonthlyComparisonResponse>(
      '/built-in-reports/monthly-comparison',
      { params: { month, ...(basis ? { basis } : {}) } },
    );
    return response.data;
  },

  getCashFlowSankey: async (
    params: CashFlowSankeyParams,
  ): Promise<CashFlowSankeyResponse> => {
    const { accountIds, ...rest } = params;
    const response = await apiClient.get<CashFlowSankeyResponse>(
      '/built-in-reports/cash-flow-sankey',
      {
        // One comma-separated value; an empty scope means the server's default
        // cash-flow accounts, so it is left off entirely.
        params: {
          ...rest,
          ...(accountIds && accountIds.length > 0
            ? { accountIds: accountIds.join(',') }
            : {}),
        },
      },
    );
    return response.data;
  },

  getMonthlyCategoryBreakdown: async (
    params: MonthlyCategoryBreakdownParams,
  ): Promise<MonthlyCategoryBreakdownResponse> => {
    const response = await apiClient.get<MonthlyCategoryBreakdownResponse>(
      '/built-in-reports/monthly-category-breakdown',
      { params: serializeAccountIds(params) },
    );
    return response.data;
  },
};
