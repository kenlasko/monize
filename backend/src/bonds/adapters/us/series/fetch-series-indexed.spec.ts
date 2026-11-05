import { SeriesFetchError } from "../../../bond-adapter";
import { parseBondTerms } from "../../../domain/bond-terms";
import { fetchSeries } from "./fetch-series";
import {
  fakeFetch,
  fixtureJson,
  fixtureText,
  treasuryAnswers,
} from "./fixture-helpers";

type Rec = Record<string, unknown>;

const TIPS = "912810FQ6";
const FRN = "91282CQM6";
const NOW = () => new Date("2026-11-04T10:00:00.000Z");

const tipsJson = () => fixtureJson("ta-ws-912810FQ6.json");
const frnJson = () => fixtureJson("ta-ws-91282CQM6.json");
const tipsXml = () => fixtureText("R_20011025_1.xml");
const frnXml = () => fixtureText("R_20260428_1.xml");

const tipsFetch = (records: unknown = tipsJson(), xml = tipsXml()) =>
  fakeFetch(treasuryAnswers(TIPS, records, { "R_20011025_1.xml": xml }));
const frnFetch = (records: unknown = frnJson(), xml = frnXml()) =>
  fakeFetch(treasuryAnswers(FRN, records, { "R_20260428_1.xml": xml }));

const withRecord = (records: Rec[], change: Rec): Rec[] =>
  records.map((r, i) => (i === 0 ? { ...r, ...change } : r));

async function refusal(promise: Promise<unknown>): Promise<SeriesFetchError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(SeriesFetchError);
    return error as SeriesFetchError;
  }
  throw new Error("expected a SeriesFetchError");
}

describe("fetching a TIPS", () => {
  it("fills the template with the coupon and the reference CPI of the dated date", async () => {
    const get = tipsFetch();
    const { entry, sources } = await fetchSeries(TIPS, get, NOW);
    expect(entry.publishedAt).toBe("2001-10-25");
    const terms = parseBondTerms(entry.terms);
    expect(terms.instrument).toMatchObject({
      programCode: "TIPS",
      seriesCode: TIPS,
      faceValue: "100",
    });
    expect(terms.schedule).toMatchObject({
      datedDate: "2001-10-15",
      firstCouponDate: "2002-04-15",
      maturityDate: "2032-04-15",
      couponMonths: 6,
    });
    expect(terms.rateRule).toMatchObject({
      type: "FIXED",
      annualRate: "0.03375",
    });
    expect(terms.principalRule).toStrictEqual({
      type: "INDEX_RATIO",
      benchmarkId: "US_CPI_U_NSA",
      baseReference: "177.5",
      lagMonths: 3,
      interpolation: "DAILY_LINEAR",
      truncateDecimals: 6,
      roundDecimals: 5,
      maturityFloor: "PAR",
    });
    expect(sources.map((s) => s.url)).toHaveLength(2);
    expect(get.calls).toHaveLength(2);
  });

  it("needs no results file when the record names none", async () => {
    const records = withRecord(tipsJson(), {
      xmlFilenameCompetitiveResults: "",
    });
    const get = tipsFetch(records);
    await fetchSeries(TIPS, get, NOW);
    expect(get.calls).toHaveLength(1);
  });

  it.each([
    ["no", { refCpiOnDatedDate: "" }],
    ["a too small", { refCpiOnDatedDate: "99.99999" }],
    ["a too large", { refCpiOnDatedDate: "1000.00001" }],
  ])("refuses %s reference CPI", async (name, change) => {
    const records = withRecord(tipsJson(), {
      ...change,
      xmlFilenameCompetitiveResults: "",
    });
    const error = await refusal(fetchSeries(TIPS, tipsFetch(records), NOW));
    expect(error.code).toBe("SOURCE_INCONSISTENT");
    expect(error.params.field).toBe("refCpiOnDatedDate");
    expect(name).toBeTruthy();
  });

  it("refuses a reference CPI the results file does not state the same", async () => {
    const xml = tipsXml().replace(
      "<RefCPIDatedDate>177.50000",
      "<RefCPIDatedDate>177.60000",
    );
    const error = await refusal(
      fetchSeries(TIPS, tipsFetch(tipsJson(), xml), NOW),
    );
    expect(error.code).toBe("SOURCE_INCONSISTENT");
    expect(error.params.field).toBe("refCpiOnDatedDate");
  });

  it("refuses a results file that does not mark the security as indexed", async () => {
    const xml = tipsXml().replace(
      "<InflationIndexSecurity>Y",
      "<InflationIndexSecurity>N",
    );
    const error = await refusal(
      fetchSeries(TIPS, tipsFetch(tipsJson(), xml), NOW),
    );
    expect(error.params.field).toBe("inflationIndexSecurity");
  });

  it("refuses a coupon the results file states differently", async () => {
    const xml = tipsXml().replaceAll(
      "<InterestRate>3.375",
      "<InterestRate>3.500",
    );
    const error = await refusal(
      fetchSeries(TIPS, tipsFetch(tipsJson(), xml), NOW),
    );
    expect(error.params.field).toBe("interestRate");
  });

  it("refuses a first coupon that is not a regular date", async () => {
    const records = withRecord(tipsJson(), {
      firstInterestPaymentDate: "2002-05-15T00:00:00",
    });
    const error = await refusal(fetchSeries(TIPS, tipsFetch(records), NOW));
    expect(error.params.field).toBe("firstInterestPaymentDate");
  });
});

