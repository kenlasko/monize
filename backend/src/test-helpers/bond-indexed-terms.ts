import { BenchmarkData } from "@/bonds/domain/benchmark";
import { BondTerms, parseBondTerms } from "@/bonds/domain/bond-terms";
import { BondEngineInput, valueBondLot } from "@/bonds/engine/bond-engine";
import {
  couponDoc,
  CouponDocOptions,
  Doc,
  lotOf,
} from "@/test-helpers/bond-coupon-terms";

/** The id of the index benchmark the indexed fixtures read. */
export const INDEX_ID = "INDEX_LEVEL_SERIES";

export interface IndexedDocOptions extends CouponDocOptions {
  /** The reference index of the dated date, as published. */
  readonly base: string;
  readonly maturityFloor?: "PAR" | "NONE";
}

/**
 * A country-neutral indexed coupon note of face 100 (the shape of
 * `couponDoc`) whose principal is `INDEX_RATIO` on `INDEX_ID`: a lag of three
 * months, daily linear interpolation, truncated to six decimals and rounded to
 * five (`docs/specs/bond-marketable-primitives.md` 7.1).
 */
export function indexedDoc(
  o: IndexedDocOptions,
  change: (doc: Doc) => void = () => undefined,
): Doc {
  return couponDoc(o, (doc) => {
    doc.principalRule = {
      type: "INDEX_RATIO",
      benchmarkId: INDEX_ID,
      baseReference: o.base,
      lagMonths: 3,
      interpolation: "DAILY_LINEAR",
      truncateDecimals: 6,
      roundDecimals: 5,
      maturityFloor: o.maturityFloor ?? "PAR",
    };
    change(doc);
  });
}

export function indexedTerms(
  o: IndexedDocOptions,
  change?: (doc: Doc) => void,
): BondTerms {
  return parseBondTerms(indexedDoc(o, change));
}

/** A monthly index series from `YYYY-MM` to level. */
export function monthlyIndex(
  levels: Readonly<Record<string, string>>,
  publisher = "PUBLISHER",
): ReadonlyMap<string, BenchmarkData> {
  return new Map<string, BenchmarkData>([
    [
      INDEX_ID,
      {
        kind: "MONTHLY",
        publisher,
        values: new Map(Object.entries(levels)),
      },
    ],
  ]);
}

/** The valuation of an indexed lot on `asOf`, with the stored `levels` and, optionally, an assumed annual inflation. */
export function valueIndexed(
  terms: BondTerms,
  lot: { purchaseDate: string; quantity: number },
  asOf: string,
  levels: Readonly<Record<string, string>>,
  annualInflation?: string,
) {
  const input: BondEngineInput = {
    ...lotOf(terms, lot.purchaseDate, lot.quantity),
    benchmarks: monthlyIndex(levels),
    projection:
      annualInflation === undefined
        ? undefined
        : new Map([[INDEX_ID, annualInflation]]),
    asOf,
  };
  return valueBondLot(input);
}
