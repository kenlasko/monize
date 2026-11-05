/**
 * What a stored value is: `RATE_FRACTION` a rate as a fraction (0.0575 for 5.75
 * percent), read by a rate rule; `INDEX_LEVEL` the level of an index (335.123),
 * read by a principal rule. A rate rule never reads an `INDEX_LEVEL` series and a
 * principal rule never reads a `RATE_FRACTION` one (`benchmarkReadsOf`).
 */
export type BenchmarkUnit = "RATE_FRACTION" | "INDEX_LEVEL";

/** What a benchmark series is and who publishes it; the data comes from an adapter. */
export interface BenchmarkDefinition {
  readonly id: string;
  readonly kind: "STEP" | "MONTHLY";
  readonly publisher: string;
}

/**
 * Stored observations of one series. STEP: a value in force from a date until
 * the next change. MONTHLY: one value per `YYYY-MM`.
 */
export type BenchmarkData =
  | {
      readonly kind: "STEP";
      readonly publisher: string;
      readonly changes: readonly {
        readonly effectiveFrom: string;
        readonly value: string;
      }[];
      /** Days after this date are unknown even if an older value exists. */
      readonly coveredThrough: string | null;
    }
  | {
      readonly kind: "MONTHLY";
      readonly publisher: string;
      readonly values: ReadonlyMap<string, string>;
    };
