export interface SimulationPercentiles {
  p10: number[];
  p25: number[];
  p50: number[];
  p75: number[];
  p90: number[];
}

export interface FinalDistributionStats {
  min: number;
  max: number;
  mean: number;
  median: number;
  stdev: number;
  /** Probability the user fully depletes the portfolio before the horizon ends. */
  depletionRate: number;
}

export interface SimulationResult {
  yearLabels: string[];
  /** Median trajectory equals percentiles.p50 — duplicated for chart convenience. */
  percentiles: SimulationPercentiles;
  /** Distribution stats of the final-year balance. */
  finalDistribution: FinalDistributionStats;
  /** null if no targetValue was supplied; otherwise share of paths where final >= target. */
  successRate: number | null;
  /** Echo of the inputs that produced this result. Lets the UI show "ran with…". */
  inputsSnapshot: Record<string, unknown>;
  /** Whether values are deflated to today's dollars. */
  realValues: boolean;
  ranAt: string;
}
