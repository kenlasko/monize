import apiClient from './api';
import {
  Account,
  CreateAccountData,
  UpdateAccountData,
  AccountSummary,
  InvestmentAccountPair,
  LoanPreviewData,
  AmortizationPreview,
  MortgagePreviewData,
  MortgageAmortizationPreview,
  UpdateMortgageRateData,
  UpdateMortgageRateResponse,
} from '@/types/account';

export const accountsApi = {
  // Create account
  create: async (data: CreateAccountData): Promise<Account> => {
    const response = await apiClient.post<Account>('/accounts', data);
    return response.data;
  },

  // Get all accounts
  getAll: async (includeInactive: boolean = false): Promise<Account[]> => {
    const response = await apiClient.get<Account[]>('/accounts', {
      params: { includeInactive },
    });
    return response.data;
  },

  // Get account by ID
  getById: async (id: string): Promise<Account> => {
    const response = await apiClient.get<Account>(`/accounts/${id}`);
    return response.data;
  },

  // Update account
  update: async (id: string, data: UpdateAccountData): Promise<Account> => {
    const response = await apiClient.patch<Account>(`/accounts/${id}`, data);
    return response.data;
  },

  // Close account
  close: async (id: string): Promise<Account> => {
    const response = await apiClient.post<Account>(`/accounts/${id}/close`);
    return response.data;
  },

  // Reopen account
  reopen: async (id: string): Promise<Account> => {
    const response = await apiClient.post<Account>(`/accounts/${id}/reopen`);
    return response.data;
  },

  // Get account balance
  getBalance: async (id: string): Promise<{ balance: number }> => {
    const response = await apiClient.get<{ balance: number }>(`/accounts/${id}/balance`);
    return response.data;
  },

  // Get account summary
  getSummary: async (): Promise<AccountSummary> => {
    const response = await apiClient.get<AccountSummary>('/accounts/summary');
    return response.data;
  },

  // Get investment account pair
  getInvestmentPair: async (id: string): Promise<InvestmentAccountPair> => {
    const response = await apiClient.get<InvestmentAccountPair>(
      `/accounts/${id}/investment-pair`,
    );
    return response.data;
  },

  // Check if account can be deleted
  canDelete: async (id: string): Promise<{ transactionCount: number; investmentTransactionCount: number; canDelete: boolean }> => {
    const response = await apiClient.get<{ transactionCount: number; investmentTransactionCount: number; canDelete: boolean }>(
      `/accounts/${id}/can-delete`,
    );
    return response.data;
  },

  // Delete account (only if no transactions)
  delete: async (id: string): Promise<void> => {
    await apiClient.delete(`/accounts/${id}`);
  },

  // Preview loan amortization
  previewLoanAmortization: async (data: LoanPreviewData): Promise<AmortizationPreview> => {
    const response = await apiClient.post<AmortizationPreview>('/accounts/loan-preview', data);
    return response.data;
  },

  // Preview mortgage amortization
  previewMortgageAmortization: async (data: MortgagePreviewData): Promise<MortgageAmortizationPreview> => {
    const response = await apiClient.post<MortgageAmortizationPreview>('/accounts/mortgage-preview', data);
    return response.data;
  },

  // Update mortgage interest rate
  updateMortgageRate: async (id: string, data: UpdateMortgageRateData): Promise<UpdateMortgageRateResponse> => {
    const response = await apiClient.patch<UpdateMortgageRateResponse>(`/accounts/${id}/mortgage-rate`, data);
    return response.data;
  },
};
