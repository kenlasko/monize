import { BenchmarkUnit } from "./benchmark";
import { BondTerms, rateBenchmarkIdOf } from "./bond-terms";

/** Which part of the terms reads a benchmark series. */
export type BenchmarkRole = "RATE" | "PRINCIPAL";

/** One benchmark series a terms document reads, and the unit its values must be stored in. */
export interface BenchmarkRead {
  readonly benchmarkId: string;
  readonly role: BenchmarkRole;
  readonly unit: BenchmarkUnit;
}

/**
 * Every benchmark the terms read, each with the unit it needs: a rate rule reads
 * a `RATE_FRACTION` series, an `INDEX_RATIO` principal an `INDEX_LEVEL` one. The valuation refuses a stored series whose unit is
 * another (`docs/specs/bond-marketable-primitives.md` 7.1), so a rule never
 * reads a series of the wrong kind of value.
 */
export function benchmarkReadsOf(terms: BondTerms): readonly BenchmarkRead[] {
  const reads: BenchmarkRead[] = [];
  const rateBenchmark = rateBenchmarkIdOf(terms.rateRule);
  if (rateBenchmark !== null) {
    reads.push({
      benchmarkId: rateBenchmark,
      role: "RATE",
      unit: "RATE_FRACTION",
    });
  }
  const principal = terms.principalRule;
  if (principal.type === "INDEX_RATIO") {
    reads.push({
      benchmarkId: principal.benchmarkId,
      role: "PRINCIPAL",
      unit: "INDEX_LEVEL",
    });
  }
  return reads;
}

/** True when the terms read the benchmark `benchmarkId`, in any role. */
export function readsBenchmark(terms: BondTerms, benchmarkId: string): boolean {
  return benchmarkReadsOf(terms).some((r) => r.benchmarkId === benchmarkId);
}
