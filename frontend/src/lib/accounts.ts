import apiClient from './api';
import {
  Account,
  CreateAccountData,
  UpdateAccountData,
  AccountSummary,
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
};
