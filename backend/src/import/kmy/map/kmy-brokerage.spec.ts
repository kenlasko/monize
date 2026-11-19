import { rawAccount, standardRoots } from "../__fixtures__/kmy-raw-builders";
import { buildAccountTree } from "./kmy-account-tree";
import { KMY_BROKERAGE_SUFFIXES, findBrokerageAccount } from "./kmy-brokerage";

function find(
  accounts: ReturnType<typeof rawAccount>[],
  claimed: string[] = [],
) {
  const all = [...standardRoots(), ...accounts];
  const tree = buildAccountTree(all);
  return findBrokerageAccount(accounts[0], accounts, tree, new Set(claimed));
}

describe("findBrokerageAccount", () => {
  const inv = rawAccount({ id: "I", name: "Fidelity", type: 7 });

  it("lists the English suffix first and every translation after it", () => {
    expect(KMY_BROKERAGE_SUFFIXES[0]).toBe("Brokerage");
    expect(KMY_BROKERAGE_SUFFIXES).toContain("Verrechnung");
    expect(KMY_BROKERAGE_SUFFIXES).toContain("傭金");
  });

  it("prefers the account the KVP names", () => {
    const named = rawAccount({ id: "N", name: "Whatever", type: 3 });
    const byName = rawAccount({
      id: "B",
      name: "Fidelity (Brokerage)",
      type: 1,
    });
    const linked = {
      ...inv,
      kvp: new Map([["kmm-brokerage-account", "N"]]),
    };
    expect(find([linked, byName, named])?.id).toBe("N");
  });

  it.each([
    ["English", "Fidelity (Brokerage)"],
    ["German", "Fidelity (Verrechnung)"],
    ["case-insensitive", "FIDELITY (brokerage)"],
    ["Japanese", "Fidelity (傭金)"],
  ])("matches the %s suffix by name", (_label, name) => {
    const cash = rawAccount({ id: "B", name, type: 1 });
    expect(find([inv, cash])?.id).toBe("B");
  });

  it("falls through to none when nothing matches", () => {
    expect(
      find([inv, rawAccount({ id: "B", name: "Fidelity (Misc)", type: 1 })]),
    ).toBeNull();
  });

  it("refuses an ineligible type, a standard root, a claimed account and an unreachable one", () => {
    const wrongType = rawAccount({
      id: "B",
      name: "Fidelity (Brokerage)",
      type: 4,
    });
    expect(find([inv, wrongType])).toBeNull();
    const cash = rawAccount({ id: "B", name: "Fidelity (Brokerage)", type: 1 });
    expect(find([inv, cash], ["B"])).toBeNull();
    const orphan = rawAccount({
      id: "B",
      name: "Fidelity (Brokerage)",
      type: 1,
      parentId: "C",
    });
    const loop = rawAccount({ id: "C", type: 1, parentId: "B" });
    expect(find([inv, orphan, loop])).toBeNull();
    const kvpToRoot = {
      ...inv,
      kvp: new Map([["kmm-brokerage-account", "AStd::Asset"]]),
    };
    expect(find([kvpToRoot])).toBeNull();
  });

  it("matches the first of two candidates by ordinal", () => {
    const first = rawAccount({
      id: "B1",
      name: "Fidelity (Brokerage)",
      type: 1,
    });
    const second = rawAccount({
      id: "B2",
      name: "Fidelity (Brokerage)",
      type: 1,
    });
    expect(find([inv, first, second])?.id).toBe("B1");
  });
});
