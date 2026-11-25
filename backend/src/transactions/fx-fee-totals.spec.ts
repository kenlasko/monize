import { FxAggregate } from "../common/fx-aggregate";
import { foldFxFeeTotals, FxFeeMonthPart } from "./fx-fee-totals";

function month(...fees: number[]): FxFeeMonthPart {
  const sum = new FxAggregate();
  for (const fee of fees) sum.addConverted(fee);
  return { sum, count: fees.length, partial: false };
}

describe("foldFxFeeTotals", () => {
  // Three fees of 2.50496 read 2.50 each, so the page's sum of the months
  // read 7.50 where the fees come to 7.51 (issue #2413).
  it("reads each column, the total and each average once from the aggregates", () => {
    const result = foldFxFeeTotals(
      new Map([
        ["2026-01", month(2.50496)],
        ["2026-02", month(2.50496)],
        ["2026-03", month(2.50496)],
      ]),
      2,
    );

    expect(result.total).toBe(7.51);
    expect(result.count).toBe(3);
    expect(result.byGranularity.month.buckets.map((b) => b.total)).toEqual([
      2.5, 2.5, 2.5,
    ]);
    expect(result.byGranularity.quarter.buckets).toEqual([
      {
        key: "2026-Q1",
        periodStart: "2026-01-01",
        total: 7.51,
        knownTotal: 7.51,
        count: 3,
      },
    ]);
    expect(result.byGranularity.year.buckets).toEqual([
      {
        key: "2026",
        periodStart: "2026-01-01",
        total: 7.51,
        knownTotal: 7.51,
        count: 3,
      },
    ]);
    // 7.51488 over three months is 2.50496, read 2.50; over one quarter 7.51.
    expect(result.byGranularity.month.periodAverage).toBe(2.5);
    expect(result.byGranularity.quarter.periodAverage).toBe(7.51);
  });

  it("counts the empty periods between the first and the last in an average", () => {
    const result = foldFxFeeTotals(
      new Map([
        ["2025-11", month(3)],
        ["2026-02", month(3)],
      ]),
      2,
    );

    // November to February is four months, two quarters and two years.
    expect(result.byGranularity.month.periodAverage).toBe(1.5);
    expect(result.byGranularity.quarter.buckets.map((b) => b.key)).toEqual([
      "2025-Q4",
      "2026-Q1",
    ]);
    expect(result.byGranularity.quarter.periodAverage).toBe(3);
    expect(result.byGranularity.year.periodAverage).toBe(3);
  });

  it("answers zero, not null, with no fees", () => {
    const result = foldFxFeeTotals(new Map(), 2);
    expect(result.total).toBe(0);
    expect(result.count).toBe(0);
    expect(result.byGranularity.month).toEqual({
      buckets: [],
      periodAverage: 0,
      knownPeriodAverage: 0,
    });
  });

  // A month that lost a fee for want of a rate makes every figure over it a
  // subtotal: `null` under its own name, the known part beside it.
  it("withholds every figure over a month that lost a fee, keeping the known part", () => {
    const result = foldFxFeeTotals(
      new Map([
        ["2026-01", month(3)],
        ["2026-02", { ...month(2), partial: true }],
        ["2026-04", month(1)],
      ]),
      2,
    );

    expect(result.total).toBeNull();
    expect(result.knownTotal).toBe(6);
    expect(
      result.byGranularity.month.buckets.map((b) => [b.total, b.knownTotal]),
    ).toEqual([
      [3, 3],
      [null, 2],
      [1, 1],
    ]);
    expect(
      result.byGranularity.quarter.buckets.map((b) => [b.total, b.knownTotal]),
    ).toEqual([
      [null, 5],
      [1, 1],
    ]);
    expect(result.byGranularity.month.periodAverage).toBeNull();
    expect(result.byGranularity.month.knownPeriodAverage).toBe(1.5);
  });

  it("reads a yen total in whole yen", () => {
    const result = foldFxFeeTotals(
      new Map([["2026-01", month(162.3456, 162.3456)]]),
      0,
    );
    expect(result.total).toBe(325);
    expect(result.byGranularity.month.buckets[0].total).toBe(325);
  });
});
