import { auctionsByIssueUrl, auctionsNear } from "./auctions-near";
import { fakeFetch, fixtureText } from "./fixture-helpers";

/**
 * Recorded verbatim on 2026-11-06 (`fixtures/recorded/issued-*.json`): every
 * Bill, Note and Bond with an issue date from 2026-10-06 to 2026-12-07, the
 * window `auctionsNear` asks for a trade date of 2026-11-06.
 */
const DATE = "2026-11-06";
const START = "2026-10-06";
const END = "2026-12-07";

function recordedFetch() {
  const answers: Record<string, string> = {};
  for (const type of ["Bill", "Note", "Bond"] as const) {
    answers[auctionsByIssueUrl(type, START, END)] = fixtureText(
      `recorded/issued-${type}-${START}-${END}.json`,
    );
  }
  return fakeFetch(answers);
}

describe("auctionsNear (TreasuryDirect)", () => {
  it("asks for the program's security type over a month either side of the date", async () => {
    const fetch = recordedFetch();
    await auctionsNear("NOTE", DATE, fetch);
    expect(fetch.calls).toEqual([
      "https://www.treasurydirect.gov/TA_WS/securities/search?format=json" +
        "&securityType=Note&dateFieldName=issueDate" +
        "&startDate=2026-10-06&endDate=2026-12-07",
    ]);
  });

  it("lists nominal notes only, nearest issue first, announced ones without a price", async () => {
    const listings = await auctionsNear("NOTE", DATE, recordedFetch());
    expect(listings.map((l) => [l.identifier, l.issueDate, l.term])).toEqual([
      ["91282CRU7", "2026-11-02", "2-Year"],
      ["91282CRT0", "2026-11-02", "5-Year"],
      ["91282CRV5", "2026-11-02", "7-Year"],
      ["91282CRW3", "2026-11-16", "3-Year"],
      ["91282CRX1", "2026-11-16", "10-Year"],
      ["91282CRQ6", "2026-10-15", "3-Year"],
      ["91282CRF0", "2026-10-15", "9-Year 10-Month"],
    ]);
    expect(listings[1]).toEqual({
      seriesCode: "91282CRT0",
      identifier: "91282CRT0",
      term: "5-Year",
      auctionDate: "2026-10-27",
      issueDate: "2026-11-02",
      maturityDate: "2031-10-31",
      reopening: false,
      announced: false,
      rateKind: "COUPON",
      ratePercent: "4.75",
      pricePer100: "99.582397",
    });
    const announced = listings.find((l) => l.identifier === "91282CRX1");
    expect(announced).toMatchObject({
      announced: true,
      ratePercent: null,
      pricePer100: null,
    });
    expect(listings.find((l) => l.identifier === "91282CRF0")?.reopening).toBe(
      true,
    );
  });

  it("lists a TIPS from the Note and Bond lists by its flag", async () => {
    const listings = await auctionsNear("TIPS", DATE, recordedFetch());
    expect(listings.map((l) => l.identifier)).toEqual(["91282CRR4"]);
    expect(listings[0]).toMatchObject({
      rateKind: "COUPON",
      ratePercent: "2.25",
    });
  });

  it("lists a floating rate note with its spread", async () => {
    const listings = await auctionsNear("FRN", DATE, recordedFetch());
    expect(listings).toHaveLength(1);
    expect(listings[0]).toMatchObject({
      identifier: "91282CRS2",
      seriesCode: "91282CRS2",
      rateKind: "SPREAD",
      ratePercent: "0.038",
    });
  });

  it("names a bill's series by its CUSIP and issue date, and drops a bill shorter than 28 days", async () => {
    const listings = await auctionsNear("BILL", DATE, recordedFetch());
    expect(listings.length).toBeGreaterThan(10);
    for (const l of listings) {
      expect(l.seriesCode).toBe(
        l.identifier +
          l.issueDate.slice(2, 4) +
          l.issueDate.slice(5, 7) +
          l.issueDate.slice(8, 10),
      );
      expect(l.rateKind).toBe("DISCOUNT");
    }
    const issued = listings.filter((l) => !l.announced);
    expect(
      issued.every((l) => l.ratePercent !== null && l.pricePer100 !== null),
    ).toBe(true);
  });

  it("lists nothing for a program it does not know, without a request", async () => {
    const fetch = recordedFetch();
    expect(await auctionsNear("EDO", DATE, fetch)).toEqual([]);
    expect(fetch.calls).toEqual([]);
  });

  it("skips a record it cannot read instead of failing the list", async () => {
    const records = JSON.parse(
      fixtureText(`recorded/issued-Bond-${START}-${END}.json`),
    );
    records[0].issueDate = "not a date";
    records[1].cusip = "912810UX5";
    const fetch = fakeFetch({
      [auctionsByIssueUrl("Bond", START, END)]: JSON.stringify(records),
    });
    const listings = await auctionsNear("BOND", DATE, fetch);
    expect(listings).toHaveLength(records.length - 2);
  });
});
