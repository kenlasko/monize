import { computeStatementCycle, daysInMonth } from "./statement-cycle.util";

describe("statement-cycle.util", () => {
  describe("daysInMonth", () => {
    it("returns the number of days in a month (0-based month)", () => {
      expect(daysInMonth(2024, 1)).toBe(29); // Feb 2024 (leap)
      expect(daysInMonth(2023, 1)).toBe(28); // Feb 2023
      expect(daysInMonth(2024, 3)).toBe(30); // Apr
      expect(daysInMonth(2024, 0)).toBe(31); // Jan
    });
  });

  describe("computeStatementCycle", () => {
    it("computes the current cycle before the settlement day", () => {
      const c = computeStatementCycle(10, 15, "2024-07-08");
      expect(c).toEqual({
        cycleStart: "2024-06-10",
        cycleEnd: "2024-07-09",
        lastSettlementDate: "2024-06-10",
        nextSettlementDate: "2024-07-10",
        daysUntilSettlement: 2,
        paymentDueDate: "2024-07-15",
        daysUntilPaymentDue: 7,
      });
    });

    it("rolls to next month once past the settlement day", () => {
      const c = computeStatementCycle(10, 5, "2024-07-15");
      expect(c.nextSettlementDate).toBe("2024-08-10");
      expect(c.lastSettlementDate).toBe("2024-07-10");
      expect(c.cycleStart).toBe("2024-07-10");
      expect(c.cycleEnd).toBe("2024-08-09");
      expect(c.daysUntilSettlement).toBe(26);
      // Next due day (5th) has already passed this month -> next month.
      expect(c.paymentDueDate).toBe("2024-08-05");
      expect(c.daysUntilPaymentDue).toBe(21);
    });

    it("treats the settlement day itself as the next settlement (0 days)", () => {
      const c = computeStatementCycle(10, null, "2024-07-10");
      expect(c.nextSettlementDate).toBe("2024-07-10");
      expect(c.lastSettlementDate).toBe("2024-06-10");
      expect(c.cycleStart).toBe("2024-06-10");
      expect(c.cycleEnd).toBe("2024-07-09");
      expect(c.daysUntilSettlement).toBe(0);
    });

    it("returns null payment fields when no due day is set", () => {
      const c = computeStatementCycle(10, null, "2024-07-08");
      expect(c.paymentDueDate).toBeNull();
      expect(c.daysUntilPaymentDue).toBeNull();
    });

    it("clamps a settlement day beyond the month length", () => {
      const c = computeStatementCycle(31, null, "2024-02-15");
      expect(c.nextSettlementDate).toBe("2024-02-29"); // leap year clamps to 29
      expect(c.lastSettlementDate).toBe("2024-01-31");
      expect(c.cycleStart).toBe("2024-01-31");
      expect(c.cycleEnd).toBe("2024-02-28");
      expect(c.daysUntilSettlement).toBe(14);
    });

    it("clamps in a non-leap February", () => {
      const c = computeStatementCycle(31, null, "2023-02-15");
      expect(c.nextSettlementDate).toBe("2023-02-28");
      expect(c.lastSettlementDate).toBe("2023-01-31");
    });

    it("crosses the year boundary", () => {
      const c = computeStatementCycle(10, 25, "2024-12-20");
      expect(c.nextSettlementDate).toBe("2025-01-10");
      expect(c.lastSettlementDate).toBe("2024-12-10");
      expect(c.cycleStart).toBe("2024-12-10");
      expect(c.cycleEnd).toBe("2025-01-09");
      expect(c.daysUntilSettlement).toBe(21);
      expect(c.paymentDueDate).toBe("2024-12-25");
      expect(c.daysUntilPaymentDue).toBe(5);
    });
  });
});
