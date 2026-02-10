import {
  getMortgagePeriodsPerYear,
  calculateCanadianPeriodicRate,
  calculateStandardPeriodicRate,
  calculatePaymentAmount,
  calculateMortgagePayment,
  calculateEffectiveAnnualRate,
  calculateMortgageAmortization,
  calculateMortgageEndDate,
  MortgagePaymentFrequency,
  MortgageAmortizationInput,
} from "./mortgage-amortization.util";

describe("Mortgage Amortization Utility", () => {
  describe("getMortgagePeriodsPerYear", () => {
    it("returns 12 for MONTHLY", () => {
      expect(getMortgagePeriodsPerYear("MONTHLY")).toBe(12);
    });

    it("returns 24 for SEMI_MONTHLY", () => {
      expect(getMortgagePeriodsPerYear("SEMI_MONTHLY")).toBe(24);
    });

    it("returns 26 for BIWEEKLY", () => {
      expect(getMortgagePeriodsPerYear("BIWEEKLY")).toBe(26);
    });

    it("returns 26 for ACCELERATED_BIWEEKLY", () => {
      expect(getMortgagePeriodsPerYear("ACCELERATED_BIWEEKLY")).toBe(26);
    });

    it("returns 52 for WEEKLY", () => {
      expect(getMortgagePeriodsPerYear("WEEKLY")).toBe(52);
    });

    it("returns 52 for ACCELERATED_WEEKLY", () => {
      expect(getMortgagePeriodsPerYear("ACCELERATED_WEEKLY")).toBe(52);
    });

    it("defaults to 12 for unknown frequency", () => {
      expect(
        getMortgagePeriodsPerYear("UNKNOWN" as MortgagePaymentFrequency),
      ).toBe(12);
    });
  });

  describe("calculateCanadianPeriodicRate", () => {
    it("computes semi-annual compounding for monthly payments", () => {
      // 5% annual rate, 12 periods per year
      // Formula: ((1 + 0.05/2)^(2/12)) - 1
      const rate = calculateCanadianPeriodicRate(5, 12);
      const expected = Math.pow(1 + 0.05 / 2, 2 / 12) - 1;
      expect(rate).toBeCloseTo(expected, 10);
    });

    it("computes semi-annual compounding for biweekly payments", () => {
      const rate = calculateCanadianPeriodicRate(5, 26);
      const expected = Math.pow(1 + 0.05 / 2, 2 / 26) - 1;
      expect(rate).toBeCloseTo(expected, 10);
    });

    it("returns 0 for 0% annual rate", () => {
      expect(calculateCanadianPeriodicRate(0, 12)).toBe(0);
    });

    it("produces a rate lower than simple division for common rates", () => {
      // Semi-annual compounding produces a slightly lower effective monthly rate
      // compared to simple annualRate/12
      const canadianRate = calculateCanadianPeriodicRate(6, 12);
      const simpleRate = 6 / 100 / 12;
      expect(canadianRate).toBeLessThan(simpleRate);
    });
  });

  describe("calculateStandardPeriodicRate", () => {
    it("computes monthly compounding rate", () => {
      // 6% annual, 12 periods = 0.005
      expect(calculateStandardPeriodicRate(6, 12)).toBeCloseTo(0.005, 10);
    });

    it("computes biweekly rate", () => {
      // 6% annual, 26 periods
      expect(calculateStandardPeriodicRate(6, 26)).toBeCloseTo(
        6 / 100 / 26,
        10,
      );
    });

    it("returns 0 for 0% annual rate", () => {
      expect(calculateStandardPeriodicRate(0, 12)).toBe(0);
    });
  });

  describe("calculatePaymentAmount", () => {
    it("returns correct payment for a standard mortgage", () => {
      // $300,000 at 5% monthly for 25 years (300 months)
      const periodicRate = 0.05 / 12;
      const totalPayments = 300;
      const payment = calculatePaymentAmount(300000, periodicRate, totalPayments);

      // Expected: ~$1,753.77 (standard amortization formula)
      expect(payment).toBeCloseTo(1753.77, 0);
    });

    it("handles 0% interest", () => {
      const payment = calculatePaymentAmount(120000, 0, 300);
      expect(payment).toBe(400);
    });

    it("rounds to 2 decimal places", () => {
      const payment = calculatePaymentAmount(100000, 0.004, 360);
      const rounded = Math.round(payment * 100) / 100;
      expect(payment).toBe(rounded);
    });

    it("returns principal/totalPayments for zero rate", () => {
      const payment = calculatePaymentAmount(100000, 0, 200);
      expect(payment).toBe(500);
    });
  });

  describe("calculateMortgagePayment", () => {
    const baseInput: MortgageAmortizationInput = {
      principal: 300000,
      annualRate: 5,
      amortizationMonths: 300,
      paymentFrequency: "MONTHLY",
      isCanadian: false,
      isVariableRate: false,
      startDate: new Date(2026, 0, 1),
    };

    it("calculates standard MONTHLY payment", () => {
      const payment = calculateMortgagePayment(baseInput);
      // $300k at 5% for 25 years, monthly
      expect(payment).toBeGreaterThan(1700);
      expect(payment).toBeLessThan(1800);
    });

    it("calculates ACCELERATED_BIWEEKLY as half of monthly payment", () => {
      const monthlyPayment = calculateMortgagePayment({
        ...baseInput,
        paymentFrequency: "MONTHLY",
      });

      const acceleratedBiweeklyPayment = calculateMortgagePayment({
        ...baseInput,
        paymentFrequency: "ACCELERATED_BIWEEKLY",
      });

      // Accelerated biweekly = monthly / 2
      expect(acceleratedBiweeklyPayment).toBeCloseTo(monthlyPayment / 2, 2);
    });

    it("calculates ACCELERATED_WEEKLY as quarter of monthly payment", () => {
      const monthlyPayment = calculateMortgagePayment({
        ...baseInput,
        paymentFrequency: "MONTHLY",
      });

      const acceleratedWeeklyPayment = calculateMortgagePayment({
        ...baseInput,
        paymentFrequency: "ACCELERATED_WEEKLY",
      });

      // Accelerated weekly = monthly / 4
      expect(acceleratedWeeklyPayment).toBeCloseTo(monthlyPayment / 4, 2);
    });

    it("calculates BIWEEKLY (non-accelerated) payment", () => {
      const biweeklyPayment = calculateMortgagePayment({
        ...baseInput,
        paymentFrequency: "BIWEEKLY",
      });

      // Should be roughly half of monthly but calculated on 26 periods/year basis
      expect(biweeklyPayment).toBeGreaterThan(0);
      expect(biweeklyPayment).toBeLessThan(1000);
    });

    it("uses Canadian semi-annual compounding when isCanadian and not variable", () => {
      const canadianPayment = calculateMortgagePayment({
        ...baseInput,
        isCanadian: true,
        isVariableRate: false,
      });

      const standardPayment = calculateMortgagePayment({
        ...baseInput,
        isCanadian: false,
        isVariableRate: false,
      });

      // Canadian compounding produces a slightly different payment
      expect(canadianPayment).not.toBe(standardPayment);
    });
  });

  describe("calculateEffectiveAnnualRate", () => {
    it("calculates EAR for Canadian fixed (semi-annual compounding)", () => {
      // EAR = (1 + 0.05/2)^2 - 1 = 0.050625 = 5.06%
      const ear = calculateEffectiveAnnualRate(5, true, false);
      expect(ear).toBeCloseTo(5.06, 1);
    });

    it("calculates EAR for standard (monthly compounding)", () => {
      // EAR = (1 + 0.05/12)^12 - 1 = ~0.05116 = 5.12%
      const ear = calculateEffectiveAnnualRate(5, false, false);
      expect(ear).toBeCloseTo(5.12, 1);
    });

    it("Canadian variable uses monthly compounding (same as standard)", () => {
      const canadianVariable = calculateEffectiveAnnualRate(5, true, true);
      const standard = calculateEffectiveAnnualRate(5, false, false);
      expect(canadianVariable).toBe(standard);
    });

    it("returns 0 for 0% rate", () => {
      expect(calculateEffectiveAnnualRate(0, true, false)).toBe(0);
      expect(calculateEffectiveAnnualRate(0, false, false)).toBe(0);
    });

    it("semi-annual compounding EAR is lower than monthly compounding EAR", () => {
      const semiAnnual = calculateEffectiveAnnualRate(6, true, false);
      const monthly = calculateEffectiveAnnualRate(6, false, false);
      expect(semiAnnual).toBeLessThan(monthly);
    });
  });

  describe("calculateMortgageAmortization (integration)", () => {
    it("returns complete amortization result for a standard mortgage", () => {
      const input: MortgageAmortizationInput = {
        principal: 300000,
        annualRate: 5,
        amortizationMonths: 300,
        paymentFrequency: "MONTHLY",
        isCanadian: false,
        isVariableRate: false,
        startDate: new Date(2026, 0, 1),
      };

      const result = calculateMortgageAmortization(input);

      expect(result).toHaveProperty("paymentAmount");
      expect(result).toHaveProperty("principalPayment");
      expect(result).toHaveProperty("interestPayment");
      expect(result).toHaveProperty("totalPayments");
      expect(result).toHaveProperty("endDate");
      expect(result).toHaveProperty("totalInterest");
      expect(result).toHaveProperty("effectiveAnnualRate");
    });

    it("first payment split adds up to total payment", () => {
      const input: MortgageAmortizationInput = {
        principal: 300000,
        annualRate: 5,
        amortizationMonths: 300,
        paymentFrequency: "MONTHLY",
        isCanadian: false,
        isVariableRate: false,
        startDate: new Date(2026, 0, 1),
      };

      const result = calculateMortgageAmortization(input);
      const paymentSum = result.principalPayment + result.interestPayment;

      // Due to rounding, allow small tolerance
      expect(paymentSum).toBeCloseTo(result.paymentAmount, 1);
    });

    it("total interest is positive for non-zero rate", () => {
      const input: MortgageAmortizationInput = {
        principal: 300000,
        annualRate: 5,
        amortizationMonths: 300,
        paymentFrequency: "MONTHLY",
        isCanadian: false,
        isVariableRate: false,
        startDate: new Date(2026, 0, 1),
      };

      const result = calculateMortgageAmortization(input);
      expect(result.totalInterest).toBeGreaterThan(0);
    });

    it("total payments matches amortization period for standard frequency", () => {
      const input: MortgageAmortizationInput = {
        principal: 300000,
        annualRate: 5,
        amortizationMonths: 300,
        paymentFrequency: "MONTHLY",
        isCanadian: false,
        isVariableRate: false,
        startDate: new Date(2026, 0, 1),
      };

      const result = calculateMortgageAmortization(input);
      expect(result.totalPayments).toBe(300);
    });

    it("accelerated biweekly results in fewer total months to pay off", () => {
      const baseInput: MortgageAmortizationInput = {
        principal: 300000,
        annualRate: 5,
        amortizationMonths: 300,
        paymentFrequency: "MONTHLY",
        isCanadian: false,
        isVariableRate: false,
        startDate: new Date(2026, 0, 1),
      };

      const standardResult = calculateMortgageAmortization(baseInput);
      const acceleratedResult = calculateMortgageAmortization({
        ...baseInput,
        paymentFrequency: "ACCELERATED_BIWEEKLY",
      });

      // Accelerated biweekly should have less total interest
      expect(acceleratedResult.totalInterest).toBeLessThan(
        standardResult.totalInterest,
      );
    });

    it("handles 0% interest rate", () => {
      const input: MortgageAmortizationInput = {
        principal: 120000,
        annualRate: 0,
        amortizationMonths: 120,
        paymentFrequency: "MONTHLY",
        isCanadian: false,
        isVariableRate: false,
        startDate: new Date(2026, 0, 1),
      };

      const result = calculateMortgageAmortization(input);
      expect(result.paymentAmount).toBe(1000);
      expect(result.totalInterest).toBe(0);
      expect(result.interestPayment).toBe(0);
    });

    it("end date is after start date", () => {
      const startDate = new Date(2026, 0, 1);
      const input: MortgageAmortizationInput = {
        principal: 300000,
        annualRate: 5,
        amortizationMonths: 300,
        paymentFrequency: "MONTHLY",
        isCanadian: false,
        isVariableRate: false,
        startDate,
      };

      const result = calculateMortgageAmortization(input);
      expect(result.endDate.getTime()).toBeGreaterThan(startDate.getTime());
    });

    it("Canadian fixed mortgage produces valid results", () => {
      const input: MortgageAmortizationInput = {
        principal: 400000,
        annualRate: 5.5,
        amortizationMonths: 300,
        paymentFrequency: "MONTHLY",
        isCanadian: true,
        isVariableRate: false,
        startDate: new Date(2026, 0, 1),
      };

      const result = calculateMortgageAmortization(input);
      expect(result.paymentAmount).toBeGreaterThan(0);
      expect(result.totalPayments).toBe(300);
      expect(result.effectiveAnnualRate).toBeGreaterThan(0);
    });
  });

  describe("calculateMortgageEndDate", () => {
    const startDate = new Date(2026, 0, 1); // Jan 1, 2026

    it("adds months for MONTHLY frequency", () => {
      const endDate = calculateMortgageEndDate(startDate, "MONTHLY", 12);
      expect(endDate.getFullYear()).toBe(2027);
      expect(endDate.getMonth()).toBe(0);
    });

    it("adds weeks for WEEKLY frequency", () => {
      const endDate = calculateMortgageEndDate(startDate, "WEEKLY", 52);
      // 52 weeks = ~1 year (364 days)
      const diffDays = Math.round(
        (endDate.getTime() - startDate.getTime()) / (1000 * 60 * 60 * 24),
      );
      expect(diffDays).toBe(52 * 7);
    });

    it("adds biweekly periods for BIWEEKLY frequency", () => {
      const endDate = calculateMortgageEndDate(startDate, "BIWEEKLY", 26);
      // 26 biweekly = 364 days
      const diffDays = Math.round(
        (endDate.getTime() - startDate.getTime()) / (1000 * 60 * 60 * 24),
      );
      expect(diffDays).toBe(26 * 14);
    });

    it("maps ACCELERATED_BIWEEKLY to BIWEEKLY for date calculation", () => {
      const biweeklyEnd = calculateMortgageEndDate(startDate, "BIWEEKLY", 26);
      const accelBiweeklyEnd = calculateMortgageEndDate(
        startDate,
        "ACCELERATED_BIWEEKLY",
        26,
      );
      expect(accelBiweeklyEnd.getTime()).toBe(biweeklyEnd.getTime());
    });

    it("maps ACCELERATED_WEEKLY to WEEKLY for date calculation", () => {
      const weeklyEnd = calculateMortgageEndDate(startDate, "WEEKLY", 52);
      const accelWeeklyEnd = calculateMortgageEndDate(
        startDate,
        "ACCELERATED_WEEKLY",
        52,
      );
      expect(accelWeeklyEnd.getTime()).toBe(weeklyEnd.getTime());
    });

    it("handles SEMI_MONTHLY frequency", () => {
      const endDate = calculateMortgageEndDate(startDate, "SEMI_MONTHLY", 24);
      // 24 semi-monthly payments = 1 year
      expect(endDate.getFullYear()).toBe(2027);
    });

    it("returns far future for Infinity payments", () => {
      const endDate = calculateMortgageEndDate(startDate, "MONTHLY", Infinity);
      expect(endDate.getFullYear()).toBeGreaterThanOrEqual(2126);
    });

    it("returns far future for very large payment count (>10000)", () => {
      const endDate = calculateMortgageEndDate(startDate, "MONTHLY", 20000);
      expect(endDate.getFullYear()).toBeGreaterThanOrEqual(2126);
    });
  });
});
