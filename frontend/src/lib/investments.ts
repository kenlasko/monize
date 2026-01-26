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

  // Get investment transactions
  getTransactions: async (params?: {
    accountId?: string;
    startDate?: string;
    endDate?: string;
  }): Promise<InvestmentTransaction[]> => {
    const response = await apiClient.get<InvestmentTransaction[]>(
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
  getSecurities: async (): Promise<Security[]> => {
    const response = await apiClient.get<Security[]>('/securities');
    return response.data;
  },

  // Create security
  createSecurity: async (data: CreateSecurityData): Promise<Security> => {
    const response = await apiClient.post<Security>('/securities', data);
    return response.data;
  },

  // Search securities
  searchSecurities: async (query: string): Promise<Security[]> => {
    const response = await apiClient.get<Security[]>('/securities', {
      params: { search: query },
    });
    return response.data;
  },
};
