jest.mock("../transaction-rules/rule-accrual", () => ({
  assertRuleAccrualHistory: async () => [],
  refreshRuleAccrualHistory: async () => undefined,
}));
import { ConflictException } from "@nestjs/common";
import { EntityManager } from "typeorm";
import { lockTransactionRows } from "../common/db/locks";
import { Transaction } from "../transactions/entities/transaction.entity";
import { assertReconciledRowsMutable } from "../transactions/reconciled-lock.util";
import { ActionHistory } from "./entities/action-history.entity";
import { TransactionSplit } from "../transactions/entities/transaction-split.entity";
import { rewindScheduleCursor } from "../scheduled-transactions/schedule-cursor";
import { assertRuleRunRedoable, undoRuleRun } from "./rule-run-undo";

jest.mock("../common/db/locks", () => ({ lockTransactionRows: jest.fn() }));
jest.mock("../scheduled-transactions/schedule-cursor", () => ({
  rewindScheduleCursor: jest.fn(),
}));
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
      expect(moved.affectedAccountIds).toEqual(new Set([LOAN]));
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
      expect(moved.affectedAccountIds.size).toBe(0);
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

/**
 * The undo of a run that settled loan installments
 * (`docs/specs/loan-installment-settlement.md` section 12.6): the schedule
 * rows locked after the transaction rows, the LIFO refusal before any write,
 * the claims released and the cursor advances rewound in reverse run order,
 * and the released schedules returned for the after-commit reprice.
 */
