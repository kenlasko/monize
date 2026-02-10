import { describe, it, expect, vi, beforeEach } from 'vitest';
import apiClient from './api';
import { builtInReportsApi } from './built-in-reports';

vi.mock('./api', () => ({
  default: { get: vi.fn() },
}));

describe('builtInReportsApi', () => {
  beforeEach(() => vi.clearAllMocks());

  const params = { startDate: '2025-01-01', endDate: '2025-01-31' } as any;

  it('getSpendingByCategory fetches with params', async () => {
    vi.mocked(apiClient.get).mockResolvedValue({ data: { categories: [] } });
    await builtInReportsApi.getSpendingByCategory(params);
    expect(apiClient.get).toHaveBeenCalledWith('/built-in-reports/spending-by-category', { params });
  });

  it('getSpendingByPayee fetches with params', async () => {
    vi.mocked(apiClient.get).mockResolvedValue({ data: { payees: [] } });
    await builtInReportsApi.getSpendingByPayee(params);
    expect(apiClient.get).toHaveBeenCalledWith('/built-in-reports/spending-by-payee', { params });
  });

  it('getIncomeBySource fetches with params', async () => {
    vi.mocked(apiClient.get).mockResolvedValue({ data: { sources: [] } });
    await builtInReportsApi.getIncomeBySource(params);
    expect(apiClient.get).toHaveBeenCalledWith('/built-in-reports/income-by-source', { params });
  });

  it('getMonthlySpendingTrend fetches with params', async () => {
    vi.mocked(apiClient.get).mockResolvedValue({ data: { months: [] } });
    await builtInReportsApi.getMonthlySpendingTrend(params);
    expect(apiClient.get).toHaveBeenCalledWith('/built-in-reports/monthly-spending-trend', { params });
  });

  it('getIncomeVsExpenses fetches with params', async () => {
    vi.mocked(apiClient.get).mockResolvedValue({ data: {} });
    await builtInReportsApi.getIncomeVsExpenses(params);
    expect(apiClient.get).toHaveBeenCalledWith('/built-in-reports/income-vs-expenses', { params });
  });

  it('getCashFlow fetches with params', async () => {
    vi.mocked(apiClient.get).mockResolvedValue({ data: {} });
    await builtInReportsApi.getCashFlow(params);
    expect(apiClient.get).toHaveBeenCalledWith('/built-in-reports/cash-flow', { params });
  });

  it('getYearOverYear defaults to 2 years', async () => {
    vi.mocked(apiClient.get).mockResolvedValue({ data: {} });
    await builtInReportsApi.getYearOverYear();
    expect(apiClient.get).toHaveBeenCalledWith('/built-in-reports/year-over-year', {
      params: { yearsToCompare: 2 },
    });
  });

  it('getYearOverYear passes custom years', async () => {
    vi.mocked(apiClient.get).mockResolvedValue({ data: {} });
    await builtInReportsApi.getYearOverYear(5);
    expect(apiClient.get).toHaveBeenCalledWith('/built-in-reports/year-over-year', {
      params: { yearsToCompare: 5 },
    });
  });

  it('getWeekendVsWeekday fetches with params', async () => {
    vi.mocked(apiClient.get).mockResolvedValue({ data: {} });
    await builtInReportsApi.getWeekendVsWeekday(params);
    expect(apiClient.get).toHaveBeenCalledWith('/built-in-reports/weekend-vs-weekday', { params });
  });

  it('getSpendingAnomalies defaults threshold to 2', async () => {
    vi.mocked(apiClient.get).mockResolvedValue({ data: {} });
    await builtInReportsApi.getSpendingAnomalies();
    expect(apiClient.get).toHaveBeenCalledWith('/built-in-reports/spending-anomalies', {
      params: { threshold: 2 },
    });
  });

  it('getTaxSummary fetches with year', async () => {
    vi.mocked(apiClient.get).mockResolvedValue({ data: {} });
    await builtInReportsApi.getTaxSummary(2024);
    expect(apiClient.get).toHaveBeenCalledWith('/built-in-reports/tax-summary', {
      params: { year: 2024 },
    });
  });

  it('getRecurringExpenses defaults minOccurrences to 3', async () => {
    vi.mocked(apiClient.get).mockResolvedValue({ data: {} });
    await builtInReportsApi.getRecurringExpenses();
    expect(apiClient.get).toHaveBeenCalledWith('/built-in-reports/recurring-expenses', {
      params: { minOccurrences: 3 },
    });
  });

  it('getBillPaymentHistory fetches with params', async () => {
    vi.mocked(apiClient.get).mockResolvedValue({ data: {} });
    await builtInReportsApi.getBillPaymentHistory(params);
    expect(apiClient.get).toHaveBeenCalledWith('/built-in-reports/bill-payment-history', { params });
  });

  it('getUncategorizedTransactions fetches with params', async () => {
    vi.mocked(apiClient.get).mockResolvedValue({ data: {} });
    await builtInReportsApi.getUncategorizedTransactions({ ...params, limit: 50 });
    expect(apiClient.get).toHaveBeenCalledWith('/built-in-reports/uncategorized-transactions', {
      params: { ...params, limit: 50 },
    });
  });

  it('getDuplicateTransactions fetches with sensitivity', async () => {
    vi.mocked(apiClient.get).mockResolvedValue({ data: {} });
    await builtInReportsApi.getDuplicateTransactions({ ...params, sensitivity: 'high' });
    expect(apiClient.get).toHaveBeenCalledWith('/built-in-reports/duplicate-transactions', {
      params: { ...params, sensitivity: 'high' },
    });
  });
});
