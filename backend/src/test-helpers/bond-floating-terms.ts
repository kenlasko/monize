import { BenchmarkData } from "@/bonds/domain/benchmark";
import { BondTerms, parseBondTerms } from "@/bonds/domain/bond-terms";
import { addDays } from "@/bonds/domain/calendar-date";
import { BondEngineInput, valueBondLot } from "@/bonds/engine/bond-engine";
import { couponDoc, Doc, lotOf } from "@/test-helpers/bond-coupon-terms";

/** The id of the weekly index benchmark the floating fixtures read. */
export const FLOAT_ID = "FLOAT_INDEX_SERIES";

export interface FloatingDocOptions {
  /** The spread as a fraction (may be negative), e.g. "0.00103". */
  readonly spread: string;
  readonly lockoutBusinessDays?: number;
  readonly paymentAdjustment?: "NONE" | "NEXT_BUSINESS_DAY";
}

/**
 * A country-neutral floating rate note of face 100: dated 2026-04-30, first
 * coupon 2026-07-31, maturity 2028-04-30, quarterly on month ends (eight
 * periods), the rate `DAILY_INDEX_PLUS_SPREAD` on `FLOAT_ID` with a zero floor
 * and nine daily decimals (`docs/specs/bond-marketable-primitives.md` 7.2).
 */
export function floatingDoc(
  o: FloatingDocOptions,
  change: (doc: Doc) => void = () => undefined,
): Doc {
  return couponDoc(
    {
      datedDate: "2026-04-30",
      firstCouponDate: "2026-07-31",
      maturityDate: "2028-04-30",
      rate: "0",
      couponMonths: 3,
      endOfMonth: true,
      paymentAdjustment: o.paymentAdjustment,
    },
    (doc) => {
      doc.accrual = { type: "ACTUAL_360_DAILY_SUM" };
      doc.rateRule = {
        type: "DAILY_INDEX_PLUS_SPREAD",
        benchmarkId: FLOAT_ID,
        spread: o.spread,
        floor: "0",
        lockoutBusinessDays: o.lockoutBusinessDays ?? 2,
        calendarId: "TEST",
        dailyDecimals: 9,
      };
      change(doc);
    },
  );
}

export function floatingTerms(
  o: FloatingDocOptions,
  change?: (doc: Doc) => void,
): BondTerms {
  return parseBondTerms(floatingDoc(o, change));
}

/** Weekly Monday auctions from 2026-04-27, `count` of them, the index 3.60 percent rising 0.02 percent a week. */
export function weeklyIndex(count: number): [string, string][] {
  return Array.from({ length: count }, (_, k) => [
    addDays("2026-04-27", 7 * k),
    (0.036 + 0.0002 * k).toFixed(4),
  ]);
}

/** A STEP series from (date, fraction) observations. */
export function stepIndex(
  observations: readonly (readonly [string, string])[],
  publisher = "PUBLISHER",
): ReadonlyMap<string, BenchmarkData> {
  return new Map<string, BenchmarkData>([
    [
      FLOAT_ID,
      {
        kind: "STEP",
        publisher,
        coveredThrough: observations.length
          ? observations[observations.length - 1][0]
          : null,
        changes: observations.map(([effectiveFrom, value]) => ({
          effectiveFrom,
          value,
        })),
      },
    ],
  ]);
}

/** The valuation of a floating lot on `asOf`, with the stored observations and, optionally, an assumed index. */
export function valueFloating(
  terms: BondTerms,
  lot: { purchaseDate: string; quantity: number },
  asOf: string,
  observations: readonly (readonly [string, string])[],
  assumedIndex?: string,
) {
  const input: BondEngineInput = {
    ...lotOf(terms, lot.purchaseDate, lot.quantity),
    benchmarks: stepIndex(observations),
    projection:
      assumedIndex === undefined
        ? undefined
        : new Map([[FLOAT_ID, assumedIndex]]),
    asOf,
  };
  return valueBondLot(input);
}
