import { rawAccount, standardRoots } from "../__fixtures__/kmy-raw-builders";
import {
  buildAccountTree,
  groupOfType,
  isAssetOrLiability,
  isCategoryType,
} from "./kmy-account-tree";

describe("kmy-account-tree", () => {
  it("assigns every type of reference 5.2 to its group", () => {
    const groups = Array.from({ length: 17 }, (_, type) => groupOfType(type));
    expect(groups).toEqual([
      null,
      "asset",
      "asset",
      "asset",
      "liability",
      "liability",
      "asset",
      "asset",
      "asset",
      "asset",
      "liability",
      "asset",
      "income",
      "expense",
      "asset",
      "asset",
      "equity",
    ]);
    expect(groupOfType(99)).toBeNull();
  });

  it("separates money accounts from categories and stock accounts", () => {
    expect(isAssetOrLiability(1)).toBe(true);
    expect(isAssetOrLiability(7)).toBe(true);
    expect(isAssetOrLiability(15)).toBe(false);
    expect(isAssetOrLiability(12)).toBe(false);
    expect(isCategoryType(12)).toBe(true);
    expect(isCategoryType(16)).toBe(false);
  });

  it("reparents an account whose parent does not exist to its group's root", () => {
    const tree = buildAccountTree([
      ...standardRoots(),
      rawAccount({ id: "A1", type: 1, parentId: "missing" }),
      rawAccount({ id: "A2", type: 4, parentId: null }),
      rawAccount({ id: "A3", type: 13, parentId: "" }),
    ]);
    expect(tree.parentOf("A1")).toBe("AStd::Asset");
    expect(tree.parentOf("A2")).toBe("AStd::Liability");
    expect(tree.parentOf("A3")).toBe("AStd::Expense");
    expect(tree.parentOf("AStd::Asset")).toBeNull();
    expect(tree.reachable("A1")).toBe(true);
    expect(tree.reachable("nope")).toBe(false);
  });

  it("finds ancestors nearest first, roots excluded, and stops at a cycle", () => {
    const tree = buildAccountTree([
      ...standardRoots(),
      rawAccount({ id: "A1", type: 1 }),
      rawAccount({ id: "A2", type: 1, parentId: "A1" }),
      rawAccount({ id: "A3", type: 1, parentId: "A2" }),
      rawAccount({ id: "C1", type: 1, parentId: "C2" }),
      rawAccount({ id: "C2", type: 1, parentId: "C1" }),
      rawAccount({ id: "U", type: 0, parentId: null }),
    ]);
    expect(tree.ancestors("A3").map((a) => a.id)).toEqual(["A2", "A1"]);
    expect(tree.nearestAncestor("A3", (a) => a.id === "A1")?.id).toBe("A1");
    expect(tree.nearestAncestor("A1", () => true)).toBeNull();
    expect(tree.reachable("A3")).toBe(true);
    expect(tree.reachable("C1")).toBe(false);
    expect(tree.ancestors("C1").map((a) => a.id)).toEqual(["C2"]);
    expect(tree.reachable("U")).toBe(false);
  });
});
