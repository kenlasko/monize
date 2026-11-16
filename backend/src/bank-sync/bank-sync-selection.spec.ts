import { BadRequestException } from "@nestjs/common";
import {
  assertDisjointSelection,
  namesExistingTransactions,
  selectionOf,
  type BankSyncSelection,
} from "./bank-sync-selection";

const EMPTY = {
  importKeys: [],
  excludeKeys: [],
  mergeKeys: [],
  keepKeys: [],
  replaceKeys: [],
};

function selection(over: Partial<BankSyncSelection> = {}): BankSyncSelection {
  return { ...EMPTY, ...over };
}

describe("selectionOf", () => {
  it("is no selection when no list is given: every new row is imported", () => {
    expect(selectionOf(undefined)).toBeUndefined();
    expect(selectionOf({})).toBeUndefined();
  });

  it("is a selection when any list is given, the others being empty", () => {
    expect(selectionOf({ importKeys: ["a"] })).toEqual(
      selection({ importKeys: ["a"] }),
    );
    expect(selectionOf({ excludeKeys: ["b"] })).toEqual(
      selection({ excludeKeys: ["b"] }),
    );
    expect(selectionOf({ mergeKeys: ["c"] })).toEqual(
      selection({ mergeKeys: ["c"] }),
    );
    expect(selectionOf({ keepKeys: ["d"] })).toEqual(
      selection({ keepKeys: ["d"] }),
    );
    expect(selectionOf({ replaceKeys: ["e"] })).toEqual(
      selection({ replaceKeys: ["e"] }),
    );
  });

  it("treats an empty importKeys as a selection of nothing, not as no selection", () => {
    expect(selectionOf({ importKeys: [] })).toEqual(selection());
  });
});

describe("namesExistingTransactions", () => {
  it("is true only for a merge, a keep or a replace", () => {
    expect(
      namesExistingTransactions(
        selection({ importKeys: ["a"], excludeKeys: ["b"] }),
      ),
    ).toBe(false);
    expect(namesExistingTransactions(selection({ mergeKeys: ["a"] }))).toBe(
      true,
    );
    expect(namesExistingTransactions(selection({ keepKeys: ["a"] }))).toBe(
      true,
    );
    expect(namesExistingTransactions(selection({ replaceKeys: ["a"] }))).toBe(
      true,
    );
  });
});

describe("assertDisjointSelection", () => {
  it("accepts lists that share no key", () => {
    expect(() =>
      assertDisjointSelection(
        selection({
          importKeys: ["a", "b"],
          excludeKeys: ["c"],
          mergeKeys: ["d"],
          keepKeys: ["e"],
          replaceKeys: ["f"],
        }),
      ),
    ).not.toThrow();
    expect(() => assertDisjointSelection(selection())).not.toThrow();
  });

  it("accepts a key repeated within one list", () => {
    expect(() =>
      assertDisjointSelection(selection({ mergeKeys: ["a", "a"] })),
    ).not.toThrow();
  });

  it("refuses a key both imported and excepted with 400", () => {
    expect(() =>
      assertDisjointSelection(
        selection({ importKeys: ["a", "b"], excludeKeys: ["b"] }),
      ),
    ).toThrow(BadRequestException);
  });

  it.each([
    ["merged and kept", { mergeKeys: ["a"], keepKeys: ["a"] }],
    ["imported and replaced", { importKeys: ["a"], replaceKeys: ["a"] }],
    ["excepted and merged", { excludeKeys: ["a"], mergeKeys: ["a"] }],
  ])("refuses a key %s with 400", (_label, over) => {
    expect(() => assertDisjointSelection(selection(over))).toThrow(
      BadRequestException,
    );
  });
});
