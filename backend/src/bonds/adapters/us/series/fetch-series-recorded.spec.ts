import { parseBondTerms } from "../../../domain/bond-terms";
import { parseTbill13w } from "../us-tbill-13w";
import { fetchSeries } from "./fetch-series";
import {
  fakeFetch,
  fixtureJson,
  fixtureText,
  treasuryAnswers,
} from "./fixture-helpers";

/**
 * The fetch over answers recorded verbatim from TreasuryDirect on 2026-11-06
 * (`fixtures/recorded/`, listed in `fixtures/README.md`). The constructed
 * fixtures prove each code path; these prove the field names and formats the
 * live source actually sends.
 */
const NOW = () => new Date("2026-11-06T12:00:00.000Z");

function recorded(cusip: string, xml: string | null) {
  return fakeFetch(
    treasuryAnswers(
      cusip,
      fixtureJson(`recorded/search-${cusip}.json`),
      xml === null ? {} : { [xml]: fixtureText(`recorded/${xml}`) },
    ),
  );
}

async function termsOf(code: string, cusip: string, xml: string | null) {
  const fetch = recorded(cusip, xml);
  const { entry } = await fetchSeries(code, fetch, NOW);
  return { terms: parseBondTerms(entry.terms), calls: fetch.calls };
}

describe("the fetch over recorded TreasuryDirect answers", () => {
  it("reads the 26-week bill of #1908 and its results file", async () => {
    const { terms, calls } = await termsOf(
      "912797WM5261001",
      "912797WM5",
      "R_20260928_1.xml",
    );
    expect(terms.schedule).toMatchObject({
      anchor: "ISSUE_DATE",
      issueDate: "2026-10-01",
      maturityDate: "2027-04-01",
    });
    expect(terms.rateRule).toEqual({ type: "ZERO_COUPON_DISCOUNT" });
    expect(calls).toHaveLength(2);
  });

  it.each([
    // [cusip, results file, dated, first coupon (the file's FirstInterestPaymentDate), maturity, annual rate]
    [
      "91282CRF0",
      "R_20260812_2.xml",
      "2026-08-15",
      "2027-02-15",
      "2036-08-15",
      "0.04625",
    ],
    [
      "912810UW6",
      "R_20260813_3.xml",
      "2026-08-15",
      "2027-02-15",
      "2056-08-15",
      "0.05125",
    ],
  ])(
    "reads the original issue of the note or bond %s, past its reopenings",
    async (
      cusip,
      xml,
      datedDate,
      firstCouponDate,
      maturityDate,
      annualRate,
    ) => {
      const { terms } = await termsOf(cusip, cusip, xml);
      expect(terms.schedule).toMatchObject({
        anchor: "COUPON_DATES",
        datedDate,
        firstCouponDate,
        maturityDate,
        couponMonths: 6,
        endOfMonth: false,
      });
      expect(terms.rateRule).toEqual({ type: "FIXED", annualRate });
    },
  );

  it("reads a TIPS with the reference CPI of its original dated date", async () => {
    const { terms } = await termsOf(
      "91282CRE3",
      "91282CRE3",
      "R_20260723_3.xml",
    );
    expect(terms.schedule).toMatchObject({
      datedDate: "2026-07-15",
      firstCouponDate: "2027-01-15",
      maturityDate: "2036-07-15",
    });
    expect(terms.rateRule).toEqual({ type: "FIXED", annualRate: "0.02375" });
    expect(terms.principalRule).toMatchObject({
      type: "INDEX_RATIO",
      baseReference: "333.96974",
    });
  });

  it("reads a floating rate note with a month-end quarterly schedule", async () => {
    const { terms } = await termsOf(
      "91282CQM6",
      "91282CQM6",
      "R_20260428_1.xml",
    );
    expect(terms.schedule).toMatchObject({
      datedDate: "2026-04-30",
      firstCouponDate: "2026-07-31",
      maturityDate: "2028-04-30",
      couponMonths: 3,
      endOfMonth: true,
    });
    expect(terms.rateRule).toMatchObject({
      type: "DAILY_INDEX_PLUS_SPREAD",
      spread: "0.00103",
    });
  });

  it("reads a 2001 TIPS whose record names no results file", async () => {
    const { terms, calls } = await termsOf("912810FQ6", "912810FQ6", null);
    expect(terms.schedule).toMatchObject({
      datedDate: "2001-10-15",
      firstCouponDate: "2002-04-15",
      maturityDate: "2032-04-15",
    });
    expect(terms.principalRule).toMatchObject({ baseReference: "177.5" });
    expect(calls).toHaveLength(1);
  });

  it("reads a yield for every weekly 13-week auction of a recorded search", () => {
    const body = new TextEncoder().encode(
      fixtureText("recorded/search-13-week-bills.json"),
    );
    const observations = parseTbill13w(body);
    // Issued 2026-09-01 to 2026-11-06: ten weekly auctions, none missing.
    expect(observations.map((o) => o.observationDate)).toEqual([
      "2026-08-31",
      "2026-09-08",
      "2026-09-14",
      "2026-09-21",
      "2026-09-28",
      "2026-10-05",
      "2026-10-13",
      "2026-10-19",
      "2026-10-26",
      "2026-11-02",
    ]);
    for (const o of observations) {
      expect(o.observationDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(Number(o.value)).toBeGreaterThan(0);
      expect(Number(o.value)).toBeLessThan(0.2);
    }
  });
});
