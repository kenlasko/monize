import {
  getPeriodsPerYear,
  calculatePaymentSplit,
  calculateTotalPayments,
  calculateEndDate,
  calculateAmortization,
  calculateFinalPayment,
  PaymentFrequency,
} from "./loan-amortization.util";

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

    it("rounds to 2 decimal places", () => {
      const result = calculatePaymentSplit(10000, 3.333, 500, "MONTHLY");
      expect(result.interest).toBe(Math.round(result.interest * 100) / 100);
      expect(result.principal).toBe(Math.round(result.principal * 100) / 100);
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

    it("adds months for MONTHLY frequency", () => {
      const endDate = calculateEndDate(startDate, "MONTHLY", 12);
      expect(endDate.getFullYear()).toBe(2027);
      expect(endDate.getMonth()).toBe(0); // January
    });

    it("adds weeks for WEEKLY frequency", () => {
      const endDate = calculateEndDate(startDate, "WEEKLY", 4);
      // 4 weeks = 28 days from Jan 1
      expect(endDate.getDate()).toBe(29); // Jan 29
    });

    it("adds biweekly periods", () => {
      const endDate = calculateEndDate(startDate, "BIWEEKLY", 2);
      // 2 * 14 = 28 days
      expect(endDate.getDate()).toBe(29);
    });

    it("adds quarters for QUARTERLY frequency", () => {
      const endDate = calculateEndDate(startDate, "QUARTERLY", 4);
      // 4 quarters = 1 year
      expect(endDate.getFullYear()).toBe(2027);
    });

    it("adds years for YEARLY frequency", () => {
      const endDate = calculateEndDate(startDate, "YEARLY", 5);
      expect(endDate.getFullYear()).toBe(2031);
    });

    it("returns far future for infinite payments", () => {
      const endDate = calculateEndDate(startDate, "MONTHLY", Infinity);
      expect(endDate.getFullYear()).toBeGreaterThanOrEqual(2126);
    });

    it("returns far future for very large number of payments", () => {
      const endDate = calculateEndDate(startDate, "MONTHLY", 1500);
      expect(endDate.getFullYear()).toBeGreaterThanOrEqual(2126);
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

  describe("calculateFinalPayment", () => {
    it("includes one period of interest", () => {
      // $100 balance at 12% annual, monthly
      const result = calculateFinalPayment(100, 12, "MONTHLY");
      // Interest for one month: 100 * (12/100/12) = 1.00
      expect(result).toBe(101.0);
    });

    it("returns just the balance for zero interest", () => {
      const result = calculateFinalPayment(100, 0, "MONTHLY");
      expect(result).toBe(100.0);
    });

    it("rounds to 2 decimal places", () => {
      const result = calculateFinalPayment(333.33, 7.77, "MONTHLY");
      expect(result).toBe(Math.round(result * 100) / 100);
    });
  });
});
