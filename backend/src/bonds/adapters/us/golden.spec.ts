import { BondTerms, parseBondTerms } from "../../domain/bond-terms";
import { EMPTY_CALENDAR_REGISTRY } from "../../domain/calendar-registry";
import { BondEngineInput } from "../../engine/bond-engine-types";
import { redemptionSplit, valueBondLot } from "../../engine/bond-engine";
import { registerUsCalendars } from ".";
import billCases from "./bill-cases.json";
import noteCases from "./note-cases.json";
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

// Every expected figure is computed from the official formula named in its
// `source` (31 CFR 356 Appendix B, Treasury's bill price formula), never from
// the engine's output. The bill is the constructed fixture of the bill of
// kenlasko/monize#1908 read through the adapter's own fetch; the notes are
// hand-written terms on the adapter's NOTE template with the dates and rates
// the appendix gives.

interface Lot {
  purchaseDate: string;
  quantity: number;
  cost?: string;
}

interface GoldenCase {
  id: string;
  description: string;
  source: string;
  lot: Lot;
  asOf: string;
  expect?: Record<string, unknown>;
  expectTerms?: { issuePrice: string };
  split?: { date: string; expect: Record<string, unknown> };
  knownCashflows?: Record<string, unknown>[];
}

const calendars = registerUsCalendars(EMPTY_CALENDAR_REGISTRY);

function inputOf(terms: BondTerms, c: GoldenCase): BondEngineInput {
  return {
    terms,
    termsVersion: 1,
    announcedRates: new Map(),
    benchmarks: new Map(),
    calendars,
    lot: c.lot,
    asOf: c.asOf,
  };
}

function check(terms: BondTerms, c: GoldenCase): void {
  const input = inputOf(terms, c);
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

describe("golden cases for the bill of 912797WM5", () => {
  let terms: BondTerms;

  beforeAll(async () => {
    const get = fakeFetch(
      treasuryAnswers("912797WM5", fixtureJson(billCases.fixture), {
        "R_20260929_1.xml": fixtureText("R_20260929_1.xml"),
      }),
    );
    const { entry } = await fetchSeries(billCases.series, get);
    terms = parseBondTerms(entry.terms);
  });

  it.each(billCases.cases as GoldenCase[])("$id: $description", (c) => {
    if (c.expectTerms) {
      expect(terms.instrument.issuePrice).toBe(c.expectTerms.issuePrice);
    }
    check(terms, c);
  });
});

describe("golden cases for notes (31 CFR 356 Appendix B)", () => {
  const source: SourceDocument = {
    provider: "treasurydirect",
    url: "https://www.law.cornell.edu/cfr/text/31/appendix-B_to_part_356",
    document: "31 CFR 356 Appendix B",
  };

  it.each(
    noteCases.cases as unknown as (GoldenCase & {
      terms: {
        datedDate: string;
        firstCouponDate: string;
        maturityDate: string;
        annualRate: string;
        endOfMonth: boolean;
      };
    })[],
  )("$id: $description", (c) => {
    const terms = parseBondTerms(
      fillCoupon(SERIES_TEMPLATES.NOTE, {
        seriesCode: `APPB-${c.id}`,
        ...c.terms,
        source,
      }),
    );
    check(terms, c);
  });
});

describe("golden case files", () => {
  const all = [...billCases.cases, ...noteCases.cases] as GoldenCase[];

  it("cites a source for every case and asserts a figure", () => {
    for (const c of all) {
      expect({ id: c.id, sourced: c.source.length > 0 }).toEqual({
        id: c.id,
        sourced: true,
      });
      const asserted =
        Object.keys(c.expect ?? {}).length +
        Object.keys(c.split?.expect ?? {}).length +
        (c.knownCashflows ?? []).length;
      expect({ id: c.id, asserted: asserted > 0 }).toEqual({
        id: c.id,
        asserted: true,
      });
    }
  });

  it("covers E1 to E7 of the primitives spec", () => {
    expect(all.map((c) => c.id)).toEqual([
      "E1",
      "E2",
      "E3",
      "E4",
      "E5",
      "E6",
      "E7",
    ]);
  });
});
