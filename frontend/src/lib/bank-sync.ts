import apiClient from './api';
import { dedupe, invalidateBalanceCaches, invalidateCache } from './apiCache';
import { isUnknownSyncOutcome } from './bank-sync-outcome';
import type {
  BankInstitution,
  BankSyncAccount,
  BankSyncAuthorizationStart,
  BankSyncCallbackPayload,
  BankSyncConnection,
  BankSyncConnectionEntry,
  BankSyncCredentialsTestResult,
  BankSyncLinkDefaults,
  BankSyncMatchedConnection,
  BankSyncPreview,
  BankSyncRemovedExceptions,
  BankSyncResult,
  BankSyncSelection,
  BankSyncStatus,
  CreateBankSyncConnection,
  SaveBankSyncCredentials,
  UpdateBankSyncAccount,
  UpdateBankSyncConnection,
} from '@/types/bank-sync';

/**
 * A sync reads every page of the bank's booked rows before it writes, so it
 * outlasts the client's 10s default. The server's own lease is 30 minutes, so a
 * sync can still be running when this gives up: see `isUnknownSyncOutcome`.
 */
const SYNC_TIMEOUT_MS = 120_000;

/** True when any account of the answer wrote a transaction row. */
function wroteRows(entries: readonly BankSyncConnectionEntry[]): boolean {
  return entries.some((entry) => 'imported' in entry && entry.imported > 0);
}

/**
 * The bank sync client.
 *
 * Every write drops the `bank-sync:` prefix, so the settings page never shows a
 * connection list that predates its own action. The two sync routes also write
 * transaction rows, so they drop the balance caches -- but only when a row was
 * actually written (`imported > 0`): a sync that found nothing new moved no
 * balance, and dropping the account and portfolio caches costs a fresh
 * valuation to redraw the same numbers (`docs/frontend/api-and-cache.md`, "A
 * write that wrote nothing is not a write"). A sync that FAILED still drops
 * `bank-sync:`, because the server records the failure on the bank account row.
 */