describe("fetching a floating rate note", () => {
  it("fills the template: quarterly, daily accrual, the 13-week benchmark and the spread", async () => {
    const get = frnFetch();
    const { entry } = await fetchSeries(FRN, get, NOW);
    expect(entry.publishedAt).toBe("2026-04-28");
    const terms = parseBondTerms(entry.terms);
    expect(terms.instrument.programCode).toBe("FRN");
    expect(terms.schedule).toMatchObject({
      datedDate: "2026-04-30",
      firstCouponDate: "2026-07-31",
      maturityDate: "2028-04-30",
      couponMonths: 3,
      endOfMonth: true,
    });
    expect(terms.accrual).toEqual({ type: "ACTUAL_360_DAILY_SUM" });
    expect(terms.rateRule).toStrictEqual({
      type: "DAILY_INDEX_PLUS_SPREAD",
      benchmarkId: "US_TBILL_13W_MMY",
      spread: "0.00103",
      floor: "0",
      lockoutBusinessDays: 2,
      calendarId: "US",
      dailyDecimals: 9,
    });
    expect(get.calls).toHaveLength(2);
  });

  it("keeps a negative spread negative", async () => {
    const records = withRecord(frnJson(), {
      spread: "-0.150000",
      xmlFilenameCompetitiveResults: "",
    });
    const { entry } = await fetchSeries(FRN, frnFetch(records), NOW);
    expect(parseBondTerms(entry.terms).rateRule).toMatchObject({
      spread: "-0.0015",
    });
  });

  it.each([
    ["a missing spread", { spread: "" }, "SOURCE_INCONSISTENT", "spread"],
    [
      "a spread above 1 percent",
      { spread: "1.000001" },
      "SOURCE_INCONSISTENT",
      "spread",
    ],
    [
      "a spread below -1 percent",
      { spread: "-1.000001" },
      "SOURCE_INCONSISTENT",
      "spread",
    ],
    [
      "a spread that is not a number",
      { spread: "abc" },
      "SOURCE_FORMAT_CHANGED",
      "spread",
    ],
    [
      "a semiannual frequency",
      { interestPaymentFrequency: "Semi-Annual" },
      "SOURCE_INCONSISTENT",
      "interestPaymentFrequency",
    ],
    [
      "a first payment that is not a quarter end",
      { firstInterestPaymentDate: "2026-08-31T00:00:00" },
      "SOURCE_INCONSISTENT",
      "firstInterestPaymentDate",
    ],
  ])("refuses %s", async (_name, change, code, field) => {
    const records = withRecord(frnJson(), {
      ...change,
      xmlFilenameCompetitiveResults: "",
    });
    const error = await refusal(fetchSeries(FRN, frnFetch(records), NOW));
    expect(error.code).toBe(code);
    expect(error.params.field).toBe(field);
  });

  it("refuses a spread the results file states differently", async () => {
    const xml = frnXml().replaceAll("<Spread>0.103", "<Spread>0.113");
    const error = await refusal(
      fetchSeries(FRN, frnFetch(frnJson(), xml), NOW),
    );
    expect(error.code).toBe("SOURCE_INCONSISTENT");
    expect(error.params.field).toBe("spread");
  });

  it("refuses a results file that does not mark the security as floating", async () => {
    const xml = frnXml().replace("<FloatingRate>Y", "<FloatingRate>N");
    const error = await refusal(
      fetchSeries(FRN, frnFetch(frnJson(), xml), NOW),
    );
    expect(error.params.field).toBe("floatingRate");
  });

  it("refuses a results file that marks the security as indexed too", async () => {
    const xml = frnXml().replace(
      "<InflationIndexSecurity>N",
      "<InflationIndexSecurity>Y",
    );
    const error = await refusal(
      fetchSeries(FRN, frnFetch(frnJson(), xml), NOW),
    );
    expect(error.params.field).toBe("inflationIndexSecurity");
  });
});
