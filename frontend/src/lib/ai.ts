import apiClient from './api';
import type {
  AiProviderConfig,
  CreateAiProviderConfig,
  UpdateAiProviderConfig,
  AiUsageSummary,
  AiStatus,
  AiConnectionTestResult,
} from '@/types/ai';

export const aiApi = {
  getStatus: async (): Promise<AiStatus> => {
    const response = await apiClient.get<AiStatus>('/ai/status');
    return response.data;
  },

  getConfigs: async (): Promise<AiProviderConfig[]> => {
    const response = await apiClient.get<AiProviderConfig[]>('/ai/configs');
    return response.data;
  },

  createConfig: async (data: CreateAiProviderConfig): Promise<AiProviderConfig> => {
    const response = await apiClient.post<AiProviderConfig>('/ai/configs', data);
    return response.data;
  },

  updateConfig: async (id: string, data: UpdateAiProviderConfig): Promise<AiProviderConfig> => {
    const response = await apiClient.patch<AiProviderConfig>(`/ai/configs/${id}`, data);
    return response.data;
  },

  deleteConfig: async (id: string): Promise<void> => {
    await apiClient.delete(`/ai/configs/${id}`);
  },

  testConnection: async (id: string): Promise<AiConnectionTestResult> => {
    const response = await apiClient.post<AiConnectionTestResult>(`/ai/configs/${id}/test`);
    return response.data;
  },

  getUsage: async (days?: number): Promise<AiUsageSummary> => {
    const params = days ? { days } : {};
    const response = await apiClient.get<AiUsageSummary>('/ai/usage', { params });
    return response.data;
  },
};