export const bankSyncApi = {
  getStatus: async (): Promise<BankSyncStatus> =>
    dedupe(
      'bank-sync:status',
      async () => (await apiClient.get<BankSyncStatus>('/bank-sync/status')).data,
      30_000,
    ),

  /** Answers with the status, so the caller needs no second read. */
  saveCredentials: async (
    data: SaveBankSyncCredentials,
  ): Promise<BankSyncStatus> => {
    const response = await apiClient.put<BankSyncStatus>(
      '/bank-sync/credentials',
      data,
    );
    invalidateCache('bank-sync:');
    return response.data;
  },

  deleteCredentials: async (): Promise<void> => {
    await apiClient.delete('/bank-sync/credentials');
    invalidateCache('bank-sync:');
  },

  /**
   * Ask the provider whether the stored application works. Costs a real
   * request and changes nothing stored, so it drops no cache.
   */
  testCredentials: async (): Promise<BankSyncCredentialsTestResult> =>
    (
      await apiClient.post<BankSyncCredentialsTestResult>(
        '/bank-sync/credentials/test',
      )
    ).data,

  listInstitutions: async (country: string): Promise<BankInstitution[]> =>
    dedupe(
      `bank-sync:institutions:${country}`,
      async () =>
        (
          await apiClient.get<BankInstitution[]>('/bank-sync/institutions', {
            params: { country },
          })
        ).data,
      5 * 60_000,
    ),

  listConnections: async (): Promise<BankSyncConnection[]> =>
    dedupe(
      'bank-sync:connections',
      async () =>
        (await apiClient.get<BankSyncConnection[]>('/bank-sync/connections'))
          .data,
      30_000,
    ),

  createConnection: async (
    data: CreateBankSyncConnection,
  ): Promise<BankSyncAuthorizationStart> => {
    const response = await apiClient.post<BankSyncAuthorizationStart>(
      '/bank-sync/connections',
      data,
    );
    invalidateCache('bank-sync:');
    return response.data;
  },

  reauthorize: async (id: string): Promise<BankSyncAuthorizationStart> => {
    const response = await apiClient.post<BankSyncAuthorizationStart>(
      `/bank-sync/connections/${id}/reauthorize`,
    );
    invalidateCache('bank-sync:');
    return response.data;
  },

  /**
   * Answers with the connection and what the server linked on its own: every
   * unlinked bank account whose number names exactly one Monize account.
   */
  completeCallback: async (
    payload: BankSyncCallbackPayload,
  ): Promise<BankSyncMatchedConnection> => {
    try {
      const response = await apiClient.post<BankSyncMatchedConnection>(
        '/bank-sync/callback',
        payload,
      );
      return response.data;
    } finally {
      // Refused or not, the callback may have moved the row (an error at the
      // bank marks it failed), so the list is read again either way.
      invalidateCache('bank-sync:');
    }
  },

  updateConnection: async (
    id: string,
    data: UpdateBankSyncConnection,
  ): Promise<BankSyncConnection> => {
    const response = await apiClient.patch<BankSyncConnection>(
      `/bank-sync/connections/${id}`,
      data,
    );
    invalidateCache('bank-sync:');
    return response.data;
  },

  deleteConnection: async (id: string): Promise<void> => {
    await apiClient.delete(`/bank-sync/connections/${id}`);
    invalidateCache('bank-sync:');
  },

  /**
   * Match the connection's bank accounts to Monize accounts by account number
   * and link the unambiguous ones. A connection made before identifiers were
   * kept has them read from the bank first, so this can outlast the default
   * timeout. It links accounts but moves no balance, so it drops `bank-sync:`
   * alone.
   */
  matchAccounts: async (id: string): Promise<BankSyncMatchedConnection> => {
    try {
      const response = await apiClient.post<BankSyncMatchedConnection>(
        `/bank-sync/connections/${id}/match`,
        undefined,
        { timeout: SYNC_TIMEOUT_MS },
      );
      return response.data;
    } finally {
      invalidateCache('bank-sync:');
    }
  },

  /**
   * The start date a link to `accountId` would get, and the newest transaction
   * it follows. Read on demand and never cached: the account's newest
   * transaction is whatever it is now.
   */
  getLinkDefaults: async (
    id: string,
    accountId: string,
  ): Promise<BankSyncLinkDefaults> =>
    (
      await apiClient.get<BankSyncLinkDefaults>(
        `/bank-sync/accounts/${id}/link-defaults`,
        { params: { accountId } },
      )
    ).data,

  updateAccount: async (
    id: string,
    data: UpdateBankSyncAccount,
  ): Promise<BankSyncAccount> => {
    const response = await apiClient.patch<BankSyncAccount>(
      `/bank-sync/accounts/${id}`,
      data,
    );
    invalidateCache('bank-sync:');
    return response.data;
  },

  /**
   * What a sync of this account would do, listed row by row; nothing is
   * written. It reads the bank, so it takes a sync's timeout. A failure drops
   * `bank-sync:` because the server may have recorded a lapsed consent on the
   * connection; a success changes nothing a cache holds.
   */
  previewAccount: async (id: string): Promise<BankSyncPreview> => {
    try {
      const response = await apiClient.post<BankSyncPreview>(
        `/bank-sync/accounts/${id}/preview`,
        undefined,
        { timeout: SYNC_TIMEOUT_MS },
      );
      return response.data;
    } catch (error) {
      invalidateCache('bank-sync:');
      throw error;
    }
  },

  /**
   * Sync one account. With the `planFingerprint` of a preview the server
   * imports exactly the rows that preview listed and answers 409 when the
   * bank's data has changed since. With a `selection` (the person's choice in
   * the preview) it imports only `importKeys` and adds `excludeKeys` to the
   * exceptions; it answers 400 for a key that is not a new row. A selection
   * with no `importKeys` is still a selection: it imports nothing.
   */
  syncAccount: async (
    id: string,
    planFingerprint?: string,
    selection?: BankSyncSelection,
  ): Promise<BankSyncResult> => {
    const body = {
      ...(planFingerprint ? { planFingerprint } : {}),
      ...(selection
        ? { importKeys: selection.importKeys, excludeKeys: selection.excludeKeys }
        : {}),
    };
    try {
      const response = await apiClient.post<BankSyncResult>(
        `/bank-sync/accounts/${id}/sync`,
        Object.keys(body).length > 0 ? body : undefined,
        { timeout: SYNC_TIMEOUT_MS },
      );
      if (wroteRows([response.data])) invalidateBalanceCaches();
      return response.data;
    } catch (error) {
      if (isUnknownSyncOutcome(error)) invalidateBalanceCaches();
      throw error;
    } finally {
      invalidateCache('bank-sync:');
    }
  },

  /**
   * Take exceptions back (spec section 7b): the next preview lists those bank
   * transactions as new again. Moves no balance, so it drops `bank-sync:` alone.
   */
  removeExceptions: async (
    id: string,
    keys: readonly string[],
  ): Promise<BankSyncRemovedExceptions> => {
    try {
      const response = await apiClient.post<BankSyncRemovedExceptions>(
        `/bank-sync/accounts/${id}/exceptions/remove`,
        { keys: [...keys] },
      );
      return response.data;
    } finally {
      invalidateCache('bank-sync:');
    }
  },

  /**
   * One entry per linked account: its result, or `{ bankAccountId, error }` for
   * an account that could not be synced. Rejects only when the connection
   * itself is unusable before any account was attempted.
   */
  syncConnection: async (id: string): Promise<BankSyncConnectionEntry[]> => {
    try {
      const response = await apiClient.post<BankSyncConnectionEntry[]>(
        `/bank-sync/connections/${id}/sync`,
        undefined,
        { timeout: SYNC_TIMEOUT_MS },
      );
      if (wroteRows(response.data)) invalidateBalanceCaches();
      return response.data;
    } catch (error) {
      if (isUnknownSyncOutcome(error)) invalidateBalanceCaches();
      throw error;
    } finally {
      invalidateCache('bank-sync:');
    }
  },
};
