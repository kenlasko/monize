import apiClient from './api';
import {
  ScheduledTransaction,
  CreateScheduledTransactionData,
  UpdateScheduledTransactionData,
  ScheduledTransactionOverride,
  CreateScheduledTransactionOverrideData,
  UpdateScheduledTransactionOverrideData,
  OverrideCheckResult,
  PostScheduledTransactionData,
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
  post: async (id: string, data?: PostScheduledTransactionData): Promise<ScheduledTransaction> => {
    const response = await apiClient.post<ScheduledTransaction>(
      `/scheduled-transactions/${id}/post`,
      data || {},
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

  // ==================== Override Methods ====================

  // Get all overrides for a scheduled transaction
  getOverrides: async (scheduledTransactionId: string): Promise<ScheduledTransactionOverride[]> => {
    const response = await apiClient.get<ScheduledTransactionOverride[]>(
      `/scheduled-transactions/${scheduledTransactionId}/overrides`,
    );
    return response.data;
  },

  // Check if a scheduled transaction has any overrides
  hasOverrides: async (scheduledTransactionId: string): Promise<OverrideCheckResult> => {
    const response = await apiClient.get<OverrideCheckResult>(
      `/scheduled-transactions/${scheduledTransactionId}/overrides/check`,
    );
    return response.data;
  },

  // Get override for a specific date
  getOverrideByDate: async (
    scheduledTransactionId: string,
    date: string,
  ): Promise<ScheduledTransactionOverride | null> => {
    const response = await apiClient.get<ScheduledTransactionOverride | null>(
      `/scheduled-transactions/${scheduledTransactionId}/overrides/date/${date}`,
    );
    return response.data;
  },

  // Create an override for a specific occurrence
  createOverride: async (
    scheduledTransactionId: string,
    data: CreateScheduledTransactionOverrideData,
  ): Promise<ScheduledTransactionOverride> => {
    const response = await apiClient.post<ScheduledTransactionOverride>(
      `/scheduled-transactions/${scheduledTransactionId}/overrides`,
      data,
    );
    return response.data;
  },

  // Get a specific override by ID
  getOverride: async (
    scheduledTransactionId: string,
    overrideId: string,
  ): Promise<ScheduledTransactionOverride> => {
    const response = await apiClient.get<ScheduledTransactionOverride>(
      `/scheduled-transactions/${scheduledTransactionId}/overrides/${overrideId}`,
    );
    return response.data;
  },

  // Update an override
  updateOverride: async (
    scheduledTransactionId: string,
    overrideId: string,
    data: UpdateScheduledTransactionOverrideData,
  ): Promise<ScheduledTransactionOverride> => {
    const response = await apiClient.patch<ScheduledTransactionOverride>(
      `/scheduled-transactions/${scheduledTransactionId}/overrides/${overrideId}`,
      data,
    );
    return response.data;
  },

  // Delete an override
  deleteOverride: async (scheduledTransactionId: string, overrideId: string): Promise<void> => {
    await apiClient.delete(`/scheduled-transactions/${scheduledTransactionId}/overrides/${overrideId}`);
  },

  // Delete all overrides for a scheduled transaction
  deleteAllOverrides: async (scheduledTransactionId: string): Promise<number> => {
    const response = await apiClient.delete<number>(
      `/scheduled-transactions/${scheduledTransactionId}/overrides`,
    );
    return response.data;
  },
};
