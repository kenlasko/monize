import { dedupeMaskedText } from "./support-backup-integrity";

/**
 * Masking is not injective, so two originally-distinct values can collapse to
 * the same masked string and collide on a UNIQUE index at restore time.
 * dedupeMaskedText must restore uniqueness without touching ids.
 */
describe("dedupeMaskedText", () => {
  const names = (rows: Record<string, unknown>[]): unknown[] =>
    rows.map((r) => r.name);

  it("disambiguates payees whose masked names collide", () => {
    const out = dedupeMaskedText({
      payees: [
        { id: "a", name: "****" },
        { id: "b", name: "****" },
        { id: "c", name: "****" },
      ],
    });
    // All three survive with distinct names; ids are untouched.
    expect(new Set(names(out.payees)).size).toBe(3);
    expect(out.payees.map((r) => r.id)).toEqual(["a", "b", "c"]);
    expect(out.payees[0].name).toBe("****");
    expect(out.payees[1].name).toBe("**** (2)");
    expect(out.payees[2].name).toBe("**** (3)");
  });

  it("scopes category-name uniqueness per parent", () => {
    const out = dedupeMaskedText({
      categories: [
        { id: "1", name: "****", parent_id: "p1" },
        { id: "2", name: "****", parent_id: "p1" },
        { id: "3", name: "****", parent_id: "p2" },
      ],
    });
    // Same name under a different parent is allowed, so row 3 stays "****".
    expect(names(out.categories)).toEqual(["****", "**** (2)", "****"]);
  });

  it("treats a LOWER() unique index as case-insensitive", () => {
    const out = dedupeMaskedText({
      tags: [
        { id: "1", name: "Ab" },
        { id: "2", name: "ab" },
      ],
    });
    expect(out.tags[0].name).toBe("Ab");
    expect(out.tags[1].name).toBe("ab (2)");
  });

  it("keeps symbols within their varchar(20) width", () => {
    const long = "A".repeat(20);
    const out = dedupeMaskedText({
      securities: [
        { id: "1", symbol: long },
        { id: "2", symbol: long },
      ],
    });
    expect(out.securities[1].symbol).toHaveLength(20);
    expect(out.securities[1].symbol).not.toBe(long);
    expect(out.securities[0].symbol).toBe(long);
  });

  it("leaves already-unique values untouched", () => {
    const input = {
      payees: [
        { id: "a", name: "Bi*****ka" },
        { id: "b", name: "Am*****on" },
      ],
    };
    const out = dedupeMaskedText(input);
    expect(names(out.payees)).toEqual(["Bi*****ka", "Am*****on"]);
  });

  it("ignores tables and columns it does not manage", () => {
    const out = dedupeMaskedText({
      accounts: [
        { id: "a", name: "****" },
        { id: "b", name: "****" },
      ],
    });
    // accounts.name has no UNIQUE constraint, so no disambiguation.
    expect(names(out.accounts)).toEqual(["****", "****"]);
  });
});
