import {
  getPeriodsPerYear,
  calculatePaymentSplit,
  calculateTotalPayments,
  calculateEndDate,
  calculateAmortization,
  calculatePaymentForTerm,
  PaymentFrequency,
} from "./loan-amortization.util";
import { roundMoney } from "../common/round.util";

describe("Loan Amortization Utility", () => {
  describe("getPeriodsPerYear", () => {
    it("returns 52 for WEEKLY", () => {
      expect(getPeriodsPerYear("WEEKLY")).toBe(52);
    });

    it("returns 26 for BIWEEKLY", () => {
      expect(getPeriodsPerYear("BIWEEKLY")).toBe(26);
    });

    it("returns 12 for MONTHLY", () => {
      expect(getPeriodsPerYear("MONTHLY")).toBe(12);
    });

    it("returns 4 for QUARTERLY", () => {
      expect(getPeriodsPerYear("QUARTERLY")).toBe(4);
    });

    it("returns 1 for YEARLY", () => {
      expect(getPeriodsPerYear("YEARLY")).toBe(1);
    });

    it("defaults to 12 for unknown frequency", () => {
      expect(getPeriodsPerYear("UNKNOWN" as PaymentFrequency)).toBe(12);
    });
  });

  describe("calculatePaymentSplit", () => {
    it("splits payment into principal and interest for standard loan", () => {
      // $100,000 loan at 5% annual, $1,000 monthly payment
      const result = calculatePaymentSplit(100000, 5, 1000, "MONTHLY");
      // Monthly interest: 100000 * (5/100/12) = 416.67
      expect(result.interest).toBeCloseTo(416.67, 2);
      expect(result.principal).toBeCloseTo(583.33, 2);
    });

    it("splits sum to the payment exactly, not payment + 0.0001", () => {
      // interest is 1000.00005 exactly: rounding each line apart drifts
      const result = calculatePaymentSplit(200000.01, 6, 1500, "MONTHLY");
      expect(roundMoney(result.principal + result.interest)).toBe(1500);
    });

    it("returns zero principal when payment is less than interest", () => {
      // $100,000 at 12%, monthly payment of $500 (interest = $1000/month)
      const result = calculatePaymentSplit(100000, 12, 500, "MONTHLY");
      expect(result.principal).toBe(0);
      expect(result.interest).toBe(1000);
    });

    it("handles zero interest rate", () => {
      const result = calculatePaymentSplit(10000, 0, 500, "MONTHLY");
      expect(result.interest).toBe(0);
      expect(result.principal).toBe(500);
    });

    it("caps principal at remaining balance", () => {
      // Balance is $100, payment is $500, zero interest
      const result = calculatePaymentSplit(100, 0, 500, "MONTHLY");
      expect(result.principal).toBe(100);
    });

    it("rounds to 4 decimal places (storage precision)", () => {
      const result = calculatePaymentSplit(10000, 3.333, 500, "MONTHLY");
      expect(result.interest).toBe(Math.round(result.interest * 10000) / 10000);
      expect(result.principal).toBe(
        Math.round(result.principal * 10000) / 10000,
      );
    });

    it("works with biweekly frequency", () => {
      const result = calculatePaymentSplit(100000, 5, 500, "BIWEEKLY");
      // Biweekly rate: 5/100/26 = 0.001923
      const expectedInterest = Math.round(100000 * (5 / 100 / 26) * 100) / 100;
      expect(result.interest).toBeCloseTo(expectedInterest, 2);
    });
  });

  describe("calculateTotalPayments", () => {
    it("calculates correct number of payments for standard loan", () => {
      // $200,000 at 5%, $1,200/month = ~238 payments (~20 years)
      const result = calculateTotalPayments(200000, 5, 1200, "MONTHLY");
      expect(result).toBeGreaterThan(200);
      expect(result).toBeLessThan(300);
    });

    it("handles zero interest rate", () => {
      // $10,000 at 0%, $500/month = 20 payments
      const result = calculateTotalPayments(10000, 0, 500, "MONTHLY");
      expect(result).toBe(20);
    });

    it("returns Infinity when payment does not cover interest", () => {
      // $100,000 at 12%, $500/month (interest = $1000/month)
      const result = calculateTotalPayments(100000, 12, 500, "MONTHLY");
      expect(result).toBe(Infinity);
    });

    it("rounds up to whole number of payments", () => {
      // Should always return integer
      const result = calculateTotalPayments(10000, 5, 500, "MONTHLY");
      expect(Number.isInteger(result)).toBe(true);
    });

    it("calculates correctly for yearly frequency", () => {
      // $10,000 at 0%, $5,000/year = 2 payments
      const result = calculateTotalPayments(10000, 0, 5000, "YEARLY");
      expect(result).toBe(2);
    });
  });

  describe("calculateEndDate", () => {
    const startDate = new Date(2026, 0, 1); // Jan 1, 2026

    // startDate is payment number 1, so N payments advance N - 1 intervals.
    // These assertions are the calendar, counted out by hand: a 12-payment
    // monthly schedule starting 2026-01-01 pays on the 1st of every month of
    // 2026 and is finished, so its final payment is 2026-12-01. Advancing 12
    // intervals named 2027-01-01, a payment date the schedule never reaches.
    it("dates the last of 12 monthly payments in the twelfth month", () => {
      const endDate = calculateEndDate(startDate, "MONTHLY", 12);
      expect(endDate.getFullYear()).toBe(2026);
      expect(endDate.getMonth()).toBe(11); // December
      expect(endDate.getDate()).toBe(1);
    });

    it("dates a single payment on the first payment date itself", () => {
      const endDate = calculateEndDate(startDate, "MONTHLY", 1);
      expect(endDate.getTime()).toBe(startDate.getTime());
    });

    it("adds weeks for WEEKLY frequency", () => {
      const endDate = calculateEndDate(startDate, "WEEKLY", 4);
      // Payments on Jan 1, 8, 15, 22 -- three 7-day advances
      expect(endDate.getDate()).toBe(22);
    });

    it("adds biweekly periods", () => {
      const endDate = calculateEndDate(startDate, "BIWEEKLY", 2);
      // Payments on Jan 1 and Jan 15 -- one 14-day advance
      expect(endDate.getDate()).toBe(15);
    });

    it("adds quarters for QUARTERLY frequency", () => {
      const endDate = calculateEndDate(startDate, "QUARTERLY", 4);
      // Payments on Jan 1, Apr 1, Jul 1, Oct 1 of the same year
      expect(endDate.getFullYear()).toBe(2026);
      expect(endDate.getMonth()).toBe(9); // October
    });

    it("adds years for YEARLY frequency", () => {
      const endDate = calculateEndDate(startDate, "YEARLY", 5);
      // Payments in 2026..2030
      expect(endDate.getFullYear()).toBe(2030);
    });

    it("returns the start date when there are no payments", () => {
      const endDate = calculateEndDate(startDate, "MONTHLY", 0);
      expect(endDate.getTime()).toBe(startDate.getTime());
    });

    it("returns far future for infinite payments", () => {
      const endDate = calculateEndDate(startDate, "MONTHLY", Infinity);
      expect(endDate.getFullYear()).toBeGreaterThanOrEqual(2126);
    });

    it("returns far future for the unknown-schedule sentinel", () => {
      const endDate = calculateEndDate(startDate, "MONTHLY", -1);
      expect(endDate.getFullYear()).toBeGreaterThanOrEqual(2126);
    });

    it("returns far future above the dateable ceiling", () => {
      // The ceiling is 10000, matching calculateMortgageEndDate and
      // createLoanAccount's own guard. It used to be 2500, which sent an
      // ordinary 2600-payment weekly loan to the year-2126 sentinel while the
      // same result reported 2600 payments.
      const endDate = calculateEndDate(startDate, "MONTHLY", 20000);
      expect(endDate.getFullYear()).toBeGreaterThanOrEqual(2126);
    });

    it("dates a long weekly schedule instead of giving up on it", () => {
      // 2600 weekly payments is 50 years -- inside the projection horizon the
      // frontend engine now derives, and well inside the caller's own guard.
      const endDate = calculateEndDate(startDate, "WEEKLY", 2600);
      const days = Math.round(
        (endDate.getTime() - startDate.getTime()) / (1000 * 60 * 60 * 24),
      );
      expect(days).toBe(2599 * 7);
      expect(endDate.getFullYear()).toBeLessThan(2126);
    });
  });

  describe("calculateAmortization", () => {
    it("returns complete amortization details", () => {
      const startDate = new Date(2026, 0, 1);
      const result = calculateAmortization(
        100000,
        5,
        1000,
        "MONTHLY",
        startDate,
      );

      expect(result).toHaveProperty("principalPayment");
      expect(result).toHaveProperty("interestPayment");
      expect(result).toHaveProperty("remainingBalance");
      expect(result).toHaveProperty("totalPayments");
      expect(result).toHaveProperty("endDate");
    });

    it("remaining balance decreases after first payment", () => {
      const startDate = new Date(2026, 0, 1);
      const result = calculateAmortization(
        100000,
        5,
        1000,
        "MONTHLY",
        startDate,
      );

      expect(result.remainingBalance).toBeLessThan(100000);
      expect(result.remainingBalance).toBeGreaterThan(0);
    });

    it("principal + interest equals payment amount for standard case", () => {
      const startDate = new Date(2026, 0, 1);
      const result = calculateAmortization(
        100000,
        5,
        1000,
        "MONTHLY",
        startDate,
      );

      const totalPayment = result.principalPayment + result.interestPayment;
      expect(totalPayment).toBeCloseTo(1000, 1);
    });

    it("returns -1 for totalPayments when loan can never be paid off", () => {
      const startDate = new Date(2026, 0, 1);
      const result = calculateAmortization(
        100000,
        12,
        500,
        "MONTHLY",
        startDate,
      );

      expect(result.totalPayments).toBe(-1);
    });

    it("remaining balance is non-negative", () => {
      const startDate = new Date(2026, 0, 1);
      const result = calculateAmortization(100, 0, 500, "MONTHLY", startDate);

      expect(result.remainingBalance).toBeGreaterThanOrEqual(0);
    });
  });

  describe("calculatePaymentForTerm", () => {
    it("is the inverse of calculateTotalPayments", () => {
      // A payment that clears 200000 in ~180 months at 5% should, fed back in,
      // reproduce ~180 payments.
      const payment = calculatePaymentForTerm(200000, 5, 180, "MONTHLY");
      const periods = calculateTotalPayments(200000, 5, payment, "MONTHLY");
      expect(Math.abs(periods - 180)).toBeLessThanOrEqual(1);
    });

    it("splits the balance evenly at 0% interest", () => {
      expect(calculatePaymentForTerm(12000, 0, 24, "MONTHLY")).toBe(500);
    });

    it("returns 0 for a non-positive balance or term", () => {
      expect(calculatePaymentForTerm(0, 5, 180, "MONTHLY")).toBe(0);
      expect(calculatePaymentForTerm(1000, 5, 0, "MONTHLY")).toBe(0);
    });

    it("rounds to 4 decimal places (storage precision)", () => {
      const result = calculatePaymentForTerm(225400, 5, 300, "MONTHLY");
      expect(result).toBe(Math.round(result * 10000) / 10000);
    });
  });
});
