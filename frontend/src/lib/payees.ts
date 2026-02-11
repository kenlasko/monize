import apiClient from './api';
import {
  Payee,
  CreatePayeeData,
  UpdatePayeeData,
  PayeeSummary,
  CategorySuggestion,
  CategorySuggestionsParams,
  CategoryAssignment,
} from '@/types/payee';
import { getCached, setCache, invalidateCache } from './apiCache';

export const payeesApi = {
  // Create payee
  create: async (data: CreatePayeeData): Promise<Payee> => {
    const response = await apiClient.post<Payee>('/payees', data);
    invalidateCache('payees:');
    return response.data;
  },

  // Get all payees
  getAll: async (): Promise<Payee[]> => {
    const cached = getCached<Payee[]>('payees:all');
    if (cached) return cached;
    const response = await apiClient.get<Payee[]>('/payees');
    setCache('payees:all', response.data);
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

  // Search payees
  search: async (query: string, limit: number = 10): Promise<Payee[]> => {
    const response = await apiClient.get<Payee[]>('/payees/search', {
      params: { q: query, limit },
    });
    return response.data;
  },

  // Autocomplete payees
  autocomplete: async (query: string): Promise<Payee[]> => {
    const response = await apiClient.get<Payee[]>('/payees/autocomplete', {
      params: { q: query },
    });
    return response.data;
  },

  // Get most used payees
  getMostUsed: async (limit: number = 10): Promise<Payee[]> => {
    const response = await apiClient.get<Payee[]>('/payees/most-used', {
      params: { limit },
    });
    return response.data;
  },

  // Get recently used payees
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

  // Apply category auto-assignments
  applyCategorySuggestions: async (assignments: CategoryAssignment[]): Promise<{ updated: number }> => {
    const response = await apiClient.post<{ updated: number }>('/payees/category-suggestions/apply', assignments);
    invalidateCache('payees:');
    return response.data;
  },
};
