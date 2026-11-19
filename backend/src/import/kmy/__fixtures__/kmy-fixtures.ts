import { readFileSync } from "fs";
import { join } from "path";

/**
 * Test-only registry of the committed KMyMoney sample files. Its own list:
 * nothing here is added to `MNY_FIXTURES`. See README.md for provenance.
 */

export interface KmyFixture {
  /** Bare file name inside this directory. */
  readonly file: string;
  readonly container: "gzip" | "xml";
  /** Counts the reader must report. */
  readonly accounts: number;
  readonly transactions: number;
  readonly schedules: number;
  readonly securities: number;
  readonly currencies: number;
  readonly prices: number;
  readonly budgets: number;
}

const SYNTHETIC_COUNTS = {
  accounts: 17,
  transactions: 11,
  schedules: 1,
  securities: 1,
  currencies: 2,
  prices: 3,
  budgets: 1,
} as const;

const FIXTURES = {
  syntheticKmy: {
    file: "sample-synthetic.kmy",
    container: "gzip",
    ...SYNTHETIC_COUNTS,
  },
  syntheticXml: {
    file: "sample-synthetic.xml",
    container: "xml",
    ...SYNTHETIC_COUNTS,
  },
} as const;

export type KmyFixtureName = keyof typeof FIXTURES;

export const KMY_FIXTURES: Record<KmyFixtureName, KmyFixture> = FIXTURES;

/** Reads a fixture into a fresh buffer on every call. */
export function readKmyFixture(name: KmyFixtureName): Buffer {
  return readFileSync(join(__dirname, KMY_FIXTURES[name].file));
}
