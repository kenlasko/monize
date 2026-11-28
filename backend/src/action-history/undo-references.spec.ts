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
    const m = makeManager(5);
    await expect(run("scheduled_transaction", m)).resolves.toBeUndefined();
    expect(m.query).not.toHaveBeenCalled();
  });

  it("refuses the undo of a budget create while it has a CLOSED period", async () => {
    const m = makeManager(2);
    const error = await run("budget", m).catch((e) => e);
    expect(error).toBeInstanceOf(ConflictException);
    expect(error.getResponse()).toMatchObject({
      errorCode: "RECORD_IN_USE",
      errors: [{ kind: "budgetPeriods", count: 2 }],
    });
    const counting = m.query.mock.calls.map(([sql]) => sql as string).pop();
    expect(counting).toContain("p.status = 'CLOSED'");
  });

  it("allows the undo of a budget that has only an OPEN period", async () => {
    await expect(run("budget", makeManager(0))).resolves.toBeUndefined();
  });
});
