import type { InvestmentAction } from './investment';

export type AiProviderType = 'anthropic' | 'openai' | 'ollama' | 'ollama-cloud' | 'openai-compatible' | 'mcp_relay';

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
 * Body for the "test this draft before saving" endpoint. When editing an
 * existing provider and the user hasn't typed a new API key, pass
 * `configId` so the server falls back to the stored (encrypted) key.
 */
export interface TestAiProviderConfigDraft {
  provider: AiProviderType;
  model?: string;
  apiKey?: string;
  baseUrl?: string;
  configId?: string;
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
  /**
   * True when the highest-priority active provider is the MCP relay, so the
   * chat routes prompts to the user's own agent instead of an LLM.
   */
  relayActive: boolean;
}

export interface AiConnectionTestResult {
  available: boolean;
  error?: string;
  /**
   * True when the configured model responded to a probe. Absent when
   * the provider doesn't verify models or the server wasn't reachable.
   */
  modelAvailable?: boolean;
  /** The model id that was checked, for display. */
  model?: string;
  /** Specific model-level failure message for display to the user. */
  modelError?: string;
}

export const AI_PROVIDER_LABELS: Record<AiProviderType, string> = {
  anthropic: 'Anthropic (Claude)',
  openai: 'OpenAI (GPT)',
  ollama: 'Ollama (Local)',
  'ollama-cloud': 'Ollama Cloud',
  'openai-compatible': 'OpenAI-Compatible',
  mcp_relay: 'MCP Relay',
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
  'ollama-cloud': [
    'gpt-oss:120b-cloud',
    'gpt-oss:20b-cloud',
    'deepseek-v3.1:671b-cloud',
  ],
  'openai-compatible': [],
  mcp_relay: [],
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

export type AiActionType =
  | 'create_transaction'
  | 'categorize_transaction'
  | 'create_payee'
  | 'update_payee'
  | 'delete_payee'
  | 'create_security'
  | 'update_security'
  | 'delete_security'
  | 'create_investment_transaction'
  | 'create_transactions'
  | 'create_investment_transactions'
  | 'update_transaction'
  | 'delete_transaction'
  | 'update_investment_transaction'
  | 'delete_investment_transaction'
  | 'create_transfer'
  | 'update_transfer'
  // Generic bulk envelope for update/delete/transfer-create batches proposed by
  // the unified manage_transactions tool. The descriptor carries an `operation`
  // discriminator the bulk card reads to pick its title and row layout.
  | 'batch_actions';

export type PendingActionStatus =
  | 'pending'
  | 'confirming'
  | 'confirmed'
  | 'cancelled'
  | 'error'
  | 'expired';

export interface PendingActionPreview {
  accountName?: string;
  amount?: number;
  currencyCode?: string;
  transactionDate?: string;
  // Transfer display fields (create_transfer / update_transfer): the "from" leg
  // reuses accountName/amount/currencyCode above; these carry the "to" leg.
  fromAccountName?: string;
  toAccountName?: string;
  toAmount?: number | null;
  toCurrencyCode?: string | null;
  payeeName?: string | null;
  /** True when approving a create_transaction will also create a new payee. */
  payeeWillBeCreated?: boolean;
  categoryName?: string | null;
  newCategoryName?: string | null;
  currentCategoryName?: string | null;
  description?: string | null;
  name?: string | null;
  // create_investment_transaction display fields.
  investmentAction?: InvestmentAction;
  symbol?: string | null;
  securityName?: string | null;
  securityCurrency?: string | null;
  quantity?: number | null;
  price?: number | null;
  commission?: number;
  totalAmount?: number;
  cashAccountName?: string | null;
  cashCurrency?: string | null;
  cashAmount?: number | null;
  // create_security display fields (symbol/securityName/securityCurrency above
  // are reused for the ticker, full name, and currency).
  securityType?: string | null;
  exchange?: string | null;
  isFavourite?: boolean;
  /**
   * Per-row previews for the bulk actions (`create_transactions`,
   * `create_investment_transactions`). Every pasted row in order -- both the
   * valid rows and the flagged ones the bulk card greys out.
   */
  rows?: PendingActionPreviewRow[];
}

/** One row in a bulk confirmation card; `status: 'error'` rows are flagged. */
export interface PendingActionPreviewRow {
  status: 'ok' | 'error';
  error?: string;
  // Payee display field (batch_actions with a payee operation).
  name?: string | null;
  accountName?: string;
  amount?: number;
  currencyCode?: string;
  transactionDate?: string;
  // Transfer row fields (batch_actions with operation === 'create_transfer').
  fromAccountName?: string;
  toAccountName?: string;
  toAmount?: number | null;
  toCurrencyCode?: string | null;
  payeeName?: string | null;
  payeeWillBeCreated?: boolean;
  categoryName?: string | null;
  description?: string | null;
  investmentAction?: InvestmentAction;
  symbol?: string | null;
  securityName?: string | null;
  securityCurrency?: string | null;
  quantity?: number | null;
  price?: number | null;
  commission?: number;
  totalAmount?: number;
  cashAccountName?: string | null;
  cashCurrency?: string | null;
  cashAmount?: number | null;
}

/**
 * A write action the assistant proposed via a `pending_action` SSE event. The
 * `descriptor` + `signature` are echoed back verbatim to the confirm endpoint;
 * `status` is client-side UI state tracked by the chat store.
 */
export interface PendingAction {
  actionId: string;
  type: AiActionType;
  preview: PendingActionPreview;
  descriptor: Record<string, unknown>;
  signature: string;
  expiresAt: number;
  status: PendingActionStatus;
  resultId?: string;
  /** Number of entities created by a bulk action (set on success). */
  resultCount?: number;
  /** Rows the bulk confirm skipped, by input index (set on success). */
  resultSkipped?: Array<{ index: number; reason: string }>;
  errorMessage?: string;
}

export interface ConfirmActionResponse {
  type: AiActionType;
  id: string;
  /** Bulk actions: ids of every created entity. */
  ids?: string[];
  /** Bulk actions: number of entities created. */
  count?: number;
  /** Bulk actions: rows skipped best-effort, by input index. */
  skipped?: Array<{ index: number; reason: string }>;
}

export interface StreamEvent {
  type:
    | 'thinking'
    | 'assistant_text'
    | 'tool_start'
    | 'tool_result'
    | 'chart'
    | 'pending_action'
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
  // Emitted when the model proposes a write action (create/categorize). The
  // frontend attaches it to the assistant message and renders a confirmation
  // card the user must approve before anything is persisted.
  action?: Omit<PendingAction, 'status'>;
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
