import { BenchmarkData } from "../../domain/benchmark";
import { parseBondTerms } from "../../domain/bond-terms";
import { ExactDecimal } from "../../domain/exact-decimal";
import { IndexRatioRule } from "../../domain/principal-rule";
import { valueBondLot } from "../../engine/bond-engine";
import { indexFigureOn, indexSeriesOf } from "../../engine/index-ratio";
import { calendars, check, GoldenCase } from "./golden-support";
import frnCases from "./frn-cases.json";
import { fetchSeries } from "./series/fetch-series";
import {
  fakeFetch,
  fixtureJson,
  fixtureText,
  treasuryAnswers,
} from "./series/fixture-helpers";
import {
  fillCoupon,
  SERIES_TEMPLATES,
  SourceDocument,
} from "./series/templates";
import tipsCases from "./tips-cases.json";
import { moneyMarketYield } from "./us-tbill-13w";
import { US_CPI_U_NSA, US_TBILL_13W_MMY } from "./us-benchmarks";

// Expected figures come from the official formulas named in each case's
// `source` (31 CFR 356 Appendix B, Treasury's Ref CPI table of July 2026),
// never from the engine's output.

const source: SourceDocument = {
  provider: "treasurydirect",
  url: "https://www.law.cornell.edu/cfr/text/31/appendix-B_to_part_356",
  document: "31 CFR 356 Appendix B",
};

const monthly = (levels: Record<string, string>): Map<string, BenchmarkData> =>
  new Map([
    [
      US_CPI_U_NSA,
      {
        kind: "MONTHLY",
        publisher: "BLS",
        values: new Map(Object.entries(levels)),
      },
    ],
  ]);

interface TipsCase extends GoldenCase {
  terms: {
    datedDate: string;
    firstCouponDate: string;
    maturityDate: string;
    annualRate: string;
    endOfMonth: boolean;
    baseReference?: string;
  };
  levels: Record<string, string>;
  ratios?: {
    date: string;
    refCpi: string;
    byBase: Record<string, string>;
  }[];
}

const tipsTerms = (c: TipsCase, baseReference?: string) =>
  parseBondTerms(
    fillCoupon(SERIES_TEMPLATES.TIPS, {
      seriesCode: `APPB-${c.id}`,
      ...c.terms,
      baseReference: baseReference ?? c.terms.baseReference ?? "164",
      source,
    }),
  );

describe("golden cases for TIPS (31 CFR 356 Appendix B)", () => {
  const cases = tipsCases.cases as unknown as TipsCase[];

  it.each(cases.filter((c) => c.expect || c.knownCashflows || c.split))(
    "$id: $description",
    (c) => {
      check(tipsTerms(c), c, monthly(c.levels));
    },
  );

  it("E9: the Ref CPI and the index ratio of each July 2026 day on each base", () => {
    const c = cases.find((x) => x.id === "E9") as TipsCase;
    for (const day of c.ratios ?? []) {
      for (const [base, ratio] of Object.entries(day.byBase)) {
        const rule = tipsTerms(c, base).principalRule as IndexRatioRule;
        const series = indexSeriesOf(
          rule,
          monthly(c.levels).get(US_CPI_U_NSA),
          null,
        );
        const figure = indexFigureOn({ series, asOf: "2026-07-01" }, day.date);
        expect({
          date: day.date,
          base,
          refCpi: figure.refIndex?.toFixed(5),
          ratio: figure.ratio?.toFixed(5),
        }).toEqual({ date: day.date, base, refCpi: day.refCpi, ratio });
      }
    }
  });

  it("E9: a lot values its principal at the ratio of the day", () => {
    const c = cases.find((x) => x.id === "E9") as TipsCase;
    const terms = tipsTerms(c, "177.50000");
    const valuation = valueBondLot({
      terms,
      termsVersion: 1,
      announcedRates: new Map(),
      benchmarks: monthly(c.levels),
      calendars,
      lot: { purchaseDate: "2025-07-15", quantity: 100 },
      asOf: "2026-07-31",
    });
    expect(valuation.principal).toBe("188.763000");
  });
});

describe("golden cases for floating rate notes (31 CFR 356 Appendix B IV)", () => {
  it.each(frnCases.yields)("$id: $description", (c) => {
    expect(
      moneyMarketYield(ExactDecimal.parse(c.discountPercent), c.days),
    ).toEqual(c.expect);
  });

  async function fixtureTerms(spread?: string) {
    const get = fakeFetch(
      treasuryAnswers(frnCases.series, fixtureJson(frnCases.fixture), {
        "R_20260428_1.xml": fixtureText("R_20260428_1.xml"),
      }),
    );
    const { entry } = await fetchSeries(frnCases.series, get);
    const terms = parseBondTerms(entry.terms);
    if (spread === undefined) return terms;
    const schedule = terms.schedule as unknown as {
      datedDate: string;
      firstCouponDate: string;
      maturityDate: string;
    };
    return parseBondTerms(
      fillCoupon(SERIES_TEMPLATES.FRN, {
        seriesCode: frnCases.series,
        datedDate: schedule.datedDate,
        firstCouponDate: schedule.firstCouponDate,
        maturityDate: schedule.maturityDate,
        endOfMonth: true,
        spread,
        source,
      }),
    );
  }

  it.each(frnCases.accruals)("$id: $description", async (c) => {
    const terms = await fixtureTerms(c.spread);
    const valuation = valueBondLot({
      terms,
      termsVersion: 1,
      announcedRates: new Map(),
      benchmarks: new Map([
        [
          US_TBILL_13W_MMY,
          {
            kind: "STEP",
            publisher: "Treasury",
            coveredThrough: "2026-05-04",
            changes: [{ effectiveFrom: "2026-04-27", value: c.index }],
          },
        ],
      ]),
      calendars,
      lot: { purchaseDate: "2026-04-30", quantity: 100 },
      asOf: "2026-05-02",
    });
    expect(valuation.rateSchedule[0].dailyRates?.[0]).toMatchObject(c.expect);
  });

  it(`${frnCases.schedule.id}: ${frnCases.schedule.description}`, async () => {
    const terms = await fixtureTerms();
    const valuation = valueBondLot({
      terms,
      termsVersion: 1,
      announcedRates: new Map(),
      benchmarks: new Map(),
      calendars,
      lot: { purchaseDate: "2026-04-30", quantity: 100 },
      asOf: "2026-05-02",
    });
    expect(valuation.rateSchedule.map((p) => p.end)).toEqual(
      frnCases.schedule.ends,
    );
    expect(
      valuation.projectedCashflows
        .filter((f) => f.type === "INTEREST")
        .map((f) => f.date),
    ).toEqual(frnCases.schedule.paid);
  });
});

describe("golden case files (indexed and floating)", () => {
  it("cites a source for every case", () => {
    const all = [
      ...tipsCases.cases,
      ...frnCases.yields,
      ...frnCases.accruals,
      frnCases.schedule,
    ];
    expect(all.map((c) => [c.id, c.source.length > 0])).toEqual(
      all.map((c) => [c.id, true]),
    );
    expect(all.map((c) => c.id)).toEqual([
      "E8",
      "E9",
      "E10",
      "E11",
      "E12",
      "E13",
      "FRN-91282CQM6",
    ]);
  });
});
