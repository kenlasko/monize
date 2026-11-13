import {
  TransferDestinationFacts,
  TransferDestinationLedger,
  applyBalanceFloor,
  floorFor,
  transferBalanceFloors,
  transferFloorPlan,
} from "./transfer-estimate-floor";

/**
 * The balance floor of an estimated transfer (issue #2164,
 * docs/specs/scheduled-amount-estimate.md section 10).
 */
describe("transfer-estimate-floor", () => {
  /** The card in the issue: the statement closes on the 5th, payment is due on the 26th. */
  const card: TransferDestinationFacts = {
    accountType: "CREDIT_CARD",
    statementSettlementDay: 5,
    statementDueDay: 26,
  };
  /** The history's estimate of every payment: $2000 out of chequing. */
  const BASELINE = -2000;

  /** What the occurrence due on `dueDate` is estimated at, `today`, given the card's ledger. */
  const estimateOn = (
    today: string,
    ledger: TransferDestinationLedger,
    dueDate: string,
    nextOccurrenceDueDate = "2026-11-26",
  ): number => {
    const plan = transferFloorPlan(card, "MONTHLY", today);
    const floors = transferBalanceFloors(
      plan,
      ledger,
      nextOccurrenceDueDate,
      4,
    );
    return applyBalanceFloor(BASELINE, floorFor(floors, dueDate), 2).amount;
  };

  describe("statement mode: the issue's worked example", () => {
    // The Oct 5 statement owed 1000 and was paid on Oct 26.
    const beforeNovemberClose = (balanceToday: number) => ({
      balanceToday,
      balanceAtLastSettlement: -1000,
      creditsSinceLastSettlement: 1000,
    });
    // The Nov 5 statement owed 2700.
    const afterNovemberClose = (balanceToday: number, credits = 0) => ({
      balanceToday,
      balanceAtLastSettlement: -2700,
      creditsSinceLastSettlement: credits,
    });

    it.each([
      // date, balance, Nov 26 bill
      ["2026-10-26", -1200, -2000], // the baseline
      ["2026-10-27", -1500, -2000],
      ["2026-10-30", -1900, -2000],
      ["2026-11-02", -2100, -2100], // the balance passes the baseline
      ["2026-11-04", -2500, -2500],
      ["2026-11-05", -2700, -2700], // the cycle closes at the end of today
    ])(
      "on %s with the card at %d, the Nov 26 payment is %d",
      (today, balance, expected) => {
        expect(
          estimateOn(today, beforeNovemberClose(balance), "2026-11-26"),
        ).toBe(expected);
      },
    );

    it.each([
      // date, balance, credits since Nov 5, Nov 26 bill, Dec 26 bill
      ["2026-11-10", -3000, 0, -2700, -2000], // the new cycle starts at the baseline
      ["2026-11-19", -4800, 0, -2700, -2100], // the balance less the pending payment
      ["2026-11-25", -5000, 0, -2700, -2300],
    ])(
      "on %s with the card at %d, Nov 26 is the closed statement and Dec 26 what lies beyond it",
      (today, balance, credits, november, december) => {
        const ledger = afterNovemberClose(balance, credits);
        expect(estimateOn(today, ledger, "2026-11-26")).toBe(november);
        expect(estimateOn(today, ledger, "2026-12-26", "2026-11-26")).toBe(
          december,
        );
      },
    );

    it.each([
      ["2026-11-26", -2300, -2300], // the bill is paid
      ["2026-11-28", -2500, -2500],
    ])(
      "on %s, once the Nov 5 statement is paid, the Dec 26 payment is the card's balance %d",
      (today, balance, expected) => {
        expect(
          estimateOn(
            today,
            afterNovemberClose(balance, 2700),
            "2026-12-26",
            "2026-12-26",
          ),
        ).toBe(expected);
      },
    );

    it("leaves a payment two cycles out at the baseline", () => {
      expect(
        estimateOn("2026-11-19", afterNovemberClose(-9000), "2027-01-26"),
      ).toBe(BASELINE);
    });

    it("counts a partial payment made outside the schedule against the closed statement", () => {
      // 2700 owed at the close, 1000 paid by hand since: 1700 left, under the baseline.
      expect(
        estimateOn("2026-11-19", afterNovemberClose(-4800, 1000), "2026-11-26"),
      ).toBe(BASELINE);
      // The open cycle is what the card owes beyond those 1700.
      expect(
        estimateOn("2026-11-19", afterNovemberClose(-4800, 1000), "2026-12-26"),
      ).toBe(-3100);
    });

    it("places the cycle by the settlement dates around today", () => {
      expect(transferFloorPlan(card, "MONTHLY", "2026-11-05")).toEqual({
        mode: "statement",
        lastSettlement: "2026-10-05",
        openSettlement: "2026-11-05",
        followingSettlement: "2026-12-05",
      });
      expect(transferFloorPlan(card, "MONTHLY", "2026-11-06")).toEqual({
        mode: "statement",
        lastSettlement: "2026-11-05",
        openSettlement: "2026-12-05",
        followingSettlement: "2027-01-05",
      });
    });

    it("clamps a settlement day past the month's end", () => {
      expect(
        transferFloorPlan(
          { ...card, statementSettlementDay: 31 },
          "MONTHLY",
          "2027-02-10",
        ),
      ).toEqual({
        mode: "statement",
        lastSettlement: "2027-01-31",
        openSettlement: "2027-02-28",
        followingSettlement: "2027-03-31",
      });
    });
  });

  describe("balance mode", () => {
    it.each([
      [
        "no settlement day",
        { ...card, statementSettlementDay: null },
        "MONTHLY",
      ],
      ["no due day", { ...card, statementDueDay: null }, "MONTHLY"],
      [
        "a line of credit",
        { ...card, accountType: "LINE_OF_CREDIT" },
        "MONTHLY",
      ],
      ["a schedule more often than monthly", card, "BIWEEKLY"],
    ] as const)("applies to %s", (_label, facts, frequency) => {
      expect(transferFloorPlan(facts, frequency, "2026-11-10")).toEqual({
        mode: "balance",
      });
    });

    it("applies when the destination is unknown", () => {
      expect(transferFloorPlan(null, "MONTHLY", "2026-11-10")).toEqual({
        mode: "balance",
      });
    });

    it("raises the next occurrence to what the destination owes today, and no later one", () => {
      const floors = transferBalanceFloors(
        { mode: "balance" },
        {
          balanceToday: -2600.5,
          balanceAtLastSettlement: null,
          creditsSinceLastSettlement: 0,
        },
        "2026-11-26",
        4,
      );
      expect(floors).toEqual([
        { after: "2026-11-25", through: "2026-11-26", owed: 2600.5 },
      ]);
      expect(
        applyBalanceFloor(BASELINE, floorFor(floors, "2026-11-26"), 2),
      ).toEqual({ amount: -2600.5, raised: true });
      // Only the next occurrence's own date: a weekly schedule's occurrences
      // before a next occurrence moved later are not each asked for the debt.
      expect(floorFor(floors, "2026-11-19")).toBeNull();
      expect(floorFor(floors, "2026-12-26")).toBeNull();
    });

    it("raises an overdue next occurrence on its own date", () => {
      const floors = transferBalanceFloors(
        { mode: "balance" },
        {
          balanceToday: -2600.5,
          balanceAtLastSettlement: null,
          creditsSinceLastSettlement: 0,
        },
        "2026-10-26",
        4,
      );
      expect(
        applyBalanceFloor(BASELINE, floorFor(floors, "2026-10-26"), 2).amount,
      ).toBe(-2600.5);
    });

    it.each(["LOAN", "MORTGAGE"])(
      "never raises an installment into a %s to its whole debt",
      (accountType) => {
        const plan = transferFloorPlan(
          { ...card, accountType, statementSettlementDay: null },
          "MONTHLY",
          "2026-11-10",
        );
        expect(plan).toEqual({ mode: "none" });
        expect(
          transferBalanceFloors(
            plan,
            {
              balanceToday: -300000,
              balanceAtLastSettlement: null,
              creditsSinceLastSettlement: 0,
            },
            "2026-11-26",
            4,
          ),
        ).toEqual([]);
      },
    );

    it("never raises anything for a destination holding money", () => {
      const floors = transferBalanceFloors(
        { mode: "balance" },
        {
          balanceToday: 5000,
          balanceAtLastSettlement: null,
          creditsSinceLastSettlement: 0,
        },
        "2026-11-26",
        4,
      );
      expect(floors[0].owed).toBe(0);
      expect(
        applyBalanceFloor(BASELINE, floorFor(floors, "2026-11-26"), 2),
      ).toEqual({ amount: BASELINE, raised: false });
    });
  });

  describe("applyBalanceFloor", () => {
    const floor = {
      after: "2026-11-25",
      through: "2026-11-26",
      owed: 2100.456,
    };

    it("keeps the estimate when it is at least the debt", () => {
      expect(applyBalanceFloor(-2500, floor, 2)).toEqual({
        amount: -2500,
        raised: false,
      });
    });

    it("rounds the debt to the entry places and keeps the estimate's sign", () => {
      expect(applyBalanceFloor(-2000, floor, 2)).toEqual({
        amount: -2100.46,
        raised: true,
      });
      expect(applyBalanceFloor(2000, floor, 2)).toEqual({
        amount: 2100.46,
        raised: true,
      });
    });

    it("leaves an occurrence no floor governs alone", () => {
      expect(applyBalanceFloor(-2000, null, 2)).toEqual({
        amount: -2000,
        raised: false,
      });
    });
  });
});
