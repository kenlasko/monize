import apiClient from './api';
import { Category, CreateCategoryData, UpdateCategoryData } from '@/types/category';

export const categoriesApi = {
  // Create category
  create: async (data: CreateCategoryData): Promise<Category> => {
    const response = await apiClient.post<Category>('/categories', data);
    return response.data;
  },

  // Get all categories
  getAll: async (): Promise<Category[]> => {
    const response = await apiClient.get<Category[]>('/categories');
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
    return response.data;
  },

  // Delete category
  delete: async (id: string): Promise<void> => {
    await apiClient.delete(`/categories/${id}`);
  },
};
