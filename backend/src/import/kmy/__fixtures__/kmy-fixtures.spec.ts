import { readFileSync } from "fs";
import { join } from "path";
import { gunzipSync } from "zlib";
import { KMY_FIXTURES, readKmyFixture } from "./kmy-fixtures";

describe("kmy fixtures", () => {
  it("registers the synthetic file in both containers", () => {
    expect(Object.keys(KMY_FIXTURES)).toEqual(["syntheticKmy", "syntheticXml"]);
  });

  it("the .kmy is the gzip of the .xml, byte for byte", () => {
    const gz = readKmyFixture("syntheticKmy");
    const xml = readKmyFixture("syntheticXml");
    expect(gz[0]).toBe(0x1f);
    expect(gz[1]).toBe(0x8b);
    expect(gunzipSync(gz).equals(xml)).toBe(true);
  });

  it("the XML is the reference's section 18 example", () => {
    const xml = readKmyFixture("syntheticXml").toString("utf8");
    expect(
      xml.startsWith(
        '<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE KMYMONEY-FILE>',
      ),
    ).toBe(true);
    expect(xml).toContain("SYNTHETIC EXAMPLE - not produced by KMyMoney");
    const reference = readFileSync(
      join(__dirname, "../../../../../docs/kmymoney-data-model.md"),
      "utf8",
    );
    expect(reference).toContain(xml.trimEnd());
  });

  it("returns a fresh buffer on every call", () => {
    const first = readKmyFixture("syntheticXml");
    first[0] = 0;
    expect(readKmyFixture("syntheticXml")[0]).toBe(0x3c);
  });
});
