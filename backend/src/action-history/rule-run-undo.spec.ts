import { ConflictException } from "@nestjs/common";
import { EntityManager } from "typeorm";
import { lockTransactionRows } from "../common/db/locks";
import { Transaction } from "../transactions/entities/transaction.entity";
import { assertReconciledRowsMutable } from "../transactions/reconciled-lock.util";
import { ActionHistory } from "./entities/action-history.entity";
import { TransactionSplit } from "../transactions/entities/transaction-split.entity";
import { assertRuleRunRedoable, undoRuleRun } from "./rule-run-undo";

jest.mock("../common/db/locks", () => ({ lockTransactionRows: jest.fn() }));
jest.mock("../transactions/reconciled-lock.util", () => ({
  assertReconciledRowsMutable: jest.fn(),
}));

const USER = "user-1";

function action(transactions: unknown): ActionHistory {
  return {
    id: "a1",
    userId: USER,
    entityType: "transaction_rule_run",
    action: "bulk_update",
    beforeData: transactions === undefined ? null : { transactions },
  } as unknown as ActionHistory;
}

const balances = {
  updateBalance: jest.fn(),
  recalculateCurrentBalance: jest.fn(),
};

function harness() {
  const manager = {
    update: jest.fn().mockResolvedValue({ affected: 1 }),
    delete: jest.fn().mockResolvedValue({ affected: 1 }),
    query: jest.fn().mockResolvedValue([]),
  };
  return { manager, em: manager as unknown as EntityManager };
}

const locked = (...ids: string[]) =>
  new Map(ids.map((id) => [id, { id, status: "UNRECONCILED" }]));

