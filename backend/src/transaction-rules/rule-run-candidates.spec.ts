import { EntityManager } from "typeorm";
import { lockTransactionRows } from "../common/db/locks";
import { Transaction } from "../transactions/entities/transaction.entity";
import { effectiveRunLimit, loadCandidateUnits } from "./rule-run-candidates";

jest.mock("../common/db/locks", () => ({ lockTransactionRows: jest.fn() }));

const USER = "user-1";
let counter = 0;
const tx = (over: Partial<Transaction> = {}): Transaction => {
  counter += 1;
  return {
    id: `t${counter}`,
    userId: USER,
    accountId: "acc-a",
    amount: -10,
    isTransfer: false,
    linkedTransactionId: null,
    parentTransactionId: null,
    ...over,
  } as unknown as Transaction;
};

function harness(
  candidates: Transaction[],
  others: Transaction[] = [],
  /** Split transfer lines linking a candidate: `rowId` its linked row. */
  lines: { rowId: string; parentId: string; parentStatus: string }[] = [],
) {
  const qb: Record<string, jest.Mock> = {};
  for (const name of [
    "innerJoin",
    "where",
    "andWhere",
    "orderBy",
    "addOrderBy",
    "take",
  ]) {
    qb[name] = jest.fn().mockReturnValue(qb);
  }
  qb.getMany = jest.fn().mockResolvedValue(candidates);
  const find = jest.fn(
    async (_entity: unknown, opts: { where: { id: { value: string[] } } }) =>
      [...candidates, ...others].filter((row) =>
        opts.where.id.value.includes(row.id),
      ),
  );
  const query = jest.fn(async (sql: string) =>
    sql.includes("FROM transaction_splits")
      ? lines.map(({ rowId, parentId }) => ({ rowId, parentId }))
      : lines.map(({ parentId, parentStatus }) => ({
          id: parentId,
          status: parentStatus,
        })),
  );
  const manager = {
    getRepository: jest.fn(() => ({ createQueryBuilder: () => qb })),
    find,
    query,
  };
  return { qb, find, query, em: manager as unknown as EntityManager };
}

describe("effectiveRunLimit", () => {
  it("defaults to 200 and stays inside 1..1000", () => {
    expect(effectiveRunLimit(undefined)).toBe(200);
    expect(effectiveRunLimit(0)).toBe(1);
    expect(effectiveRunLimit(-5)).toBe(1);
    expect(effectiveRunLimit(2500)).toBe(1000);
    expect(effectiveRunLimit(7.9)).toBe(7);
  });

  it("takes a caller's own ceiling in place of the run's", () => {
    expect(effectiveRunLimit(5000, 5000)).toBe(5000);
    expect(effectiveRunLimit(9000, 5000)).toBe(5000);
    expect(effectiveRunLimit(undefined, 5000)).toBe(200);
  });
});

