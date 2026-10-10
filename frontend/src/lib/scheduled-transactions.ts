import apiClient from './api';
import {
  ScheduledTransaction,
  ScheduledOccurrence,
  CreateScheduledTransactionData,
  UpdateScheduledTransactionData,
  ScheduledTransactionOverride,
  CreateScheduledTransactionOverrideData,
  UpdateScheduledTransactionOverrideData,
  OverrideCheckResult,
  PostScheduledTransactionData,
  LoanProjectionAnchor,
  LoanOccurrencesProjection,
} from '@/types/scheduled-transaction';
import { dedupe, invalidateBalanceCaches, invalidateCache } from './apiCache';

/** The most occurrences one loan projection prices (spec 8.5; the server's DTO bound). */
export const LOAN_OCCURRENCES_MAX_COUNT = 60;

export const scheduledTransactionsApi = {
  // Create a new scheduled transaction
  create: async (data: CreateScheduledTransactionData): Promise<ScheduledTransaction> => {
    const response = await apiClient.post<ScheduledTransaction>('/scheduled-transactions', data);
    invalidateCache('scheduled:');
    return response.data;
  },

  // Get all scheduled transactions
  getAll: async (): Promise<ScheduledTransaction[]> => {
    return dedupe(
      'scheduled:all',
      async () => {
        const response = await apiClient.get<ScheduledTransaction[]>('/scheduled-transactions');
        return response.data;
      },
      120_000, // 2 min
    );
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

  /**
   * The occurrences due through `through`, each priced at what it would post
   * today (issue #1247).
   *
   * A client cannot work this out for itself: expanding the recurrence in the
   * browser gives dates but no per-occurrence amount, which is how the Upcoming
   * Bills report came to apply one schedule-level figure to every projected
   * occurrence and export it. `maxPerSchedule` bounds the payload and is applied
   * after ordering by due date, so what comes back is always the next ones.
   */
  getOccurrences: async (params: {
    through: string;
    maxPerSchedule?: number;
  }): Promise<ScheduledOccurrence[]> => {
    const response = await apiClient.get<ScheduledOccurrence[]>(
      '/scheduled-transactions/occurrences',
      { params },
    );
    return response.data;
  },

  /**
   * The next-installment projection anchor for a loan account: the next
   * scheduled installment's due date and the debt measured from the ledger
   * through that date -- the same balance boundary the scheduled bill's
   * interest is calculated from, so an amortization projection anchored here
   * agrees with the next bill (issue #1253). Both fields are null when the
   * loan has no active scheduled payment; the caller then keeps its
   * today-anchored fallback.
   */
  getLoanProjectionAnchor: async (
    accountId: string,
  ): Promise<LoanProjectionAnchor> => {
    const response = await apiClient.get<LoanProjectionAnchor>(
      `/scheduled-transactions/loan-anchor/${accountId}`,
    );
    return response.data;
  },

  /**
   * The next `count` occurrences of a loan bill, each priced at its own due
   * date on the debt the earlier ones leave (INV-LOAN-009). The server bounds
   * `count` to `LOAN_OCCURRENCES_MAX_COUNT`. Not cached: the answer moves with
   * every posting, override and rate change on the loan.
   */
  getLoanOccurrences: async (
    id: string,
    count: number,
  ): Promise<LoanOccurrencesProjection> => {
    const response = await apiClient.get<LoanOccurrencesProjection>(
      `/scheduled-transactions/${id}/loan-occurrences`,
      { params: { count } },
    );
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
    invalidateCache('scheduled:');
    return response.data;
  },

  // Delete scheduled transaction
  delete: async (id: string): Promise<void> => {
    await apiClient.delete(`/scheduled-transactions/${id}`);
    invalidateCache('scheduled:');
  },

  // Post scheduled transaction (create actual transaction and advance).
  // Returns null when the scheduled transaction was a one-time entry and was
  // deleted as part of the post.
  post: async (id: string, data?: PostScheduledTransactionData): Promise<ScheduledTransaction | null> => {
    const response = await apiClient.post<ScheduledTransaction | null>(
      `/scheduled-transactions/${id}/post`,
      data || {},
    );
    invalidateCache('scheduled:');
    // Posting writes a real transaction, so every balance derived from it is
    // now stale. Without this the Accounts page shows the pre-post balance for
    // up to two minutes, including after navigating back to it.
    invalidateBalanceCaches();
    return response.data;
  },

  // Skip this occurrence and advance to next due date
  skip: async (id: string): Promise<ScheduledTransaction> => {
    const response = await apiClient.post<ScheduledTransaction>(
      `/scheduled-transactions/${id}/skip`,
    );
    invalidateCache('scheduled:');
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
    invalidateCache('scheduled:');
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
    invalidateCache('scheduled:');
    return response.data;
  },

  // Delete an override
  deleteOverride: async (scheduledTransactionId: string, overrideId: string): Promise<void> => {
    await apiClient.delete(`/scheduled-transactions/${scheduledTransactionId}/overrides/${overrideId}`);
    invalidateCache('scheduled:');
  },

  // Delete all overrides for a scheduled transaction
  deleteAllOverrides: async (scheduledTransactionId: string): Promise<number> => {
    const response = await apiClient.delete<number>(
      `/scheduled-transactions/${scheduledTransactionId}/overrides`,
    );
    invalidateCache('scheduled:');
    return response.data;
  },
};
