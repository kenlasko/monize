import {
  normalizeForSearch,
  searchIncludes,
  searchStartsWith,
} from "./search-match";

describe("search-match", () => {
  it("lower-cases and strips punctuation and symbols but keeps spaces", () => {
    expect(normalizeForSearch("Zehr's Supermarket")).toBe("zehrs supermarket");
    expect(normalizeForSearch("AT&T / Wal-Mart.")).toBe("att  walmart");
  });

  it("matches across punctuation on either side", () => {
    expect(searchIncludes("Zehr's Supermarket", "zehrs")).toBe(true);
    expect(searchIncludes("Zehrs Supermarket", "zehr's")).toBe(true);
    expect(searchIncludes("Zellers", "zehrs")).toBe(false);
  });

  it("falls back to a literal match when the query is only punctuation", () => {
    expect(searchIncludes("AT&T", "&")).toBe(true);
    expect(searchIncludes("Costco", "&")).toBe(false);
  });

  it("checks a prefix and treats a missing text as no match", () => {
    expect(searchStartsWith("Zehr's Supermarket", "zehrs")).toBe(true);
    expect(searchStartsWith("Zehr's Supermarket", "super")).toBe(false);
    expect(searchIncludes(undefined, "a")).toBe(false);
    expect(searchStartsWith(null, "a")).toBe(false);
  });
});
