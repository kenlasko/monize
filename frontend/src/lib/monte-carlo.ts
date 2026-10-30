import apiClient from './api';

export type CashFlowType = 'ONE_TIME' | 'RECURRING';

/**
 * Most cash flows one scenario may carry. Equal to the server's
 * `MAX_SCENARIO_CASH_FLOWS` (backend/src/monte-carlo/dto/cash-flow.dto.ts),
 * which refuses a longer list.
 */
export const MAX_CASH_FLOWS = 100;

export interface CashFlow {
  /** Display name (e.g. "Pension", "Roof renovation"). */
  name: string;
  /** Signed: positive = income, negative = expense. */
  amount: number;
  flowType: CashFlowType;
  /** Year offset from today; 1 = first simulated year. */
  startYear: number;
  /** Inclusive end year for RECURRING; null/undefined = until horizon ends. */
  endYear?: number | null;
  inflationAdjust: boolean;
}

export interface MonteCarloScenario {
  id: string;
  name: string;
  description: string | null;
  cashFlows?: CashFlow[];
  accountIds: string[];
  startingValue: number;
  useCurrentBalance: boolean;
  yearsToRetirement: number;
  annualContribution: number;
  contributionGrowthRate: number;
  yearsInRetirement: number;
  annualWithdrawal: number;
  expectedReturn: number;
  volatility: number;
  inflationRate: number;
  showRealValues: boolean;
  useHistoricalReturns: boolean;
  simulationCount: number;
  targetValue: number | null;
  randomSeed: string | null;
  isFavourite: boolean;
  sortOrder: number;
  lastRunAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Pure simulation inputs — what /run accepts and what's persisted minus identity/metadata. */
export type MonteCarloScenarioInputs = Omit<
  MonteCarloScenario,
  | 'id'
  | 'name'
  | 'description'
  | 'isFavourite'
  | 'sortOrder'
  | 'lastRunAt'
  | 'createdAt'
  | 'updatedAt'
  | 'targetValue'
  | 'randomSeed'
  | 'cashFlows'
> & {
  targetValue?: number;
  randomSeed?: string;
  cashFlows?: CashFlow[];
};

export type MonteCarloScenarioCreateInput = MonteCarloScenarioInputs & {
  name: string;
  description?: string;
};

export type MonteCarloScenarioUpdateInput = Partial<MonteCarloScenarioCreateInput> & {
  isFavourite?: boolean;
};

export interface PercentileBand {
  p10: number;
  p25: number;
  p50: number;
  p75: number;
  p90: number;
}

export interface PerformanceSummary {
  twrNominal: PercentileBand;
  twrReal: PercentileBand;
  endBalanceNominal: PercentileBand;
  endBalanceReal: PercentileBand;
  meanReturnNominal: PercentileBand;
  annualizedVolatility: PercentileBand;
  maxDrawdown: PercentileBand;
  maxDrawdownExcludingCashflows: PercentileBand;
  safeWithdrawalRate: PercentileBand;
  perpetualWithdrawalRate: PercentileBand;
}

export interface SimulationResult {
  yearLabels: string[];
  percentiles: {
    p10: number[];
    p25: number[];
    p50: number[];
    p75: number[];
    p90: number[];
  };
  finalDistribution: {
    min: number;
    max: number;
    mean: number;
    median: number;
    stdev: number;
    depletionRate: number;
  };
  performanceSummary: PerformanceSummary;
  successRate: number | null;
  inputsSnapshot: Record<string, unknown>;
  realValues: boolean;
  ranAt: string;
}

export interface HistoricalStats {
  yearsObserved: number;
  meanReturn: number | null;
  volatility: number | null;
  /**
   * False when the mean/volatility could not be computed over the whole selected
   * portfolio -- a held security had no current price, its value could not be
   * converted into one common currency for weighting, or it could not carry a
   * weight at all (a net short position, or an unknown currency).
   * `meanReturn`/`volatility` are `null` then, and the backend refuses a
   * simulation configured to use historical returns rather than weighting a
   * subset or silently substituting the manual figures (recheck RR5-003,
   * review #1132).
   *
   * Carried on the type so this contract is not silently dropped at the frontend
   * boundary, which is the mistake RR4-002 was.
   */
  returnsComplete?: boolean;
  missingRatePairs?: string[];
  unpricedSecurityIds?: string[];
  unweightableSecurityIds?: string[];
  /**
   * True when the current portfolio value could not be determined, so the
   * idle-cash weight is unknown and the statistics are withheld for that
   * reason (a missing currency pair, if any, is in `missingRatePairs`).
   */
  portfolioValueUnknown?: boolean;
  /**
   * Aggregate current market value of the selected accounts, or `null` when the
   * server could not determine it (a missing price or exchange rate, or a failed
   * portfolio valuation).
   *
   * `null` and `0` are different answers: zero means the accounts hold nothing.
   * Do not coerce this to 0 -- a simulation started from a fabricated empty
   * portfolio produces a plausible, meaningless projection (audit P5-010).
   */
  currentBalance: number | null;
}

export interface HoldingStat {
  symbol: string;
  name: string;
  /** `null` when the security carries no currency (unknown, not a default). */
  currencyCode: string | null;
  quantity: number;
  /**
   * Current market value, or `null` when the security has no current price.
   *
   * `null` and `0` are different answers. This was typed `number` while the server
   * sent `0` for a missing quote, so the table told the user an unpriced holding
   * was worth nothing -- in the same report that refuses to project from an
   * incomplete value (recheck RR4-004).
   */
  marketValue: number | null;
  yearsObserved: number;
  meanReturn: number | null;
  volatility: number | null;
}

export interface AccountHoldingStats {
  accountId: string;
  accountName: string;
  currencyCode: string;
  holdings: HoldingStat[];
}

export const monteCarloApi = {
  list: async (): Promise<MonteCarloScenario[]> => {
    const r = await apiClient.get<MonteCarloScenario[]>('/monte-carlo/scenarios');
    return r.data;
  },

  get: async (id: string): Promise<MonteCarloScenario> => {
    const r = await apiClient.get<MonteCarloScenario>(`/monte-carlo/scenarios/${id}`);
    return r.data;
  },

  create: async (input: MonteCarloScenarioCreateInput): Promise<MonteCarloScenario> => {
    const r = await apiClient.post<MonteCarloScenario>('/monte-carlo/scenarios', input);
    return r.data;
  },

  update: async (
    id: string,
    input: MonteCarloScenarioUpdateInput,
  ): Promise<MonteCarloScenario> => {
    const r = await apiClient.patch<MonteCarloScenario>(
      `/monte-carlo/scenarios/${id}`,
      input,
    );
    return r.data;
  },

  remove: async (id: string): Promise<void> => {
    await apiClient.delete(`/monte-carlo/scenarios/${id}`);
  },

  reorder: async (scenarioIds: string[]): Promise<void> => {
    await apiClient.patch('/monte-carlo/scenarios/reorder', { scenarioIds });
  },

  runSaved: async (id: string): Promise<SimulationResult> => {
    const r = await apiClient.post<SimulationResult>(
      `/monte-carlo/scenarios/${id}/run`,
    );
    return r.data;
  },

  run: async (input: MonteCarloScenarioInputs): Promise<SimulationResult> => {
    const r = await apiClient.post<SimulationResult>('/monte-carlo/run', input);
    return r.data;
  },

  /** Brokerage and standalone investment accounts only (no cash siblings). */
  brokerageAccounts: async (): Promise<
    Array<{ id: string; name: string; currencyCode: string }>
  > => {
    const r = await apiClient.get<
      Array<{ id: string; name: string; currencyCode: string }>
    >('/monte-carlo/accounts');
    return r.data;
  },

  holdingStats: async (
    accountIds: string[],
  ): Promise<AccountHoldingStats[]> => {
    const r = await apiClient.get<AccountHoldingStats[]>(
      '/monte-carlo/holding-stats',
      { params: { accountIds: accountIds.join(',') } },
    );
    return r.data;
  },

  historicalStats: async (accountIds: string[]): Promise<HistoricalStats> => {
    const r = await apiClient.get<HistoricalStats>('/monte-carlo/historical-stats', {
      params: { accountIds: accountIds.join(',') },
    });
    return r.data;
  },
};
