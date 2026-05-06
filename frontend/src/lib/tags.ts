import apiClient from './api';
import { Tag, CreateTagData, UpdateTagData } from '@/types/tag';
import { dedupe, invalidateCache } from './apiCache';

export const tagsApi = {
  create: async (data: CreateTagData): Promise<Tag> => {
    const response = await apiClient.post<Tag>('/tags', data);
    invalidateCache('tags:');
    return response.data;
  },

  getAll: async (): Promise<Tag[]> => {
    return dedupe(
      'tags:all',
      async () => {
        const response = await apiClient.get<Tag[]>('/tags');
        return response.data;
      },
      300_000, // 5 min
    );
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
