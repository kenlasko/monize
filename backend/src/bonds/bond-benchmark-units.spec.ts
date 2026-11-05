import { assertBenchmarkUnit } from "./bond-benchmark-units";
import { BondDataInconsistentError } from "./bond-errors";

const rate = {
  benchmarkId: "B_RATE",
  role: "RATE",
  unit: "RATE_FRACTION",
} as const;

describe("assertBenchmarkUnit", () => {
  it("accepts the unit the terms read the series in", () => {
    expect(() => assertBenchmarkUnit(rate, "RATE_FRACTION")).not.toThrow();
  });

  it("refuses another unit and names the series and both units", () => {
    expect(() => assertBenchmarkUnit(rate, "INDEX_LEVEL")).toThrow(
      BondDataInconsistentError,
    );
    try {
      assertBenchmarkUnit(rate, "INDEX_LEVEL");
    } catch (error) {
      expect(error).toMatchObject({
        code: "BENCHMARK_UNIT_MISMATCH",
        params: {
          benchmarkId: "B_RATE",
          unit: "INDEX_LEVEL",
          expected: "RATE_FRACTION",
        },
      });
    }
  });

  it("does not judge a row that states no unit (the column is NOT NULL; only a hand-built row lacks it)", () => {
    expect(() => assertBenchmarkUnit(rate, undefined)).not.toThrow();
  });
});
