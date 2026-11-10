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
  inputCostPer1M: number | null;
  outputCostPer1M: number | null;
  costCurrency: string;
  /**
   * Per-query budgets for the AI Assistant's tool-calling loop. `null` means
   * the provider runs on the built-in default; the `AI_QUERY_*` environment
   * variables size the centrally managed provider only and never appear here.
   */
  queryMaxIterations: number | null;
  queryMaxToolCalls: number | null;
  queryTimeoutMinutes: number | null;
  queryMaxInputTokens: number | null;
  queryMaxToolResultChars: number | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * Aggregated estimated cost buckets. The key is an ISO 4217 currency code
 * and the value is the summed cost in that currency. Empty when no matching
 * configured rates exist for any logs in the bucket.
 */
export type EstimatedCostByCurrency = Record<string, number>;

export interface AiUsageSummary {
  totalRequests: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  /**
   * Sum of estimated costs keyed by the configured provider's cost currency.
   * Each entry represents one currency bucket (e.g. USD: 1.23, EUR: 0.45).
   * Empty when no configured rates match any logs in the period.
   */
  totalEstimatedCostByCurrency: EstimatedCostByCurrency;
  /** The user's reporting currency, which every `*InReportingCurrency` is in. */
  reportingCurrency: string;
  /**
   * The estimated costs in the reporting currency, each day's at that day's
   * rate (issue #2106); null while a cost has no admissible rate.
   */
  totalEstimatedCostInReportingCurrency: number | null;
  byProvider: Array<{
    provider: string;
    requests: number;
    inputTokens: number;
    outputTokens: number;
    estimatedCostByCurrency: EstimatedCostByCurrency;
    estimatedCostInReportingCurrency: number | null;
  }>;
  byFeature: Array<{
    feature: string;
    requests: number;
    inputTokens: number;
    outputTokens: number;
    estimatedCostByCurrency: EstimatedCostByCurrency;
    estimatedCostInReportingCurrency: number | null;
  }>;
  recentLogs: Array<{
    id: string;
    provider: string;
    model: string;
    feature: string;
    inputTokens: number;
    outputTokens: number;
    durationMs: number;
    /** Cost value in `costCurrency`, or null when no matching rate is configured. */
    estimatedCost: number | null;
    /** Currency code of `estimatedCost`, or null when no rate is configured. */
    costCurrency: string | null;
    /** `estimatedCost` in the reporting currency at its day's rate, or null. */
    estimatedCostInReportingCurrency: number | null;
    createdAt: string;
  }>;
}

export interface AiStatusResponse {
  configured: boolean;
  encryptionAvailable: boolean;
  activeProviders: number;
  hasSystemDefault: boolean;
  systemDefaultProvider: string | null;
  systemDefaultModel: string | null;
  // True when the highest-priority active provider is the MCP relay, so the
  // chat should route prompts to the user's own agent instead of an LLM.
  relayActive: boolean;
}

export interface AiConnectionTestResponse {
  /** True when the provider endpoint itself is reachable. */
  available: boolean;
  /** Generic connection error, surfaced to the user. */
  error?: string;
  /**
   * True when the configured model responded to a probe. Absent when the
   * provider doesn't implement model verification (treat as "unknown"),
   * or when `available` is false (can't reach the server to check).
   */
  modelAvailable?: boolean;
  /** The model id that was checked (for display in the UI). */
  model?: string;
  /** Specific model-level failure, e.g. "Model ... is not installed". */
  modelError?: string;
}
