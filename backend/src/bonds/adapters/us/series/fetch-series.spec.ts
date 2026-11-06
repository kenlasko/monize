import { SeriesFetchError } from "../../../bond-adapter";
import { parseBondTerms } from "../../../domain/bond-terms";
import { fetchSeries } from "./fetch-series";
import {
  Answer,
  fakeFetch,
  fixtureJson,
  fixtureText,
  treasuryAnswers,
} from "./fixture-helpers";
import { auctionSearchUrl, resultsXmlUrl } from "./series-source";

type Rec = Record<string, unknown>;

const BILL = "912797WM5261001";
const NOTE = "91282CZK0";
const NOW = () => new Date("2026-11-04T10:00:00.000Z");
const NO_XML = { treasuryAuctionResultsXmlFileName: "" };

const billJson = () => fixtureJson("ta-ws-912797WM5.json");
const noteJson = () => fixtureJson("ta-ws-91282CZK0.json");
const billXml = () => fixtureText("R_20260929_1.xml");
const noteXml = () => fixtureText("R_20260928_1.xml");

function billFetch(records: unknown = billJson(), xml = billXml()) {
  return fakeFetch(
    treasuryAnswers("912797WM5", records, { "R_20260929_1.xml": xml }),
  );
}

function noteFetch(records: unknown = noteJson(), xml = noteXml()) {
  return fakeFetch(
    treasuryAnswers(NOTE, records, {
      "R_20260928_1.xml": xml,
      "R_20261027_1.xml": xml,
    }),
  );
}

const withRecord = (records: Rec[], index: number, change: Rec): Rec[] =>
  records.map((r, i) => (i === index ? { ...r, ...change } : r));

const without = (records: Rec[], field: string): Rec[] =>
  records.map((r, i) => {
    if (i !== 0) return r;
    const { [field]: _gone, ...rest } = r;
    return rest;
  });

async function refusal(promise: Promise<unknown>): Promise<SeriesFetchError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(SeriesFetchError);
    return error as SeriesFetchError;
  }
  throw new Error("expected a SeriesFetchError");
}

