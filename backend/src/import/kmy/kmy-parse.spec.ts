import { readKmyFixture } from "./__fixtures__/kmy-fixtures";
import { parseKmyBytes } from "./kmy-parse";
import { KmyImportError } from "./model/kmy-errors";
import { gzip } from "./__fixtures__/kmy-xml-builders";

const BASE = {
  filename: "sample.kmy",
  maxXmlBytes: 50 * 1024 * 1024,
  userDefaultCurrency: "USD",
  phoneRegion: null,
  coinDecimals: new Map<string, number>(),
  asOf: "2026-01-01",
};

describe("parseKmyBytes", () => {
  it("reads then maps the committed synthetic file", () => {
    const parsed = parseKmyBytes({
      ...BASE,
      bytes: readKmyFixture("syntheticKmy"),
    });
    expect(parsed.sourceFormat).toBe("kmy");
    expect(parsed.kmyFile?.container).toBe("gzip");
    expect(parsed.fileBalances).toBeDefined();
  });

  it("gives the same result for the gzip and plain XML forms", () => {
    const gz = parseKmyBytes({
      ...BASE,
      bytes: readKmyFixture("syntheticKmy"),
    });
    const xml = parseKmyBytes({
      ...BASE,
      bytes: readKmyFixture("syntheticXml"),
    });
    expect([...gz.expectedBalances]).toEqual([...xml.expectedBalances]);
  });

  it.each([
    ["plain text", Buffer.from("hello world, not a kmy file")],
    ["a truncated gzip stream", gzip("<KMYMONEY-FILE>").subarray(0, 12)],
    ["a SQLite header", Buffer.from("SQLite format 3\0" + "x".repeat(64))],
  ])("refuses %s with a typed error", (_label, bytes) => {
    expect(() => parseKmyBytes({ ...BASE, bytes })).toThrow(KmyImportError);
  });

  it("does not mutate the input bytes", () => {
    const bytes = readKmyFixture("syntheticKmy");
    const before = Buffer.from(bytes);
    parseKmyBytes({ ...BASE, bytes });
    expect(bytes.equals(before)).toBe(true);
  });
});
