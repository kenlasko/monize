import apiClient from './api';
import {
  ScheduledTransaction,
  CreateScheduledTransactionData,
  UpdateScheduledTransactionData,
} from '@/types/scheduled-transaction';

export const scheduledTransactionsApi = {
  // Create a new scheduled transaction
  create: async (data: CreateScheduledTransactionData): Promise<ScheduledTransaction> => {
    const response = await apiClient.post<ScheduledTransaction>('/scheduled-transactions', data);
    return response.data;
  },

  // Get all scheduled transactions
  getAll: async (): Promise<ScheduledTransaction[]> => {
    const response = await apiClient.get<ScheduledTransaction[]>('/scheduled-transactions');
    return response.data;
  },

  // Get due scheduled transactions (past due date)
  getDue: async (): Promise<ScheduledTransaction[]> => {
    const response = await apiClient.get<ScheduledTransaction[]>('/scheduled-transactions/due');
    return response.data;
  },

  // Get upcoming scheduled transactions
  getUpcoming: async (days?: number): Promise<ScheduledTransaction[]> => {
    const response = await apiClient.get<ScheduledTransaction[]>('/scheduled-transactions/upcoming', {
      params: days ? { days } : undefined,
    });
    return response.data;
  },

  // Get single scheduled transaction by ID
  getById: async (id: string): Promise<ScheduledTransaction> => {
    const response = await apiClient.get<ScheduledTransaction>(`/scheduled-transactions/${id}`);
    return response.data;
  },

  // Update scheduled transaction
  update: async (
    id: string,
    data: UpdateScheduledTransactionData,
  ): Promise<ScheduledTransaction> => {
    const response = await apiClient.patch<ScheduledTransaction>(
      `/scheduled-transactions/${id}`,
      data,
    );
    return response.data;
  },

  // Delete scheduled transaction
  delete: async (id: string): Promise<void> => {
    await apiClient.delete(`/scheduled-transactions/${id}`);
  },

  // Post scheduled transaction (create actual transaction and advance)
  post: async (id: string, transactionDate?: string): Promise<ScheduledTransaction> => {
    const response = await apiClient.post<ScheduledTransaction>(
      `/scheduled-transactions/${id}/post`,
      { transactionDate },
    );
    return response.data;
  },

  // Skip this occurrence and advance to next due date
  skip: async (id: string): Promise<ScheduledTransaction> => {
    const response = await apiClient.post<ScheduledTransaction>(
      `/scheduled-transactions/${id}/skip`,
    );
    return response.data;
  },
};
