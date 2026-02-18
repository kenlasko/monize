import apiClient from './api';
import type {
  AiProviderConfig,
  CreateAiProviderConfig,
  UpdateAiProviderConfig,
  AiUsageSummary,
  AiStatus,
  AiConnectionTestResult,
  QueryResult,
  StreamCallbacks,
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

  query: async (query: string): Promise<QueryResult> => {
    const response = await apiClient.post<QueryResult>('/ai/query', { query });
    return response.data;
  },

  queryStream: (query: string, callbacks: StreamCallbacks): AbortController => {
    const controller = new AbortController();

    // Get CSRF token from cookie
    const csrfToken = document.cookie
      .split('; ')
      .find((row) => row.startsWith('csrf_token='))
      ?.split('=')[1] || '';

    fetch('/api/v1/ai/query/stream', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-CSRF-Token': csrfToken,
      },
      body: JSON.stringify({ query }),
      credentials: 'include',
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok) {
          const text = await response.text();
          let message = `Request failed: ${response.status}`;
          try {
            const json = JSON.parse(text);
            message = json.message || message;
          } catch {
            // Use default message
          }
          callbacks.onError?.(new Error(message));
          return;
        }

        const reader = response.body?.getReader();
        if (!reader) {
          callbacks.onError?.(new Error('No response body'));
          return;
        }

        const decoder = new TextDecoder();
        let buffer = '';

        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n\n');
            buffer = lines.pop() || '';

            for (const line of lines) {
              const trimmed = line.trim();
              if (trimmed.startsWith('data: ')) {
                try {
                  const event = JSON.parse(trimmed.slice(6));
                  callbacks.onEvent(event);
                } catch {
                  // Skip malformed events
                }
              }
            }
          }
        } finally {
          reader.releaseLock();
        }

        callbacks.onDone?.();
      })
      .catch((error) => {
        if (error.name !== 'AbortError') {
          callbacks.onError?.(error);
        }
      });

    return controller;
  },
};
