import apiClient from './api';
import {
  Payee,
  CreatePayeeData,
  UpdatePayeeData,
  PayeeSummary,
  CategorySuggestion,
  CategorySuggestionsParams,
  CategoryAssignment,
  DeactivationPreviewParams,
  DeactivationCandidate,
  PayeeDetail,
  PayeeContactLookupContext,
  PayeeContactLookupResult,
  PayeeStatusFilter,
  PayeeAlias,
  CreatePayeeAliasData,
  MergePayeeData,
  MergePayeeResult,
  AutoMergePreviewParams,
  AutoMergeGroup,
  ApplyAutoMergeGroup,
  ApplyAutoMergeResult,
} from '@/types/payee';
import { dedupe, invalidateBalanceCaches, invalidateCache } from './apiCache';

/**
 * Same-origin URL for a payee's cached brand favicon. Rendered directly in an
 * <img>; the request carries the auth cookie and never contacts a third party.
 * Returns 404 when no logo is cached, so callers should provide a fallback
 * (handled by the PayeeLogo component's onError).
 */
export function payeeLogoUrl(id: string): string {
  return `/api/v1/payees/${id}/logo`;
}

export const payeesApi = {
  // Re-fetch the payee's brand favicon from its current website
  refreshLogo: async (id: string): Promise<Payee> => {
    const response = await apiClient.post<Payee>(`/payees/${id}/refresh-logo`);
    invalidateCache('payees:');
    return response.data;
  },

  // Look a name up without saving anything (the form's prefill). Takes an
  // AbortSignal so a superseded request can be cancelled rather than adopted.
  // `context` is whatever the form already holds (a half-typed address, a
  // note): it steers the lookup to the right organisation and the right
  // branch of it, and this endpoint stores none of it.
  lookupContact: async (
    name: string,
    context?: PayeeContactLookupContext,
    signal?: AbortSignal,
  ): Promise<PayeeContactLookupResult> => {
    const response = await apiClient.post<PayeeContactLookupResult>(
      '/payees/lookup-contact',
      { name, ...context },
      { signal },
    );
    return response.data;
  },

  // Look an existing payee up and return the candidates. This writes nothing:
  // the detail screen confirms the change with the user, and their
  // confirmation goes through `update` as their own edit -- so no cache is
  // invalidated here either.
  lookupContactForPayee: async (id: string): Promise<PayeeContactLookupResult> => {
    const response = await apiClient.post<PayeeContactLookupResult>(
      `/payees/${id}/lookup-contact`,
    );
    return response.data;
  },

  // Create payee
  create: async (data: CreatePayeeData): Promise<Payee> => {
    const response = await apiClient.post<Payee>('/payees', data);
    invalidateCache('payees:');
    return response.data;
  },

  // Get all payees (optionally filtered by status)
  getAll: async (status?: PayeeStatusFilter): Promise<Payee[]> => {
    const cacheKey = `payees:all:${status || 'default'}`;
    const params: Record<string, string> = {};
    if (status) {
      params.status = status;
    }
    return dedupe(
      cacheKey,
      async () => {
        const response = await apiClient.get<Payee[]>('/payees', { params });
        return response.data;
      },
      300_000, // 5 min
    );
  },

  // Get payee by ID
  getById: async (id: string): Promise<Payee> => {
    const response = await apiClient.get<Payee>(`/payees/${id}`);
    return response.data;
  },

  // Get the detail-page aggregate (stats, account breakdown, largest transaction)
  getDetail: async (id: string): Promise<PayeeDetail> => {
    const response = await apiClient.get<PayeeDetail>(`/payees/${id}/detail`, { params: { basis: 'cash' } });
    return response.data;
  },

  // Update payee. When the update applies the default category to existing
  // transactions, the response also reports how many were categorized.
  update: async (
    id: string,
    data: UpdatePayeeData,
  ): Promise<Payee & { transactionsCategorized?: number }> => {
    const response = await apiClient.patch<Payee & { transactionsCategorized?: number }>(
      `/payees/${id}`,
      data,
    );
    invalidateCache('payees:');
    // Categorising existing transactions moves budget roll-ups.
    const categorized = response.data.transactionsCategorized;
    if (typeof categorized === 'number' && categorized > 0) invalidateBalanceCaches();
    return response.data;
  },

  // Delete payee
  delete: async (id: string): Promise<void> => {
    await apiClient.delete(`/payees/${id}`);
    invalidateCache('payees:');
  },

  // Search payees (only active)
  search: async (query: string, limit: number = 10): Promise<Payee[]> => {
    const response = await apiClient.get<Payee[]>('/payees/search', {
      params: { q: query, limit },
    });
    return response.data;
  },

  // Autocomplete payees (only active)
  autocomplete: async (query: string): Promise<Payee[]> => {
    const response = await apiClient.get<Payee[]>('/payees/autocomplete', {
      params: { q: query },
    });
    return response.data;
  },

  // Get most used payees (only active)
  getMostUsed: async (limit: number = 10): Promise<Payee[]> => {
    const response = await apiClient.get<Payee[]>('/payees/most-used', {
      params: { limit },
    });
    return response.data;
  },

  // Get recently used payees (only active)
  getRecentlyUsed: async (limit: number = 10): Promise<Payee[]> => {
    const response = await apiClient.get<Payee[]>('/payees/recently-used', {
      params: { limit },
    });
    return response.data;
  },

  // Get payee summary
  getSummary: async (): Promise<PayeeSummary> => {
    const response = await apiClient.get<PayeeSummary>('/payees/summary');
    return response.data;
  },

  // Get payees by category
  getByCategory: async (categoryId: string): Promise<Payee[]> => {
    const response = await apiClient.get<Payee[]>(`/payees/by-category/${categoryId}`);
    return response.data;
  },

  // Get category auto-assignment suggestions
  getCategorySuggestions: async (params: CategorySuggestionsParams): Promise<CategorySuggestion[]> => {
    const response = await apiClient.get<CategorySuggestion[]>('/payees/category-suggestions/preview', {
      params: {
        minTransactions: params.minTransactions,
        minPercentage: params.minPercentage,
        onlyWithoutCategory: params.onlyWithoutCategory ?? true,
      },
    });
    return response.data;
  },

  // Apply category auto-assignments (batches in chunks of 500 to respect server limit)
  applyCategorySuggestions: async (assignments: CategoryAssignment[]): Promise<{ updated: number; transactionsBackfilled: number }> => {
    const BATCH_SIZE = 500;
    let totalUpdated = 0;
    let totalBackfilled = 0;

    for (let i = 0; i < assignments.length; i += BATCH_SIZE) {
      const batch = assignments.slice(i, i + BATCH_SIZE);
      const response = await apiClient.post<{ updated: number; transactionsBackfilled: number }>('/payees/category-suggestions/apply', { assignments: batch });
      totalUpdated += response.data.updated;
      totalBackfilled += response.data.transactionsBackfilled;
    }

    invalidateCache('payees:');
    // A backfill sets category_id on existing transactions, which moves budget roll-ups.
    if (totalBackfilled > 0) invalidateBalanceCaches();
    return { updated: totalUpdated, transactionsBackfilled: totalBackfilled };
  },

  // Preview deactivation candidates
  getDeactivationPreview: async (params: DeactivationPreviewParams): Promise<DeactivationCandidate[]> => {
    const response = await apiClient.get<DeactivationCandidate[]>('/payees/deactivation/preview', {
      params: {
        maxTransactions: params.maxTransactions,
        monthsUnused: params.monthsUnused,
      },
    });
    return response.data;
  },

  // Bulk deactivate payees (batches in chunks of 500 to respect server limit)
  deactivatePayees: async (payeeIds: string[]): Promise<{ deactivated: number }> => {
    const BATCH_SIZE = 500;
    let totalDeactivated = 0;

    for (let i = 0; i < payeeIds.length; i += BATCH_SIZE) {
      const batch = payeeIds.slice(i, i + BATCH_SIZE);
      const response = await apiClient.post<{ deactivated: number }>('/payees/deactivation/apply', { payeeIds: batch });
      totalDeactivated += response.data.deactivated;
    }

    invalidateCache('payees:');
    return { deactivated: totalDeactivated };
  },

  // Reactivate a payee
  reactivatePayee: async (id: string): Promise<Payee> => {
    const response = await apiClient.post<Payee>(`/payees/${id}/reactivate`);
    invalidateCache('payees:');
    return response.data;
  },

  // Check if a payee name matches an inactive payee
  findInactiveByName: async (name: string): Promise<Payee | null> => {
    const response = await apiClient.get<Payee | null>('/payees/inactive/match', {
      params: { name },
    });
    return response.data;
  },

  // ===== Alias Methods =====

  // Get aliases for a specific payee
  getAliases: async (payeeId: string): Promise<PayeeAlias[]> => {
    const response = await apiClient.get<PayeeAlias[]>(`/payees/${payeeId}/aliases`);
    return response.data;
  },

  // Get all aliases for the user
  getAllAliases: async (): Promise<PayeeAlias[]> => {
    const response = await apiClient.get<PayeeAlias[]>('/payees/aliases');
    return response.data;
  },

  // Create alias
  createAlias: async (data: CreatePayeeAliasData): Promise<PayeeAlias> => {
    const response = await apiClient.post<PayeeAlias>('/payees/aliases', data);
    invalidateCache('payees:');
    return response.data;
  },

  // Delete alias
  deleteAlias: async (aliasId: string): Promise<void> => {
    await apiClient.delete(`/payees/aliases/${aliasId}`);
    invalidateCache('payees:');
  },

  // ===== Merge Methods =====

  // Merge one payee into another
  mergePayees: async (data: MergePayeeData): Promise<MergePayeeResult> => {
    const response = await apiClient.post<MergePayeeResult>('/payees/merge', data);
    invalidateCache('payees:');
    return response.data;
  },

  // ===== Auto-Merge Methods =====

  // Preview auto-merge groups of near-duplicate payees
  getAutoMergePreview: async (params: AutoMergePreviewParams): Promise<AutoMergeGroup[]> => {
    const response = await apiClient.get<{ groups: AutoMergeGroup[] }>('/payees/auto-merge/preview', {
      params: {
        minGroupSize: params.minGroupSize,
        similarityThreshold: params.similarityThreshold,
        minTokenLength: params.minTokenLength,
        includeInactive: params.includeInactive,
        categoryMatch: params.categoryMatch,
        ignoreCommonWords: params.ignoreCommonWords,
        commonWordMinVariants: params.commonWordMinVariants,
      },
    });
    return response.data.groups;
  },

  // Apply the chosen auto-merge groups
  applyAutoMerge: async (groups: ApplyAutoMergeGroup[]): Promise<ApplyAutoMergeResult> => {
    const response = await apiClient.post<ApplyAutoMergeResult>('/payees/auto-merge/apply', { groups });
    invalidateCache('payees:');
    return response.data;
  },
};
