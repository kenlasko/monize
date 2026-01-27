import apiClient from './api';
import { Account } from '@/types/account';
import {
  PortfolioSummary,
  AssetAllocation,
  InvestmentTransaction,
  CreateInvestmentTransactionData,
  Holding,
  Security,
  CreateSecurityData,
  PaginatedInvestmentTransactions,
} from '@/types/investment';

export const investmentsApi = {
  // Get portfolio summary
  getPortfolioSummary: async (accountId?: string): Promise<PortfolioSummary> => {
    const response = await apiClient.get<PortfolioSummary>('/portfolio/summary', {
      params: accountId ? { accountId } : undefined,
    });
    return response.data;
  },

  // Get asset allocation
  getAssetAllocation: async (accountId?: string): Promise<AssetAllocation> => {
    const response = await apiClient.get<AssetAllocation>('/portfolio/allocation', {
      params: accountId ? { accountId } : undefined,
    });
    return response.data;
  },

  // Get all investment accounts
  getInvestmentAccounts: async (): Promise<Account[]> => {
    const response = await apiClient.get<Account[]>('/portfolio/accounts');
    return response.data;
  },

  // Get all holdings
  getHoldings: async (accountId?: string): Promise<Holding[]> => {
    const response = await apiClient.get<Holding[]>('/holdings', {
      params: accountId ? { accountId } : undefined,
    });
    return response.data;
  },

  // Get investment transactions with pagination
  getTransactions: async (params?: {
    accountId?: string;
    startDate?: string;
    endDate?: string;
    page?: number;
    limit?: number;
  }): Promise<PaginatedInvestmentTransactions> => {
    const response = await apiClient.get<PaginatedInvestmentTransactions>(
      '/investment-transactions',
      { params },
    );
    return response.data;
  },

  // Create investment transaction
  createTransaction: async (
    data: CreateInvestmentTransactionData,
  ): Promise<InvestmentTransaction> => {
    const response = await apiClient.post<InvestmentTransaction>(
      '/investment-transactions',
      data,
    );
    return response.data;
  },

  // Delete investment transaction
  deleteTransaction: async (id: string): Promise<void> => {
    await apiClient.delete(`/investment-transactions/${id}`);
  },

  // Get all securities
  getSecurities: async (includeInactive = false): Promise<Security[]> => {
    const response = await apiClient.get<Security[]>('/securities', {
      params: includeInactive ? { includeInactive: true } : undefined,
    });
    return response.data;
  },

  // Get a single security by ID
  getSecurity: async (id: string): Promise<Security> => {
    const response = await apiClient.get<Security>(`/securities/${id}`);
    return response.data;
  },

  // Create security
  createSecurity: async (data: CreateSecurityData): Promise<Security> => {
    const response = await apiClient.post<Security>('/securities', data);
    return response.data;
  },

  // Update security
  updateSecurity: async (id: string, data: Partial<CreateSecurityData>): Promise<Security> => {
    const response = await apiClient.patch<Security>(`/securities/${id}`, data);
    return response.data;
  },

  // Deactivate security
  deactivateSecurity: async (id: string): Promise<Security> => {
    const response = await apiClient.post<Security>(`/securities/${id}/deactivate`);
    return response.data;
  },

  // Activate security
  activateSecurity: async (id: string): Promise<Security> => {
    const response = await apiClient.post<Security>(`/securities/${id}/activate`);
    return response.data;
  },

  // Search securities
  searchSecurities: async (query: string): Promise<Security[]> => {
    const response = await apiClient.get<Security[]>('/securities/search', {
      params: { q: query },
    });
    return response.data;
  },
};
