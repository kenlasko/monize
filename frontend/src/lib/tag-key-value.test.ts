import { describe, it, expect } from "vitest";
import {
  parseTag,
  isKeyValueTag,
  normalizeTagKey,
  collectTagKeys,
} from "./tag-key-value";

describe("tag-key-value", () => {
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
  });

  it("splits on the first colon so values may contain colons", () => {
    expect(parseTag("ref:https://x.y")).toEqual({
      key: "ref",
      value: "https://x.y",
    });
  });

  it("rejects an empty key (leading colon)", () => {
    expect(parseTag(":poland")).toEqual({ key: null, value: null });
  });

  it("trims and preserves case", () => {
    expect(parseTag("  Country : USA ")).toEqual({
      key: "Country",
      value: "USA",
    });
  });

  it("isKeyValueTag reflects the convention", () => {
    expect(isKeyValueTag("country:poland")).toBe(true);
    expect(isKeyValueTag("plain")).toBe(false);
  });

  it("normalizeTagKey case-folds and nulls plain labels", () => {
    expect(normalizeTagKey("Country:USA")).toBe("country");
    expect(normalizeTagKey("plain")).toBeNull();
  });

  it("collectTagKeys returns distinct, case-folded, sorted keys", () => {
    expect(
      collectTagKeys([
        "country:poland",
        "Country:usa",
        "sector:tech",
        "plain",
      ]),
    ).toEqual(["country", "sector"]);
  });
});
