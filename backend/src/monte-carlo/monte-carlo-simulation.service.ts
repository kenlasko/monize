import { Injectable } from "@nestjs/common";
import {
  FinalDistributionStats,
  SimulationPercentiles,
  SimulationResult,
} from "./dto/simulation-result.dto";

export interface SimulationParams {
  startingValue: number;
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
  targetValue?: number | null;
  randomSeed?: string | null;
}

/**
 * Pure Monte Carlo simulation math. No DB access — caller resolves the
 * starting balance and persists results separately.
 *
 * Model: discrete annual steps. For each year `t` from 1..N:
 *
 *   cashFlow_t = (t <= K) ? +contribution_t : -withdrawal_t
 *   r_t        ~ Normal(mu, sigma^2)
 *   value_t    = max(0, (value_{t-1} + cashFlow_t) * (1 + r_t))
 *
 * where contributions grow at `contributionGrowthRate` per year and N = K + M.
 * If `showRealValues`, every reported value is deflated by (1+inflation)^t.
 */
@Injectable()
export class MonteCarloSimulationService {
  run(params: SimulationParams): SimulationResult {
    const totalYears = params.yearsToRetirement + params.yearsInRetirement;
    if (totalYears === 0) {
      return this.emptyResult(params);
    }

    const sims = Math.max(100, Math.min(50000, params.simulationCount));
    const rand = this.makePrng(params.randomSeed);
    const normal = this.makeNormalSampler(rand);

    // Per-year buckets: column = year index (1..totalYears), row = simulation.
    const columns: Float64Array[] = [];
    for (let t = 0; t < totalYears; t++) {
      columns.push(new Float64Array(sims));
    }

    let depleted = 0;
    let aboveTarget = 0;
    const finalBalances = new Float64Array(sims);

    for (let s = 0; s < sims; s++) {
      let value = params.startingValue;
      let pathDepleted = false;

      for (let t = 1; t <= totalYears; t++) {
        const inAccumulation = t <= params.yearsToRetirement;
        const cashFlow = inAccumulation
          ? params.annualContribution *
            Math.pow(1 + params.contributionGrowthRate, t - 1)
          : -params.annualWithdrawal;

        const r = params.expectedReturn + params.volatility * normal();

        value = (value + cashFlow) * (1 + r);
        if (value < 0) {
          value = 0;
          pathDepleted = true;
        }

        let reported = value;
        if (params.showRealValues) {
          reported = value / Math.pow(1 + params.inflationRate, t);
        }
        columns[t - 1][s] = reported;
      }

      if (pathDepleted) depleted++;
      finalBalances[s] = columns[totalYears - 1][s];
      if (
        params.targetValue != null &&
        finalBalances[s] >= params.targetValue
      ) {
        aboveTarget++;
      }
    }

    const percentiles = this.computePercentiles(columns);
    const finalDistribution = this.computeFinalStats(finalBalances, depleted);
    const successRate = params.targetValue == null ? null : aboveTarget / sims;

    return {
      yearLabels: this.makeYearLabels(totalYears),
      percentiles,
      finalDistribution,
      successRate,
      realValues: params.showRealValues,
      inputsSnapshot: { ...params },
      ranAt: new Date().toISOString(),
    };
  }

  private emptyResult(params: SimulationParams): SimulationResult {
    return {
      yearLabels: [],
      percentiles: { p10: [], p25: [], p50: [], p75: [], p90: [] },
      finalDistribution: {
        min: params.startingValue,
        max: params.startingValue,
        mean: params.startingValue,
        median: params.startingValue,
        stdev: 0,
        depletionRate: 0,
      },
      successRate:
        params.targetValue == null
          ? null
          : params.startingValue >= params.targetValue
            ? 1
            : 0,
      realValues: params.showRealValues,
      inputsSnapshot: { ...params },
      ranAt: new Date().toISOString(),
    };
  }

  private computePercentiles(columns: Float64Array[]): SimulationPercentiles {
    const p10: number[] = [];
    const p25: number[] = [];
    const p50: number[] = [];
    const p75: number[] = [];
    const p90: number[] = [];

    for (const column of columns) {
      const sorted = Float64Array.from(column).sort();
      p10.push(this.quantile(sorted, 0.1));
      p25.push(this.quantile(sorted, 0.25));
      p50.push(this.quantile(sorted, 0.5));
      p75.push(this.quantile(sorted, 0.75));
      p90.push(this.quantile(sorted, 0.9));
    }

    return { p10, p25, p50, p75, p90 };
  }

  private computeFinalStats(
    finals: Float64Array,
    depleted: number,
  ): FinalDistributionStats {
    const sorted = Float64Array.from(finals).sort();
    const n = sorted.length;
    let sum = 0;
    let min = Infinity;
    let max = -Infinity;
    for (const v of finals) {
      sum += v;
      if (v < min) min = v;
      if (v > max) max = v;
    }
    const mean = sum / n;
    let variance = 0;
    for (const v of finals) {
      const d = v - mean;
      variance += d * d;
    }
    variance /= n;

    return {
      min: this.round(min),
      max: this.round(max),
      mean: this.round(mean),
      median: this.round(this.quantile(sorted, 0.5)),
      stdev: this.round(Math.sqrt(variance)),
      depletionRate: depleted / n,
    };
  }

  private quantile(sorted: Float64Array, q: number): number {
    if (sorted.length === 0) return 0;
    const pos = (sorted.length - 1) * q;
    const lo = Math.floor(pos);
    const hi = Math.ceil(pos);
    if (lo === hi) return this.round(sorted[lo]);
    return this.round(sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo));
  }

  private round(v: number): number {
    return Math.round(v * 10000) / 10000;
  }

  private makeYearLabels(totalYears: number): string[] {
    const baseYear = new Date().getFullYear();
    const labels: string[] = [];
    for (let i = 1; i <= totalYears; i++) {
      labels.push(String(baseYear + i));
    }
    return labels;
  }

  /**
   * Mulberry32 PRNG when a seed is supplied (deterministic for tests),
   * Math.random otherwise. Seed string is parsed as a 32-bit unsigned int;
   * non-numeric or empty strings fall back to a numeric hash.
   */
  private makePrng(seed?: string | null): () => number {
    if (!seed) return Math.random;
    let s = Number.parseInt(seed, 10);
    if (!Number.isFinite(s)) {
      s = 0;
      for (let i = 0; i < seed.length; i++) {
        s = (s * 31 + seed.charCodeAt(i)) >>> 0;
      }
    }
    let state = s >>> 0 || 1;
    return () => {
      state = (state + 0x6d2b79f5) >>> 0;
      let t = state;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /** Box–Muller transform — returns standard normal samples. */
  private makeNormalSampler(rand: () => number): () => number {
    let spare: number | null = null;
    return () => {
      if (spare !== null) {
        const v = spare;
        spare = null;
        return v;
      }
      let u1 = 0;
      let u2 = 0;
      while (u1 === 0) u1 = rand();
      while (u2 === 0) u2 = rand();
      const mag = Math.sqrt(-2 * Math.log(u1));
      const z0 = mag * Math.cos(2 * Math.PI * u2);
      const z1 = mag * Math.sin(2 * Math.PI * u2);
      spare = z1;
      return z0;
    };
  }
}
