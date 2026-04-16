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
    /** Cost value in `costCurrency`, or null when no matching rate is configured. */
    estimatedCost: number | null;
    /** Currency code of `estimatedCost`, or null when no rate is configured. */
    costCurrency: string | null;
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
