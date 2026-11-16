import type { EntityManager } from "typeorm";
import { TransactionStatus } from "../transactions/entities/transaction.entity";
import {
  allowedDuplicateActions,
  findPossibleDuplicates,
  mergeIntoExisting,
  loadDuplicateCandidates,
  matchPossibleDuplicates,
  mergeMovesDate,
  toDuplicateExistingView,
  type DuplicateCandidate,
} from "./possible-duplicates";

function existing(over: Partial<DuplicateCandidate> = {}): DuplicateCandidate {
  return {
    id: "tx-1",
    transactionDate: "2026-11-10",
    amount: -42.5,
    payeeName: "Hydro",
    categoryName: "Utilities",
    description: null,
    referenceNumber: null,
    status: TransactionStatus.UNRECONCILED,
    isTransfer: false,
    isSplit: false,
    transferAccountName: null,
    externalId: null,
    ...over,
  };
}

describe("matchPossibleDuplicates", () => {
  it.each([0, 1, 2, 3])("pairs the same amount %i day(s) apart", (days) => {
    const date = `2026-11-${String(10 + days).padStart(2, "0")}`;
    const pairs = matchPossibleDuplicates(
      [{ ref: "a", date, amount: -42.5 }],
      [existing()],
    );
    expect(pairs.get("a")?.id).toBe("tx-1");
  });

  it("pairs either side of the existing date", () => {
    const pairs = matchPossibleDuplicates(
      [{ ref: "a", date: "2026-11-07", amount: -42.5 }],
      [existing()],
    );
    expect(pairs.get("a")?.id).toBe("tx-1");
  });

  it("pairs across a month end", () => {
    const pairs = matchPossibleDuplicates(
      [{ ref: "a", date: "2026-12-01", amount: -42.5 }],
      [existing({ transactionDate: "2026-11-29" })],
    );
    expect(pairs.get("a")?.id).toBe("tx-1");
  });

  it.each([
    ["four days apart", "2026-11-14", -42.5],
    ["a cent off", "2026-11-10", -42.51],
    ["the other sign", "2026-11-10", 42.5],
  ])("does not pair %s", (_label, date, amount) => {
    expect(
      matchPossibleDuplicates([{ ref: "a", date, amount }], [existing()]).size,
    ).toBe(0);
  });

  it("compares amounts at the storage scale, not by float spelling", () => {
    const pairs = matchPossibleDuplicates(
      [{ ref: "a", date: "2026-11-10", amount: 0.1 + 0.2 }],
      [existing({ amount: 0.3 })],
    );
    expect(pairs.get("a")?.id).toBe("tx-1");
  });

  it("pairs one to one: the closer date wins, the other row stays new", () => {
    const pairs = matchPossibleDuplicates(
      [
        { ref: "far", date: "2026-11-12", amount: -42.5 },
        { ref: "near", date: "2026-11-11", amount: -42.5 },
      ],
      [existing()],
    );
    expect(pairs.get("near")?.id).toBe("tx-1");
    expect(pairs.has("far")).toBe(false);
  });

  it("breaks a tie by the incoming row's position", () => {
    const pairs = matchPossibleDuplicates(
      [
        { ref: "first", date: "2026-11-11", amount: -42.5 },
        { ref: "second", date: "2026-11-09", amount: -42.5 },
      ],
      [existing()],
    );
    expect(pairs.get("first")?.id).toBe("tx-1");
    expect(pairs.has("second")).toBe(false);
  });

  it("gives each of two equal incoming rows its own existing row", () => {
    const pairs = matchPossibleDuplicates(
      [
        { ref: "a", date: "2026-11-10", amount: -42.5 },
        { ref: "b", date: "2026-11-10", amount: -42.5 },
      ],
      [
        existing({ id: "tx-2", transactionDate: "2026-11-10" }),
        existing({ id: "tx-1", transactionDate: "2026-11-10" }),
      ],
    );
    expect(pairs.get("a")?.id).toBe("tx-1");
    expect(pairs.get("b")?.id).toBe("tx-2");
  });

  it("takes the existing row with the closest date for one incoming row", () => {
    const pairs = matchPossibleDuplicates(
      [{ ref: "a", date: "2026-11-10", amount: -42.5 }],
      [
        existing({ id: "tx-far", transactionDate: "2026-11-07" }),
        existing({ id: "tx-near", transactionDate: "2026-11-11" }),
      ],
    );
    expect(pairs.get("a")?.id).toBe("tx-near");
  });

  it("answers nothing for no incoming rows or no existing rows", () => {
    expect(matchPossibleDuplicates([], [existing()]).size).toBe(0);
    expect(
      matchPossibleDuplicates(
        [{ ref: 1, date: "2026-11-10", amount: -42.5 }],
        [],
      ).size,
    ).toBe(0);
  });
});

describe("allowedDuplicateActions", () => {
  it("offers every action for an ordinary row", () => {
    expect(allowedDuplicateActions(existing())).toEqual([
      "import",
      "merge",
      "keep",
      "replace",
    ]);
  });

  it("offers no merge and no delete for a Reconciled row", () => {
    expect(
      allowedDuplicateActions(
        existing({ status: TransactionStatus.RECONCILED }),
      ),
    ).toEqual(["import", "keep"]);
  });

  it("offers no delete for a transfer leg or a split parent", () => {
    expect(allowedDuplicateActions(existing({ isTransfer: true }))).toEqual([
      "import",
      "merge",
      "keep",
    ]);
    expect(allowedDuplicateActions(existing({ isSplit: true }))).toEqual([
      "import",
      "merge",
      "keep",
    ]);
  });
});

