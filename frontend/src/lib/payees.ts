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
import { dedupe, invalidateCache } from './apiCache';

export const payeesApi = {
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

  // Update payee
  update: async (id: string, data: UpdatePayeeData): Promise<Payee> => {
    const response = await apiClient.patch<Payee>(`/payees/${id}`, data);
    invalidateCache('payees:');
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
