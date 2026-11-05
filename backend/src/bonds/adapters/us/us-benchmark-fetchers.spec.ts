import { readFileSync } from "fs";
import { join } from "path";
import { BenchmarkFetchError } from "../../bond-adapter";
import { ExactDecimal } from "../../domain/exact-decimal";
import { UNITED_STATES_BOND_ADAPTER } from "./index";
import { fakeFetch } from "./series/fixture-helpers";
import { blsCpiUrl, fetchBlsCpi, parseBlsCpi } from "./us-bls-cpi";
import {
  fetchTbill13w,
  moneyMarketYield,
  parseTbill13w,
  tbill13wUrl,
} from "./us-tbill-13w";

const fixture = (name: string) =>
  readFileSync(join(__dirname, "benchmark-fixtures", name), "utf8");
const bls = (change: (doc: any) => void = () => undefined) => {
  const doc = JSON.parse(fixture("bls-cuur0000sa0.json"));
  change(doc);
  return JSON.stringify(doc);
};
const bytes = (text: string) => new TextEncoder().encode(text);

describe("the CPI-U fetcher (BLS)", () => {
  const observations = parseBlsCpi(bls(), "2026-06-15");

  it("reads one level per month, dated the first, as published", () => {
    expect(observations.slice(-3)).toEqual([
      { observationDate: "2026-03-01", value: "330.213", publishedOn: null },
      { observationDate: "2026-04-01", value: "333.02", publishedOn: null },
      { observationDate: "2026-05-01", value: "335.123", publishedOn: null },
    ]);
  });

  it("skips a month the BLS does not publish and never reads it as zero", () => {
    expect(observations.map((o) => o.observationDate)).not.toContain(
      "2025-10-01",
    );
    expect(observations).toHaveLength(11);
  });

  it("skips the annual average (M13)", () => {
    const rows = parseBlsCpi(
      bls((d) =>
        d.Results.series[0].data.push({
          year: "2025",
          period: "M13",
          value: "999.999",
        }),
      ),
      "2026-06-15",
    );
    expect(rows).toHaveLength(11);
  });

  it.each([
    [
      "a status that is not a success",
      (d: any) => (d.status = "REQUEST_NOT_PROCESSED"),
    ],
    [
      "another series",
      (d: any) => (d.Results.series[0].seriesID = "CUSR0000SA0"),
    ],
    [
      "a value that is not a decimal",
      (d: any) => (d.Results.series[0].data[0].value = "abc"),
    ],
    ["a zero level", (d: any) => (d.Results.series[0].data[0].value = "0.000")],
    [
      "a negative level",
      (d: any) => (d.Results.series[0].data[0].value = "-3.1"),
    ],
    [
      "a JSON number as a level",
      (d: any) => (d.Results.series[0].data[0].value = 335.123),
    ],
    [
      "a duplicated month",
      (d: any) =>
        d.Results.series[0].data.push({ ...d.Results.series[0].data[0] }),
    ],
    [
      "a period that is not a month",
      (d: any) => (d.Results.series[0].data[0].period = "S01"),
    ],
    ["no series", (d: any) => (d.Results.series = [])],
  ])("refuses %s", (_name, change) => {
    expect(() => parseBlsCpi(bls(change), "2026-06-15")).toThrow(
      BenchmarkFetchError,
    );
  });

  it("refuses a month after the request date", () => {
    expect(() => parseBlsCpi(bls(), "2026-04-30")).toThrow(/after/);
  });

  it("refuses text that is not JSON", () => {
    expect(() => parseBlsCpi("<html>", "2026-06-15")).toThrow(
      BenchmarkFetchError,
    );
  });

  it("covers through the end of the newest month, from the BLS host only", async () => {
    const url = blsCpiUrl(2017, 2026);
    const get = fakeFetch({ [url]: bls() });
    const result = await fetchBlsCpi(get, "2026-06-15");
    expect(result.coveredThrough).toBe("2026-05-31");
    expect(result.sourceUrl).toBe(url);
    expect(get.calls).toEqual([url]);
    expect(new URL(url).hostname).toBe("api.bls.gov");
  });

  it("refuses a status other than 200 and an answer from another host", async () => {
    await expect(fetchBlsCpi(fakeFetch({}), "2026-06-15")).rejects.toThrow(
      /HTTP 404/,
    );
    const url = blsCpiUrl(2017, 2026);
    await expect(
      fetchBlsCpi(
        fakeFetch({
          [url]: { status: 200, body: bls(), url: "https://example.org/x" },
        }),
        "2026-06-15",
      ),
    ).rejects.toThrow(/another host/);
  });
});