describe("fetching a bill", () => {
  it("reads the auction, checks its price and fills the template", async () => {
    const get = billFetch();
    const { entry, sources } = await fetchSeries(BILL, get, NOW);
    expect(entry.termsVersion).toBe(1);
    expect(entry.publishedAt).toBe("2026-09-29");
    const terms = parseBondTerms(entry.terms);
    expect(terms.instrument).toMatchObject({
      issuerCountryCode: "US",
      issuerCode: "US_TREASURY",
      programCode: "BILL",
      seriesCode: BILL,
      currency: "USD",
      marketability: "MARKETABLE",
      faceValue: "100",
      issuePrice: "97.833694",
    });
    expect(terms.schedule).toMatchObject({
      anchor: "ISSUE_DATE",
      issueDate: "2026-10-01",
      maturityDate: "2027-04-01",
      calendarId: "US",
    });
    expect(terms.rateRule).toEqual({ type: "ZERO_COUPON_DISCOUNT" });
    expect(terms.saleWindow).toBeNull();
    expect(terms.source).toEqual({
      provider: "treasurydirect",
      url: auctionSearchUrl("912797WM5"),
      document: "auction 2026-09-29",
    });
    expect(sources.map((s) => s.url)).toEqual([
      auctionSearchUrl("912797WM5"),
      resultsXmlUrl("R_20260929_1.xml"),
    ]);
    expect(sources[0].retrievedAt).toBe("2026-11-04T10:00:00.000Z");
    expect(get.calls).toEqual([
      "https://www.treasurydirect.gov/TA_WS/securities/search?cusip=912797WM5&format=json",
      "https://www.treasurydirect.gov/xml/R_20260929_1.xml",
    ]);
  });

  it("needs no results file when the record names none", async () => {
    const get = billFetch(withRecord(billJson(), 0, NO_XML));
    const { entry, sources } = await fetchSeries(BILL, get, NOW);
    expect(entry.publishedAt).toBe("2026-09-29");
    expect(sources).toHaveLength(1);
    expect(get.calls).toHaveLength(1);
  });

  it("takes the issue of the code's date among reopenings of the same CUSIP", async () => {
    const reopening: Rec = {
      ...billJson()[0],
      competitiveAuctionCloseDate: "2026-10-27T00:00:00",
      issueDate: "2026-10-29T00:00:00",
      highRate: "4.100000",
      highPrice: "98.246111",
      reopening: "Yes",
      ...NO_XML,
    };
    const { entry } = await fetchSeries(
      "912797WM5261029",
      billFetch([...billJson(), reopening]),
      NOW,
    );
    const terms = parseBondTerms(entry.terms);
    expect(terms.instrument.issuePrice).toBe("98.246111");
    expect(terms.schedule).toMatchObject({ issueDate: "2026-10-29" });
  });

  it("answers SERIES_NOT_PUBLISHED when no auction was issued on the code's date", async () => {
    const error = await refusal(
      fetchSeries("912797WM5261002", billFetch(), NOW),
    );
    expect(error.code).toBe("SERIES_NOT_PUBLISHED");
  });

  it("refuses the bare CUSIP of a bill: its issue date is needed", async () => {
    const error = await refusal(fetchSeries("912797WM5", billFetch(), NOW));
    expect(error.code).toBe("SERIES_CODE_INVALID");
  });

  it("refuses a price that is not the discount formula to six decimals", async () => {
    const records = withRecord(billJson(), 0, { highPrice: "97.833695" });
    const error = await refusal(fetchSeries(BILL, billFetch(records), NOW));
    expect(error.code).toBe("SOURCE_INCONSISTENT");
    expect(error.params).toMatchObject({
      field: "highPrice",
      value: "97.833695",
      expected: "97.833694",
    });
  });

  it.each([
    [
      "a term under 4 weeks",
      { maturityDate: "2026-10-15T00:00:00", highPrice: "99.833361" },
    ],
    [
      "a term over 52 weeks",
      { maturityDate: "2027-10-08T00:00:00", highPrice: "95.658472" },
    ],
  ])("refuses %s", async (_name, change) => {
    const records = withRecord(billJson(), 0, { ...change, ...NO_XML });
    const error = await refusal(fetchSeries(BILL, billFetch(records), NOW));
    expect(error.code).toBe("SOURCE_INCONSISTENT");
    expect(error.params.field).toBe("term");
  });

  it("accepts a bill auctioned at a discount rate of nothing (a price of par)", async () => {
    const { entry } = await fetchSeries(
      BILL,
      billFetch(fixtureJson("ta-ws-912797WM5-par.json")),
      NOW,
    );
    const terms = parseBondTerms(entry.terms);
    expect(terms.instrument.issuePrice).toBe("100.00");
    expect(terms.instrument.faceValue).toBe("100");
  });

  it.each([
    ["a price of par with a discount rate", { highRate: "0.100000" }],
    ["a price under par with no discount rate", { highPrice: "99.999999" }],
    ["a price above par", { highPrice: "100.000001" }],
  ])("refuses %s", async (_name, change) => {
    const records = withRecord(fixtureJson("ta-ws-912797WM5-par.json"), 0, {
      ...change,
    });
    const error = await refusal(fetchSeries(BILL, billFetch(records), NOW));
    expect(error.code).toBe("SOURCE_INCONSISTENT");
    expect(error.params.field).toBe("highPrice");
  });

  it("refuses an auction after its issue", async () => {
    const records = withRecord(billJson(), 0, {
      competitiveAuctionCloseDate: "2026-10-02T00:00:00",
    });
    const error = await refusal(fetchSeries(BILL, billFetch(records), NOW));
    expect(error.params.field).toBe("auctionDate");
  });

  it("treats a cash management bill as a bill", async () => {
    const records = withRecord(billJson(), 0, {
      securityType: "CMB",
      ...NO_XML,
    });
    const { entry } = await fetchSeries(BILL, billFetch(records), NOW);
    expect(parseBondTerms(entry.terms).instrument.programCode).toBe("BILL");
  });
});

