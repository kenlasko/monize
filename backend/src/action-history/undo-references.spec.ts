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

  it.each([
    "category",
    "payee",
    "tag",
    "account",
    "scheduled_transaction",
    "security",
  ])("allows the undo of an unused %s", async (type) => {
    await expect(run(type, makeManager(0))).resolves.toBeUndefined();
  });

  it("allows the undo of a schedule that only a loan links to (loan creation)", async () => {
    const m = {
      query: jest.fn((sql: string) =>
        Promise.resolve(
          sql.includes("FOR UPDATE")
            ? [{ name: "Loan payment" }]
            : [{ id: "l1" }],
        ),
      ),
    };
    await expect(run("scheduled_transaction", m)).resolves.toBeUndefined();
  });

  it("words a redo of a delete as a redo", async () => {
    const error = await run("tag", makeManager(1), true).catch((e) => e);
    expect(error.getResponse().message).toContain("Cannot redo deleting");
  });

  it("checks nothing for a row that is already gone or an entity without a finder", async () => {
    const gone = makeManager(5, false);
    await expect(run("tag", gone)).resolves.toBeUndefined();
    expect(gone.query).toHaveBeenCalledTimes(1);
    const budget = makeManager(5);
    await expect(run("budget", budget)).resolves.toBeUndefined();
    expect(budget.query).not.toHaveBeenCalled();
  });
});