describe("loadCandidateUnits", () => {
  beforeEach(() => {
    counter = 0;
    jest.resetAllMocks();
  });

  it("scopes to the user, top-level rows and non-investment rows, newest first, one over the limit", async () => {
    const { qb, em } = harness([tx()]);

    await loadCandidateUnits(em, USER, { limit: 5 }, { lock: false });

    expect(qb.where).toHaveBeenCalledWith("transaction.userId = :userId", {
      userId: USER,
    });
    const conditions = qb.andWhere.mock.calls.map((c) => String(c[0]));
    expect(conditions).toContain("transaction.parentTransactionId IS NULL");
    expect(conditions.some((c) => c.includes("investment_transactions"))).toBe(
      true,
    );
    expect(qb.orderBy).toHaveBeenCalledWith(
      "transaction.transactionDate",
      "DESC",
      undefined,
    );
    expect(qb.take).toHaveBeenCalledWith(6);
    expect(lockTransactionRows).not.toHaveBeenCalled();
  });

  it("scans oldest first when asked, every leg of the register order reversed", async () => {
    const { qb, em } = harness([tx()]);

    await loadCandidateUnits(
      em,
      USER,
      { limit: 5 },
      { lock: false, direction: "ASC" },
    );

    expect(qb.orderBy).toHaveBeenCalledWith(
      "transaction.transactionDate",
      "ASC",
      undefined,
    );
    // The register order's own legs, reversed with it (credits still before
    // debits within a moment, as `applyRegisterOrder` keeps them).
    expect(qb.addOrderBy.mock.calls.map((c) => [c[0], c[1]])).toEqual([
      ["transaction.createdAt", "ASC"],
      ["transaction.amount", "DESC"],
      ["transaction.id", "ASC"],
    ]);
    expect(qb.take).toHaveBeenCalledWith(6);
  });

  it("applies the account and date filters as bound parameters", async () => {
    const { qb, em } = harness([]);

    await loadCandidateUnits(
      em,
      USER,
      {
        accountIds: ["a1", "a2"],
        startDate: "2026-01-01",
        endDate: "2026-02-01",
      },
      { lock: false },
    );

    expect(qb.andWhere).toHaveBeenCalledWith(
      "transaction.accountId IN (:...accountIds)",
      { accountIds: ["a1", "a2"] },
    );
    expect(qb.andWhere).toHaveBeenCalledWith(
      "transaction.transactionDate >= :startDate",
      { startDate: "2026-01-01" },
    );
    expect(qb.andWhere).toHaveBeenCalledWith(
      "transaction.transactionDate <= :endDate",
      { endDate: "2026-02-01" },
    );
  });

  it("ignores an empty account list", async () => {
    const { qb, em } = harness([]);
    await loadCandidateUnits(em, USER, { accountIds: [] }, { lock: false });
    expect(
      qb.andWhere.mock.calls.some((c) => String(c[0]).includes("accountIds")),
    ).toBe(false);
  });

  it("drops the row past the limit and says truncated", async () => {
    const { em } = harness([tx(), tx(), tx()]);
    const set = await loadCandidateUnits(
      em,
      USER,
      { limit: 2 },
      { lock: false },
    );
    expect(set.units.map((u) => u.primary.id)).toEqual(["t1", "t2"]);
    expect(set.truncated).toBe(true);
  });

  it("makes a plain row a unit of its own", async () => {
    const { em } = harness([tx()]);
    const { units, truncated } = await loadCandidateUnits(
      em,
      USER,
      {},
      { lock: false },
    );
    expect(truncated).toBe(false);
    expect(units).toHaveLength(1);
    expect(units[0]).toMatchObject({
      isTransfer: false,
      crossOwnerTransferLeg: false,
    });
    expect(units[0].legs).toEqual([units[0].primary]);
  });

  describe("transfers", () => {
    const pair = () => {
      const out = tx({
        id: "out",
        accountId: "checking",
        amount: -100,
        isTransfer: true,
        linkedTransactionId: "in",
      });
      const inn = tx({
        id: "in",
        accountId: "savings",
        amount: 100,
        isTransfer: true,
        linkedTransactionId: "out",
      });
      return { out, inn };
    };

    it("evaluates a pair once, on the outgoing leg, however many legs matched", async () => {
      const { out, inn } = pair();
      const { em } = harness([inn, out]);
      const { units } = await loadCandidateUnits(em, USER, {}, { lock: false });
      expect(units).toHaveLength(1);
      expect(units[0].primary.id).toBe("out");
      expect(units[0].legs.map((l) => l.id)).toEqual(["out", "in"]);
      expect(units[0]).toMatchObject({
        isTransfer: true,
        fromAccountId: "checking",
        toAccountId: "savings",
        crossOwnerTransferLeg: false,
      });
    });

    it("reaches the pair through the leg the filter selected, loading the partner", async () => {
      const { out, inn } = pair();
      const { em, find } = harness([inn], [out]);
      const { units } = await loadCandidateUnits(em, USER, {}, { lock: false });
      expect(find).toHaveBeenCalledTimes(1);
      expect(units).toHaveLength(1);
      expect(units[0].primary.id).toBe("out");
    });

    it("breaks a tie on zero amounts by id so the choice is stable", async () => {
      const a = tx({
        id: "a",
        amount: 0,
        isTransfer: true,
        linkedTransactionId: "b",
      });
      const b = tx({
        id: "b",
        amount: 0,
        isTransfer: true,
        linkedTransactionId: "a",
      });
      const { em } = harness([b, a]);
      const { units } = await loadCandidateUnits(em, USER, {}, { lock: false });
      expect(units).toHaveLength(1);
      expect(units[0].primary.id).toBe("a");
    });

    it("treats a leg whose partner the caller cannot read as a cross-owner leg", async () => {
      const mine = tx({
        id: "mine",
        accountId: "checking",
        amount: 100,
        isTransfer: true,
        linkedTransactionId: "theirs",
      });
      const { em } = harness([mine]);
      const { units } = await loadCandidateUnits(em, USER, {}, { lock: false });
      expect(units).toHaveLength(1);
      expect(units[0]).toMatchObject({
        isTransfer: true,
        crossOwnerTransferLeg: true,
        fromAccountId: null,
        toAccountId: "checking",
      });
      expect(units[0].legs).toHaveLength(1);
    });

    it("names the source account of an outgoing cross-owner leg", async () => {
      const mine = tx({
        id: "mine",
        accountId: "checking",
        amount: -100,
        isTransfer: true,
        linkedTransactionId: null,
      });
      const { em } = harness([mine]);
      const { units } = await loadCandidateUnits(em, USER, {}, { lock: false });
      expect(units[0]).toMatchObject({
        fromAccountId: "checking",
        toAccountId: null,
        crossOwnerTransferLeg: true,
      });
    });

    it("does not pair through a one-way link or a split-transfer counterpart", async () => {
      const oneWay = tx({
        id: "x",
        amount: -5,
        isTransfer: true,
        linkedTransactionId: "y",
      });
      const stranger = tx({
        id: "y",
        amount: 5,
        isTransfer: true,
        linkedTransactionId: "other",
      });
      const withParent = tx({
        id: "p",
        amount: -5,
        isTransfer: true,
        linkedTransactionId: "q",
      });
      const counterpart = tx({
        id: "q",
        amount: 5,
        isTransfer: true,
        linkedTransactionId: "p",
        parentTransactionId: "parent",
      });
      const { em } = harness([oneWay, withParent], [stranger, counterpart]);
      const { units } = await loadCandidateUnits(em, USER, {}, { lock: false });
      expect(units.map((u) => [u.primary.id, u.crossOwnerTransferLeg])).toEqual(
        [
          ["x", true],
          ["p", true],
        ],
      );
    });
  });

  describe("with the lock", () => {
    it("locks every leg once, in one call, and plans on the re-read rows", async () => {
      const first = tx({ id: "r1" });
      const { em, find } = harness([first]);
      // The row moved between the first read and the lock.
      const fresh = { ...first, categoryId: "moved" } as Transaction;
      find.mockResolvedValueOnce([fresh]);

      const { units } = await loadCandidateUnits(em, USER, {}, { lock: true });

      expect(lockTransactionRows).toHaveBeenCalledTimes(1);
      expect(lockTransactionRows).toHaveBeenCalledWith(em, ["r1"], USER);
      expect(units[0].primary).toBe(fresh);
    });

    it("locks a split parent whose transfer line links a candidate before the candidates, and reports its status", async () => {
      // INV-CATEGORY-002: a category written onto the linked row reaches the
      // line, so its parent is locked first (a split parent before its legs).
      const linked = tx({
        id: "linked",
        isTransfer: true,
        linkedTransactionId: "parent",
      });
      const { em } = harness(
        [linked],
        [],
        [{ rowId: "linked", parentId: "parent", parentStatus: "RECONCILED" }],
      );
      const { lineParentStatus } = await loadCandidateUnits(
        em,
        USER,
        {},
        { lock: true },
      );
      expect((lockTransactionRows as jest.Mock).mock.calls).toEqual([
        [em, ["parent"], USER],
        [em, ["linked"], USER],
      ]);
      expect(lineParentStatus?.get("linked")).toBe("RECONCILED");
    });

    it("drops a row deleted before the lock was taken", async () => {
      const { em, find } = harness([tx({ id: "r1" }), tx({ id: "r2" })]);
      find.mockResolvedValueOnce([{ id: "r2" } as Transaction]);
      const { units } = await loadCandidateUnits(em, USER, {}, { lock: true });
      expect(units.map((u) => u.primary.id)).toEqual(["r2"]);
    });

    it("locks both legs of a pair reached through one leg", async () => {
      const out = tx({
        id: "out",
        amount: -1,
        isTransfer: true,
        linkedTransactionId: "in",
      });
      const inn = tx({
        id: "in",
        amount: 1,
        isTransfer: true,
        linkedTransactionId: "out",
      });
      const { em } = harness([inn], [out]);
      const { units } = await loadCandidateUnits(em, USER, {}, { lock: true });
      expect(
        (lockTransactionRows as jest.Mock).mock.calls[0][1].sort(),
      ).toEqual(["in", "out"]);
      expect(units[0].primary.id).toBe("out");
    });
  });
});