describe("fetching a note", () => {
  it("reads the original issue, not its reopening, and fills the template", async () => {
    const get = noteFetch();
    const { entry, sources } = await fetchSeries(NOTE, get, NOW);
    expect(entry.publishedAt).toBe("2026-09-28");
    const terms = parseBondTerms(entry.terms);
    expect(terms.instrument).toMatchObject({
      programCode: "NOTE",
      seriesCode: NOTE,
      marketability: "MARKETABLE",
      faceValue: "100",
    });
    expect(terms.instrument.issuePrice).toBeUndefined();
    expect(terms.schedule).toEqual({
      anchor: "COUPON_DATES",
      datedDate: "2026-09-30",
      firstCouponDate: "2027-03-31",
      maturityDate: "2028-09-30",
      couponMonths: 6,
      endOfMonth: true,
      paymentAdjustment: "NEXT_BUSINESS_DAY",
      calendarId: "US",
    });
    expect(terms.rateRule).toEqual({ type: "FIXED", annualRate: "0.0375" });
    expect(terms.accrual).toEqual({ type: "ACTUAL_ACTUAL_ICMA" });
    expect(terms.rounding).toEqual({
      moneyDecimals: 2,
      mode: "HALF_UP",
      basis: "PER_HOLDING",
      unitDecimals: 6,
    });
    expect(sources).toHaveLength(2);
    expect(get.calls).toEqual([
      auctionSearchUrl(NOTE),
      resultsXmlUrl("R_20260928_1.xml"),
    ]);
  });

  it("names a bond by its security type", async () => {
    const records = noteJson().map((r) => ({
      ...r,
      securityType: "Bond",
      ...NO_XML,
    }));
    const { entry } = await fetchSeries(NOTE, noteFetch(records), NOW);
    expect(parseBondTerms(entry.terms).instrument.programCode).toBe("BOND");
  });

  it("is not published when only a reopening is on record", async () => {
    const error = await refusal(
      fetchSeries(NOTE, noteFetch([noteJson()[1]]), NOW),
    );
    expect(error.code).toBe("SERIES_NOT_PUBLISHED");
  });

  it("puts coupons on the maturity's own day when it is not a month end", async () => {
    const records = noteJson().map((r) => ({
      ...r,
      competitiveAuctionCloseDate: "2026-09-14T00:00:00",
      datedDate: "2026-09-15T00:00:00",
      issueDate: "2026-09-15T00:00:00",
      maturityDate: "2028-09-15T00:00:00",
      ...NO_XML,
    }));
    const { entry } = await fetchSeries(NOTE, noteFetch(records), NOW);
    expect(parseBondTerms(entry.terms).schedule).toMatchObject({
      endOfMonth: false,
    });
  });

  it("converts the percent to an exact fraction", async () => {
    const records = withRecord(noteJson(), 0, {
      interestRate: "4.285000",
      ...NO_XML,
    });
    const { entry } = await fetchSeries(NOTE, noteFetch(records), NOW);
    expect(parseBondTerms(entry.terms).rateRule).toEqual({
      type: "FIXED",
      annualRate: "0.04285",
    });
  });

  it("refuses a first coupon the results file states differently", async () => {
    const xml = noteXml().replace(
      "<FirstInterestPaymentDate>2027-03-31",
      "<FirstInterestPaymentDate>2027-03-30",
    );
    const error = await refusal(
      fetchSeries(NOTE, noteFetch(noteJson(), xml), NOW),
    );
    expect(error.code).toBe("SOURCE_INCONSISTENT");
    expect(error.params.field).toBe("firstInterestPaymentDate");
  });

  it("puts a long first coupon on the second regular date after the dated date", async () => {
    const records = withRecord(noteJson(), 0, {
      firstInterestPaymentLength: "Long",
      ...NO_XML,
    });
    const { entry } = await fetchSeries(NOTE, noteFetch(records), NOW);
    expect(parseBondTerms(entry.terms).schedule).toMatchObject({
      firstCouponDate: "2027-09-30",
    });
  });

  it("puts a short first coupon on the first regular date after the dated date", async () => {
    const records = withRecord(noteJson(), 0, {
      firstInterestPaymentLength: "Short",
      ...NO_XML,
    });
    const { entry } = await fetchSeries(NOTE, noteFetch(records), NOW);
    expect(parseBondTerms(entry.terms).schedule).toMatchObject({
      firstCouponDate: "2027-03-31",
    });
  });

  it("refuses a first period length it does not know", async () => {
    const records = withRecord(noteJson(), 0, {
      firstInterestPaymentLength: "Odd",
    });
    const error = await refusal(fetchSeries(NOTE, noteFetch(records), NOW));
    expect(error.code).toBe("SOURCE_FORMAT_CHANGED");
    expect(error.params.field).toBe("firstInterestPaymentLength");
  });

  it.each([
    ["a coupon over 20 %", { interestRate: "20.125000" }, "interestRate"],
    [
      "a dated date after the issue",
      { datedDate: "2026-10-01T00:00:00" },
      "datedDate",
    ],
    [
      "a maturity before the issue",
      { maturityDate: "2026-09-29T00:00:00" },
      "maturityDate",
    ],
    [
      "a maturity over 31 years out",
      { maturityDate: "2058-09-30T00:00:00" },
      "maturityDate",
    ],
    [
      "a frequency that is not semiannual",
      { frequencyOfInterestPayments: "Quarterly" },
      "frequencyOfInterestPayments",
    ],
  ])("refuses %s", async (_name, change, field) => {
    const records = withRecord(noteJson(), 0, { ...change, ...NO_XML });
    const error = await refusal(fetchSeries(NOTE, noteFetch(records), NOW));
    expect(error.code).toBe("SOURCE_INCONSISTENT");
    expect(error.params.field).toBe(field);
  });

  it("accepts a 30-year bond", async () => {
    const records = noteJson().map((r) => ({
      ...r,
      securityType: "Bond",
      competitiveAuctionCloseDate: "2026-08-13T00:00:00",
      datedDate: "2026-08-15T00:00:00",
      issueDate: "2026-08-17T00:00:00",
      maturityDate: "2056-08-15T00:00:00",
      ...NO_XML,
    }));
    const { entry } = await fetchSeries(NOTE, noteFetch(records), NOW);
    expect(parseBondTerms(entry.terms).schedule).toMatchObject({
      maturityDate: "2056-08-15",
    });
  });

  it("refuses a coupon security's CUSIP followed by an issue date", async () => {
    const error = await refusal(fetchSeries(`${NOTE}260930`, noteFetch(), NOW));
    expect(error.code).toBe("SERIES_CODE_INVALID");
  });
});