describe("mergeMovesDate", () => {
  it("moves an ordinary row's date, not a transfer leg's or a split parent's", () => {
    expect(mergeMovesDate(existing())).toBe(true);
    expect(mergeMovesDate(existing({ isTransfer: true }))).toBe(false);
    expect(mergeMovesDate(existing({ isSplit: true }))).toBe(false);
  });
});

describe("toDuplicateExistingView", () => {
  it("writes the amount at the given places and leaves out the internals", () => {
    const view = toDuplicateExistingView(existing({ externalId: "ofx:1" }), 4);
    expect(view.amount).toBe("-42.5000");
    expect(view).not.toHaveProperty("externalId");
  });
});

describe("loadDuplicateCandidates", () => {
  function managerAnswering(rows: unknown[]) {
    const query = jest.fn().mockResolvedValue(rows);
    return { m: { query } as unknown as EntityManager, query };
  }

  it("reads the window around the incoming dates and the incoming amounts", async () => {
    const { m, query } = managerAnswering([]);
    await loadDuplicateCandidates(
      m,
      "user-1",
      "acc-1",
      [
        { date: "2026-11-10", amount: -42.5 },
        { date: "2026-11-02", amount: -42.5 },
        { date: "2026-11-05", amount: 100 },
      ],
      { excludeBankSynced: true },
    );
    const [sql, params] = query.mock.calls[0];
    expect(params).toEqual([
      "user-1",
      "acc-1",
      "2026-10-30",
      "2026-11-13",
      ["-42.50000000", "100.00000000"],
      true,
    ]);
    expect(sql).toContain("t.parent_transaction_id IS NULL");
    expect(sql).toContain("<> 'VOID'");
    expect(sql).toContain("investment_transactions");
    expect(sql).toContain("bank_sync_imported_transactions");
  });

  it("reads nothing for no incoming rows", async () => {
    const { m, query } = managerAnswering([]);
    expect(
      await loadDuplicateCandidates(m, "user-1", "acc-1", [], {
        excludeBankSynced: false,
      }),
    ).toEqual([]);
    expect(query).not.toHaveBeenCalled();
  });

  it("maps the raw row, a NULL status as Unreconciled", async () => {
    const { m } = managerAnswering([
      {
        id: "tx-1",
        transaction_date: "2026-11-10",
        amount: "-42.50000000",
        payee_name: "Hydro",
        category_name: null,
        description: "Bill",
        reference_number: "123",
        status: null,
        is_transfer: true,
        is_split: null,
        transfer_account_name: "Visa",
        external_id: null,
      },
    ]);
    const [row] = await loadDuplicateCandidates(
      m,
      "user-1",
      "acc-1",
      [{ date: "2026-11-10", amount: -42.5 }],
      { excludeBankSynced: false },
    );
    expect(row).toEqual(
      existing({
        description: "Bill",
        referenceNumber: "123",
        categoryName: null,
        isTransfer: true,
        transferAccountName: "Visa",
      }),
    );
  });
});

describe("findPossibleDuplicates", () => {
  it("pairs over the rows it read", async () => {
    const query = jest.fn().mockResolvedValue([
      {
        id: "tx-1",
        transaction_date: "2026-11-10",
        amount: "-42.50000000",
        payee_name: null,
        category_name: null,
        description: null,
        reference_number: null,
        status: "CLEARED",
        is_transfer: false,
        is_split: false,
        transfer_account_name: null,
        external_id: null,
      },
    ]);
    const pairs = await findPossibleDuplicates(
      { query } as unknown as EntityManager,
      "user-1",
      "acc-1",
      [{ ref: "k", date: "2026-11-11", amount: -42.5 }],
      { excludeBankSynced: true },
    );
    expect(pairs.get("k")?.id).toBe("tx-1");
  });

  it("reads nothing for no incoming rows", async () => {
    const query = jest.fn();
    const pairs = await findPossibleDuplicates(
      { query } as unknown as EntityManager,
      "user-1",
      "acc-1",
      [],
      { excludeBankSynced: true },
    );
    expect(pairs.size).toBe(0);
    expect(query).not.toHaveBeenCalled();
  });
});

describe("mergeIntoExisting", () => {
  it("takes the incoming date, reference, Cleared and an external id, in one UPDATE", async () => {
    const query = jest.fn().mockResolvedValue([]);
    await mergeIntoExisting(
      { query } as unknown as EntityManager,
      "user-1",
      existing({ isTransfer: true }),
      { date: "2026-11-12", referenceNumber: "77", externalId: "ofx:A" },
    );
    const [sql, params] = query.mock.calls[0];
    expect(sql).toContain("COALESCE($5, reference_number)");
    expect(sql).toContain("COALESCE(external_id, $7)");
    expect(params).toEqual([
      "tx-1",
      "user-1",
      false,
      "2026-11-12",
      "77",
      TransactionStatus.CLEARED,
      "ofx:A",
    ]);
  });
});
