import { EntityManager, FindOperator } from "typeorm";
import {
  OFX_EXTERNAL_ID_PREFIX,
  isSameBankRow,
  loadHeldExternalIds,
  ofxExternalId,
} from "./ofx-external-id";
import { EXTERNAL_ID_MAX_LENGTH } from "../transactions/transaction-external-id";

describe("ofxExternalId", () => {
  it("prefixes the bank's id", () => {
    expect(ofxExternalId("20260115-0001")).toBe("ofx:20260115-0001");
  });

  it("trims the id, so a download with stray spaces maps to the same key", () => {
    expect(ofxExternalId("  ABC  ")).toBe("ofx:ABC");
  });

  it.each([undefined, null, "", "   "])(
    "gives no key for a row without an id (%p)",
    (fitId) => {
      expect(ofxExternalId(fitId)).toBeNull();
    },
  );

  it("keeps the longest id that fits the column", () => {
    const fitId = "9".repeat(
      EXTERNAL_ID_MAX_LENGTH - OFX_EXTERNAL_ID_PREFIX.length,
    );
    expect(ofxExternalId(fitId)).toHaveLength(EXTERNAL_ID_MAX_LENGTH);
  });

  it("gives no key for an id too long to store, rather than a cut one that could match another row", () => {
    const fitId = "9".repeat(
      EXTERNAL_ID_MAX_LENGTH - OFX_EXTERNAL_ID_PREFIX.length + 1,
    );
    expect(ofxExternalId(fitId)).toBeNull();
  });
});

describe("isSameBankRow", () => {
  const holder = { transactionDate: "2026-01-15", amount: -42.5 };

  it("matches the row on date and amount", () => {
    expect(isSameBankRow(holder, { date: "2026-01-15", amount: -42.5 })).toBe(
      true,
    );
  });

  it("compares a stored numeric string by value", () => {
    const stored = { transactionDate: "2026-01-15", amount: "-42.5000" };
    expect(
      isSameBankRow(stored as unknown as typeof holder, {
        date: "2026-01-15",
        amount: -42.5,
      }),
    ).toBe(true);
  });

  it("tells two coin amounts apart at eight places, not four", () => {
    const coin = { transactionDate: "2026-01-15", amount: "-0.00002500" };
    expect(
      isSameBankRow(coin as unknown as typeof holder, {
        date: "2026-01-15",
        amount: -0.000025,
      }),
    ).toBe(true);
    expect(
      isSameBankRow(coin as unknown as typeof holder, {
        date: "2026-01-15",
        amount: -0.00002501,
      }),
    ).toBe(false);
  });

  it.each([
    ["another date", { date: "2026-01-16", amount: -42.5 }],
    ["another amount", { date: "2026-01-15", amount: -42.51 }],
  ])("does not match a holder edited to %s", (_label, row) => {
    expect(isSameBankRow(holder, row)).toBe(false);
  });
});

describe("loadHeldExternalIds", () => {
  const managerFinding = (
    rows: Array<{
      externalId: string | null;
      transactionDate: string;
      amount: number;
    }>,
  ) => {
    const find = jest.fn().mockResolvedValue(rows);
    return { find, manager: { find } as unknown as EntityManager };
  };
  const keysAsked = (find: jest.Mock): string[][] =>
    find.mock.calls.map(
      ([, options]) =>
        (options.where.externalId as FindOperator<string[]>).value,
    );

  it("asks once for the file's distinct keys and maps each holder by key", async () => {
    const { find, manager } = managerFinding([
      { externalId: "ofx:A", transactionDate: "2026-01-15", amount: -10 },
    ]);

    const held = await loadHeldExternalIds(manager, "acc-1", [
      { fitId: "A" },
      { fitId: " A " },
      { fitId: "B" },
      { fitId: null },
      {},
    ]);

    expect(find).toHaveBeenCalledTimes(1);
    expect(find.mock.calls[0][1].where.accountId).toBe("acc-1");
    expect(keysAsked(find)).toEqual([["ofx:A", "ofx:B"]]);
    expect([...held]).toEqual([
      ["ofx:A", { transactionDate: "2026-01-15", amount: -10 }],
    ]);
  });

  it("does not query for a file with no bank ids", async () => {
    const { find, manager } = managerFinding([]);

    const held = await loadHeldExternalIds(manager, "acc-1", [{}, {}]);

    expect(find).not.toHaveBeenCalled();
    expect(held.size).toBe(0);
  });

  it("splits a long file into lookups of at most 1000 keys", async () => {
    const { find, manager } = managerFinding([]);
    const rows = Array.from({ length: 2001 }, (_, i) => ({ fitId: `F${i}` }));

    await loadHeldExternalIds(manager, "acc-1", rows);

    expect(keysAsked(find).map((keys) => keys.length)).toEqual([1000, 1000, 1]);
  });
});
