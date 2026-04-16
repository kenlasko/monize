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
  inputCostPer1M: number | null;
  outputCostPer1M: number | null;
  costCurrency: string;
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
  inputCostPer1M?: number | null;
  outputCostPer1M?: number | null;
  costCurrency?: string;
}

export interface UpdateAiProviderConfig {
  displayName?: string;
  model?: string;
  apiKey?: string;
  baseUrl?: string;
  priority?: number;
  isActive?: boolean;
  config?: Record<string, unknown>;
  inputCostPer1M?: number | null;
  outputCostPer1M?: number | null;
  costCurrency?: string;
}

/**
 * Aggregated estimated cost keyed by ISO 4217 currency code.
 * Empty when no configured rates match any logs.
 */
export type EstimatedCostByCurrency = Record<string, number>;

export interface AiUsageSummary {
  totalRequests: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalEstimatedCostByCurrency: EstimatedCostByCurrency;
  byProvider: Array<{
    provider: string;
    requests: number;
    inputTokens: number;
    outputTokens: number;
    estimatedCostByCurrency: EstimatedCostByCurrency;
  }>;
  byFeature: Array<{
    feature: string;
    requests: number;
    inputTokens: number;
    outputTokens: number;
    estimatedCostByCurrency: EstimatedCostByCurrency;
  }>;
  recentLogs: Array<{
    id: string;
    provider: string;
    model: string;
    feature: string;
    inputTokens: number;
    outputTokens: number;
    durationMs: number;
    estimatedCost: number | null;
    costCurrency: string | null;
    createdAt: string;
  }>;
}

export interface AiStatus {
  configured: boolean;
  encryptionAvailable: boolean;
  activeProviders: number;
  hasSystemDefault: boolean;
  systemDefaultProvider: string | null;
  systemDefaultModel: string | null;
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
  ollama: [
    'ministral-3:latest',
    'qwen3:30b',
    'gpt-oss:20b',
    'MFDoom/deepseek-r1-tool-calling:8b',
  ],
  'openai-compatible': [],
};

// Natural Language Query types

export interface QueryResult {
  answer: string;
  toolsUsed: Array<{ name: string; summary: string }>;
  sources: Array<{ type: string; description: string; dateRange?: string }>;
  usage: { inputTokens: number; outputTokens: number; toolCalls: number };
}

export type ChartType = 'bar' | 'pie' | 'line' | 'area';

export interface ChartPayload {
  type: ChartType;
  title: string;
  data: Array<{ label: string; value: number }>;
}

export interface StreamEvent {
  type:
    | 'thinking'
    | 'assistant_text'
    | 'tool_start'
    | 'tool_result'
    | 'chart'
    | 'content'
    | 'sources'
    | 'done'
    | 'error';
  message?: string;
  name?: string;
  description?: string;
  summary?: string;
  text?: string;
  // Set on `tool_result` when the tool failed (validation error, exception, etc.)
  // The UI uses this to render a red X instead of a green checkmark.
  isError?: boolean;
  // Tool arguments the model passed to the tool. Present on tool_start so
  // the UI can show the user what the model actually queried for.
  input?: Record<string, unknown>;
  sources?: Array<{ type: string; description: string; dateRange?: string }>;
  usage?: { inputTokens: number; outputTokens: number; toolCalls: number };
  // Emitted by the backend when the model calls the render_chart tool with a
  // valid payload. The frontend attaches these to the active assistant
  // message so <ResultChart> can render them with recharts.
  chart?: ChartPayload;
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
