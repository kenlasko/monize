import apiClient from './api';
import { dedupe, invalidateCache } from './apiCache';
import {
  LoanRateChange,
  CreateLoanRateChangeData,
  CreateLoanRateChangeResult,
  UpdateLoanRateChangeData,
  DetectRateChangesResult,
  ScheduledPaymentPreview,
} from '@/types/loan-rate-change';

const cachePrefix = (accountId: string) => `loan-rate-changes:${accountId}`;

/** Mutations can move the account's current rate/payment, so both caches go */
function invalidateAfterMutation(accountId: string): void {
  invalidateCache(cachePrefix(accountId));
  invalidateCache('accounts:');
}

export const loanRateChangesApi = {
  getAll: async (accountId: string): Promise<LoanRateChange[]> => {
    return dedupe(
      `${cachePrefix(accountId)}:all`,
      async () => {
        const response = await apiClient.get<LoanRateChange[]>(
          `/accounts/${accountId}/rate-changes`,
        );
        return response.data;
      },
      120_000, // 2 min
    );
  },

  create: async (
    accountId: string,
    data: CreateLoanRateChangeData,
  ): Promise<CreateLoanRateChangeResult> => {
    const response = await apiClient.post<CreateLoanRateChangeResult>(
      `/accounts/${accountId}/rate-changes`,
      data,
    );
    invalidateAfterMutation(accountId);
    return response.data;
  },

  /**
   * Apply the pending scheduled bill-payment change after the user grants
   * permission from the rate-change confirmation prompt. Returns the applied
   * change, or null when there was nothing to sync.
   */
  applyScheduledPayment: async (
    accountId: string,
  ): Promise<ScheduledPaymentPreview | null> => {
    const response = await apiClient.post<ScheduledPaymentPreview | null>(
      `/accounts/${accountId}/rate-changes/apply-scheduled-payment`,
    );
    invalidateAfterMutation(accountId);
    return response.data;
  },

  update: async (
    accountId: string,
    id: string,
    data: UpdateLoanRateChangeData,
  ): Promise<LoanRateChange> => {
    const response = await apiClient.patch<LoanRateChange>(
      `/accounts/${accountId}/rate-changes/${id}`,
      data,
    );
    invalidateAfterMutation(accountId);
    return response.data;
  },

  delete: async (accountId: string, id: string): Promise<void> => {
    await apiClient.delete(`/accounts/${accountId}/rate-changes/${id}`);
    invalidateAfterMutation(accountId);
  },

  detect: async (accountId: string): Promise<DetectRateChangesResult> => {
    const response = await apiClient.post<DetectRateChangesResult>(
      `/accounts/${accountId}/rate-changes/detect`,
    );
    invalidateAfterMutation(accountId);
    return response.data;
  },
};
