import Cookies from 'js-cookie';
import apiClient, { attemptTokenRefresh } from './api';
import type {
  AiProviderConfig,
  CreateAiProviderConfig,
  UpdateAiProviderConfig,
  TestAiProviderConfigDraft,
  AiUsageSummary,
  AiStatus,
  AiConnectionTestResult,
  QueryResult,
  StreamCallbacks,
  InsightsListResponse,
  InsightType,
  InsightSeverity,
  ConfirmActionResponse,
  AttachmentPayload,
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

  testDraft: async (
    draft: TestAiProviderConfigDraft,
  ): Promise<AiConnectionTestResult> => {
    const response = await apiClient.post<AiConnectionTestResult>(
      '/ai/configs/test-draft',
      draft,
    );
    return response.data;
  },

  getUsage: async (days?: number): Promise<AiUsageSummary> => {
    const params = days ? { days } : {};
    const response = await apiClient.get<AiUsageSummary>('/ai/usage', { params });
    return response.data;
  },

  query: async (
    query: string,
    conversationHistory?: Array<{ role: 'user' | 'assistant'; content: string }>,
    attachments?: AttachmentPayload[],
  ): Promise<QueryResult> => {
    const response = await apiClient.post<QueryResult>(
      '/ai/query',
      {
        query,
        conversationHistory,
        ...(attachments && attachments.length > 0 ? { attachments } : {}),
      },
      { timeout: 120000 },
    );
    return response.data;
  },

  queryStream: (
    query: string,
    callbacks: StreamCallbacks,
    conversationHistory?: Array<{ role: 'user' | 'assistant'; content: string }>,
    opts?: { relay?: boolean },
    attachments?: AttachmentPayload[],
  ): AbortController => {
    const controller = new AbortController();

    // Relay mode routes the prompt to the user's own MCP agent (their
    // subscription) instead of a server-side LLM provider. Same SSE event
    // shape, different endpoint.
    const relay = opts?.relay ?? false;
    const path = relay
      ? '/api/v1/ai/relay/query/stream'
      : '/api/v1/ai/query/stream';
    // Attachments flow to both paths. On the relay path the backend stores them
    // and exposes each to the agent as a monize-attachment:// MCP resource.
    const body = {
      query,
      conversationHistory,
      ...(attachments && attachments.length > 0 ? { attachments } : {}),
    };

    // Open the stream. Re-read the CSRF cookie each call so a retry after
    // token refresh picks up the rotated value. js-cookie URL-decodes the
    // cookie — the backend stores `${nonce}:${hmac}` which Express
    // serializes with `%3A`, and the raw encoded value would fail the
    // backend's timing-safe comparison.
    const openStream = (): Promise<Response> => {
      const csrfToken = Cookies.get('csrf_token') || '';
      return fetch(path, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-CSRF-Token': csrfToken,
        },
        body: JSON.stringify(body),
        credentials: 'include',
        signal: controller.signal,
      });
    };

    (async () => {
      try {
        let response = await openStream();

        // The access token is 15m. If the user sat in the conversation long
        // enough for it to expire, the first POST returns 401. The axios
        // interceptor that normally refreshes doesn't fire for `fetch()`,
        // so replicate its refresh-and-retry here.
        if (response.status === 401) {
          const refreshed = await attemptTokenRefresh();
          if (refreshed) {
            response = await openStream();
          }
        }

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
      } catch (error) {
        if ((error as Error).name !== 'AbortError') {
          callbacks.onError?.(error as Error);
        }
      }
    })();

    return controller;
  },

  // Confirm a human-in-the-loop write action the assistant proposed. Uses the
  // axios client so CSRF + 401-refresh are handled by the interceptors.
  confirmAction: async (body: {
    actionId: string;
    signature: string;
    descriptor: Record<string, unknown>;
  }): Promise<ConfirmActionResponse> => {
    const response = await apiClient.post<ConfirmActionResponse>(
      '/ai/actions/confirm',
      body,
    );
    return response.data;
  },

  // Reverse MCP relay: pick up a late answer the agent posted after the SSE
  // stream already errored/closed. Returns null text when nothing is buffered
  // (expired, never arrived, or already picked up).
  getRelayResponse: async (
    promptId: string,
  ): Promise<{ text: string | null }> => {
    const response = await apiClient.get<{ text: string | null }>(
      `/ai/relay/response/${promptId}`,
    );
    return response.data;
  },

  // Reverse MCP relay: tunnel status for the chat indicator.
  getRelayStatus: async (): Promise<{
    state: 'offline' | 'listening' | 'busy';
    queued: number;
  }> => {
    const response = await apiClient.get<{
      state: 'offline' | 'listening' | 'busy';
      queued: number;
    }>('/ai/relay/status');
    return response.data;
  },

  // Spending Insights
  getInsights: async (params?: {
    type?: InsightType;
    severity?: InsightSeverity;
    includeDismissed?: boolean;
  }): Promise<InsightsListResponse> => {
    const queryParams: Record<string, string> = {};
    if (params?.type) queryParams.type = params.type;
    if (params?.severity) queryParams.severity = params.severity;
    if (params?.includeDismissed) queryParams.includeDismissed = 'true';
    const response = await apiClient.get<InsightsListResponse>('/ai/insights', {
      params: queryParams,
    });
    return response.data;
  },

  generateInsights: async (): Promise<void> => {
    await apiClient.post('/ai/insights/generate');
  },

  dismissInsight: async (id: string): Promise<void> => {
    await apiClient.patch(`/ai/insights/${id}/dismiss`);
  },
};
