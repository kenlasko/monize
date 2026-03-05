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
} from '@/types/payee';
import { getCached, setCache, invalidateCache } from './apiCache';

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
    const cached = getCached<Payee[]>(cacheKey);
    if (cached) return cached;
    const params: Record<string, string> = {};
    if (status) {
      params.status = status;
    }
    const response = await apiClient.get<Payee[]>('/payees', { params });
    setCache(cacheKey, response.data);
    return response.data;
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
  applyCategorySuggestions: async (assignments: CategoryAssignment[]): Promise<{ updated: number }> => {
    const BATCH_SIZE = 500;
    let totalUpdated = 0;

    for (let i = 0; i < assignments.length; i += BATCH_SIZE) {
      const batch = assignments.slice(i, i + BATCH_SIZE);
      const response = await apiClient.post<{ updated: number }>('/payees/category-suggestions/apply', { assignments: batch });
      totalUpdated += response.data.updated;
    }

    invalidateCache('payees:');
    return { updated: totalUpdated };
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
};
