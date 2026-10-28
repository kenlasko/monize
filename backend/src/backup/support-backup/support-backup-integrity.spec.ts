import { TableMap } from "./support-backup-scope";
import {
  dedupeMaskedText,
  MAX_SCRUB_PASSES,
  REFS_FOR_TEST,
  RefRule,
  scrubToFixedPoint,
} from "./support-backup-integrity";

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

/**
 * The scrub iterates because dropping a row can orphan its own dependents. It
 * used to iterate under a bare `for (pass = 0; pass < 10; pass++)` with a
 * `break` on convergence and *nothing at all* on exhaustion: if the rule graph
 * ever grew deeper than the bound, the export would return a table map with
 * dangling references still in it, gzip cleanly, and fail on the recipient's
 * restore with a foreign-key violation and no hint that the export had known.
 *
 * A silent cap is untestable through the real `REFS` -- the graph is four levels
 * deep, so no input reaches ten passes, and that is precisely why the omission
 * survived. `scrubToFixedPoint` therefore takes the map and the bound, so the
 * exhaustion branch can be reached on purpose.
 */
describe("scrubToFixedPoint", () => {
  /**
   * A chain t1 -> t2 -> ... -> tN, plus a tN whose own reference is already
   * dangling. Listing the tables parent-first means each pass resolves exactly
   * one level from the bottom, so a chain of N needs N passes -- the cheapest
   * way to make depth exceed a bound.
   */
  const chain = (
    length: number,
  ): { refs: Record<string, RefRule[]>; tables: TableMap } => {
    const refs: Record<string, RefRule[]> = {};
    const tables: TableMap = {};
    for (let i = 1; i <= length; i++) {
      const next = i === length ? "absent" : `t${i + 1}`;
      refs[`t${i}`] = [{ column: "ref", refTable: next, onMissing: "dropRow" }];
      tables[`t${i}`] = [{ id: `${i}`, ref: `${i + 1}` }];
    }
    return { refs, tables };
  };

  it("throws rather than returning a map with references still dangling", () => {
    const { refs, tables } = chain(12);
    expect(() => scrubToFixedPoint(tables, refs, MAX_SCRUB_PASSES)).toThrow(
      /did not reach a fixed point in 10 passes/,
    );
  });

  it("names the bound it exhausted, so the fix is obvious from the message", () => {
    const { refs, tables } = chain(5);
    expect(() => scrubToFixedPoint(tables, refs, 3)).toThrow(
      /did not reach a fixed point in 3 passes/,
    );
  });

  it("converges on a chain that fits, dropping the whole cascade", () => {
    // Same shape, one pass of headroom: proves the throw above is about the
    // bound and not about the chain being unsatisfiable.
    const { refs, tables } = chain(5);
    const out = scrubToFixedPoint(tables, refs, 6);
    for (let i = 1; i <= 5; i++) expect(out[`t${i}`]).toEqual([]);
  });

  it("leaves a closed map untouched", () => {
    const refs: Record<string, RefRule[]> = {
      transactions: [
        { column: "account_id", refTable: "accounts", onMissing: "dropRow" },
      ],
    };
    const tables: TableMap = {
      accounts: [{ id: "a" }],
      transactions: [{ id: "t", account_id: "a" }],
    };
    expect(scrubToFixedPoint(tables, refs, MAX_SCRUB_PASSES)).toEqual(tables);
  });
});

/**
 * The bound only stays a runaway guard while the real rule graph is shallower
 * than it. A migration that adds a `dropRow` chain deeper than
 * MAX_SCRUB_PASSES -- or a `dropRow` cycle -- would make exhaustion reachable
 * in production, where it is a failed export rather than a caught mistake. So
 * assert the headroom instead of assuming it.
 */
describe("the real REFS graph stays inside the pass bound", () => {
  /** Longest dropRow path, or null when the dropRow graph has a cycle. */
  const longestDropRowPath = (): number | null => {
    const edges = new Map<string, string[]>();
    for (const [table, rules] of REFS_FOR_TEST) {
      edges.set(
        table,
        rules.filter((r) => r.onMissing === "dropRow").map((r) => r.refTable),
      );
    }
    const depth = new Map<string, number>();
    const onStack = new Set<string>();
    let cyclic = false;
    const visit = (table: string): number => {
      const cached = depth.get(table);
      if (cached !== undefined) return cached;
      if (onStack.has(table)) {
        cyclic = true;
        return 0;
      }
      onStack.add(table);
      let best = 1;
      for (const ref of edges.get(table) ?? []) {
        if (ref === table) {
          cyclic = true;
          continue;
        }
        best = Math.max(best, 1 + visit(ref));
      }
      onStack.delete(table);
      depth.set(table, best);
      return best;
    };
    let longest = 0;
    for (const table of edges.keys()) longest = Math.max(longest, visit(table));
    return cyclic ? null : longest;
  };

  it("has no dropRow cycle, which no number of passes would resolve", () => {
    expect(longestDropRowPath()).not.toBeNull();
  });

  it("needs fewer passes than the bound allows", () => {
    // One pass resolves one level in the worst iteration order, plus one final
    // pass to observe the fixed point.
    const longest = longestDropRowPath();
    expect(longest).not.toBeNull();
    expect((longest as number) + 1).toBeLessThanOrEqual(MAX_SCRUB_PASSES);
  });
});

describe("composite reference scrub", () => {
  const refs: Record<string, RefRule[]> = {
    child: [
      {
        column: "parent_id",
        refTable: "parent",
        onMissing: "dropRow",
        targetColumns: [
          { local: "parent_id", remote: "id" },
          { local: "user_id", remote: "user_id" },
        ],
      },
    ],
  };
  it("requires the entire tuple on one target row", () => {
    const out = scrubToFixedPoint(
      {
        parent: [
          { id: "a", user_id: "alice" },
          { id: "b", user_id: "bob" },
        ],
        child: [
          { id: "valid", parent_id: "a", user_id: "alice" },
          { id: "mixed", parent_id: "a", user_id: "bob" },
        ],
      },
      refs,
      4,
    );
    expect(out.child.map((row) => row.id)).toEqual(["valid"]);
  });
  it("preserves nullable MATCH SIMPLE references", () => {
    expect(
      scrubToFixedPoint(
        {
          parent: [],
          child: [{ id: "nullable", parent_id: null, user_id: "alice" }],
        },
        refs,
        4,
      ).child,
    ).toHaveLength(1);
  });
  it("rechecks tuples after a target is removed", () => {
    const chain: Record<string, RefRule[]> = {
      ...refs,
      parent: [
        {
          column: "grandparent_id",
          refTable: "grandparent",
          onMissing: "dropRow",
        },
      ],
    };
    const out = scrubToFixedPoint(
      {
        grandparent: [],
        parent: [{ id: "a", user_id: "alice", grandparent_id: "gone" }],
        child: [{ id: "dependent", parent_id: "a", user_id: "alice" }],
      },
      chain,
      4,
    );
    expect(out.parent).toEqual([]);
    expect(out.child).toEqual([]);
  });
});
