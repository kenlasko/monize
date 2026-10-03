import type { ContactLookupSource } from './payee';
import type { InvestmentAction } from './investment';
import type { RuleAction, RuleConditionNode, RuleTrigger } from './transaction-rule';
import type { RuleStructurePlan } from './transaction-rule-run';
import type {
  RuleRunFilters,
  RuleRunMatchedRow,
  RuleRunResult,
  RuleRunSkippedRow,
} from './transaction-rule-run';

export type AiProviderType = 'anthropic' | 'openai' | 'ollama' | 'ollama-cloud' | 'openai-compatible' | 'mcp_relay';

/**
 * Per-query budget overrides sent when creating or updating a provider.
 * Omitted leaves a budget as it is; `null` clears it back to the default.
 */
export interface AiProviderQueryBudgets {
  queryMaxIterations?: number | null;
  queryMaxToolCalls?: number | null;
  queryTimeoutMinutes?: number | null;
  queryMaxInputTokens?: number | null;
  queryMaxToolResultChars?: number | null;
}

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
  /**
   * Per-query budgets for the AI Assistant's tool-calling loop, owned by this
   * provider. `null` means the built-in default applies -- the AI_QUERY_*
   * environment variables size the centrally managed provider only and are
   * never reflected here.
   */
  queryMaxIterations: number | null;
  queryMaxToolCalls: number | null;
  queryTimeoutMinutes: number | null;
  queryMaxInputTokens: number | null;
  queryMaxToolResultChars: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateAiProviderConfig extends AiProviderQueryBudgets {
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

export interface UpdateAiProviderConfig extends AiProviderQueryBudgets {
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
    'gemma4:31b-cloud',
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

// Attachment types: a user can attach images/PDFs/CSVs to a query so the AI
// can OCR or read them. `image`/`pdf` are sent as base64 binary; `text` (csv/
// plain) is decoded server-side and inlined as text.
export type AttachmentKind = 'image' | 'pdf' | 'text';

/** Wire shape sent in the query JSON body (base64 payload, no `data:` prefix). */
export interface AttachmentPayload {
  kind: AttachmentKind;
  mediaType: string;
  filename: string;
  data: string;
}

/**
 * UI-side attachment in the composer: the wire payload plus transient fields
 * (client id, decoded size, image object-URL preview) that are never sent to
 * the server or persisted to localStorage.
 */
export interface ChatAttachment extends AttachmentPayload {
  id: string;
  size: number;
  previewUrl?: string;
}

/**
 * Lightweight attachment metadata kept on a sent chat message and persisted to
 * localStorage. Deliberately omits the base64 `data` so the conversation in
 * storage stays small and binaries don't leak across reloads.
 */
export interface ChatAttachmentMeta {
  kind: AttachmentKind;
  mediaType: string;
  filename: string;
}

export type ChartType = 'bar' | 'pie' | 'line' | 'area';

export interface ChartPayload {
  type: ChartType;
  title: string;
  data: Array<{ label: string; value: number }>;
}

/**
 * Every action type the backend signs (`AI_ACTION_TYPES` in
 * `backend/src/ai/actions/ai-action.types.ts`). `ai-action-types.contract.test.ts`
 * reads that list and fails when the two differ, and `AI_ACTION_CARD_KIND`
 * (`lib/ai-action-card.ts`) is a total map over it, so a new type cannot be
 * added on one side only.
 */
export const AI_ACTION_TYPES = [
  'create_transaction',
  'categorize_transaction',
  'create_payee',
  'update_payee',
  'delete_payee',
  'create_security',
  'update_security',
  'delete_security',
  'create_investment_transaction',
  'create_transactions',
  'create_investment_transactions',
  'update_transaction',
  'delete_transaction',
  'update_investment_transaction',
  'delete_investment_transaction',
  'create_transfer',
  'update_transfer',
  // Generic bulk envelope for update/delete/transfer-create batches proposed by
  // the unified manage_transactions tool. The descriptor carries an `operation`
  // discriminator the bulk card reads to pick its title and row layout.
  'batch_actions',
  // Transaction rules: one card for the four of them (`RuleConfirmationCard`).
  'create_transaction_rule',
  'update_transaction_rule',
  'delete_transaction_rule',
  'run_transaction_rule',
] as const;

export type AiActionType = (typeof AI_ACTION_TYPES)[number];

/** The four transaction-rule action types. */
export type RuleAiActionType =
  | 'create_transaction_rule'
  | 'update_transaction_rule'
  | 'delete_transaction_rule'
  | 'run_transaction_rule';

export type PendingActionStatus =
  | 'pending'
  | 'confirming'
  | 'confirmed'
  | 'cancelled'
  | 'error'
  | 'expired';

/** One category-split line shown on a split transaction confirmation card. */
export interface PendingActionSplit {
  categoryName?: string | null;
  amount: number;
  memo?: string | null;
}

/** One chat file a create/update card will save on the transaction on approval. */
export interface PendingActionAttachment {
  filename: string;
  contentType: string;
  byteSize: number;
}

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
  /**
   * Set on a create_payee card whose contact fields were looked up rather than
   * supplied, so the card can label them as suggestions.
   */
  contactLookupSource?: ContactLookupSource | null;
  categoryName?: string | null;
  newCategoryName?: string | null;
  currentCategoryName?: string | null;
  description?: string | null;
  name?: string | null;
  /** Payee website, as the commit would store it. */
  website?: string | null;
  /** Payee contact details, as the commit would store them. */
  address?: string | null;
  email?: string | null;
  phone?: string | null;
  /**
   * True when an update_transaction / delete_transaction targets a reconciled
   * transaction. The card shows a warning line so the user knows approving will
   * disturb a completed reconciliation.
   */
  isReconciled?: boolean;
  /**
   * Category-split lines for a split create_transaction / update_transaction.
   * When present the card shows the breakdown in place of the single category.
   */
  splits?: PendingActionSplit[];
  /**
   * Chat files a create_transaction / update_transaction will save as
   * transaction attachments on approval.
   */
  attachments?: PendingActionAttachment[];
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
  /**
   * What the user's transaction rules will also do to a created transaction or
   * transfer on approval (display-only). Absent when no rule matches.
   */
  ruleEffects?: PendingActionRuleEffects;
  /** create/update/delete/run_transaction_rule: the rule and its test. */
  rule?: PendingActionRule;
}

/** Names for the ids a rule's effects mention; a missing id is a deleted item. */
export interface PendingActionRuleEffectsLabels {
  /** The accounts a transfer or a split part names; absent in a card built before they were sent. */
  accounts?: Record<string, string>;
  categories: Record<string, string>;
  payees: Record<string, string>;
  tags: Record<string, string>;
  rules: Record<string, string>;
}

/** The net change the rules make to a created row (`RuleEffectsPreview`, without the trace). */
export interface PendingActionRuleEffects {
  changes: {
    categoryId?: string | null;
    payeeId?: string | null;
    /** The name `set_payee_from_text` chose, when no payee id is known for it. */
    payeeName?: string;
    /** A payee that does not exist yet and is created when the row is saved. */
    createPayee?: string;
    /** The description `set_description` writes. */
    description?: string | null;
    addTagIds: string[];
    removeTagIds: string[];
    /** A structural action's plan: the row becomes a transfer leg or a split. */
    structure?: RuleStructurePlan;
  };
  aiReviewRequests: Array<{ ruleId: string; instruction: string }>;
  labels: PendingActionRuleEffectsLabels;
}

/** Names for the ids a rule definition mentions (`RuleDefinitionLabels`). */
export interface PendingActionRuleLabels {
  accounts: Record<string, string>;
  payees: Record<string, string>;
  categories: Record<string, string>;
  tags: Record<string, string>;
}

/** A rule definition as a card shows it (`AiActionRuleState`). */
export interface PendingActionRuleState {
  name: string;
  enabled: boolean;
  triggers: RuleTrigger[];
  condition: RuleConditionNode;
  actions: RuleAction[];
  stopProcessing: boolean;
  /** The active window, `YYYY-MM-DD`; null or absent is open on that side. */
  activeFrom?: string | null;
  activeTo?: string | null;
}

/** What running a rule on existing transactions would do (`AiActionRuleTestPreview`). */
export interface PendingActionRuleTest {
  matchedCount: number;
  /** Transactions whose condition matched, changed or not; only 0 means it matches nothing. */
  conditionMatchedCount: number;
  scanned: number;
  truncated: boolean;
  /** The first rows that would change; the counts cover all of them. */
  rows: RuleRunMatchedRow[];
  /** The first rows left alone, and why. */
  skipped: RuleRunSkippedRow[];
  skippedCount: number;
  aiReviewRequests: number;
  labels: PendingActionRuleEffectsLabels;
}

/** The rule a rule card shows (`AiActionRulePreview`). */
export interface PendingActionRule extends PendingActionRuleState {
  labels: PendingActionRuleLabels;
  /** update: the rule as stored now. */
  current?: PendingActionRuleState;
  /** run: the filters, as ids (`labels.accounts` names the accounts). */
  filters?: RuleRunFilters;
  test?: PendingActionRuleTest;
}

/** One row in a bulk confirmation card; `status: 'error'` rows are flagged. */
export interface PendingActionPreviewRow {
  status: 'ok' | 'error';
  error?: string;
  // Payee display field (batch_actions with a payee operation).
  name?: string | null;
  /** Payee website, as the commit would store it. */
  website?: string | null;
  /** Payee contact details, as the commit would store them. */
  address?: string | null;
  email?: string | null;
  phone?: string | null;
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
  /**
   * The complete replacement split set for this row, when the edit rewrites a
   * split transaction's categories. Present means `categoryName` is null: the
   * categories are these lines, and the row shows them instead.
   */
  splits?: Array<{
    categoryName: string | null;
    amount: number;
    memo?: string | null;
  }>;
  /** True when this bulk update/delete row targets a reconciled transaction. */
  isReconciled?: boolean;
  /**
   * What the user's rules will also do to this created row on approval, with a
   * transfer or split they add (display-only; the single card's shape).
   */
  ruleEffects?: PendingActionRuleEffects;
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
  /** run_transaction_rule: what the run changed and left alone (set on success). */
  resultRuleRun?: RuleRunResult;
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
  /** run_transaction_rule: rows changed, rows left alone and why, and the undo entry. */
  ruleRun?: RuleRunResult;
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
    // Relay only: sent first so the client knows its promptId and can pick up a
    // late answer if the stream dies before the agent responds.
    | 'prompt_id'
    | 'error';
  message?: string;
  // Relay only: the id of the prompt this stream is serving (on `prompt_id`).
  promptId?: string;
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
