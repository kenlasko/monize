import { describe, it, expect } from "vitest";
import { deepMerge, isPlainObject } from "./deep-merge";

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

describe("isPlainObject", () => {
  it("accepts plain objects", () => {
    expect(isPlainObject({})).toBe(true);
    expect(isPlainObject({ a: 1 })).toBe(true);
  });

  it("rejects arrays, null, and primitives", () => {
    expect(isPlainObject([])).toBe(false);
    expect(isPlainObject(null)).toBe(false);
    expect(isPlainObject("x")).toBe(false);
    expect(isPlainObject(3)).toBe(false);
    expect(isPlainObject(undefined)).toBe(false);
  });
});

describe("deepMerge", () => {
  it("overrides base leaves with override leaves", () => {
    expect(deepMerge({ a: "1", b: "2" }, { b: "3" })).toEqual({
      a: "1",
      b: "3",
    });
  });

  it("keeps base keys that the override omits (per-key fallback)", () => {
    expect(deepMerge({ keep: "en", change: "en" }, { change: "us" })).toEqual({
      keep: "en",
      change: "us",
    });
  });

  it("merges nested objects recursively instead of replacing them", () => {
    const base = { form: { colourLabel: "Colour", noColour: "No colour" } };
    const override = { form: { colourLabel: "Color" } };
    expect(deepMerge(base, override)).toEqual({
      form: { colourLabel: "Color", noColour: "No colour" },
    });
  });

  it("does not mutate base or override", () => {
    const base = { form: { a: "1" } };
    const override = { form: { b: "2" } };
    const baseBefore = clone(base);
    const overrideBefore = clone(override);
    deepMerge(base, override);
    expect(base).toEqual(baseBefore);
    expect(override).toEqual(overrideBefore);
  });

  it("replaces arrays rather than merging them", () => {
    expect(deepMerge({ list: ["a", "b"] }, { list: ["c"] })).toEqual({
      list: ["c"],
    });
  });

  it("returns a new object reference", () => {
    const base = { a: "1" };
    expect(deepMerge(base, { b: "2" })).not.toBe(base);
  });

  it("returns the base values when the override is empty", () => {
    expect(deepMerge({ a: "1" }, {})).toEqual({ a: "1" });
  });
});
