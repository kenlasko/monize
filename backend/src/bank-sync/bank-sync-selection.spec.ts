import { BadRequestException } from "@nestjs/common";
import { assertDisjointSelection, selectionOf } from "./bank-sync-selection";

describe("selectionOf", () => {
  it("is no selection when neither list is given: every new row is imported", () => {
    expect(selectionOf(undefined, undefined)).toBeUndefined();
  });

  it("is a selection when either list is given, the other being empty", () => {
    expect(selectionOf(["a"], undefined)).toEqual({
      importKeys: ["a"],
      excludeKeys: [],
    });
    expect(selectionOf(undefined, ["b"])).toEqual({
      importKeys: [],
      excludeKeys: ["b"],
    });
  });

  it("treats an empty importKeys as a selection of nothing, not as no selection", () => {
    expect(selectionOf([], undefined)).toEqual({
      importKeys: [],
      excludeKeys: [],
    });
  });
});

describe("assertDisjointSelection", () => {
  it("accepts lists that share no key", () => {
    expect(() =>
      assertDisjointSelection({ importKeys: ["a", "b"], excludeKeys: ["c"] }),
    ).not.toThrow();
    expect(() =>
      assertDisjointSelection({ importKeys: [], excludeKeys: [] }),
    ).not.toThrow();
  });

  it("refuses a key in both lists with 400", () => {
    expect(() =>
      assertDisjointSelection({ importKeys: ["a", "b"], excludeKeys: ["b"] }),
    ).toThrow(BadRequestException);
  });
});
