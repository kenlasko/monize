import { EntityManager } from "typeorm";
import { ConflictException } from "@nestjs/common";
import { ActionHistory } from "./entities/action-history.entity";
import { assertNoReferencesBeforeDelete } from "./undo-references";

describe("assertNoReferencesBeforeDelete", () => {
  const action = (entityType: string) =>
    ({
      userId: "u",
      entityType,
      entityId: "e1",
      action: "create",
    }) as ActionHistory;

  /** Answers the lock with a name and every count with `count`. */
  function makeManager(count: number, locked = true) {
    return {
      query: jest.fn((sql: string) => {
        if (sql.includes("FOR UPDATE")) {
          return Promise.resolve(locked ? [{ name: "Thing" }] : []);
        }
        if (sql.startsWith("SELECT id FROM accounts")) {
          return Promise.resolve([]);
        }
        return Promise.resolve([{ count }]);
      }),
    };
  }
  const run = (type: string, m: unknown, redo = false) =>
    assertNoReferencesBeforeDelete(action(type), m as EntityManager, redo);

  it.each(["category", "payee", "tag", "account", "security"])(
    "refuses the undo of a %s create while rows use it",
    async (type) => {
      const m = makeManager(2);
      const error = await run(type, m).catch((e) => e);
      expect(error).toBeInstanceOf(ConflictException);
      expect(error.getResponse()).toMatchObject({
        errorCode: "RECORD_IN_USE",
        errors: expect.arrayContaining([
          expect.objectContaining({ count: expect.any(Number) }),
        ]),
      });
      // The lock comes first, and nothing is written.
      expect(m.query.mock.calls[0][0]).toContain("FOR UPDATE");
      expect(
        m.query.mock.calls.every(([sql]) =>
          /^(SELECT|WITH)/.test(sql.trimStart()),
        ),
      ).toBe(true);
    },
  );

  it.each(["category", "payee", "tag", "account", "security"])(
    "allows the undo of an unused %s",
    async (type) => {
      await expect(run(type, makeManager(0))).resolves.toBeUndefined();
    },
  );

  it("words a redo of a delete as a redo", async () => {
    const error = await run("category", makeManager(1), true).catch((e) => e);
    expect(error.getResponse().message).toContain("Cannot redo deleting");
  });

  it("does not check the redo of a tag delete, which removes the tag everywhere", async () => {
    const m = makeManager(3);
    await expect(run("tag", m, true)).resolves.toBeUndefined();
    expect(m.query).not.toHaveBeenCalled();
  });

  it("names a security by its symbol", async () => {
    const m = makeManager(1);
    await run("security", m).catch(() => undefined);
    expect(m.query.mock.calls[0][0]).toContain("SELECT symbol AS name");
  });

  it("checks nothing for a row that is already gone or an entity without a finder", async () => {
    const gone = makeManager(5, false);
    await expect(run("tag", gone)).resolves.toBeUndefined();
    expect(gone.query).toHaveBeenCalledTimes(1);
    // A schedule has no finder: the undo clears a loan's link itself.
    for (const type of ["custom_report", "scheduled_transaction"]) {
      const m = makeManager(5);
      await expect(run(type, m)).resolves.toBeUndefined();
      expect(m.query).not.toHaveBeenCalled();
    }
  });

  describe("a budget", () => {
    /** Answers the lock with a name, then the three counts in order. */
    function budgetManager(
      periods: number,
      lines: (string | Record<string, unknown>)[],
      buckets: (string | Record<string, unknown>)[],
      locked = true,
      aliveCategories: string[] = [],
    ) {
      return {
        query: jest.fn((sql: string) => {
          if (sql.includes("FOR UPDATE")) {
            return Promise.resolve(locked ? [{ name: "Household" }] : []);
          }
          if (sql.includes("FROM budget_periods")) {
            return Promise.resolve([{ periods }]);
          }
          if (sql.includes("FROM categories")) {
            return Promise.resolve(aliveCategories.map((id) => ({ id })));
          }
          if (sql.includes("FROM accounts")) {
            return Promise.resolve([]);
          }
          if (sql.includes("FROM budget_categories")) {
            return Promise.resolve(
              lines.map((l) => (typeof l === "string" ? { id: l } : l)),
            );
          }
          return Promise.resolve(
            buckets.map((b) => (typeof b === "string" ? { id: b } : b)),
          );
        }),
      };
    }
    const undoOf = (m: unknown) => run("budget", m);
    const redoOf = (m: unknown, afterData?: unknown) =>
      assertNoReferencesBeforeDelete(
        { ...action("budget"), afterData } as ActionHistory,
        m as EntityManager,
        true,
      );
    const code = (p: Promise<void>) =>
      p.catch((e) => e.getResponse().errorCode);

    it("locks first and counts in later statements", async () => {
      const m = budgetManager(0, [], []);
      await undoOf(m);
      expect(m.query.mock.calls[0][0]).toContain("FOR UPDATE");
      for (const call of m.query.mock.calls.slice(1)) {
        expect(call[0]).not.toContain("FOR UPDATE");
      }
    });

    it("checks nothing for a budget that is already gone", async () => {
      const m = budgetManager(5, ["l"], ["b"], false);
      await expect(undoOf(m)).resolves.toBeUndefined();
      expect(m.query).toHaveBeenCalledTimes(1);
    });

    it("lets the undo through when nothing was added", async () => {
      await expect(undoOf(budgetManager(0, [], []))).resolves.toBeUndefined();
    });

    it.each([
      ["a period", budgetManager(1, [], [])],
      ["a line", budgetManager(0, ["l"], [])],
      ["a bucket", budgetManager(0, [], ["b"])],
    ])("refuses the undo of a create with %s", async (_n, m) => {
      expect(await code(undoOf(m))).toBe("UNDO_BUDGET_HAS_HISTORY");
    });

    it("lets the redo of a delete through over the rows its snapshot restored", async () => {
      const snapshot = { categories: [{ id: "l" }], buckets: [{ id: "b" }] };
      await expect(
        redoOf(budgetManager(0, ["l"], ["b"]), snapshot),
      ).resolves.toBeUndefined();
    });

    it("compares text as text: notes '1.0' is not '1'", async () => {
      const snapshot = { categories: [{ id: "l", notes: "1" }] };
      expect(
        await code(
          redoOf(budgetManager(0, [{ id: "l", notes: "1.0" }], []), snapshot),
        ),
      ).toBe("REDO_BUDGET_HAS_HISTORY");
    });

    it("treats a null reference to a gone category as the foreign key's SET NULL, not an edit", async () => {
      const snapshot = { categories: [{ id: "l", categoryId: "c1" }] };
      const gone = budgetManager(0, [{ id: "l", category_id: null }], []);
      await expect(redoOf(gone, snapshot)).resolves.toBeUndefined();
      // Still there: the null is somebody's edit.
      const kept = budgetManager(
        0,
        [{ id: "l", category_id: null }],
        [],
        true,
        ["c1"],
      );
      expect(await code(redoOf(kept, snapshot))).toBe(
        "REDO_BUDGET_HAS_HISTORY",
      );
    });

    it("compares numbers by value, text from the database against the snapshot", async () => {
      const snapshot = {
        categories: [{ id: "l", amount: 500, notes: null }],
        buckets: [{ id: "b", targetValue: 50 }],
      };
      await expect(
        redoOf(
          budgetManager(
            0,
            [{ id: "l", amount: "500.00000000", notes: null }],
            [{ id: "b", target_value: "50.00000000" }],
          ),
          snapshot,
        ),
      ).resolves.toBeUndefined();
    });

    it.each([
      ["an edited line", [{ id: "l", amount: "600.00000000" }], ["b"]],
      ["an edited bucket", ["l"], [{ id: "b", target_value: "60" }]],
    ])("refuses the redo of a delete with %s", async (_n, lines, buckets) => {
      const snapshot = {
        categories: [{ id: "l", amount: 500 }],
        buckets: [{ id: "b", targetValue: 50 }],
      };
      // Rows given as bare ids carry no values: only the edited one differs.
      const m = budgetManager(
        0,
        lines.map((l) =>
          typeof l === "string" ? { id: l, amount: "500" } : l,
        ),
        buckets.map((b) =>
          typeof b === "string" ? { id: b, target_value: "50" } : b,
        ),
      );
      expect(await code(redoOf(m, snapshot))).toBe("REDO_BUDGET_HAS_HISTORY");
    });

    it.each([
      ["a period", budgetManager(1, ["l"], ["b"])],
      ["a new line", budgetManager(0, ["l", "x"], ["b"])],
      ["a new bucket", budgetManager(0, ["l"], ["b", "x"])],
    ])("refuses the redo of a delete with %s", async (_n, m) => {
      const snapshot = { categories: [{ id: "l" }], buckets: [{ id: "b" }] };
      expect(await code(redoOf(m, snapshot))).toBe("REDO_BUDGET_HAS_HISTORY");
    });
  });
});
