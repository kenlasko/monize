import { Injectable } from "@nestjs/common";
import {
  FinalDistributionStats,
  PercentileBand,
  PerformanceSummary,
  SimulationPercentiles,
  SimulationResult,
} from "./dto/simulation-result.dto";
import { roundMoney } from "../common/round.util";

export interface CashFlowSpec {
  /** Signed amount: positive = income, negative = expense. */
  amount: number;
  flowType: "ONE_TIME" | "RECURRING";
  /** Year offset from "today" (1 = first simulated year). */
  startYear: number;
  /** Inclusive end year for RECURRING; null = until horizon ends. */
  endYear?: number | null;
  /** When true, scale amount by (1+inflation)^(yearsSinceStart). */
  inflationAdjust: boolean;
}

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
  /** Optional one-time / recurring cash flows layered on top of the base
   * contribution and withdrawal phases. */
  cashFlows?: CashFlowSpec[];
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

    // Per-simulation performance metrics. We sort each of these arrays at the
    // end and pull p10/p25/p50/p75/p90 to form the PerformanceSummary.
    const twrNomArr = new Float64Array(sims);
    const twrRealArr = new Float64Array(sims);
    const endBalNomArr = new Float64Array(sims);
    const endBalRealArr = new Float64Array(sims);
    const meanRetArr = new Float64Array(sims);
    const volArr = new Float64Array(sims);
    const mddArr = new Float64Array(sims);
    const mddNoCFArr = new Float64Array(sims);
    const swrArr = new Float64Array(sims);
    const pwrArr = new Float64Array(sims);

    const inflation = params.inflationRate;
    const inflationFactorN = Math.pow(1 + inflation, totalYears);
    // Floor for cumulative-return divisions so a single catastrophic year
    // can't blow up SWR/PWR/TWR with infinities; the simulated portfolio
    // value already saturates at 0 so this only affects derived statistics.
    const EPS = 1e-12;

    // The user-defined cash flows depend only on the year, never on the
    // simulated path, so sum them once per year here rather than once per
    // (simulation, year): the cost is years x flows instead of
    // simulations x years x flows, with the same values in the same order.
    const extraCashFlowByYear = new Float64Array(totalYears);
    for (let t = 1; t <= totalYears; t++) {
      extraCashFlowByYear[t - 1] = sumExtraCashFlows(
        t,
        totalYears,
        inflation,
        params.cashFlows,
      );
    }

    for (let s = 0; s < sims; s++) {
      let value = params.startingValue;
      let valueExclCF = params.startingValue;
      let peakWithCF = params.startingValue;
      let peakExclCF = params.startingValue;
      let mddWithCF = 0;
      let mddExclCF = 0;
      let sumR = 0;
      let sumR2 = 0;
      let sumLog1R = 0;
      // P_t = prod_{s=1..t}(1+r_s); used for SWR / PWR closed forms.
      let cumProd = 1;
      // S = sum_{t=1..N} (1+i)^{t-1} / P_{t-1}
      // Withdrawals are taken at the start of each year (before that year's
      // return), so the relevant product is P_{t-1} — the cumulative product
      // BEFORE applying that year's return.
      let invSum = 0;
      let pathDepleted = false;

      for (let t = 1; t <= totalYears; t++) {
        const inAccumulation = t <= params.yearsToRetirement;
        // The withdrawal is entered in today's value, so it inflates from year
        // 1 (not from retirement): $50k/yr at 2.5% over 30 years of
        // accumulation first withdraws ~$104.9k nominal. Contributions inflate
        // at the user-supplied contribution-growth rate (often a salary raise
        // rate, not strictly inflation).
        const baseCashFlow = inAccumulation
          ? params.annualContribution *
            Math.pow(1 + params.contributionGrowthRate, t - 1)
          : -params.annualWithdrawal * Math.pow(1 + inflation, t - 1);

        // Layer in any user-defined one-time / recurring cash flows.
        const desiredCashFlow = baseCashFlow + extraCashFlowByYear[t - 1];

        // Clamp withdrawals to the available balance so a depleted path stays
        // at zero rather than silently going negative for the rest of the run.
        const cashFlow =
          desiredCashFlow < 0
            ? Math.max(desiredCashFlow, -value)
            : desiredCashFlow;

        // We "wanted" desiredCashFlow but took only cashFlow — if those differ
        // for a withdrawal, the path couldn't fund the full withdrawal.
        if (cashFlow > desiredCashFlow) pathDepleted = true;

        // Accumulate inverse-product sum BEFORE updating cumProd so we use
        // P_{t-1} (1 for t=1).
        invSum += Math.pow(1 + inflation, t - 1) / Math.max(cumProd, EPS);

        const r = params.expectedReturn + params.volatility * normal();
        const oneR = 1 + r;
        cumProd *= Math.max(oneR, EPS);

        sumR += r;
        sumR2 += r * r;
        sumLog1R += Math.log(Math.max(oneR, EPS));

        value = (value + cashFlow) * oneR;
        if (value < 0) value = 0;

        valueExclCF = valueExclCF * oneR;
        if (valueExclCF < 0) valueExclCF = 0;

        if (value > peakWithCF) peakWithCF = value;
        if (peakWithCF > 0) {
          const dd = value / peakWithCF - 1;
          if (dd < mddWithCF) mddWithCF = dd;
        }
        if (valueExclCF > peakExclCF) peakExclCF = valueExclCF;
        if (peakExclCF > 0) {
          const dd = valueExclCF / peakExclCF - 1;
          if (dd < mddExclCF) mddExclCF = dd;
        }

        let reported = value;
        if (params.showRealValues) {
          reported = value / Math.pow(1 + inflation, t);
        }
        columns[t - 1][s] = reported;
      }

      if (pathDepleted) depleted++;
      finalBalances[s] = columns[totalYears - 1][s];
      // The user enters their target in today's value, so always compare
      // against the deflated final balance regardless of the showRealValues
      // display toggle. Otherwise nominal runs over a long horizon would
      // always beat any reasonable target and report 100% success.
      const realFinal = value / inflationFactorN;
      if (params.targetValue != null && realFinal >= params.targetValue) {
        aboveTarget++;
      }

      const N = totalYears;
      const meanR = sumR / N;
      const variance =
        N > 1 ? Math.max(0, (sumR2 - N * meanR * meanR) / (N - 1)) : 0;
      const vol = Math.sqrt(variance);
      const twrNom = Math.exp(sumLog1R / N) - 1;

      endBalNomArr[s] = value;
      endBalRealArr[s] = realFinal;
      meanRetArr[s] = meanR;
      volArr[s] = vol;
      twrNomArr[s] = twrNom;
      twrRealArr[s] = (1 + twrNom) / (1 + inflation) - 1;
      mddArr[s] = mddWithCF;
      mddNoCFArr[s] = mddExclCF;
      // Closed-form SWR/PWR: max constant inflation-adjusted withdrawal as a
      // fraction of the starting balance, given this path's return sequence.
      // SWR depletes the portfolio exactly at year N; PWR keeps the real
      // ending balance equal to the starting balance.
      if (invSum > 0) {
        const swr = 1 / invSum;
        swrArr[s] = swr > 0 ? swr : 0;
        const pwr = swr - inflationFactorN / (Math.max(cumProd, EPS) * invSum);
        pwrArr[s] = pwr > 0 ? pwr : 0;
      } else {
        swrArr[s] = 0;
        pwrArr[s] = 0;
      }
    }

    const percentiles = this.computePercentiles(columns);
    const finalDistribution = this.computeFinalStats(finalBalances, depleted);
    const successRate = params.targetValue == null ? null : aboveTarget / sims;
    const performanceSummary: PerformanceSummary = {
      twrNominal: this.toBand(twrNomArr),
      twrReal: this.toBand(twrRealArr),
      endBalanceNominal: this.toBand(endBalNomArr),
      endBalanceReal: this.toBand(endBalRealArr),
      meanReturnNominal: this.toBand(meanRetArr),
      annualizedVolatility: this.toBand(volArr),
      maxDrawdown: this.toBand(mddArr),
      maxDrawdownExcludingCashflows: this.toBand(mddNoCFArr),
      safeWithdrawalRate: this.toBand(swrArr),
      perpetualWithdrawalRate: this.toBand(pwrArr),
    };

    return {
      yearLabels: this.makeYearLabels(totalYears),
      percentiles,
      finalDistribution,
      performanceSummary,
      successRate,
      realValues: params.showRealValues,
      inputsSnapshot: { ...params },
      ranAt: new Date().toISOString(),
    };
  }

  private toBand(values: Float64Array): PercentileBand {
    const sorted = Float64Array.from(values).sort();
    return {
      p10: this.quantile(sorted, 0.1),
      p25: this.quantile(sorted, 0.25),
      p50: this.quantile(sorted, 0.5),
      p75: this.quantile(sorted, 0.75),
      p90: this.quantile(sorted, 0.9),
    };
  }

  private emptyBand(): PercentileBand {
    return { p10: 0, p25: 0, p50: 0, p75: 0, p90: 0 };
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
      performanceSummary: {
        twrNominal: this.emptyBand(),
        twrReal: this.emptyBand(),
        endBalanceNominal: {
          ...this.emptyBand(),
          p10: params.startingValue,
          p25: params.startingValue,
          p50: params.startingValue,
          p75: params.startingValue,
          p90: params.startingValue,
        },
        endBalanceReal: {
          ...this.emptyBand(),
          p10: params.startingValue,
          p25: params.startingValue,
          p50: params.startingValue,
          p75: params.startingValue,
          p90: params.startingValue,
        },
        meanReturnNominal: this.emptyBand(),
        annualizedVolatility: this.emptyBand(),
        maxDrawdown: this.emptyBand(),
        maxDrawdownExcludingCashflows: this.emptyBand(),
        safeWithdrawalRate: this.emptyBand(),
        perpetualWithdrawalRate: this.emptyBand(),
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
    const stdev = Math.sqrt(variance);

    return {
      min: roundMoney(min),
      max: roundMoney(max),
      mean: roundMoney(mean),
      median: roundMoney(this.quantile(sorted, 0.5)),
      // Float-noise residue (e.g. a "zero volatility" run) rounds cleanly to 0.
      stdev: roundMoney(stdev),
      depletionRate: depleted / n,
    };
  }

  private quantile(sorted: Float64Array, q: number): number {
    if (sorted.length === 0) return 0;
    const pos = (sorted.length - 1) * q;
    const lo = Math.floor(pos);
    const hi = Math.ceil(pos);
    if (lo === hi) return roundMoney(sorted[lo]);
    return roundMoney(sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo));
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
      // Bound the loop explicitly so a user-supplied seed can't be used to
      // pump us through an unbounded iteration. The DTO already caps this
      // at 32 characters; this is belt-and-suspenders for static analysis.
      const safeLen = Math.min(seed.length, 64);
      for (let i = 0; i < safeLen; i++) {
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

/**
 * Sum every user-defined cash flow that fires in year `t`.
 *
 * - ONE_TIME: contributes `amount` only when `t === startYear`.
 * - RECURRING: contributes `amount` for every `t` in
 *   `[startYear, endYear ?? totalYears]`.
 * - When `inflationAdjust` is true, the contribution scales by
 *   `(1 + inflation)^(t - startYear)` so its real value stays flat.
 */
function sumExtraCashFlows(
  t: number,
  totalYears: number,
  inflation: number,
  flows?: CashFlowSpec[],
): number {
  if (!flows || flows.length === 0) return 0;
  let total = 0;
  for (const cf of flows) {
    const start = Math.max(1, cf.startYear);
    if (cf.flowType === "ONE_TIME") {
      if (t !== start) continue;
    } else {
      const end = cf.endYear == null ? totalYears : cf.endYear;
      if (t < start || t > end) continue;
    }
    const yearsSinceStart = t - start;
    const factor = cf.inflationAdjust
      ? Math.pow(1 + inflation, yearsSinceStart)
      : 1;
    total += cf.amount * factor;
  }
  return total;
}
