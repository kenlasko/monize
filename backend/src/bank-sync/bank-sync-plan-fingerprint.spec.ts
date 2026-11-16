import type { EntityManager } from "typeorm";
import {
  findHeldRows,
  newPlannedRows,
  type HeldLedgerRow,
  planFingerprint,
} from "./bank-sync-plan-fingerprint";
import { NO_BANK_OPERATION } from "./bank-operation";
import type { PlannedBankRow } from "./bank-transaction-planner";

const row = (over: Partial<PlannedBankRow> = {}): PlannedBankRow => ({
  externalKey: "ref:1",
  legacyKeys: null,
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
  describe("possible duplicates", () => {
    it("is what it was when there is no pair", () => {
      expect(planFingerprint([row()], undefined, new Map())).toBe(
        planFingerprint([row()]),
      );
      const review = { cursor: null };
      expect(planFingerprint([row()], review, new Map())).toBe(
        planFingerprint([row()], review),
      );
    });

    it("changes with a pair, and with the transaction the pair names", () => {
      const plain = planFingerprint([row()]);
      const paired = planFingerprint(
        [row()],
        undefined,
        new Map([["ref:1", { id: "tx-1" }]]),
      );
      const other = planFingerprint(
        [row()],
        undefined,
        new Map([["ref:1", { id: "tx-2" }]]),
      );
      expect(paired).not.toBe(plain);
      expect(paired).not.toBe(other);
    });

    it("does not depend on the order of the pairs", () => {
      const rows = [row({ externalKey: "a" }), row({ externalKey: "b" })];
      expect(
        planFingerprint(
          rows,
          undefined,
          new Map([
            ["a", { id: "tx-1" }],
            ["b", { id: "tx-2" }],
          ]),
        ),
      ).toBe(
        planFingerprint(
          rows,
          undefined,
          new Map([
            ["b", { id: "tx-2" }],
            ["a", { id: "tx-1" }],
          ]),
        ),
      );
    });
  });

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
    const held = new Map<string, HeldLedgerRow>([
      ["ref:2", { key: "ref:2", excluded: false }],
    ]);
    expect(newPlannedRows(rows, held).map((r) => r.externalKey)).toEqual([
      "ref:1",
      "ref:3",
    ]);
  });

  it("treats an exception as held, and a row held by a legacy key as held", () => {
    const rows = [
      row({ externalKey: "ref:new|1" }),
      row({ externalKey: "ref:new|2" }),
    ];
    const held = new Map<string, HeldLedgerRow>([
      ["ref:new|1", { key: "ref:old", excluded: true }],
    ]);
    expect(newPlannedRows(rows, held).map((r) => r.externalKey)).toEqual([
      "ref:new|2",
    ]);
  });
});

describe("findHeldRows", () => {
  const query = jest.fn();
  const m = { query } as unknown as EntityManager;
  const legacyRow = (over: Partial<PlannedBankRow> = {}) =>
    row({
      externalKey: "ref:R|2026-09-10|-12.3400:0",
      legacyKeys: { bare: "ref:R", contested: "ref:R#abc" },
      transactionDate: "2026-09-10",
      ...over,
    });

  beforeEach(() => query.mockReset());

  it("holds a row by its own key, and says which key the ledger carries", async () => {
    query.mockResolvedValue([
      {
        external_key: "ref:R|2026-09-10|-12.3400:0",
        booking_date: "2026-09-10",
        excluded: false,
      },
    ]);
    const held = await findHeldRows(m, "user-1", "acc-1", [legacyRow()]);
    expect([...held]).toEqual([
      [
        "ref:R|2026-09-10|-12.3400:0",
        { key: "ref:R|2026-09-10|-12.3400:0", excluded: false },
      ],
    ]);
  });

  it("holds a row by its legacy contested key, whatever the booking date", async () => {
    query.mockResolvedValue([
      {
        external_key: "ref:R#abc",
        booking_date: "2026-01-01",
        excluded: false,
      },
    ]);
    const held = await findHeldRows(m, "user-1", "acc-1", [legacyRow()]);
    expect(held.get("ref:R|2026-09-10|-12.3400:0")).toEqual({
      key: "ref:R#abc",
      excluded: false,
    });
  });

  it("holds a row by its legacy bare key when that row was booked on the row's date", async () => {
    query.mockResolvedValue([
      { external_key: "ref:R", booking_date: "2026-09-10", excluded: false },
    ]);
    const held = await findHeldRows(m, "user-1", "acc-1", [legacyRow()]);
    expect(held.get("ref:R|2026-09-10|-12.3400:0")).toEqual({
      key: "ref:R",
      excluded: false,
    });
  });

  it("does not hold a row by the legacy bare key of another day: it is another transaction", async () => {
    query.mockResolvedValue([
      { external_key: "ref:R", booking_date: "2026-09-01", excluded: false },
    ]);
    const held = await findHeldRows(m, "user-1", "acc-1", [legacyRow()]);
    expect(held.size).toBe(0);
  });

  it("prefers the own key, then the contested key, over the bare key", async () => {
    query.mockResolvedValue([
      { external_key: "ref:R", booking_date: "2026-09-10", excluded: false },
      { external_key: "ref:R#abc", booking_date: "2026-09-10", excluded: true },
    ]);
    const held = await findHeldRows(m, "user-1", "acc-1", [legacyRow()]);
    expect(held.get("ref:R|2026-09-10|-12.3400:0")).toEqual({
      key: "ref:R#abc",
      excluded: true,
    });
  });

  it("passes an exception through as excluded, and a row without the flag is not one", async () => {
    query.mockResolvedValue([
      { external_key: "ref:1", booking_date: "2026-09-10", excluded: true },
      { external_key: "ref:2", booking_date: "2026-09-10", excluded: false },
      { external_key: "ref:3", booking_date: "2026-09-10" },
    ]);
    const held = await findHeldRows(m, "user-1", "acc-1", [
      row({ externalKey: "ref:1" }),
      row({ externalKey: "ref:2" }),
      row({ externalKey: "ref:3" }),
      row({ externalKey: "ref:4" }),
    ]);
    expect([...held]).toEqual([
      ["ref:1", { key: "ref:1", excluded: true }],
      ["ref:2", { key: "ref:2", excluded: false }],
      ["ref:3", { key: "ref:3", excluded: false }],
    ]);
  });

  it("asks once, for every candidate key, filtered by account and user, and reads only", async () => {
    query.mockResolvedValue([]);
    await findHeldRows(m, "user-1", "acc-1", [
      legacyRow(),
      row({ externalKey: "hash:x:0" }),
    ]);
    expect(query).toHaveBeenCalledTimes(1);
    const [sql, params] = query.mock.calls[0];
    expect(String(sql)).toMatch(/^\s*SELECT external_key/);
    expect(String(sql)).toContain("account_id = $1");
    expect(String(sql)).toContain("user_id = $2");
    expect(String(sql)).toContain("excluded_at IS NOT NULL");
    expect(params).toEqual([
      "acc-1",
      "user-1",
      ["ref:R|2026-09-10|-12.3400:0", "ref:R#abc", "ref:R", "hash:x:0"],
    ]);
  });

  it("asks nothing for no planned rows", async () => {
    await expect(findHeldRows(m, "user-1", "acc-1", [])).resolves.toEqual(
      new Map(),
    );
    expect(query).not.toHaveBeenCalled();
  });
});
