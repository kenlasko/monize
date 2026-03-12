import apiClient from './api';
import { Tag, CreateTagData, UpdateTagData } from '@/types/tag';
import { getCached, setCache, invalidateCache } from './apiCache';

export const tagsApi = {
  create: async (data: CreateTagData): Promise<Tag> => {
    const response = await apiClient.post<Tag>('/tags', data);
    invalidateCache('tags:');
    return response.data;
  },

  getAll: async (): Promise<Tag[]> => {
    const cached = getCached<Tag[]>('tags:all');
    if (cached) return cached;
    const response = await apiClient.get<Tag[]>('/tags');
    setCache('tags:all', response.data);
    return response.data;
  },

  getById: async (id: string): Promise<Tag> => {
    const response = await apiClient.get<Tag>(`/tags/${id}`);
    return response.data;
  },

  update: async (id: string, data: UpdateTagData): Promise<Tag> => {
    const response = await apiClient.patch<Tag>(`/tags/${id}`, data);
    invalidateCache('tags:');
    return response.data;
  },

  delete: async (id: string): Promise<void> => {
    await apiClient.delete(`/tags/${id}`);
    invalidateCache('tags:');
  },

  getTransactionCount: async (id: string): Promise<number> => {
    const response = await apiClient.get<number>(`/tags/${id}/transaction-count`);
    return response.data;
  },

  getAllTransactionCounts: async (): Promise<Record<string, number>> => {
    const response = await apiClient.get<Record<string, number>>('/tags/transaction-counts');
    return response.data;
  },
};
