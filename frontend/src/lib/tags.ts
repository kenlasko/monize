import apiClient from './api';
import { Tag, CreateTagData, UpdateTagData, TagUsageMap, TagDeleteImpact } from '@/types/tag';
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
    // The portfolio tag allocation is derived from tags.
    invalidateCache('investments:');
    return response.data;
  },

  delete: async (id: string): Promise<void> => {
    await apiClient.delete(`/tags/${id}`);
    invalidateCache('tags:');
    // The portfolio tag allocation is derived from tags.
    invalidateCache('investments:');
  },

  getTransactionCount: async (id: string): Promise<number> => {
    const response = await apiClient.get<number>(`/tags/${id}/transaction-count`);
    return response.data;
  },

  getDeleteImpact: async (id: string): Promise<TagDeleteImpact> => {
    const response = await apiClient.get<TagDeleteImpact>(`/tags/${id}/delete-impact`);
    return response.data;
  },

  getAllTransactionCounts: async (): Promise<Record<string, number>> => {
    const response = await apiClient.get<Record<string, number>>('/tags/transaction-counts');
    return response.data;
  },

  // Not cached: usage follows transaction writes, and `tags:` is reference data.
  getUsage: async (): Promise<TagUsageMap> => {
    const response = await apiClient.get<TagUsageMap>('/tags/usage');
    return response.data;
  },
};
