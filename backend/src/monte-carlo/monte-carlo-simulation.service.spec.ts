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

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [MonteCarloSimulationService],
    }).compile();
    service = module.get(MonteCarloSimulationService);
  });

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

  it("collapses to deterministic compounding when volatility is 0", () => {
    const result = service.run({
      ...baseParams,
      volatility: 0,
      annualContribution: 0,
      simulationCount: 100,
    });
    // V_t = V_0 * (1+r)^t exactly
    const expectedFinal =
      baseParams.startingValue * Math.pow(1 + baseParams.expectedReturn, 10);
    expect(result.finalDistribution.median).toBeCloseTo(expectedFinal, 0);
    expect(result.finalDistribution.stdev).toBe(0);
  });

  it("computes successRate against a target", () => {
    const easyTarget = service.run({
      ...baseParams,
      targetValue: 1, // anything above zero, basically guaranteed
    });
    expect(easyTarget.successRate).toBe(1);

    const impossibleTarget = service.run({
      ...baseParams,
      targetValue: 1e15,
    });
    expect(impossibleTarget.successRate).toBe(0);
  });

  it("returns null successRate when no target is set", () => {
    const result = service.run({ ...baseParams, targetValue: null });
    expect(result.successRate).toBeNull();
  });

  it("depletes the portfolio when withdrawals far exceed returns", () => {
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

  it("real-value mode produces lower numbers than nominal at the same horizon", () => {
    const nominal = service.run({ ...baseParams, showRealValues: false });
    const real = service.run({ ...baseParams, showRealValues: true });
    const lastIndex = nominal.percentiles.p50.length - 1;
    expect(real.percentiles.p50[lastIndex]).toBeLessThan(
      nominal.percentiles.p50[lastIndex],
    );
    expect(real.realValues).toBe(true);
  });

  it("handles a 0-year horizon by returning a degenerate result", () => {
    const result = service.run({
      ...baseParams,
      yearsToRetirement: 0,
      yearsInRetirement: 0,
    });
    expect(result.percentiles.p50).toEqual([]);
    expect(result.finalDistribution.median).toBe(baseParams.startingValue);
  });

  it("growth-rate contributions exceed flat contributions over time", () => {
    const flat = service.run({
      ...baseParams,
      contributionGrowthRate: 0,
      volatility: 0,
    });
    const growing = service.run({
      ...baseParams,
      contributionGrowthRate: 0.05,
      volatility: 0,
    });
    expect(growing.finalDistribution.median).toBeGreaterThan(
      flat.finalDistribution.median,
    );
  });
});
