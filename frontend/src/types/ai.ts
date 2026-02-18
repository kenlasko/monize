export type AiProviderType = 'anthropic' | 'openai' | 'ollama' | 'openai-compatible';

export interface AiProviderConfig {
  id: string;
  provider: AiProviderType;
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

export interface CreateAiProviderConfig {
  provider: AiProviderType;
  displayName?: string;
  model?: string;
  apiKey?: string;
  baseUrl?: string;
  priority?: number;
  config?: Record<string, unknown>;
}

export interface UpdateAiProviderConfig {
  displayName?: string;
  model?: string;
  apiKey?: string;
  baseUrl?: string;
  priority?: number;
  isActive?: boolean;
  config?: Record<string, unknown>;
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

export interface AiStatus {
  configured: boolean;
  encryptionAvailable: boolean;
  activeProviders: number;
}

export interface AiConnectionTestResult {
  available: boolean;
  error?: string;
}

export const AI_PROVIDER_LABELS: Record<AiProviderType, string> = {
  anthropic: 'Anthropic (Claude)',
  openai: 'OpenAI (GPT)',
  ollama: 'Ollama (Local)',
  'openai-compatible': 'OpenAI-Compatible',
};

export const AI_PROVIDER_DEFAULT_MODELS: Record<AiProviderType, string[]> = {
  anthropic: ['claude-sonnet-4-20250514', 'claude-haiku-4-20250414', 'claude-opus-4-20250514'],
  openai: ['gpt-4o', 'gpt-4o-mini', 'o3-mini'],
  ollama: ['llama3', 'llama3:70b', 'mistral', 'codellama', 'phi3'],
  'openai-compatible': [],
};

// Natural Language Query types

export interface QueryResult {
  answer: string;
  toolsUsed: Array<{ name: string; summary: string }>;
  sources: Array<{ type: string; description: string; dateRange?: string }>;
  usage: { inputTokens: number; outputTokens: number; toolCalls: number };
}

export interface StreamEvent {
  type: 'thinking' | 'tool_start' | 'tool_result' | 'content' | 'sources' | 'done' | 'error';
  message?: string;
  name?: string;
  description?: string;
  summary?: string;
  text?: string;
  sources?: Array<{ type: string; description: string; dateRange?: string }>;
  usage?: { inputTokens: number; outputTokens: number; toolCalls: number };
}

export interface StreamCallbacks {
  onEvent: (event: StreamEvent) => void;
  onDone?: () => void;
  onError?: (error: Error) => void;
}

// Spending Insights types

export type InsightType = 'anomaly' | 'trend' | 'subscription' | 'budget_pace' | 'seasonal' | 'new_recurring';
export type InsightSeverity = 'info' | 'warning' | 'alert';

export interface AiInsight {
  id: string;
  type: InsightType;
  title: string;
  description: string;
  severity: InsightSeverity;
  data: Record<string, unknown>;
  isDismissed: boolean;
  generatedAt: string;
  expiresAt: string;
  createdAt: string;
}

export interface InsightsListResponse {
  insights: AiInsight[];
  total: number;
  lastGeneratedAt: string | null;
  isGenerating: boolean;
}

export const INSIGHT_TYPE_LABELS: Record<InsightType, string> = {
  anomaly: 'Anomaly',
  trend: 'Trend',
  subscription: 'Subscription',
  budget_pace: 'Budget Pace',
  seasonal: 'Seasonal',
  new_recurring: 'New Recurring',
};

export const INSIGHT_SEVERITY_LABELS: Record<InsightSeverity, string> = {
  info: 'Info',
  warning: 'Warning',
  alert: 'Alert',
};
