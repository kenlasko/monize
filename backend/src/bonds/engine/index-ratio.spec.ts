import { IndexRatioRule } from "../domain/principal-rule";
import { ExactDecimal } from "../domain/exact-decimal";
import { indexFigureOn, indexSeriesOf } from "./index-ratio";

const rule = (baseReference: string): IndexRatioRule => ({
  type: "INDEX_RATIO",
  benchmarkId: "IDX",
  baseReference,
  lagMonths: 3,
  interpolation: "DAILY_LINEAR",
  truncateDecimals: 6,
  roundDecimals: 5,
  maturityFloor: "PAR",
});

const levels = (
  entries: Record<string, string>,
  inflation: string | null = null,
) =>
  indexSeriesOf(
    rule("1"),
    {
      kind: "MONTHLY",
      publisher: "P",
      values: new Map(Object.entries(entries)),
    },
    inflation === null ? null : ExactDecimal.parse(inflation),
  );

// 31 CFR 356 Appendix B I.B and the Treasury's "Ref CPI and Index Ratios for
// July 2026": the CPI-U (NSA) of March, April and May 2026.
const CPI = {
  "2026-03": "330.213",
  "2026-04": "333.020",
  "2026-05": "335.123",
};

describe("the reference index of a day (E9)", () => {
  const lookup = (base: string) => ({
    series: indexSeriesOf(
      rule(base),
      { kind: "MONTHLY", publisher: "P", values: new Map(Object.entries(CPI)) },
      null,
    ),
    asOf: "2026-07-31",
  });

  it.each([
    ["2026-07-01", "333.02000"],
    ["2026-07-02", "333.08784"],
    ["2026-07-15", "333.96974"],
    ["2026-07-31", "335.05516"],
  ])("is %s -> %s", (date, ref) => {
    expect(indexFigureOn(lookup("161.74000"), date).refIndex?.toFixed(5)).toBe(
      ref,
    );
  });

  it.each([
    ["2026-07-02", "161.74000", "2.05940"],
    ["2026-07-02", "164.39333", "2.02616"],
    ["2026-07-02", "177.50000", "1.87655"],
    ["2026-07-15", "161.74000", "2.06486"],
    ["2026-07-15", "164.39333", "2.03153"],
    ["2026-07-15", "177.50000", "1.88152"],
    ["2026-07-31", "161.74000", "2.07157"],
    ["2026-07-31", "164.39333", "2.03813"],
    ["2026-07-31", "177.50000", "1.88763"],
  ])("the ratio of %s on the base %s is %s", (date, base, ratio) => {
    expect(indexFigureOn(lookup(base), date).ratio?.toFixed(5)).toBe(ratio);
  });

  it("reads one month only on the first of a month (no interpolation)", () => {
    const only = {
      series: levels({ "2026-04": "333.020" }),
      asOf: "2026-07-31",
    };
    expect(indexFigureOn(only, "2026-07-01").refIndex?.toFixed(5)).toBe(
      "333.02000",
    );
    // The 2nd needs May as well: it is named, never replaced by April.
    const second = indexFigureOn(only, "2026-07-02");
    expect(second.ratio).toBeNull();
    expect(second.absent).toEqual(["2026-05"]);
  });
});

describe("a figure that cannot be worked out", () => {
  it("is unknown and names every month it needs that is not stored", () => {
    const figure = indexFigureOn(
      { series: levels({ "2026-03": "330.213" }), asOf: "2026-07-31" },
      "2026-07-15",
    );
    expect(figure.refIndex).toBeNull();
    expect(figure.ratio).toBeNull();
    expect(figure.projected).toBe(false);
    expect(figure.absent).toEqual(["2026-04", "2026-05"]);
  });

  it("is unknown when the benchmark is not stored at all", () => {
    const figure = indexFigureOn(
      {
        series: indexSeriesOf(rule("100"), undefined, null),
        asOf: "2026-07-31",
      },
      "2026-07-01",
    );
    expect(figure.ratio).toBeNull();
    expect(figure.absent).toEqual(["2026-04"]);
  });
});

describe("a projected month", () => {
  const series = levels({ "2026-10": "166.2" }, "0.03");

  it("grows the newest stored level by the assumed inflation x months / 12, after the valuation day only", () => {
    // 2027-07-01 reads 2027-04: 6 months after 2026-10 -> 166.2 x 1.015.
    const after = indexFigureOn({ series, asOf: "2026-11-01" }, "2027-07-01");
    expect(after.refIndex?.toFixed(5)).toBe("168.69300");
    expect(after.projected).toBe(true);
    expect(after.absent).toEqual([]);
    // On or before the valuation day it is unknown, never projected.
    const due = indexFigureOn({ series, asOf: "2027-07-01" }, "2027-07-01");
    expect(due.ratio).toBeNull();
    expect(due.absent).toEqual(["2027-04"]);
  });

  it("never projects a month older than the newest stored one", () => {
    const gap = indexFigureOn(
      {
        series: levels({ "2026-03": "330.213", "2026-10": "166.2" }, "0.03"),
        asOf: "2026-01-01",
      },
      "2026-07-01",
    );
    expect(gap.ratio).toBeNull();
    expect(gap.absent).toEqual(["2026-04"]);
  });

  it("has nothing to project from with no stored month", () => {
    const none = indexFigureOn(
      { series: levels({}, "0.03"), asOf: "2026-01-01" },
      "2026-07-01",
    );
    expect(none.ratio).toBeNull();
  });
});
