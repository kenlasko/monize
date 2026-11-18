import { rawAccount, rawFile } from "../__fixtures__/kmy-raw-builders";
import { harness } from "./kmy-map.harness";
import { mapKmyCategories } from "./kmy-map-categories";

function categories(
  referenced: ReadonlySet<number> | null,
  equityUsed: ReadonlySet<number> = new Set(),
) {
  const raw = rawFile({
    accounts: [
      rawAccount({ id: "U", name: "Utilities", type: 13 }),
      rawAccount({ id: "G", name: "Gas", type: 13, parentId: "U" }),
      rawAccount({ id: "W", name: "Winter: heating", type: 13, parentId: "G" }),
      rawAccount({ id: "S", name: "Salary", type: 12 }),
      rawAccount({ id: "F", name: "Fees", type: 13 }),
      rawAccount({ id: "E", name: "Opening Balances", type: 16 }),
      rawAccount({ id: "C", name: "Checking", type: 1 }),
    ],
  });
  const { tree } = harness(raw);
  return mapKmyCategories({ raw, tree, referenced, equityUsed });
}

describe("mapKmyCategories (spec 5.4)", () => {
  it("keeps three levels, parents first, with chain-of-handle full names", () => {
    const result = categories(null);
    expect(
      result.categories.map((c) => [
        c.handle,
        c.name,
        c.parentName,
        c.fullName,
        c.isIncome,
      ]),
    ).toEqual([
      [6, "Utilities", null, "6", false],
      [9, "Salary", null, "9", true],
      [10, "Fees", null, "10", false],
      [7, "Gas", "6", "6/7", false],
      [8, "Winter: heating", "6/7", "6/7/8", false],
    ]);
    expect(result.byHandle.get(8)?.fullName).toBe("6/7/8");
    expect(result.skipped).toBe(0);
  });

  it("keeps only referenced categories and all their ancestors", () => {
    const result = categories(new Set([8, 10]));
    expect(result.categories.map((c) => c.handle)).toEqual([6, 10, 7, 8]);
    expect(result.skipped).toBe(1);
  });

  it("adds an equity account used outside an opening balance as a top-level income category", () => {
    expect(categories(null).categories.map((c) => c.handle)).not.toContain(11);
    const result = categories(new Set([10]), new Set([11]));
    const equity = result.categories.find((c) => c.handle === 11);
    expect(equity).toEqual({
      handle: 11,
      parentName: null,
      name: "Opening Balances",
      fullName: "11",
      isIncome: true,
    });
  });

  it("names a category with an empty name after its handle", () => {
    const raw = rawFile({
      accounts: [rawAccount({ id: "X", name: " ", type: 13 })],
    });
    const result = mapKmyCategories({
      raw,
      tree: harness(raw).tree,
      referenced: null,
      equityUsed: new Set(),
    });
    expect(result.categories[0].name).toBe("Category 6");
  });
});
