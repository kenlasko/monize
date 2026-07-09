import {
  parseTag,
  isKeyValueTag,
  normalizeTagKey,
  collectTagKeys,
} from "./tag-key-value.util";

describe("tag-key-value.util", () => {
  describe("parseTag", () => {
    it("parses a key:value tag", () => {
      expect(parseTag("country:poland")).toEqual({
        key: "country",
        value: "poland",
      });
    });

    it("treats a plain label as having no key", () => {
      expect(parseTag("poland")).toEqual({ key: null, value: null });
    });

    it("treats an empty value as key-present-no-value", () => {
      expect(parseTag("country:")).toEqual({ key: "country", value: null });
      expect(parseTag("country:   ")).toEqual({ key: "country", value: null });
    });

    it("splits on the first colon so values may contain colons", () => {
      expect(parseTag("ref:https://x.y")).toEqual({
        key: "ref",
        value: "https://x.y",
      });
    });

    it("rejects an empty/whitespace key (leading colon)", () => {
      expect(parseTag(":poland")).toEqual({ key: null, value: null });
      expect(parseTag("   :poland")).toEqual({ key: null, value: null });
    });

    it("trims surrounding whitespace on key and value", () => {
      expect(parseTag("  country : poland  ")).toEqual({
        key: "country",
        value: "poland",
      });
    });

    it("preserves original case", () => {
      expect(parseTag("Country:USA")).toEqual({ key: "Country", value: "USA" });
    });

    it("handles empty / nullish input", () => {
      expect(parseTag("")).toEqual({ key: null, value: null });
      expect(parseTag(undefined as unknown as string)).toEqual({
        key: null,
        value: null,
      });
    });
  });

  describe("isKeyValueTag", () => {
    it("is true only for key:value (or key:) names", () => {
      expect(isKeyValueTag("country:poland")).toBe(true);
      expect(isKeyValueTag("country:")).toBe(true);
      expect(isKeyValueTag("poland")).toBe(false);
      expect(isKeyValueTag(":poland")).toBe(false);
    });
  });

  describe("normalizeTagKey", () => {
    it("case-folds the key and returns null for plain labels", () => {
      expect(normalizeTagKey("Country:USA")).toBe("country");
      expect(normalizeTagKey("poland")).toBeNull();
    });
  });

  describe("collectTagKeys", () => {
    it("returns distinct, case-folded, sorted keys", () => {
      expect(
        collectTagKeys([
          "country:poland",
          "Country:usa",
          "sector:tech",
          "plain",
          "sector:",
        ]),
      ).toEqual(["country", "sector"]);
    });

    it("returns an empty array when no key:value tags are present", () => {
      expect(collectTagKeys(["one", "two"])).toEqual([]);
    });
  });
});