describe("what the source answers", () => {
  const url = auctionSearchUrl(NOTE);
  const run = (answer: Answer) =>
    fetchSeries(NOTE, fakeFetch({ [url]: answer }), NOW);

  it("does not request anything for a bad code", async () => {
    const get = noteFetch();
    for (const bad of ["91282CZK1", "", "91282CZK0X", "912797WM5261301"]) {
      const error = await refusal(fetchSeries(bad, get, NOW));
      expect(error.code).toBe("SERIES_CODE_INVALID");
    }
    expect(get.calls).toEqual([]);
  });

  it("refuses an empty array as not published", async () => {
    expect((await refusal(run("[]"))).code).toBe("SERIES_NOT_PUBLISHED");
  });

  it.each([
    ["an object", "{}", "array"],
    ["text", "not json", "json"],
    ["an array of numbers", "[1]", "auction"],
    ["an array of arrays", "[[]]", "auction"],
  ])("refuses %s as a changed format", async (_name, body, field) => {
    const error = await refusal(run(body));
    expect(error.code).toBe("SOURCE_FORMAT_CHANGED");
    expect(error.params.field).toBe(field);
  });

  it("refuses a redirect, whether it is a status or a landing address", async () => {
    expect((await refusal(run({ status: 301 }))).params).toMatchObject({
      reason: "status",
      status: "301",
    });
    expect(
      (await refusal(run({ status: 301, url: "https://example.test/" }))).params
        .reason,
    ).toBe("redirect");
    const landed = await refusal(
      run({ status: 200, body: "[]", url: "https://example.test/x" }),
    );
    expect(landed.code).toBe("SOURCE_UNAVAILABLE");
    expect(landed.params.reason).toBe("redirect");
    for (const landing of [
      "http://www.treasurydirect.gov/TA_WS/securities/search",
      "https://www.treasurydirect.gov:8443/x",
      "https://user@www.treasurydirect.gov/x",
      "not a url",
    ]) {
      const error = await refusal(
        run({ status: 200, body: "[]", url: landing }),
      );
      expect(error.params.reason).toBe("redirect");
    }
  });

  it("splits a permanent 4xx (this series) from a transient failure", async () => {
    const missing = await refusal(run({ status: 404 }));
    expect(missing.code).toBe("SOURCE_DOCUMENT_MISSING");
    expect(missing.params).toEqual({ document: "auction data", status: "404" });
    expect((await refusal(run({ status: 429 }))).code).toBe(
      "SOURCE_UNAVAILABLE",
    );
    expect((await refusal(run({ status: 503 }))).code).toBe(
      "SOURCE_UNAVAILABLE",
    );
  });

  it("refuses an oversized body", async () => {
    const error = await refusal(run(new Uint8Array(2 * 1024 * 1024 + 1)));
    expect(error.code).toBe("SOURCE_FORMAT_CHANGED");
    expect(error.params.field).toBe("size");
  });

  it("reports a network failure as unavailable, keeping the cause", async () => {
    const cause = new Error("socket hang up");
    const error = await refusal(
      fetchSeries(
        NOTE,
        async () => {
          throw cause;
        },
        NOW,
      ),
    );
    expect(error.code).toBe("SOURCE_UNAVAILABLE");
    expect(error.params.reason).toBe("network");
    expect(error.cause).toBe(cause);
  });

  it("gives up on a request that never answers", async () => {
    jest.useFakeTimers();
    try {
      const pending = refusal(
        fetchSeries(NOTE, () => new Promise(() => undefined), NOW),
      );
      await jest.advanceTimersByTimeAsync(30_001);
      expect((await pending).params.reason).toBe("network");
    } finally {
      jest.useRealTimers();
    }
  });

  it("refuses a record of another CUSIP", async () => {
    const records = withRecord(noteJson(), 0, { cusip: "912797WM5" });
    const error = await refusal(fetchSeries(NOTE, noteFetch(records), NOW));
    expect(error.code).toBe("SOURCE_INCONSISTENT");
    expect(error.params.field).toBe("cusip");
  });

  it("refuses two original issues", async () => {
    const records = [noteJson()[0], noteJson()[0]];
    const error = await refusal(fetchSeries(NOTE, noteFetch(records), NOW));
    expect(error.params.field).toBe("auction");
  });

  it.each([
    "securityType",
    "competitiveAuctionCloseDate",
    "issueDate",
    "maturityDate",
    "datedDate",
    "firstInterestPaymentLength",
    "interestRate",
    "frequencyOfInterestPayments",
    "reopening",
    "floatingRate",
    "inflationProtected",
  ])("refuses a note record without %s as a changed format", async (field) => {
    const error = await refusal(
      fetchSeries(NOTE, noteFetch(without(noteJson(), field)), NOW),
    );
    expect(error.code).toBe("SOURCE_FORMAT_CHANGED");
    expect(error.params.field).toBe(field);
  });

  it.each([
    "cusip",
    "competitiveAuctionCloseDate",
    "issueDate",
    "maturityDate",
    "highRate",
    "highPrice",
  ])("refuses a bill record without %s as a changed format", async (field) => {
    const error = await refusal(
      fetchSeries(BILL, billFetch(without(billJson(), field)), NOW),
    );
    expect(error.code).toBe("SOURCE_FORMAT_CHANGED");
    expect(error.params.field).toBe(field);
  });

  it.each([
    ["a number for a rate", { interestRate: 3.75 }, "interestRate"],
    ["a rate that is not a decimal", { interestRate: "3,75" }, "interestRate"],
    ["a rate in exponent form", { interestRate: "3.75e0" }, "interestRate"],
    ["a flag that is not Yes or No", { reopening: "Y" }, "reopening"],
    [
      "a date that does not exist",
      { issueDate: "2026-02-30T00:00:00" },
      "issueDate",
    ],
    ["a date with a time", { issueDate: "2026-09-30T12:00:00" }, "issueDate"],
    ["an unknown security type", { securityType: "STRIP" }, "securityType"],
  ])("refuses %s as a changed format", async (_name, change, field) => {
    const records = withRecord(noteJson(), 0, change);
    const error = await refusal(fetchSeries(NOTE, noteFetch(records), NOW));
    expect(error.code).toBe("SOURCE_FORMAT_CHANGED");
    expect(error.params.field).toBe(field);
  });

  it("accepts a date with or without its midnight time", async () => {
    const records = withRecord(noteJson(), 0, {
      competitiveAuctionCloseDate: "2026-09-28",
      issueDate: "2026-09-30",
    });
    const { entry } = await fetchSeries(NOTE, noteFetch(records), NOW);
    expect(entry.publishedAt).toBe("2026-09-28");
  });
});

