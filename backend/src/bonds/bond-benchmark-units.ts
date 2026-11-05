import { BenchmarkRead } from "./domain/benchmark-reads";
import { BondDataInconsistentError } from "./bond-errors";

/**
 * Refuses a stored series whose unit is not the one the terms read it in (a rate
 * rule needs `RATE_FRACTION`, a principal rule `INDEX_LEVEL`): a value of the
 * wrong kind would be valued as if it were the right one. The column is NOT NULL,
 * so a row without a unit is a hand-built one and is not judged.
 */
export function assertBenchmarkUnit(
  read: BenchmarkRead,
  stored: unknown,
): void {
  if (typeof stored !== "string" || stored === read.unit) return;
  throw new BondDataInconsistentError(
    "BENCHMARK_UNIT_MISMATCH",
    { benchmarkId: read.benchmarkId, unit: stored, expected: read.unit },
    `Benchmark ${read.benchmarkId} is stored in ${stored}, the terms read it in ${read.unit}`,
  );
}
