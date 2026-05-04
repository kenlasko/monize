import apiClient from './api';

export interface MonteCarloScenario {
  id: string;
  name: string;
  description: string | null;
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
  'id' | 'name' | 'description' | 'isFavourite' | 'lastRunAt' | 'createdAt' | 'updatedAt'
>;

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

  historicalStats: async (accountIds: string[]): Promise<HistoricalStats> => {
    const r = await apiClient.get<HistoricalStats>('/monte-carlo/historical-stats', {
      params: { accountIds: accountIds.join(',') },
    });
    return r.data;
  },
};