describe("the results file", () => {
  const swap = (from: string, to: string) => noteXml().replace(from, to);

  it("is read from the file the record names, and only a plain file name", async () => {
    for (const name of [
      "../x.xml",
      "a/b.xml",
      "x.xml?y=1",
      "x.pdf",
      "https://a.test/x.xml",
    ]) {
      const records = withRecord(noteJson(), 0, {
        treasuryAuctionResultsXmlFileName: name,
      });
      const get = noteFetch(records);
      const error = await refusal(fetchSeries(NOTE, get, NOW));
      expect(error.code).toBe("SOURCE_FORMAT_CHANGED");
      expect(get.calls).toEqual([auctionSearchUrl(NOTE)]);
    }
  });

  it("is a refusal of this series when it is gone", async () => {
    const get = fakeFetch(treasuryAnswers(NOTE, noteJson()));
    const error = await refusal(fetchSeries(NOTE, get, NOW));
    expect(error.code).toBe("SOURCE_DOCUMENT_MISSING");
    expect(error.params.document).toBe("results");
  });

  it("is refused when it comes from another address", async () => {
    const get = fakeFetch({
      ...treasuryAnswers(NOTE, noteJson()),
      [resultsXmlUrl("R_20260928_1.xml")]: {
        status: 200,
        body: noteXml(),
        url: "https://example.test/xml/R_20260928_1.xml",
      },
    });
    const error = await refusal(fetchSeries(NOTE, get, NOW));
    expect(error.params.reason).toBe("redirect");
  });

  it.each([
    [
      "the CUSIP",
      "<CUSIP>91282CZK0</CUSIP>",
      "<CUSIP>91282CZK9</CUSIP>",
      "cusip",
    ],
    [
      "the security type",
      "<SecurityType>NOTE</SecurityType>",
      "<SecurityType>BOND</SecurityType>",
      "securityType",
    ],
    [
      "the issue date",
      "<IssueDate>2026-09-30</IssueDate>",
      "<IssueDate>2026-10-01</IssueDate>",
      "issueDate",
    ],
    [
      "the maturity date",
      "<MaturityDate>2028-09-30</MaturityDate>",
      "<MaturityDate>2028-10-31</MaturityDate>",
      "maturityDate",
    ],
    [
      "the dated date",
      "<DatedDate>2026-09-30</DatedDate>",
      "<DatedDate>2026-09-15</DatedDate>",
      "datedDate",
    ],
    [
      "the coupon",
      "<InterestRate>3.750</InterestRate>",
      "<InterestRate>3.875</InterestRate>",
      "interestRate",
    ],
    [
      "the price",
      "<HighPrice>99.987654</HighPrice>",
      "<HighPrice>99.987655</HighPrice>",
      "highPrice",
    ],
  ])("refuses a file that disagrees on %s", async (_name, from, to, field) => {
    const error = await refusal(
      fetchSeries(NOTE, noteFetch(noteJson(), swap(from, to)), NOW),
    );
    expect(error.code).toBe("SOURCE_INCONSISTENT");
    expect(error.params.field).toBe(field);
  });

  it("refuses a bill file that disagrees on the price", async () => {
    const xml = billXml().replace(
      "<HighPrice>97.833694</HighPrice>",
      "<HighPrice>97.833693</HighPrice>",
    );
    const error = await refusal(
      fetchSeries(BILL, billFetch(billJson(), xml), NOW),
    );
    expect(error.code).toBe("SOURCE_INCONSISTENT");
    expect(error.params.field).toBe("highPrice");
  });

  it("refuses a file with no price, no coupon, a DTD or no sections", async () => {
    const noPrice = billXml().replace(
      "<HighPrice>97.833694</HighPrice>",
      "<HighPrice/>",
    );
    expect(
      (await refusal(fetchSeries(BILL, billFetch(billJson(), noPrice), NOW)))
        .code,
    ).toBe("SOURCE_FORMAT_CHANGED");
    const noRate = swap(
      "<InterestRate>3.750</InterestRate>",
      "<InterestRate/>",
    );
    expect(
      (await refusal(fetchSeries(NOTE, noteFetch(noteJson(), noRate), NOW)))
        .code,
    ).toBe("SOURCE_FORMAT_CHANGED");
    const dtd = `<!DOCTYPE x [<!ENTITY a "b">]>${noteXml()}`;
    expect(
      (await refusal(fetchSeries(NOTE, noteFetch(noteJson(), dtd), NOW))).params
        .field,
    ).toBe("xml");
    expect(
      (await refusal(fetchSeries(NOTE, noteFetch(noteJson(), "<a/>"), NOW)))
        .params.field,
    ).toBe("AuctionAnnouncement");
  });

  it("takes the coupon from the announcement when the results leave it out", async () => {
    const xml = noteXml()
      .replace("<InterestRate>3.750</InterestRate>", "<InterestRate/>")
      .replace("<InterestRate/>", "<InterestRate>3.750</InterestRate>");
    const { entry } = await fetchSeries(NOTE, noteFetch(noteJson(), xml), NOW);
    expect(entry.publishedAt).toBe("2026-09-28");
  });
});

