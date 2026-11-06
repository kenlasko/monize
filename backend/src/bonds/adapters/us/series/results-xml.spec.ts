import { SeriesFetchError } from "../../../bond-adapter";
import { fixtureText } from "./fixture-helpers";
import { parseResultsXml } from "./results-xml";

const bytes = (text: string) => new TextEncoder().encode(text);

describe("the results file parser, on the recorded FRN file", () => {
  const xml = parseResultsXml(bytes(fixtureText("R_20260428_1.xml")));

  it("reads the announcement's elements", () => {
    expect(xml.announcement("CUSIP")).toBe("91282CQM6");
    expect(xml.announcement("SecurityType")).toBe("NOTE");
    expect(xml.announcement("IssueDate")).toBe("2026-04-30");
    expect(xml.announcement("MaturityDate")).toBe("2028-04-30");
    expect(xml.announcement("DatedDate")).toBe("2026-04-30");
    expect(xml.announcement("Spread")).toBe("0.103");
    expect(xml.announcement("FirstInterestPaymentDate")).toBe("2026-07-31");
    expect(xml.announcement("FloatingRate")).toBe("Y");
  });

  it("reads the results' elements", () => {
    expect(xml.results("HighPrice")).toBe("100.000000");
    expect(xml.results("HighDiscountMargin")).toBe("0.103");
    expect(xml.results("Spread")).toBe("0.103");
  });

  it("tells an empty element from an absent one", () => {
    expect(xml.announcement("InterestRate")).toBe("");
    expect(xml.results("HighDiscountRate")).toBe("");
    expect(xml.announcement("NoSuchElement")).toBeUndefined();
  });

  it("does not take the results' element for the announcement's", () => {
    expect(xml.announcement("HighPrice")).toBeUndefined();
    expect(xml.results("CUSIP")).toBeUndefined();
  });

  it("does not match a longer element name", () => {
    expect(xml.announcement("CUSIP")).toBe("91282CQM6");
    expect(xml.results("OriginalCUSIP")).toBe("");
  });
});

describe("a file that is not a results file", () => {
  it.each([
    ["no section", "<a/>"],
    ["no results", "<AuctionAnnouncement></AuctionAnnouncement>"],
  ])("refuses %s", (_name, text) => {
    expect(() => parseResultsXml(bytes(text))).toThrow(SeriesFetchError);
  });

  it("refuses a DTD or an entity", () => {
    expect(() =>
      parseResultsXml(bytes(`<!DOCTYPE a>${fixtureText("R_20260428_1.xml")}`)),
    ).toThrow(SeriesFetchError);
  });

  it("refuses a lookup of a name that is not an element name", () => {
    const xml = parseResultsXml(bytes(fixtureText("R_20260428_1.xml")));
    expect(() => xml.announcement(".*")).toThrow(RangeError);
  });
});

describe("a hostile results file is refused in linear time", () => {
  const timed = (text: string) => {
    const started = Date.now();
    let error: unknown = null;
    try {
      parseResultsXml(bytes(text));
    } catch (thrown) {
      error = thrown;
    }
    return { error, ms: Date.now() - started };
  };

  // A lazy `<Tag>([\s\S]*?)</Tag>` over repeated opening tags is quadratic:
  // 840 KB took 6.3 s. The bound is generous; the fixed code takes milliseconds.
  it.each([
    ["AuctionAnnouncement", ""],
    ["AuctionResults", "<AuctionAnnouncement></AuctionAnnouncement>"],
  ])("refuses 1 MB of repeated <%s> tags in under 500 ms", (tag, lead) => {
    const { error, ms } = timed(
      lead + `<${tag}>`.repeat(Math.ceil(1_000_000 / (tag.length + 2))),
    );
    expect(error).toBeInstanceOf(SeriesFetchError);
    expect((error as SeriesFetchError).params).toEqual({ field: tag });
    expect(ms).toBeLessThan(500);
  });

  it("refuses an opening tag that is never closed, and a section opened twice", () => {
    expect(timed("<AuctionAnnouncement>x".repeat(1)).error).toBeInstanceOf(
      SeriesFetchError,
    );
    const twice = fixtureText("R_20260428_1.xml").replace(
      "<AuctionResults>",
      "<AuctionResults><AuctionResults>",
    );
    expect(timed(twice).error).toBeInstanceOf(SeriesFetchError);
  });
});
