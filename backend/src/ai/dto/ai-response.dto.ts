export interface AiProviderConfigResponse {
  id: string;
  provider: string;
  displayName: string | null;
  isActive: boolean;
  priority: number;
  model: string | null;
  apiKeyMasked: string | null;
  baseUrl: string | null;
  config: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface AiUsageSummary {
  totalRequests: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  byProvider: Array<{
    provider: string;
    requests: number;
    inputTokens: number;
    outputTokens: number;
  }>;
  byFeature: Array<{
    feature: string;
    requests: number;
    inputTokens: number;
    outputTokens: number;
  }>;
  recentLogs: Array<{
    id: string;
    provider: string;
    model: string;
    feature: string;
    inputTokens: number;
    outputTokens: number;
    durationMs: number;
    createdAt: string;
  }>;
}

export interface AiStatusResponse {
  configured: boolean;
  encryptionAvailable: boolean;
  activeProviders: number;
}

export interface AiConnectionTestResponse {
  available: boolean;
  error?: string;
}