describe("a refusal carries machine values, never the source's text (INV-BOND-006)", () => {
  const HOSTILE = `${"X".repeat(5000)} <script>alert(1)</script>`;
  // An element's text cannot hold markup.
  const LONG = "X".repeat(5000);
  const MACHINE = /^[A-Za-z0-9.,%/:<>?-]{0,16}$/;
  const expectMachineParams = (error: SeriesFetchError) => {
    for (const value of Object.values(error.params)) {
      expect(String(value)).toMatch(MACHINE);
    }
  };

  it("echoes no 5,000-character CUSIP of the JSON", async () => {
    const records = withRecord(noteJson(), 0, { cusip: HOSTILE });
    const error = await refusal(fetchSeries(NOTE, noteFetch(records), NOW));
    expect(error.code).toBe("SOURCE_INCONSISTENT");
    expect(error.params).toEqual({
      field: "cusip",
      value: "?",
      expected: NOTE,
    });
  });

  it("echoes no CUSIP of the results file", async () => {
    const xml = noteXml().replace(
      "<CUSIP>91282CZK0</CUSIP>",
      `<CUSIP>${LONG}</CUSIP>`,
    );
    const error = await refusal(
      fetchSeries(NOTE, noteFetch(undefined, xml), NOW),
    );
    expect(error.code).toBe("SOURCE_INCONSISTENT");
    expect(error.params).toEqual({
      field: "cusip",
      value: NOTE,
      expected: "?",
    });
  });

  it("echoes no security type of either document", async () => {
    const records = withRecord(noteJson(), 0, { securityType: HOSTILE });
    const error = await refusal(fetchSeries(NOTE, noteFetch(records), NOW));
    expectMachineParams(error);
    const xml = noteXml().replace(
      "<SecurityType>NOTE</SecurityType>",
      `<SecurityType>${LONG}</SecurityType>`,
    );
    const second = await refusal(
      fetchSeries(NOTE, noteFetch(undefined, xml), NOW),
    );
    expect(second.code).toBe("SOURCE_INCONSISTENT");
    expectMachineParams(second);
  });

  it("echoes no price decimals of 5,000 digits", async () => {
    const records = withRecord(billJson(), 0, {
      highPrice: `97.${"8".repeat(5000)}`,
    });
    const error = await refusal(fetchSeries(BILL, billFetch(records), NOW));
    expectMachineParams(error);
  });
});
