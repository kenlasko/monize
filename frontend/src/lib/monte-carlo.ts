import apiClient from './api';

export type CashFlowType = 'ONE_TIME' | 'RECURRING';

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
  successRate: number | null;
  inputsSnapshot: Record<string, unknown>;
  realValues: boolean;
  ranAt: string;
}

export interface HistoricalStats {
  yearsObserved: number;
  meanReturn: number | null;
  volatility: number | null;
  currentBalance: number;
}

export interface HoldingStat {
  symbol: string;
  name: string;
  currencyCode: string;
  quantity: number;
  marketValue: number;
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
