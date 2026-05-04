import { Test, TestingModule } from "@nestjs/testing";
import {
  MonteCarloSimulationService,
  SimulationParams,
} from "./monte-carlo-simulation.service";

describe("MonteCarloSimulationService", () => {
  let service: MonteCarloSimulationService;

  const baseParams: SimulationParams = {
    startingValue: 100000,
    yearsToRetirement: 10,
    annualContribution: 5000,
    contributionGrowthRate: 0,
    yearsInRetirement: 0,
    annualWithdrawal: 0,
    expectedReturn: 0.07,
    volatility: 0.15,
    inflationRate: 0.025,
    showRealValues: false,
    simulationCount: 500,
    targetValue: null,
    randomSeed: "42",
  };

  // Deterministic-mode preset: zero volatility lets us assert closed-form math.
  const deterministic = (overrides: Partial<SimulationParams> = {}) =>
    service.run({
      ...baseParams,
      volatility: 0,
      simulationCount: 100,
      ...overrides,
    });

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [MonteCarloSimulationService],
    }).compile();
    service = module.get(MonteCarloSimulationService);
  });

  describe("output shape", () => {
    it("produces year-by-year percentile arrays of the right length", () => {
      const result = service.run(baseParams);
      expect(result.yearLabels).toHaveLength(10);
      expect(result.percentiles.p10).toHaveLength(10);
      expect(result.percentiles.p50).toHaveLength(10);
      expect(result.percentiles.p90).toHaveLength(10);
    });

    it("orders percentiles correctly at every horizon", () => {
      const result = service.run(baseParams);
      for (let i = 0; i < result.percentiles.p10.length; i++) {
        expect(result.percentiles.p10[i]).toBeLessThanOrEqual(
          result.percentiles.p25[i],
        );
        expect(result.percentiles.p25[i]).toBeLessThanOrEqual(
          result.percentiles.p50[i],
        );
        expect(result.percentiles.p50[i]).toBeLessThanOrEqual(
          result.percentiles.p75[i],
        );
        expect(result.percentiles.p75[i]).toBeLessThanOrEqual(
          result.percentiles.p90[i],
        );
      }
    });

    it("is deterministic when given a seed", () => {
      const a = service.run(baseParams);
      const b = service.run(baseParams);
      expect(a.percentiles.p50).toEqual(b.percentiles.p50);
      expect(a.finalDistribution.median).toBe(b.finalDistribution.median);
    });
  });

  describe("starting value", () => {
    it("scales the entire trajectory linearly when no flows or returns", () => {
      const result = deterministic({
        startingValue: 1000,
        annualContribution: 0,
        expectedReturn: 0,
      });
      // No returns, no contributions ⇒ flat at startingValue forever.
      expect(result.finalDistribution.median).toBeCloseTo(1000, 4);
    });

    it("higher starting value produces a higher final value", () => {
      const lo = deterministic({ startingValue: 50000 });
      const hi = deterministic({ startingValue: 500000 });
      expect(hi.finalDistribution.median).toBeGreaterThan(
        lo.finalDistribution.median,
      );
    });

    it("doubling the starting value with no flows doubles the final value", () => {
      const a = deterministic({
        startingValue: 100000,
        annualContribution: 0,
      });
      const b = deterministic({
        startingValue: 200000,
        annualContribution: 0,
      });
      expect(b.finalDistribution.median).toBeCloseTo(
        2 * a.finalDistribution.median,
        2,
      );
    });
  });

  describe("expected return", () => {
    it("collapses to compound interest when volatility is 0 and no flows", () => {
      const r = 0.07;
      const result = deterministic({
        annualContribution: 0,
        expectedReturn: r,
      });
      const expected = baseParams.startingValue * Math.pow(1 + r, 10);
      expect(result.finalDistribution.median).toBeCloseTo(expected, 0);
      expect(result.finalDistribution.stdev).toBe(0);
    });

    it("0% return with no flows leaves the balance flat", () => {
      const result = deterministic({
        annualContribution: 0,
        expectedReturn: 0,
      });
      expect(result.finalDistribution.median).toBe(baseParams.startingValue);
    });

    it("higher expected return produces a higher final value (deterministic)", () => {
      const lo = deterministic({ expectedReturn: 0.03 });
      const hi = deterministic({ expectedReturn: 0.1 });
      expect(hi.finalDistribution.median).toBeGreaterThan(
        lo.finalDistribution.median,
      );
    });

    it("negative expected return shrinks the balance", () => {
      const result = deterministic({
        annualContribution: 0,
        expectedReturn: -0.05,
      });
      expect(result.finalDistribution.median).toBeLessThan(
        baseParams.startingValue,
      );
    });
  });

  describe("volatility", () => {
    it("zero volatility produces zero stdev across paths", () => {
      const result = deterministic({});
      expect(result.finalDistribution.stdev).toBe(0);
    });

    it("higher volatility produces a wider final distribution", () => {
      const lo = service.run({
        ...baseParams,
        volatility: 0.05,
        simulationCount: 1000,
      });
      const hi = service.run({
        ...baseParams,
        volatility: 0.3,
        simulationCount: 1000,
      });
      expect(hi.finalDistribution.stdev).toBeGreaterThan(
        lo.finalDistribution.stdev,
      );
    });

    it("higher volatility widens the p10–p90 band at the horizon", () => {
      const lo = service.run({
        ...baseParams,
        volatility: 0.05,
        simulationCount: 1000,
      });
      const hi = service.run({
        ...baseParams,
        volatility: 0.3,
        simulationCount: 1000,
      });
      const last = lo.percentiles.p90.length - 1;
      const loBand = lo.percentiles.p90[last] - lo.percentiles.p10[last];
      const hiBand = hi.percentiles.p90[last] - hi.percentiles.p10[last];
      expect(hiBand).toBeGreaterThan(loBand);
    });
  });

  describe("contributions", () => {
    it("doubling annual contribution noticeably changes the final value", () => {
      const lo = deterministic({ annualContribution: 5000 });
      const hi = deterministic({ annualContribution: 50000 });
      expect(hi.finalDistribution.median).toBeGreaterThan(
        lo.finalDistribution.median * 2,
      );
    });

    it("matches a closed-form annuity when starting value is 0", () => {
      // V_N = c * sum_{t=0..N-1} (1+r)^(N - t) = c * (1+r) * ((1+r)^N - 1) / r
      const c = 1000;
      const r = 0.05;
      const N = 10;
      const result = deterministic({
        startingValue: 0,
        annualContribution: c,
        expectedReturn: r,
        yearsToRetirement: N,
      });
      const expected = (c * (1 + r) * (Math.pow(1 + r, N) - 1)) / r;
      expect(result.finalDistribution.median).toBeCloseTo(expected, 0);
    });

    it("contribution growth rate compounds contributions over time", () => {
      const flat = deterministic({ contributionGrowthRate: 0 });
      const growing = deterministic({ contributionGrowthRate: 0.05 });
      expect(growing.finalDistribution.median).toBeGreaterThan(
        flat.finalDistribution.median,
      );
    });

    it("zero contribution + zero return + zero starting value yields zero", () => {
      const result = deterministic({
        startingValue: 0,
        annualContribution: 0,
        expectedReturn: 0,
      });
      expect(result.finalDistribution.median).toBe(0);
    });
  });

  describe("withdrawals", () => {
    it("modest withdrawals reduce the final value vs zero withdrawals", () => {
      const noWithdrawal = deterministic({
        yearsToRetirement: 10,
        yearsInRetirement: 10,
        annualWithdrawal: 0,
      });
      const withWithdrawal = deterministic({
        yearsToRetirement: 10,
        yearsInRetirement: 10,
        annualWithdrawal: 5000,
      });
      expect(withWithdrawal.finalDistribution.median).toBeLessThan(
        noWithdrawal.finalDistribution.median,
      );
    });

    it("withdrawals grow with inflation (higher inflation depletes faster)", () => {
      // With inflation > 0, the nominal withdrawal grows each year. Compare
      // two runs that only differ in inflation, with a sustainable
      // withdrawal level so neither path fully depletes, and verify the
      // higher inflation leaves less behind.
      const sharedOverrides = {
        startingValue: 1000000,
        annualContribution: 0,
        yearsToRetirement: 0,
        yearsInRetirement: 20,
        annualWithdrawal: 30000,
        expectedReturn: 0.05,
      };
      const lowInflation = deterministic({
        ...sharedOverrides,
        inflationRate: 0.0,
      });
      const highInflation = deterministic({
        ...sharedOverrides,
        inflationRate: 0.05,
      });
      // Both runs should leave money on the table at this withdrawal rate.
      expect(lowInflation.finalDistribution.median).toBeGreaterThan(0);
      expect(highInflation.finalDistribution.median).toBeGreaterThan(0);
      expect(highInflation.finalDistribution.median).toBeLessThan(
        lowInflation.finalDistribution.median,
      );
    });

    it("massive withdrawals deplete most paths", () => {
      const result = service.run({
        ...baseParams,
        yearsToRetirement: 0,
        yearsInRetirement: 30,
        annualWithdrawal: 50000,
        annualContribution: 0,
        expectedReturn: 0.01,
        volatility: 0.05,
        simulationCount: 300,
      });
      expect(result.finalDistribution.depletionRate).toBeGreaterThan(0.5);
      expect(result.finalDistribution.min).toBe(0);
    });

    it("never lets the balance go negative", () => {
      const result = service.run({
        ...baseParams,
        yearsToRetirement: 0,
        yearsInRetirement: 50,
        annualWithdrawal: 1000000,
        annualContribution: 0,
        simulationCount: 100,
      });
      expect(result.finalDistribution.min).toBeGreaterThanOrEqual(0);
      for (const v of result.percentiles.p10) {
        expect(v).toBeGreaterThanOrEqual(0);
      }
    });
  });

  describe("inflation and real values", () => {
    it("real-value mode deflates the displayed series", () => {
      const nominal = service.run({ ...baseParams, showRealValues: false });
      const real = service.run({ ...baseParams, showRealValues: true });
      const last = nominal.percentiles.p50.length - 1;
      expect(real.percentiles.p50[last]).toBeLessThan(
        nominal.percentiles.p50[last],
      );
      expect(real.realValues).toBe(true);
    });

    it("matches the closed-form deflator at the horizon", () => {
      const params = {
        ...baseParams,
        volatility: 0,
        annualContribution: 0,
        startingValue: 100000,
        yearsToRetirement: 10,
        expectedReturn: 0.07,
        inflationRate: 0.025,
      };
      const nominal = service.run({ ...params, showRealValues: false });
      const real = service.run({ ...params, showRealValues: true });
      const lastNom =
        nominal.percentiles.p50[nominal.percentiles.p50.length - 1];
      const lastReal = real.percentiles.p50[real.percentiles.p50.length - 1];
      expect(lastReal).toBeCloseTo(
        lastNom / Math.pow(1 + params.inflationRate, 10),
        0,
      );
    });
  });

  describe("success rate", () => {
    it("returns null when no target is set", () => {
      const result = service.run({ ...baseParams, targetValue: null });
      expect(result.successRate).toBeNull();
    });

    it("compares the target against the real (today's-value) final balance", () => {
      // A target at today's value of 1 is trivially below any positive real
      // balance, so success ≈ 1 even in nominal display mode.
      const result = service.run({
        ...baseParams,
        targetValue: 1,
        showRealValues: false,
      });
      expect(result.successRate).toBe(1);
    });

    it("an unattainable target gives a success rate of 0", () => {
      const result = service.run({ ...baseParams, targetValue: 1e15 });
      expect(result.successRate).toBe(0);
    });

    it("success rate is independent of showRealValues display mode", () => {
      const nominal = service.run({
        ...baseParams,
        showRealValues: false,
        targetValue: 250000,
        simulationCount: 1000,
      });
      const real = service.run({
        ...baseParams,
        showRealValues: true,
        targetValue: 250000,
        simulationCount: 1000,
      });
      // Same seed, same params except display mode → exact same successRate.
      expect(real.successRate).toBe(nominal.successRate);
    });
  });

  describe("end-to-end accumulation + drawdown", () => {
    it("matches a closed-form accumulation+drawdown trajectory", () => {
      // 5y accumulate $1k/yr starting at $0 with 5% return, then 5y withdraw
      // $200/yr at 0% inflation. Compute the deterministic expected balance.
      const params: SimulationParams = {
        ...baseParams,
        startingValue: 0,
        annualContribution: 1000,
        contributionGrowthRate: 0,
        yearsToRetirement: 5,
        yearsInRetirement: 5,
        annualWithdrawal: 200,
        expectedReturn: 0.05,
        volatility: 0,
        inflationRate: 0,
        simulationCount: 100,
      };

      // Hand-compute year by year.
      let v = params.startingValue;
      for (let t = 1; t <= params.yearsToRetirement; t++) {
        v = (v + params.annualContribution) * (1 + params.expectedReturn);
      }
      for (let t = 1; t <= params.yearsInRetirement; t++) {
        v = (v - params.annualWithdrawal) * (1 + params.expectedReturn);
      }
      const expected = v;

      const result = service.run(params);
      expect(result.finalDistribution.median).toBeCloseTo(expected, 0);
    });
  });

  describe("cash-flow events", () => {
    it("a one-time inflow at year K bumps the final balance", () => {
      const without = deterministic({ cashFlows: [] });
      const with1 = deterministic({
        cashFlows: [
          {
            amount: 100000,
            flowType: "ONE_TIME",
            startYear: 5,
            inflationAdjust: false,
          },
        ],
      });
      // The year-5 inflow earns r at year 5 itself (post-flow multiplier)
      // and again at years 6..10 — 6 years of compounding total.
      const expectedDelta = 100000 * Math.pow(1 + baseParams.expectedReturn, 6);
      const actualDelta =
        with1.finalDistribution.median - without.finalDistribution.median;
      expect(actualDelta).toBeCloseTo(expectedDelta, 0);
    });

    it("a one-time expense at year K reduces the final balance", () => {
      const without = deterministic({ cashFlows: [] });
      const expense = deterministic({
        cashFlows: [
          {
            amount: -25000,
            flowType: "ONE_TIME",
            startYear: 3,
            inflationAdjust: false,
          },
        ],
      });
      expect(expense.finalDistribution.median).toBeLessThan(
        without.finalDistribution.median,
      );
    });

    it("a one-time event outside the horizon has no effect", () => {
      const a = deterministic({ cashFlows: [] });
      const b = deterministic({
        cashFlows: [
          {
            amount: 1000000,
            flowType: "ONE_TIME",
            startYear: 50, // baseParams.yearsToRetirement = 10
            inflationAdjust: false,
          },
        ],
      });
      expect(b.finalDistribution.median).toBe(a.finalDistribution.median);
    });

    it("a recurring flow contributes for every year in its window", () => {
      const without = deterministic({
        cashFlows: [],
        annualContribution: 0,
      });
      const recurring = deterministic({
        cashFlows: [
          {
            amount: 1000,
            flowType: "RECURRING",
            startYear: 1,
            endYear: 10,
            inflationAdjust: false,
          },
        ],
        annualContribution: 0,
      });
      // Closed-form annuity: c·(1+r)·((1+r)^N − 1) / r where c=1000, r=0.07, N=10.
      const r = baseParams.expectedReturn;
      const N = 10;
      const expectedExtra = (1000 * (1 + r) * (Math.pow(1 + r, N) - 1)) / r;
      const actualExtra =
        recurring.finalDistribution.median - without.finalDistribution.median;
      expect(actualExtra).toBeCloseTo(expectedExtra, 0);
    });

    it("a recurring flow with no endYear runs to the horizon", () => {
      const finite = deterministic({
        cashFlows: [
          {
            amount: 500,
            flowType: "RECURRING",
            startYear: 1,
            endYear: 10,
            inflationAdjust: false,
          },
        ],
      });
      const openEnded = deterministic({
        cashFlows: [
          {
            amount: 500,
            flowType: "RECURRING",
            startYear: 1,
            inflationAdjust: false,
          },
        ],
      });
      // baseParams horizon is 10 years (yearsToRetirement = 10), so the two
      // should produce identical results when endYear === horizon.
      expect(openEnded.finalDistribution.median).toBeCloseTo(
        finite.finalDistribution.median,
        2,
      );
    });

    it("inflation-adjusted recurring flows compound vs flat amount", () => {
      const flat = deterministic({
        cashFlows: [
          {
            amount: 1000,
            flowType: "RECURRING",
            startYear: 1,
            endYear: 10,
            inflationAdjust: false,
          },
        ],
      });
      const inflated = deterministic({
        cashFlows: [
          {
            amount: 1000,
            flowType: "RECURRING",
            startYear: 1,
            endYear: 10,
            inflationAdjust: true,
          },
        ],
      });
      // Inflated flows compound at (1+inflation)^t, so they sum to more in
      // nominal terms than the flat $1000/yr stream.
      expect(inflated.finalDistribution.median).toBeGreaterThan(
        flat.finalDistribution.median,
      );
    });

    it("a flow with startYear > horizon has no effect", () => {
      const without = deterministic({ cashFlows: [] });
      const future = deterministic({
        cashFlows: [
          {
            amount: 50000,
            flowType: "RECURRING",
            startYear: 100,
            inflationAdjust: false,
          },
        ],
      });
      expect(future.finalDistribution.median).toBe(
        without.finalDistribution.median,
      );
    });

    it("multiple flows compose additively", () => {
      const inflowOnly = deterministic({
        cashFlows: [
          {
            amount: 10000,
            flowType: "ONE_TIME",
            startYear: 5,
            inflationAdjust: false,
          },
        ],
      });
      const both = deterministic({
        cashFlows: [
          {
            amount: 10000,
            flowType: "ONE_TIME",
            startYear: 5,
            inflationAdjust: false,
          },
          {
            amount: -5000,
            flowType: "ONE_TIME",
            startYear: 5,
            inflationAdjust: false,
          },
        ],
      });
      // Net effect should be roughly the same as a single +5000 inflow at
      // year 5 — i.e. half the inflowOnly delta vs no-flows.
      const noFlows = deterministic({ cashFlows: [] });
      const inflowDelta =
        inflowOnly.finalDistribution.median - noFlows.finalDistribution.median;
      const bothDelta =
        both.finalDistribution.median - noFlows.finalDistribution.median;
      expect(bothDelta).toBeCloseTo(inflowDelta / 2, 0);
    });

    it("recurring withdrawal during drawdown phase reduces final value", () => {
      // Run with extra recurring outflow during the drawdown phase only.
      const params: SimulationParams = {
        ...baseParams,
        volatility: 0,
        annualContribution: 0,
        annualWithdrawal: 1000,
        yearsToRetirement: 5,
        yearsInRetirement: 5,
        simulationCount: 100,
      };
      const without = service.run(params);
      const withExtra = service.run({
        ...params,
        cashFlows: [
          {
            amount: -2000,
            flowType: "RECURRING",
            startYear: 6,
            endYear: 10,
            inflationAdjust: false,
          },
        ],
      });
      expect(withExtra.finalDistribution.median).toBeLessThan(
        without.finalDistribution.median,
      );
    });
  });

  describe("edge cases", () => {
    it("handles a 0-year horizon", () => {
      const result = service.run({
        ...baseParams,
        yearsToRetirement: 0,
        yearsInRetirement: 0,
      });
      expect(result.percentiles.p50).toEqual([]);
      expect(result.finalDistribution.median).toBe(baseParams.startingValue);
    });

    it("clamps simulation count below 100 to 100", () => {
      // simulationCount: 1 → simulator clamps to 100, output still well-formed.
      const result = service.run({ ...baseParams, simulationCount: 1 });
      expect(result.percentiles.p50.length).toBe(10);
    });
  });
});