describe("the 13-week yield", () => {
  it("is D / (1 - D x t / 360), nine decimals in percent: 0.095 over 91 days is 0.095022819", () => {
    expect(moneyMarketYield(ExactDecimal.parse("0.095"), 91)).toEqual({
      percent: "0.095022819",
      fraction: "0.0009502282",
    });
  });

  it("gives 3.643245628 for a discount of 3.610", () => {
    expect(moneyMarketYield(ExactDecimal.parse("3.610"), 91).percent).toBe(
      "3.643245628",
    );
  });
});

describe("the 13-week bill fetcher (TreasuryDirect)", () => {
  const list = () => bytes(fixture("ta-ws-auctioned-bills.json"));

  it("keeps the 13-week auctions only, one per auction date, oldest first", () => {
    expect(parseTbill13w(list())).toEqual([
      {
        observationDate: "2021-01-11",
        value: "0.0009502282",
        publishedOn: null,
      },
      {
        observationDate: "2026-04-27",
        value: "0.0364324563",
        publishedOn: null,
      },
      {
        observationDate: "2026-05-04",
        value: "0.0365343092",
        publishedOn: null,
      },
    ]);
  });

  it("skips an auction with no rate and refuses two rates for one date", () => {
    const records = JSON.parse(fixture("ta-ws-auctioned-bills.json"));
    const blank = [
      ...records,
      {
        ...records[0],
        auctionDate: "2026-05-11T00:00:00",
        highDiscountRate: "",
      },
    ];
    expect(parseTbill13w(bytes(JSON.stringify(blank)))).toHaveLength(3);
    const twice = [...records, { ...records[0], highDiscountRate: "3.700000" }];
    expect(() => parseTbill13w(bytes(JSON.stringify(twice)))).toThrow(
      /two different rates/,
    );
  });

  it("refuses a 13-week record whose term is not about 13 weeks", () => {
    const records = JSON.parse(fixture("ta-ws-auctioned-bills.json"));
    records[0].maturityDate = "2026-12-31T00:00:00";
    expect(() => parseTbill13w(bytes(JSON.stringify(records)))).toThrow(
      BenchmarkFetchError,
    );
  });

  it("refuses a rate that is a JSON number, and a body that is not an array", () => {
    const records = JSON.parse(fixture("ta-ws-auctioned-bills.json"));
    records[0].highDiscountRate = 3.62;
    expect(() => parseTbill13w(bytes(JSON.stringify(records)))).toThrow();
    expect(() => parseTbill13w(bytes("{}"))).toThrow();
  });

  it("covers through the newest auction date and asks the issuer's host only", async () => {
    const url = tbill13wUrl();
    const get = fakeFetch({ [url]: fixture("ta-ws-auctioned-bills.json") });
    const result = await fetchTbill13w(get);
    expect(result.coveredThrough).toBe("2026-05-04");
    expect(get.calls).toEqual([url]);
    expect(url).toContain(
      "/TA_WS/securities/auctioned?format=json&type=Bill&days=",
    );
  });

  it("refuses a redirect and a status other than 200 as a benchmark failure", async () => {
    const url = tbill13wUrl();
    await expect(fetchTbill13w(fakeFetch({}))).rejects.toThrow(
      BenchmarkFetchError,
    );
    await expect(
      fetchTbill13w(
        fakeFetch({
          [url]: { status: 200, body: "[]", url: "https://example.org/" },
        }),
      ),
    ).rejects.toThrow(BenchmarkFetchError);
  });
});

describe("the adapter's benchmarks", () => {
  it("declares both with their kind, unit, publisher, host and provider", () => {
    expect(
      UNITED_STATES_BOND_ADAPTER.benchmarks.map((b) => [
        b.code,
        b.kind,
        b.unit,
        b.publisher,
        b.hosts,
        b.providerId,
      ]),
    ).toEqual([
      ["US_CPI_U_NSA", "MONTHLY", "INDEX_LEVEL", "BLS", ["api.bls.gov"], "bls"],
      [
        "US_TBILL_13W_MMY",
        "STEP",
        "RATE_FRACTION",
        "Treasury",
        ["www.treasurydirect.gov"],
        "treasurydirect",
      ],
    ]);
  });

  it("refuses a code it does not have", async () => {
    await expect(
      UNITED_STATES_BOND_ADAPTER.fetchBenchmark("US_OTHER", async () => {
        throw new Error("no request expected");
      }),
    ).rejects.toThrow(BenchmarkFetchError);
  });
});
