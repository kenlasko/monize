import type { EntityManager } from "typeorm";
import {
  findLedgerEntries,
  findLedgerKeys,
  newPlannedRows,
  planFingerprint,
} from "./bank-sync-plan-fingerprint";
import { NO_BANK_OPERATION } from "./bank-operation";
import type { PlannedBankRow } from "./bank-transaction-planner";

const row = (over: Partial<PlannedBankRow> = {}): PlannedBankRow => ({
  externalKey: "ref:1",
  transactionDate: "2026-09-10",
  amount: -12.34,
  payeeText: null,
  description: null,
  referenceNumber: null,
  direction: "debit",
  operation: { ...NO_BANK_OPERATION },
  ...over,
});

describe("planFingerprint", () => {
  it("is a SHA-256 hex digest", () => {
    expect(planFingerprint([row()])).toMatch(/^[0-9a-f]{64}$/);
  });

  it("does not depend on the order the rows arrived in: it is over the keys in key order", () => {
    const a = row({ externalKey: "ref:a", amount: 1 });
    const b = row({ externalKey: "ref:b", amount: 2 });
    const c = row({ externalKey: "hash:c:0", amount: 3 });
    expect(planFingerprint([a, b, c])).toBe(planFingerprint([c, b, a]));
  });

  it("changes when a key changes", () => {
    expect(planFingerprint([row({ externalKey: "ref:1" })])).not.toBe(
      planFingerprint([row({ externalKey: "ref:2" })]),
    );
  });

  it("changes when an amount changes, at the column's four decimals", () => {
    expect(planFingerprint([row({ amount: -12.34 })])).not.toBe(
      planFingerprint([row({ amount: -12.3401 })]),
    );
  });

  it("is blind to a float's spelling of the same amount", () => {
    expect(planFingerprint([row({ amount: 0.1 + 0.2 })])).toBe(
      planFingerprint([row({ amount: 0.3 })]),
    );
  });

  it("changes when a row is added or removed, and an empty plan has a fingerprint of its own", () => {
    const one = planFingerprint([row()]);
    expect(planFingerprint([row(), row({ externalKey: "ref:2" })])).not.toBe(
      one,
    );
    expect(planFingerprint([])).not.toBe(one);
    expect(planFingerprint([])).toMatch(/^[0-9a-f]{64}$/);
  });

  it("cannot be forged by moving text between the key and the amount", () => {
    expect(
      planFingerprint([row({ externalKey: "ref:1", amount: 5 })]),
    ).not.toBe(planFingerprint([row({ externalKey: "ref:15", amount: 0 })]));
  });

  it("ignores everything but the key and the amount", () => {
    expect(
      planFingerprint([row({ payeeText: "A", transactionDate: "2026-01-01" })]),
    ).toBe(planFingerprint([row({ payeeText: "B" })]));
  });
});

describe("newPlannedRows", () => {
  it("keeps the rows whose key the ledger does not hold, in order", () => {
    const rows = [
      row({ externalKey: "ref:1" }),
      row({ externalKey: "ref:2" }),
      row({ externalKey: "ref:3" }),
    ];
    expect(
      newPlannedRows(rows, new Set(["ref:2"])).map((r) => r.externalKey),
    ).toEqual(["ref:1", "ref:3"]);
  });
});

describe("findLedgerKeys", () => {
  const query = jest.fn();
  const m = { query } as unknown as EntityManager;

  beforeEach(() => query.mockReset());

  it("asks for the account's keys among the given ones, filtered by user, and reads only", async () => {
    query.mockResolvedValue([{ external_key: "ref:2" }]);
    const found = await findLedgerKeys(m, "user-1", "acc-1", [
      "ref:1",
      "ref:2",
    ]);
    expect(found).toEqual(new Set(["ref:2"]));
    const [sql, params] = query.mock.calls[0];
    expect(String(sql)).toMatch(/^\s*SELECT/);
    expect(String(sql)).toContain("account_id = $1");
    expect(String(sql)).toContain("user_id = $2");
    expect(params).toEqual(["acc-1", "user-1", ["ref:1", "ref:2"]]);
  });

  it("asks nothing for no keys", async () => {
    await expect(findLedgerKeys(m, "user-1", "acc-1", [])).resolves.toEqual(
      new Set(),
    );
    expect(query).not.toHaveBeenCalled();
  });
});

describe("findLedgerEntries (spec section 7b)", () => {
  const query = jest.fn();
  const m = { query } as unknown as EntityManager;

  beforeEach(() => query.mockReset());

  it("tells an exception from an imported row, and reads only", async () => {
    query.mockResolvedValue([
      { external_key: "ref:1", excluded: false },
      { external_key: "ref:2", excluded: true },
      // A row the driver answers without the flag is not an exception.
      { external_key: "ref:3" },
    ]);
    const found = await findLedgerEntries(m, "user-1", "acc-1", [
      "ref:1",
      "ref:2",
      "ref:3",
    ]);
    expect([...found]).toEqual([
      ["ref:1", { excluded: false }],
      ["ref:2", { excluded: true }],
      ["ref:3", { excluded: false }],
    ]);
    const [sql, params] = query.mock.calls[0];
    expect(String(sql)).toMatch(/^\s*SELECT external_key/);
    expect(String(sql)).toContain("excluded_at IS NOT NULL");
    expect(params).toEqual(["acc-1", "user-1", ["ref:1", "ref:2", "ref:3"]]);
  });

  it("holds an exception as a key like any other, so it is never a new row", async () => {
    query.mockResolvedValue([{ external_key: "ref:2", excluded: true }]);
    await expect(
      findLedgerKeys(m, "user-1", "acc-1", ["ref:1", "ref:2"]),
    ).resolves.toEqual(new Set(["ref:2"]));
  });

  it("asks nothing for no keys", async () => {
    await expect(findLedgerEntries(m, "user-1", "acc-1", [])).resolves.toEqual(
      new Map(),
    );
    expect(query).not.toHaveBeenCalled();
  });
});