describe("undoRuleRun", () => {
  beforeEach(() => {
    jest.resetAllMocks();
  });

  it("does nothing for an entry without rows", async () => {
    const { manager, em } = harness();
    await undoRuleRun(action(undefined), em, balances);
    await undoRuleRun(action([]), em, balances);
    expect(lockTransactionRows).not.toHaveBeenCalled();
    expect(manager.update).not.toHaveBeenCalled();
  });

  it("restores only the fields the snapshot holds, scoped to the user", async () => {
    const { manager, em } = harness();
    (lockTransactionRows as jest.Mock).mockResolvedValue(locked("t1", "t2"));

    await undoRuleRun(
      action([
        { id: "t1", categoryId: null },
        {
          id: "t2",
          payeeId: "p-old",
          payeeName: "Old",
          categoryId: "c-old",
        },
      ]),
      em,
      balances,
    );

    expect(manager.update).toHaveBeenCalledTimes(2);
    expect(manager.update).toHaveBeenCalledWith(
      Transaction,
      { id: "t1", userId: USER },
      { categoryId: null },
    );
    expect(manager.update).toHaveBeenCalledWith(
      Transaction,
      { id: "t2", userId: USER },
      { categoryId: "c-old", payeeId: "p-old", payeeName: "Old" },
    );
    // No tag snapshot: no tag statement.
    expect(manager.query).not.toHaveBeenCalled();
  });

  it("restores the description, alone or with the payee, and a null description", async () => {
    const { manager, em } = harness();
    (lockTransactionRows as jest.Mock).mockResolvedValue(locked("t1", "t2"));
    await undoRuleRun(
      action([
        { id: "t1", description: "before" },
        {
          id: "t2",
          payeeId: null,
          payeeName: "raw",
          description: null,
        },
      ]),
      em,
      balances,
    );
    expect(manager.update).toHaveBeenCalledWith(
      Transaction,
      { id: "t1", userId: USER },
      { description: "before" },
    );
    expect(manager.update).toHaveBeenCalledWith(
      Transaction,
      { id: "t2", userId: USER },
      { payeeId: null, payeeName: "raw", description: null },
    );
  });

  it("restores a null payee and null name", async () => {
    const { manager, em } = harness();
    (lockTransactionRows as jest.Mock).mockResolvedValue(locked("t1"));
    await undoRuleRun(
      action([{ id: "t1", payeeId: null, payeeName: null }]),
      em,
      balances,
    );
    expect(manager.update).toHaveBeenCalledWith(
      Transaction,
      { id: "t1", userId: USER },
      { payeeId: null, payeeName: null },
    );
  });

  it("replaces the tag set of every row that recorded one in two statements", async () => {
    const { manager, em } = harness();
    (lockTransactionRows as jest.Mock).mockResolvedValue(
      locked("t1", "t2", "t3"),
    );

    await undoRuleRun(
      action([
        { id: "t1", tagIds: ["g1", "g2"] },
        { id: "t2", tagIds: [] },
        { id: "t3", categoryId: "c" },
      ]),
      em,
      balances,
    );

    expect(manager.query).toHaveBeenCalledTimes(2);
    const [deleteSql, deleteArgs] = manager.query.mock.calls[0];
    expect(deleteSql).toContain("DELETE FROM transaction_tags");
    expect(deleteSql).toContain("t.user_id = $1");
    expect(deleteArgs).toEqual([USER, ["t1", "t2"]]);
    const [insertSql, insertArgs] = manager.query.mock.calls[1];
    expect(insertSql).toContain("INSERT INTO transaction_tags");
    expect(insertSql).toContain("g.user_id = $1");
    expect(insertArgs).toEqual([USER, ["t1", "t1"], ["g1", "g2"]]);
  });

  it("deletes the tags but inserts nothing when the snapshot set was empty", async () => {
    const { manager, em } = harness();
    (lockTransactionRows as jest.Mock).mockResolvedValue(locked("t1"));
    await undoRuleRun(action([{ id: "t1", tagIds: [] }]), em, balances);
    expect(manager.query).toHaveBeenCalledTimes(1);
    expect(manager.query.mock.calls[0][0]).toContain("DELETE");
  });

  it("skips a row deleted since the run", async () => {
    const { manager, em } = harness();
    (lockTransactionRows as jest.Mock).mockResolvedValue(locked("t1"));
    await undoRuleRun(
      action([
        { id: "gone", categoryId: null, tagIds: ["g1"] },
        { id: "t1", categoryId: "c" },
      ]),
      em,
      balances,
    );
    expect(manager.update).toHaveBeenCalledTimes(1);
    expect(manager.query).not.toHaveBeenCalled();
  });

  it("locks the rows in one call and refuses on the reconciled lock before any write", async () => {
    const { manager, em } = harness();
    (lockTransactionRows as jest.Mock).mockResolvedValue(locked("t1"));
    (assertReconciledRowsMutable as jest.Mock).mockRejectedValue(
      new ConflictException("locked"),
    );

    await expect(
      undoRuleRun(
        action([{ id: "t1", categoryId: null, tagIds: [] }]),
        em,
        balances,
      ),
    ).rejects.toBeInstanceOf(ConflictException);

    expect(lockTransactionRows).toHaveBeenCalledWith(em, ["t1"], USER);
    expect(assertReconciledRowsMutable).toHaveBeenCalledWith(em, USER, [
      { id: "t1", status: "UNRECONCILED" },
    ]);
    expect(manager.update).not.toHaveBeenCalled();
    expect(manager.query).not.toHaveBeenCalled();
  });

  describe("a structural row", () => {
    const LOAN = "acct-loan";
    const leg = (id: string, over: Record<string, unknown> = {}) => ({
      id,
      accountId: LOAN,
      amount: 640.15,
      transactionDate: "2020-01-15",
      status: "UNRECONCILED",
      linkedTransactionId: "t1",
      ...over,
    });
    const lockAll = (
      rows: Record<string, unknown>[],
      legs: Record<string, unknown>[] = [],
    ) =>
      (lockTransactionRows as jest.Mock).mockImplementation(
        async (_em: unknown, ids: string[]) =>
          new Map(
            [...rows, ...legs]
              .filter((r) => ids.includes(r.id as string))
              .map((r) => [r.id as string, r]),
          ),
      );
    const converted = {
      id: "t1",
      categoryId: "c-old",
      isTransfer: false,
      isSplit: false,
      linkedTransactionId: null,
      structure: { kind: "transfer", counterpartIds: ["cp1"] },
    };

    it("locks the row and its transfer counterpart together, then checks the reconciled lock on both", async () => {
      const { em } = harness();
      lockAll([{ id: "t1", status: "UNRECONCILED" }], [leg("cp1")]);
      await undoRuleRun(action([converted]), em, balances);

      expect(lockTransactionRows).toHaveBeenCalledTimes(1);
      expect(lockTransactionRows).toHaveBeenCalledWith(em, ["t1", "cp1"], USER);
      const checked = (assertReconciledRowsMutable as jest.Mock).mock
        .calls[0][2] as Array<{ id: string }>;
      expect(checked.map((r) => r.id)).toEqual(["t1", "cp1"]);
    });

    it("deletes the counterpart conditionally, reverses exactly its amount, and restores the row", async () => {
      const { manager, em } = harness();
      lockAll([{ id: "t1", status: "UNRECONCILED" }], [leg("cp1")]);

      const moved = await undoRuleRun(action([converted]), em, balances);

      expect(manager.delete).toHaveBeenCalledWith(Transaction, {
        id: "cp1",
        userId: USER,
      });
      // The counterpart added +640.15 to the loan account; undo takes it back.
      expect(balances.updateBalance).toHaveBeenCalledTimes(1);
      expect(balances.updateBalance).toHaveBeenCalledWith(LOAN, -640.15);
      expect(balances.recalculateCurrentBalance).not.toHaveBeenCalled();
      expect(moved).toEqual(new Set([LOAN]));
      expect(manager.update).toHaveBeenCalledWith(
        Transaction,
        { id: "t1", userId: USER },
        {
          categoryId: "c-old",
          isTransfer: false,
          isSplit: false,
          linkedTransactionId: null,
        },
      );
    });

    it("reverses nothing for a VOID counterpart and recomputes a future-dated one", async () => {
      const { em } = harness();
      lockAll(
        [{ id: "t1" }, { id: "t2" }],
        [
          leg("cp1", { status: "VOID" }),
          leg("cp2", {
            transactionDate: "2999-01-01",
            linkedTransactionId: "t2",
          }),
        ],
      );
      await undoRuleRun(
        action([
          converted,
          {
            ...converted,
            id: "t2",
            structure: { kind: "transfer", counterpartIds: ["cp2"] },
          },
        ]),
        em,
        balances,
      );
      expect(balances.updateBalance).not.toHaveBeenCalled();
      expect(balances.recalculateCurrentBalance).toHaveBeenCalledWith(
        USER,
        LOAN,
      );
    });

    it("skips a counterpart that is already gone: nothing deleted, nothing reversed", async () => {
      const { manager, em } = harness();
      lockAll([{ id: "t1" }]);
      const moved = await undoRuleRun(action([converted]), em, balances);

      expect(manager.delete).not.toHaveBeenCalled();
      expect(balances.updateBalance).not.toHaveBeenCalled();
      expect(moved.size).toBe(0);
      // The row itself is still put back.
      expect(manager.update).toHaveBeenCalledTimes(1);
    });

    it("skips a counterpart that another request deleted first (conditional delete)", async () => {
      const { manager, em } = harness();
      lockAll([{ id: "t1" }], [leg("cp1")]);
      manager.delete.mockResolvedValue({ affected: 0 });
      await undoRuleRun(action([converted]), em, balances);
      expect(balances.updateBalance).not.toHaveBeenCalled();
    });

    it("leaves a leg alone when it is no longer linked to the row", async () => {
      const { manager, em } = harness();
      lockAll([{ id: "t1" }], [leg("cp1", { linkedTransactionId: "other" })]);
      await undoRuleRun(action([converted]), em, balances);
      expect(manager.delete).not.toHaveBeenCalled();
      expect(balances.updateBalance).not.toHaveBeenCalled();
    });

    it("refuses on the counterpart's reconciled lock before any write", async () => {
      const { manager, em } = harness();
      lockAll([{ id: "t1" }], [leg("cp1", { status: "RECONCILED" })]);
      (assertReconciledRowsMutable as jest.Mock).mockRejectedValue(
        new ConflictException("locked"),
      );
      await expect(
        undoRuleRun(action([converted]), em, balances),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(manager.delete).not.toHaveBeenCalled();
      expect(manager.update).not.toHaveBeenCalled();
      expect(balances.updateBalance).not.toHaveBeenCalled();
    });

    describe("a transfer whose link changed since the run", () => {
      it("refuses, before any write, when the row is linked to another leg", async () => {
        const { manager, em } = harness();
        lockAll(
          [{ id: "t1", status: "UNRECONCILED", linkedTransactionId: "cp9" }],
          [leg("cp1")],
        );
        await expect(
          undoRuleRun(action([converted]), em, balances),
        ).rejects.toMatchObject({
          response: expect.objectContaining({
            errorCode: "RULE_RUN_UNDO_STRUCTURE_CHANGED",
          }),
        });
        expect(manager.delete).not.toHaveBeenCalled();
        expect(manager.update).not.toHaveBeenCalled();
        expect(balances.updateBalance).not.toHaveBeenCalled();
      });

      it("undoes when the row still points at the run's counterpart", async () => {
        const { manager, em } = harness();
        lockAll(
          [{ id: "t1", status: "UNRECONCILED", linkedTransactionId: "cp1" }],
          [leg("cp1")],
        );
        await undoRuleRun(action([converted]), em, balances);
        expect(manager.delete).toHaveBeenCalledWith(Transaction, {
          id: "cp1",
          userId: USER,
        });
      });
    });

    describe("a split", () => {
      const split = {
        id: "t1",
        categoryId: "c-old",
        isTransfer: false,
        isSplit: false,
        linkedTransactionId: null,
        structure: { kind: "split", counterpartIds: ["cp1", "cp2"] },
      };

      it("locks the parent first and its legs in a second call", async () => {
        const { em } = harness();
        lockAll([{ id: "t1" }], [leg("cp1"), leg("cp2")]);
        await undoRuleRun(action([split]), em, balances);

        expect(lockTransactionRows).toHaveBeenNthCalledWith(
          1,
          em,
          ["t1"],
          USER,
        );
        expect(lockTransactionRows).toHaveBeenNthCalledWith(
          2,
          em,
          ["cp1", "cp2"],
          USER,
        );
      });

      it("removes every leg with its own reversal, deletes the lines, and unflags the row", async () => {
        const { manager, em } = harness();
        lockAll(
          [{ id: "t1" }],
          [leg("cp1", { amount: 1200.5 }), leg("cp2", { amount: 10 })],
        );
        await undoRuleRun(action([split]), em, balances);

        expect(balances.updateBalance).toHaveBeenCalledWith(LOAN, -1200.5);
        expect(balances.updateBalance).toHaveBeenCalledWith(LOAN, -10);
        expect(manager.delete).toHaveBeenCalledWith(TransactionSplit, {
          transactionId: "t1",
        });
        expect(manager.update).toHaveBeenCalledWith(
          Transaction,
          { id: "t1", userId: USER },
          {
            categoryId: "c-old",
            isTransfer: false,
            isSplit: false,
            linkedTransactionId: null,
          },
        );
      });

      describe("when the row's structure is no longer the run's", () => {
        const recorded = {
          ...split,
          structure: {
            kind: "split",
            counterpartIds: ["cp1"],
            lineIds: ["l1", "l2"],
          },
        };
        const lines = (
          ...rows: Array<[string, string | null]>
        ): Array<Record<string, unknown>> =>
          rows.map(([id, linked]) => ({
            id,
            transaction_id: "t1",
            linked_transaction_id: linked,
          }));

        it("refuses, before any write, when a line was added or replaced since", async () => {
          const { manager, em } = harness();
          lockAll([{ id: "t1" }], [leg("cp1"), leg("cp9")]);
          // The person replaced the lines: l9 is new and carries its own leg.
          manager.query.mockResolvedValueOnce(
            lines(["l1", "cp1"], ["l9", "cp9"]),
          );

          await expect(
            undoRuleRun(action([recorded]), em, balances),
          ).rejects.toMatchObject({
            response: expect.objectContaining({
              errorCode: "RULE_RUN_UNDO_STRUCTURE_CHANGED",
            }),
          });

          expect(manager.delete).not.toHaveBeenCalled();
          expect(manager.update).not.toHaveBeenCalled();
          expect(balances.updateBalance).not.toHaveBeenCalled();
        });

        it("refuses when the run's lines were replaced by category-only lines (no leg to betray it)", async () => {
          const { manager, em } = harness();
          lockAll([{ id: "t1" }], [leg("cp1")]);
          // l1 (the run's, still linked to cp1) is kept; l2 was replaced by l8,
          // a plain category line the person wrote. Only the recorded line ids
          // can tell: no unrecorded leg is linked.
          manager.query.mockResolvedValueOnce(
            lines(["l1", "cp1"], ["l8", null]),
          );

          await expect(
            undoRuleRun(action([recorded]), em, balances),
          ).rejects.toMatchObject({
            response: expect.objectContaining({
              errorCode: "RULE_RUN_UNDO_STRUCTURE_CHANGED",
            }),
          });

          expect(manager.delete).not.toHaveBeenCalled();
          expect(manager.update).not.toHaveBeenCalled();
          expect(balances.updateBalance).not.toHaveBeenCalled();
        });

        it("refuses when a recorded line now links a leg the run did not create", async () => {
          const { manager, em } = harness();
          lockAll([{ id: "t1" }], [leg("cp1")]);
          manager.query.mockResolvedValueOnce(
            lines(["l1", "cp7"], ["l2", null]),
          );
          await expect(
            undoRuleRun(action([recorded]), em, balances),
          ).rejects.toBeInstanceOf(ConflictException);
          expect(manager.delete).not.toHaveBeenCalled();
        });

        it("undoes normally when the lines are exactly the run's", async () => {
          const { manager, em } = harness();
          lockAll([{ id: "t1" }], [leg("cp1", { amount: 1200.5 })]);
          manager.query.mockResolvedValueOnce(
            lines(["l1", "cp1"], ["l2", null]),
          );
          await undoRuleRun(action([recorded]), em, balances);
          expect(balances.updateBalance).toHaveBeenCalledWith(LOAN, -1200.5);
          expect(manager.delete).toHaveBeenCalledWith(TransactionSplit, {
            transactionId: "t1",
          });
        });

        it("undoes normally when a line the run wrote has since been removed", async () => {
          const { manager, em } = harness();
          lockAll([{ id: "t1" }]);
          manager.query.mockResolvedValueOnce(lines(["l2", null]));
          await undoRuleRun(action([recorded]), em, balances);
          expect(manager.delete).toHaveBeenCalledWith(TransactionSplit, {
            transactionId: "t1",
          });
        });

        it("reads the lines of the user's own rows only", async () => {
          const { manager, em } = harness();
          lockAll([{ id: "t1" }]);
          await undoRuleRun(action([recorded]), em, balances);
          const [sql, args] = manager.query.mock.calls[0];
          expect(sql).toContain("t.user_id = $1");
          expect(args).toEqual([USER, ["t1"]]);
        });
      });

      it("a split with no transfer part has only its lines to remove", async () => {
        const { manager, em } = harness();
        lockAll([{ id: "t1" }]);
        await undoRuleRun(
          action([
            { ...split, structure: { kind: "split", counterpartIds: [] } },
          ]),
          em,
          balances,
        );
        expect(lockTransactionRows).toHaveBeenCalledTimes(1);
        expect(manager.delete).toHaveBeenCalledTimes(1);
        expect(balances.updateBalance).not.toHaveBeenCalled();
      });
    });
  });
});

describe("assertRuleRunRedoable", () => {
  it("lets a run of field changes be redone", () => {
    expect(() =>
      assertRuleRunRedoable(action([{ id: "t1", categoryId: null }])),
    ).not.toThrow();
    expect(() => assertRuleRunRedoable(action(undefined))).not.toThrow();
  });

  it.each(["transfer", "split"])(
    "refuses a run that restructured a row (%s) with RULE_RUN_REDO_STRUCTURAL",
    (kind) => {
      let error: unknown;
      try {
        assertRuleRunRedoable(
          action([
            { id: "t1", categoryId: null },
            { id: "t2", structure: { kind, counterpartIds: [] } },
          ]),
        );
      } catch (e) {
        error = e;
      }
      expect(error).toBeInstanceOf(ConflictException);
      expect((error as ConflictException).getResponse()).toMatchObject({
        errorCode: "RULE_RUN_REDO_STRUCTURAL",
      });
    },
  );
});
