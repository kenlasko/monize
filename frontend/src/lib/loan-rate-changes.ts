import apiClient from './api';
import { dedupe, invalidateCache } from './apiCache';
import {
  LoanRateChange,
  CreateLoanRateChangeData,
  CreateLoanRateChangeResult,
  RemoveLoanRateChangeResult,
  UpdateLoanRateChangeData,
  DetectRateChangesResult,
  ScheduledPaymentPreview,
} from '@/types/loan-rate-change';
import type { Account } from '@/types/account';

const cachePrefix = (accountId: string) => `loan-rate-changes:${accountId}`;

/**
 * The account types the rate-changes endpoints accept. Every route under
 * `/accounts/:id/rate-changes` goes through `LoanRateChangesService
 * .verifyLoanAccount`, which answers **400** for anything else -- so this is not
 * a display preference, it is the request's precondition, and asking for a line
 * of credit's rate history is an error rather than an empty list.
 *
 * It lives here, beside the client, because the callers are surfaces that list
 * *debt* accounts (LOAN, MORTGAGE and LINE_OF_CREDIT) and so cannot assume the
 * selected one qualifies. Both loan reports fetched unconditionally and a
 * selected line of credit turned the whole report into its error state --
 * persisted in localStorage, so it stayed broken across reloads with no in-page
 * way to choose another account.
 *
 * Exported because two other lists answer the same question for their own
 * reasons and must not be spelled a second time: the projection hook's
 * "amortizing debt" set (a revolving line does not amortize, which is the same
 * fact that gives it no contractual rate to change) derives from this one, and
 * `loan-rate-changes.contract.test.ts` checks the derivation, the backend's
 * copy of the list, and the account page's detail-view registry against it.
 */
export const RATE_CHANGE_ACCOUNT_TYPES: ReadonlyArray<Account['accountType']> =
  ['LOAN', 'MORTGAGE'];

/** Whether `/accounts/:id/rate-changes` will answer for this account at all. */
export function supportsRateChanges(
  account: Pick<Account, 'accountType'> | null | undefined,
): boolean {
  return !!account && RATE_CHANGE_ACCOUNT_TYPES.includes(account.accountType);
}

/**
 * Both caches go: a mutation leaves the account's own rate/payment untouched
 * (they are user-owned) but can realign its linked scheduled payment, and every
 * loan projection resolves its current rate from these rows.
 */
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

  /**
   * Edit a rate change. Returns the row with `scheduledPaymentPreview`, the
   * way `create` does: the bill is rewritten only once the user confirms
   * through `applyScheduledPayment`.
   */
  update: async (
    accountId: string,
    id: string,
    data: UpdateLoanRateChangeData,
  ): Promise<CreateLoanRateChangeResult> => {
    const response = await apiClient.patch<CreateLoanRateChangeResult>(
      `/accounts/${accountId}/rate-changes/${id}`,
      data,
    );
    invalidateAfterMutation(accountId);
    return response.data;
  },

  /**
   * Delete a rate change. Returns the remaining timeline's
   * `scheduledPaymentPreview`; the bill is rewritten only once the user
   * confirms through `applyScheduledPayment`.
   */
  delete: async (
    accountId: string,
    id: string,
  ): Promise<RemoveLoanRateChangeResult> => {
    const response = await apiClient.delete<RemoveLoanRateChangeResult>(
      `/accounts/${accountId}/rate-changes/${id}`,
    );
    invalidateAfterMutation(accountId);
    return response.data;
  },

  detect: async (accountId: string): Promise<DetectRateChangesResult> => {
    const response = await apiClient.post<DetectRateChangesResult>(
      `/accounts/${accountId}/rate-changes/detect`,
    );
    invalidateAfterMutation(accountId);
    return response.data;
  },
};
