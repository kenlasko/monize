import { EntityManager } from "typeorm";
import {
  applyPayrollDeductionCaps,
  capDeductionLine,
  queryCategoryPeriodPaid,
  remainingRoom,
  resolveExpectedPerPaycheque,
  resolvePayrollDeductionFigures,
} from "./payroll-deduction-cap";

const USER = "11111111-1111-4111-8111-111111111111";
const EI = "22222222-2222-4222-8222-222222222222";
const CPP = "33333333-3333-4333-8333-333333333333";

const eiRule = {
  id: "r1",
  categoryId: EI,
  yearlyMaximum: 1077.48,
  resetDate: "2026-01-01",
  expectedPerPaycheque: null,
};

/** A manager whose one query answers the category sum. */
function managerAnswering(
  answer: (categoryId: string) => { total: string; foreign_rows: string },
): { m: EntityManager; query: jest.Mock } {
  const query = jest.fn(async (_sql: string, params: unknown[]) => [
    answer(String(params[1])),
  ]);
  return { m: { query } as unknown as EntityManager, query };
}

describe("payroll deduction cap", () => {
  /** Spec truth table A. */
  it.each([
    [-300, 1000, -300],
    [-300, 120, -120],
    [-300, 0, 0],
    [-300, -5, 0],
    [250, 0, 250],
  ])("capDeductionLine(%s, %s) is %s", (line, remaining, expected) => {
    expect(capDeductionLine(line, remaining)).toBe(expected);
  });

  it("remainingRoom never goes below zero nor above the maximum", () => {
    expect(remainingRoom(1077.48, 1024)).toBe(53.48);
    expect(remainingRoom(1077.48, 1200)).toBe(0);
    expect(remainingRoom(1077.48, -10)).toBe(1077.48);
    expect(remainingRoom(-5, 0)).toBe(0);
  });

  describe("queryCategoryPeriodPaid", () => {
    it("negates the signed sum and counts foreign rows", async () => {
      const { m, query } = managerAnswering(() => ({
        total: "-1024.0000",
        foreign_rows: "2",
      }));
      await expect(
        queryCategoryPeriodPaid(
          m,
          USER,
          EI,
          { periodStart: "2026-01-01", periodEnd: "2026-12-31" },
          "CAD",
        ),
      ).resolves.toEqual({ paidToDate: 1024, foreignCurrencyRows: 2 });
      expect(query.mock.calls[0][1]).toEqual([
        USER,
        EI,
        "2026-01-01",
        "2026-12-31",
        "CAD",
      ]);
      const sql = String(query.mock.calls[0][0]);
      expect(sql).toContain("t.status <> 'VOID'");
      expect(sql).toContain("t.is_split = false");
      expect(sql).toContain("transaction_splits");
    });

    it("reads an empty period as a known zero", async () => {
      const { m } = managerAnswering(() => ({ total: "0", foreign_rows: "0" }));
      await expect(
        queryCategoryPeriodPaid(
          m,
          USER,
          EI,
          { periodStart: "2026-01-01", periodEnd: "2026-12-31" },
          "CAD",
        ),
      ).resolves.toEqual({ paidToDate: 0, foreignCurrencyRows: 0 });
    });
  });

  describe("applyPayrollDeductionCaps", () => {
    const splits = [
      { splitKind: "category", categoryId: "gross", amount: 2500 },
      { splitKind: "category", categoryId: EI, amount: -64 },
      { splitKind: "category", categoryId: CPP, amount: -150 },
    ];

    it("returns the lines untouched when there is no rule", async () => {
      const { m, query } = managerAnswering(() => ({
        total: "0",
        foreign_rows: "0",
      }));
      const result = await applyPayrollDeductionCaps(
        m,
        USER,
        [],
        "CAD",
        "2026-04-24",
        splits,
      );
      expect(result).toEqual({ splits, changed: false });
      expect(query).not.toHaveBeenCalled();
    });

    it("reduces a ruled line to the room left and leaves the rest (spec section 7)", async () => {
      const { m, query } = managerAnswering(() => ({
        total: "-1024",
        foreign_rows: "0",
      }));
      const result = await applyPayrollDeductionCaps(
        m,
        USER,
        [eiRule],
        "CAD",
        "2026-04-24",
        splits,
      );
      expect(result.changed).toBe(true);
      expect(result.splits).toEqual([
        splits[0],
        { ...splits[1], amount: -53.48 },
        splits[2],
      ]);
      // The period is the one containing the posting date.
      expect(query.mock.calls[0][1].slice(2, 4)).toEqual([
        "2026-01-01",
        "2026-12-31",
      ]);
    });

    it("zeroes the line once the room is spent and reports no change when none is needed", async () => {
      const spent = managerAnswering(() => ({
        total: "-1077.48",
        foreign_rows: "0",
      }));
      const zeroed = await applyPayrollDeductionCaps(
        spent.m,
        USER,
        [eiRule],
        "CAD",
        "2026-05-08",
        splits,
      );
      expect(zeroed.splits[1].amount).toBe(0);

      const early = managerAnswering(() => ({
        total: "-128",
        foreign_rows: "0",
      }));
      const unchanged = await applyPayrollDeductionCaps(
        early.m,
        USER,
        [eiRule],
        "CAD",
        "2026-02-06",
        splits,
      );
      expect(unchanged.changed).toBe(false);
      expect(unchanged.splits[1]).toBe(splits[1]);
    });

    it("shares one category's room across two of its lines and reads the ledger once", async () => {
      const { m, query } = managerAnswering(() => ({
        total: "-1000",
        foreign_rows: "0",
      }));
      const result = await applyPayrollDeductionCaps(
        m,
        USER,
        [eiRule],
        "CAD",
        "2026-04-24",
        [
          { splitKind: "category", categoryId: EI, amount: -50 },
          { splitKind: "category", categoryId: EI, amount: -50 },
        ],
      );
      expect(result.splits.map((s) => s.amount)).toEqual([-50, -27.48]);
      expect(query).toHaveBeenCalledTimes(1);
    });

    it("pools every rule on the category and the lowest room binds (INV-PAYROLL-003)", async () => {
      // Bill A max 4000, bill B max 5000, 4000 paid: no room is left.
      const own = { ...eiRule, yearlyMaximum: 5000 };
      const peer = { ...eiRule, id: "r2", yearlyMaximum: 4000 };
      const { m } = managerAnswering(() => ({
        total: "-4000",
        foreign_rows: "0",
      }));
      const result = await applyPayrollDeductionCaps(
        m,
        USER,
        [own],
        "CAD",
        "2026-04-24",
        [{ splitKind: "category", categoryId: EI, amount: -64 }],
        [peer],
      );
      expect(result.splits[0].amount).toBe(0);
      expect(result.changed).toBe(true);
    });

    it("skips transfer and investment lines that happen to carry the category", async () => {
      const { m, query } = managerAnswering(() => ({
        total: "-1077.48",
        foreign_rows: "0",
      }));
      const result = await applyPayrollDeductionCaps(
        m,
        USER,
        [eiRule],
        "CAD",
        "2026-04-24",
        [
          { splitKind: "transfer", categoryId: EI, amount: -64 },
          {
            splitKind: "category",
            categoryId: EI,
            amount: -64,
            investment: {},
          },
        ],
      );
      expect(result.changed).toBe(false);
      expect(query).not.toHaveBeenCalled();
    });
  });

  describe("resolveExpectedPerPaycheque", () => {
    it("prefers the bill's own negative line over the entered figure", () => {
      expect(
        resolveExpectedPerPaycheque(
          { categoryId: EI, expectedPerPaycheque: 99 },
          [{ categoryId: EI, amount: -64 }],
        ),
      ).toEqual({ expectedPerPaycheque: 64, expectedSource: "line" });
    });

    it("falls back to the entered figure, then to unknown", () => {
      expect(
        resolveExpectedPerPaycheque(
          { categoryId: EI, expectedPerPaycheque: 99 },
          [{ categoryId: EI, amount: 10 }],
        ),
      ).toEqual({ expectedPerPaycheque: 99, expectedSource: "entered" });
      expect(
        resolveExpectedPerPaycheque(
          { categoryId: EI, expectedPerPaycheque: null },
          [],
        ),
      ).toEqual({ expectedPerPaycheque: null, expectedSource: null });
    });
  });

  it("resolvePayrollDeductionFigures combines the period, the ledger and the expected amount", async () => {
    const { m } = managerAnswering(() => ({
      total: "-1024",
      foreign_rows: "1",
    }));
    await expect(
      resolvePayrollDeductionFigures(
        m,
        USER,
        eiRule,
        [{ categoryId: EI, amount: -64 }],
        "CAD",
        "2026-04-10",
      ),
    ).resolves.toEqual({
      periodStart: "2026-01-01",
      periodEnd: "2026-12-31",
      nextResetOn: "2027-01-01",
      paidToDate: 1024,
      remaining: 53.48,
      foreignCurrencyRows: 1,
      currencyCode: "CAD",
      expectedPerPaycheque: 64,
      expectedSource: "line",
    });
  });
});