describe("undoRuleRun: settled rows", () => {
  const SCHEDULE = "st-1";
  const cursor = (from: string, to: string) => ({
    before: {
      nextDueDate: from,
      occurrencesRemaining: null,
      isActive: true,
      lastPostedDate: null,
    },
    after: {
      nextDueDate: to,
      occurrencesRemaining: null,
      isActive: true,
      lastPostedDate: "2024-01-03",
    },
    prunedOverrides: [],
  });
  const settled = (
    id: string,
    claimId: string,
    dueDate: string,
    over: Record<string, unknown> = {},
  ) => ({
    id,
    categoryId: null,
    isTransfer: false,
    isSplit: false,
    linkedTransactionId: null,
    structure: {
      kind: "split",
      counterpartIds: [`cp-${id}`],
      lineIds: [`l1-${id}`, `l2-${id}`],
      claimId,
      scheduledTransactionId: SCHEDULE,
      dueDate,
      cursorAdvanced: false,
      ...over,
    },
  });
  const leg = (id: string, linkedTransactionId: string) => ({
    id,
    accountId: "loan",
    amount: 833.33,
    transactionDate: "2024-01-03",
    status: "UNRECONCILED",
    linkedTransactionId,
  });
  type Claim = {
    id: string;
    scheduled_transaction_id: string;
    original_due_date: string;
  };

  /** The manager's statements, by their text, in the order the undo issues them. */
  function arrange(rows: Record<string, unknown>[], claims: Claim[]) {
    const { manager, em } = harness();
    const statements: string[] = [];
    const lockable: Record<string, unknown>[] = [
      ...rows.map((row) => ({ ...row, status: "UNRECONCILED" })),
      ...rows.map((row) => leg(`cp-${row.id as string}`, row.id as string)),
    ];
    (lockTransactionRows as jest.Mock).mockImplementation(
      async (_em: unknown, ids: string[]) =>
        new Map(
          lockable
            .filter((r) => ids.includes(r.id as string))
            .map((r) => [r.id as string, r]),
        ),
    );
    manager.query.mockImplementation(async (sql: string) => {
      const text = String(sql);
      if (
        text.includes("FROM scheduled_transactions") &&
        text.includes("FOR UPDATE")
      ) {
        statements.push("lock-schedules");
        return [];
      }
      if (
        text.includes("FROM scheduled_transaction_postings stp") &&
        text.includes("SELECT")
      ) {
        statements.push("read-claims");
        return claims;
      }
      if (text.includes("DELETE FROM scheduled_transaction_postings")) {
        statements.push("release-claim");
        return [[], 1];
      }
      if (text.includes("FROM transaction_splits")) {
        statements.push("read-lines");
        return rows.flatMap((row) =>
          (row.structure as { lineIds: string[] }).lineIds.map((id, i) => ({
            id,
            transaction_id: row.id,
            linked_transaction_id: i === 0 ? `cp-${row.id as string}` : null,
          })),
        );
      }
      return [];
    });
    (rewindScheduleCursor as jest.Mock).mockImplementation(async () => {
      statements.push("rewind");
      return true;
    });
    manager.delete.mockImplementation(async () => {
      statements.push("delete");
      return { affected: 1 };
    });
    return { manager, em, statements };
  }

  const claimRow = (id: string, due: string): Claim => ({
    id,
    scheduled_transaction_id: SCHEDULE,
    original_due_date: due,
  });

  beforeEach(() => jest.resetAllMocks());

  it("locks the schedule and reads its claims before any write, then releases the claim and rewinds the advance, owner-scoped", async () => {
    const row = settled("t1", "claim-1", "2024-01-01", {
      cursorAdvanced: true,
      cursor: cursor("2024-01-01", "2024-02-01"),
    });
    const { manager, em, statements } = arrange(
      [row],
      [claimRow("claim-1", "2024-01-01")],
    );

    const result = await undoRuleRun(action([row]), em, balances);

    expect(statements.indexOf("lock-schedules")).toBeLessThan(
      statements.indexOf("read-claims"),
    );
    expect(statements.indexOf("read-claims")).toBeLessThan(
      statements.indexOf("delete"),
    );
    const lockSql = manager.query.mock.calls.find(([sql]) =>
      String(sql).includes("FOR UPDATE"),
    );
    expect(lockSql?.[0]).toContain("user_id = $2");
    expect(lockSql?.[1]).toEqual([[SCHEDULE], USER]);
    const release = manager.query.mock.calls.find(([sql]) =>
      String(sql).includes("DELETE FROM scheduled_transaction_postings"),
    );
    expect(release?.[0]).toContain("s.user_id = $2");
    expect(release?.[1]).toEqual(["claim-1", USER]);
    expect(rewindScheduleCursor).toHaveBeenCalledWith(
      em,
      SCHEDULE,
      USER,
      cursor("2024-01-01", "2024-02-01"),
    );
    expect(result.settledScheduleIds).toEqual(new Set([SCHEDULE]));
    expect(result.affectedAccountIds).toEqual(new Set(["loan"]));
  });

  it("releases the claim without a rewind when the claim did not move the cursor", async () => {
    const row = settled("t1", "claim-1", "2023-12-01");
    const { em } = arrange([row], [claimRow("claim-1", "2023-12-01")]);
    await undoRuleRun(action([row]), em, balances);
    expect(rewindScheduleCursor).not.toHaveBeenCalled();
  });

  it("refuses RULE_RUN_UNDO_LATER_SETTLEMENT, before any write, when the schedule holds a later claim the run did not write, whatever its source", async () => {
    const row = settled("t1", "claim-1", "2024-01-01", {
      cursorAdvanced: true,
      cursor: cursor("2024-01-01", "2024-02-01"),
    });
    const { manager, em } = arrange(
      [row],
      [claimRow("claim-1", "2024-01-01"), claimRow("claim-post", "2024-02-01")],
    );

    await expect(
      undoRuleRun(action([row]), em, balances),
    ).rejects.toMatchObject({
      response: expect.objectContaining({
        errorCode: "RULE_RUN_UNDO_LATER_SETTLEMENT",
        scheduledTransactionId: SCHEDULE,
        dueDate: "2024-02-01",
      }),
    });
    // Every claim of the schedule counts: the read filters on no source.
    const read = manager.query.mock.calls.find(([sql]) =>
      String(sql).includes("FROM scheduled_transaction_postings stp"),
    );
    expect(read?.[0]).not.toMatch(/source/);
    expect(manager.delete).not.toHaveBeenCalled();
    expect(manager.update).not.toHaveBeenCalled();
    expect(rewindScheduleCursor).not.toHaveBeenCalled();
    expect(balances.updateBalance).not.toHaveBeenCalled();
    expect(
      manager.query.mock.calls.some(([sql]) =>
        String(sql).includes("DELETE FROM scheduled_transaction_postings"),
      ),
    ).toBe(false);
  });

  it("refuses a foreign claim between two of the run's slots: later than the earliest released, whatever the latest", async () => {
    // The run settled January and March (February's debit never came); a
    // later create settled February on a debt that includes January's
    // principal. Releasing January would leave February's interest priced on
    // a debt that never existed.
    const january = settled("t1", "claim-jan", "2024-01-01", {
      cursorAdvanced: true,
      cursor: cursor("2024-01-01", "2024-02-01"),
    });
    const march = settled("t3", "claim-mar", "2024-03-01");
    const { manager, em } = arrange(
      [january, march],
      [
        claimRow("claim-jan", "2024-01-01"),
        claimRow("claim-feb", "2024-02-01"),
        claimRow("claim-mar", "2024-03-01"),
      ],
    );

    await expect(
      undoRuleRun(action([january, march]), em, balances),
    ).rejects.toMatchObject({
      response: expect.objectContaining({
        errorCode: "RULE_RUN_UNDO_LATER_SETTLEMENT",
        dueDate: "2024-02-01",
      }),
    });
    expect(manager.delete).not.toHaveBeenCalled();
    expect(rewindScheduleCursor).not.toHaveBeenCalled();
  });

  it("does not refuse for a claim on an earlier slot, nor for the later slots the run claimed itself; rewinds in reverse run order", async () => {
    const january = settled("t1", "claim-jan", "2024-01-01", {
      cursorAdvanced: true,
      cursor: cursor("2024-01-01", "2024-02-01"),
    });
    const february = settled("t2", "claim-feb", "2024-02-01", {
      cursorAdvanced: true,
      cursor: cursor("2024-02-01", "2024-03-01"),
    });
    const { manager, em, statements } = arrange(
      [january, february],
      [
        claimRow("claim-dec", "2023-12-01"),
        claimRow("claim-jan", "2024-01-01"),
        claimRow("claim-feb", "2024-02-01"),
      ],
    );

    const result = await undoRuleRun(action([january, february]), em, balances);

    const releases = manager.query.mock.calls
      .filter(([sql]) =>
        String(sql).includes("DELETE FROM scheduled_transaction_postings"),
      )
      .map(([, params]) => (params as string[])[0]);
    expect(releases).toEqual(["claim-feb", "claim-jan"]);
    // Z back to Y, then Y back to X: each advance undone against the cursor
    // the previous rewind left.
    expect(
      (rewindScheduleCursor as jest.Mock).mock.calls.map((c) => c[3]),
    ).toEqual([
      cursor("2024-02-01", "2024-03-01"),
      cursor("2024-01-01", "2024-02-01"),
    ]);
    expect(statements.filter((s) => s === "release-claim")).toHaveLength(2);
    expect(result.settledScheduleIds).toEqual(new Set([SCHEDULE]));
  });

  it("skips a settled row deleted since the run: its claim went with it, and nothing is rewound", async () => {
    const row = settled("t1", "claim-1", "2024-01-01", {
      cursorAdvanced: true,
      cursor: cursor("2024-01-01", "2024-02-01"),
    });
    const { manager, em } = arrange([], [claimRow("claim-1", "2024-01-01")]);
    (lockTransactionRows as jest.Mock).mockResolvedValue(new Map());

    const result = await undoRuleRun(action([row]), em, balances);

    expect(
      manager.query.mock.calls.some(([sql]) =>
        String(sql).includes("DELETE FROM scheduled_transaction_postings"),
      ),
    ).toBe(false);
    expect(rewindScheduleCursor).not.toHaveBeenCalled();
    expect(result.settledScheduleIds.size).toBe(0);
  });

  it("a run without a settled row locks no schedule and reads no claim", async () => {
    const { manager, em } = arrange([], []);
    (lockTransactionRows as jest.Mock).mockResolvedValue(locked("t1"));
    await undoRuleRun(action([{ id: "t1", categoryId: null }]), em, balances);
    expect(
      manager.query.mock.calls.some(([sql]) =>
        String(sql).includes("scheduled_transaction"),
      ),
    ).toBe(false);
  });
});

describe("assertRuleRunRedoable: a settled row", () => {
  it("refuses the redo of a run that settled an installment (its claim and cursor were undone, not replayable)", () => {
    expect(() =>
      assertRuleRunRedoable(
        action([
          {
            id: "t1",
            structure: {
              kind: "split",
              counterpartIds: ["cp"],
              claimId: "claim-1",
              scheduledTransactionId: "st-1",
              dueDate: "2024-01-01",
              cursorAdvanced: true,
            },
          },
        ]),
      ),
    ).toThrow(
      expect.objectContaining({
        response: expect.objectContaining({
          errorCode: "RULE_RUN_REDO_STRUCTURAL",
        }),
      }),
    );
  });
});
