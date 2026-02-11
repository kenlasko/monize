import apiClient from './api';
import { Category, CreateCategoryData, UpdateCategoryData } from '@/types/category';
import { getCached, setCache, invalidateCache } from './apiCache';

export const categoriesApi = {
  // Create category
  create: async (data: CreateCategoryData): Promise<Category> => {
    const response = await apiClient.post<Category>('/categories', data);
    invalidateCache('categories:');
    return response.data;
  },

  // Get all categories
  getAll: async (): Promise<Category[]> => {
    const cached = getCached<Category[]>('categories:all');
    if (cached) return cached;
    const response = await apiClient.get<Category[]>('/categories');
    setCache('categories:all', response.data);
    return response.data;
  },

  // Get category by ID
  getById: async (id: string): Promise<Category> => {
    const response = await apiClient.get<Category>(`/categories/${id}`);
    return response.data;
  },

  // Update category
  update: async (id: string, data: UpdateCategoryData): Promise<Category> => {
    const response = await apiClient.patch<Category>(`/categories/${id}`, data);
    invalidateCache('categories:');
    return response.data;
  },

  // Delete category
  delete: async (id: string): Promise<void> => {
    await apiClient.delete(`/categories/${id}`);
    invalidateCache('categories:');
  },

  // Get transaction count for a category
  getTransactionCount: async (id: string): Promise<number> => {
    const response = await apiClient.get<number>(`/categories/${id}/transaction-count`);
    return response.data;
  },

  // Reassign transactions from one category to another
  reassignTransactions: async (
    fromCategoryId: string,
    toCategoryId: string | null,
  ): Promise<{ transactionsUpdated: number; splitsUpdated: number }> => {
    const response = await apiClient.post<{ transactionsUpdated: number; splitsUpdated: number }>(
      `/categories/${fromCategoryId}/reassign`,
      { toCategoryId },
    );
    return response.data;
  },

  // Import default categories for new users
  importDefaults: async (): Promise<{ categoriesCreated: number }> => {
    const response = await apiClient.post<{ categoriesCreated: number }>(
      '/categories/import-defaults',
    );
    invalidateCache('categories:');
    return response.data;
  },
};
