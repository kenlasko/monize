import { BondTerms } from "../../domain/bond-terms";
import { EMPTY_CALENDAR_REGISTRY } from "../../domain/calendar-registry";
import { BenchmarkData } from "../../domain/benchmark";
import { BondEngineInput } from "../../engine/bond-engine-types";
import { redemptionSplit, valueBondLot } from "../../engine/bond-engine";
import { registerUsCalendars } from ".";

export interface Lot {
  purchaseDate: string;
  quantity: number;
  cost?: string;
}

export interface GoldenCase {
  id: string;
  description: string;
  source: string;
  lot: Lot;
  asOf: string;
  expect?: Record<string, unknown>;
  expectTerms?: { issuePrice: string };
  /** A BUY row's total amount; the lot's cost is what the write path reads from it. */
  purchaseTotalAmount?: string;
  split?: { date: string; expect: Record<string, unknown> };
  knownCashflows?: Record<string, unknown>[];
}

export const calendars = registerUsCalendars(EMPTY_CALENDAR_REGISTRY);

/** The stored benchmark series a case reads, by code. */
export type Benchmarks = ReadonlyMap<string, BenchmarkData>;

export function inputOf(
  terms: BondTerms,
  c: GoldenCase,
  benchmarks: Benchmarks = new Map(),
): BondEngineInput {
  return {
    terms,
    termsVersion: 1,
    announcedRates: new Map(),
    benchmarks,
    calendars,
    lot: c.lot,
    asOf: c.asOf,
  };
}

export function check(
  terms: BondTerms,
  c: GoldenCase,
  benchmarks: Benchmarks = new Map(),
): void {
  const input = inputOf(terms, c, benchmarks);
  const valuation = valueBondLot(input);
  if (c.expect) expect(valuation).toMatchObject(c.expect);
  for (const flow of c.knownCashflows ?? []) {
    expect(valuation.knownCashflows).toContainEqual(
      expect.objectContaining(flow),
    );
  }
  if (c.split) {
    const { asOf: _unused, ...lot } = input;
    expect(redemptionSplit(lot, c.split.date)).toMatchObject(c.split.expect);
  }
}
