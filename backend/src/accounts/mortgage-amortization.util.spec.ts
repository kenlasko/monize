import {
  getMortgagePeriodsPerYear,
  calculateCanadianPeriodicRate,
  calculateStandardPeriodicRate,
  calculatePaymentAmount,
  calculateMortgagePayment,
  calculateEffectiveAnnualRate,
  calculateMortgageAmortization,
  calculateMortgageEndDate,
  calculateResidualPayoff,
  getPeriodicRate,
  MortgagePaymentFrequency,
  MortgageAmortizationInput,
  calculateMortgagePaymentSplit,
  recalculateMortgageAfterRateChange,
} from "./mortgage-amortization.util";
import { MortgageType } from "./mortgage-type.util";

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
      const payment = calculatePaymentAmount(
        300000,
        periodicRate,
        totalPayments,
      );

      // Expected: ~$1,753.77 (standard amortization formula)
      expect(payment).toBeCloseTo(1753.77, 0);
    });

    it("handles 0% interest", () => {
      const payment = calculatePaymentAmount(120000, 0, 300);
      expect(payment).toBe(400);
    });

    it("rounds to 4 decimal places (storage precision)", () => {
      const payment = calculatePaymentAmount(100000, 0.004, 360);
      const rounded = Math.round(payment * 10000) / 10000;
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
      mortgageType: "ANNUITY",
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

    it("uses Canadian semi-annual compounding for CANADIAN_FIXED", () => {
      const canadianPayment = calculateMortgagePayment({
        ...baseInput,
        mortgageType: "CANADIAN_FIXED",
      });

      const standardPayment = calculateMortgagePayment({
        ...baseInput,
        mortgageType: "ANNUITY",
      });

      // Canadian compounding produces a slightly different payment
      expect(canadianPayment).not.toBe(standardPayment);
    });
  });

  describe("calculateEffectiveAnnualRate", () => {
    it("calculates EAR for Canadian fixed (semi-annual compounding)", () => {
      // EAR = (1 + 0.05/2)^2 - 1 = 0.050625 = 5.06%
      const ear = calculateEffectiveAnnualRate(5, 12, "CANADIAN_FIXED");
      expect(ear).toBeCloseTo(5.06, 1);
    });

    it("calculates EAR for a monthly mortgage on the nominal convention", () => {
      // EAR = (1 + 0.05/12)^12 - 1 = ~0.05116 = 5.12%
      const ear = calculateEffectiveAnnualRate(5, 12, "ANNUITY");
      expect(ear).toBeCloseTo(5.12, 1);
    });

    it("compounds at the payment frequency, not always monthly", () => {
      // The periodic rate a biweekly schedule actually charges is 0.05/26
      // twenty-six times, so the EAR it costs over a year is
      // (1 + 0.05/26)^26 - 1 = 5.1245%, not the monthly figure. Independently
      // computed here, not read back from the implementation.
      const biweekly = calculateEffectiveAnnualRate(5, 26, "ANNUITY");
      expect(biweekly).toBeCloseTo(
        Math.round((Math.pow(1 + 0.05 / 26, 26) - 1) * 10000) / 100,
        2,
      );
      const weekly = calculateEffectiveAnnualRate(5, 52, "ANNUITY");
      expect(weekly).toBeCloseTo(
        Math.round((Math.pow(1 + 0.05 / 52, 52) - 1) * 10000) / 100,
        2,
      );
    });

    it("orders the frequencies: more compounding periods cost more", () => {
      // At 5% the three EARs all round to 5.12%, so the ordering is asserted at
      // a rate where two display decimals can separate them.
      expect(calculateEffectiveAnnualRate(12, 12, "ANNUITY")).toBeLessThan(
        calculateEffectiveAnnualRate(12, 26, "ANNUITY"),
      );
      expect(calculateEffectiveAnnualRate(12, 26, "ANNUITY")).toBeLessThan(
        calculateEffectiveAnnualRate(12, 52, "ANNUITY"),
      );
    });

    it("Canadian fixed ignores the payment frequency (semi-annual by law)", () => {
      expect(calculateEffectiveAnnualRate(5, 26, "CANADIAN_FIXED")).toBe(
        calculateEffectiveAnnualRate(5, 12, "CANADIAN_FIXED"),
      );
    });

    it("returns 0 for 0% rate", () => {
      expect(calculateEffectiveAnnualRate(0, 12, "CANADIAN_FIXED")).toBe(0);
      expect(calculateEffectiveAnnualRate(0, 12, "ANNUITY")).toBe(0);
    });

    it("semi-annual compounding EAR is lower than the nominal-monthly EAR", () => {
      const semiAnnual = calculateEffectiveAnnualRate(6, 12, "CANADIAN_FIXED");
      const monthly = calculateEffectiveAnnualRate(6, 12, "ANNUITY");
      expect(semiAnnual).toBeLessThan(monthly);
    });
  });

  describe("periodic-rate convention", () => {
    // The convention is the nominal annual rate divided by the payments per
    // year -- NOT monthly compounding converted to the payment period. These
    // fixtures are derived independently of the implementation so the two
    // candidate contracts cannot be confused for one another, and so agreement
    // with the frontend engine is not the only evidence.
    it("divides the nominal rate by the payment frequency", () => {
      expect(calculateStandardPeriodicRate(6, 12)).toBeCloseTo(0.06 / 12, 12);
      expect(calculateStandardPeriodicRate(6, 26)).toBeCloseTo(0.06 / 26, 12);
      expect(calculateStandardPeriodicRate(6, 52)).toBeCloseTo(0.06 / 52, 12);
    });

    it("is not the monthly-compounded equivalent for non-monthly frequencies", () => {
      const monthlyEquivalentBiweekly = Math.pow(1 + 0.06 / 12, 12 / 26) - 1;
      expect(calculateStandardPeriodicRate(6, 26)).not.toBeCloseTo(
        monthlyEquivalentBiweekly,
        9,
      );
      // Monthly is the one frequency where the two conventions coincide.
      expect(calculateStandardPeriodicRate(6, 12)).toBeCloseTo(
        Math.pow(1 + 0.06 / 12, 12 / 12) - 1,
        12,
      );
    });

    it("the displayed EAR is the one this periodic rate compounds to", () => {
      for (const periodsPerYear of [12, 24, 26, 52]) {
        const periodic = calculateStandardPeriodicRate(6, periodsPerYear);
        const compounded = Math.pow(1 + periodic, periodsPerYear) - 1;
        expect(
          calculateEffectiveAnnualRate(6, periodsPerYear, "ANNUITY"),
        ).toBeCloseTo(Math.round(compounded * 10000) / 100, 2);
      }
    });

    // Spec table 4.1: the periodic rate and EAR each type compounds to,
    // derived here from the formulas rather than read back from the
    // implementation.
    const semiAnnualPeriodic = (rate: number, n: number) =>
      Math.pow(1 + rate / 200, 2 / n) - 1;
    const nominalPeriodic = (rate: number, n: number) => rate / 100 / n;
    const TYPE_CONVENTIONS: [
      MortgageType,
      (rate: number, n: number) => number,
      (rate: number, n: number) => number,
    ][] = [
      [
        "ANNUITY",
        nominalPeriodic,
        (rate, n) => Math.pow(1 + rate / 100 / n, n) - 1,
      ],
      [
        "CANADIAN_FIXED",
        semiAnnualPeriodic,
        (rate) => Math.pow(1 + rate / 200, 2) - 1,
      ],
      [
        "LINEAR",
        nominalPeriodic,
        (rate, n) => Math.pow(1 + rate / 100 / n, n) - 1,
      ],
      [
        "INTEREST_ONLY",
        nominalPeriodic,
        (rate, n) => Math.pow(1 + rate / 100 / n, n) - 1,
      ],
    ];

    it.each(TYPE_CONVENTIONS)(
      "%s: periodic rate and EAR follow its compounding trait",
      (type, periodic, ear) => {
        for (const periodsPerYear of [12, 24, 26, 52]) {
          expect(getPeriodicRate(6, periodsPerYear, type)).toBeCloseTo(
            periodic(6, periodsPerYear),
            15,
          );
          expect(
            calculateEffectiveAnnualRate(6, periodsPerYear, type),
          ).toBeCloseTo(Math.round(ear(6, periodsPerYear) * 10000) / 100, 2);
        }
      },
    );
  });

  describe("calculateMortgageAmortization (integration)", () => {
    it("returns complete amortization result for a standard mortgage", () => {
      const input: MortgageAmortizationInput = {
        principal: 300000,
        annualRate: 5,
        amortizationMonths: 300,
        paymentFrequency: "MONTHLY",
        mortgageType: "ANNUITY",
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
        mortgageType: "ANNUITY",
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
        mortgageType: "ANNUITY",
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
        mortgageType: "ANNUITY",
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
        mortgageType: "ANNUITY",
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
        mortgageType: "ANNUITY",
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
        mortgageType: "ANNUITY",
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
        mortgageType: "CANADIAN_FIXED",
        startDate: new Date(2026, 0, 1),
      };

      const result = calculateMortgageAmortization(input);
      expect(result.paymentAmount).toBeGreaterThan(0);
      expect(result.totalPayments).toBe(300);
      expect(result.effectiveAnnualRate).toBeGreaterThan(0);
    });
  });

  describe("final payment and lifetime interest", () => {
    /**
     * Independent period-by-period payoff at the same periodic rate: the last
     * payment is capped at the balance plus that period's interest. Derived
     * here rather than read back from the implementation, so it can disagree.
     */
    const simulate = (
      principal: number,
      periodicRate: number,
      payment: number,
    ): { payments: number; interest: number; finalPayment: number } => {
      let balance = principal;
      let interest = 0;
      let payments = 0;
      let finalPayment = 0;
      while (balance > 1e-9 && payments < 5000) {
        const periodInterest = balance * periodicRate;
        finalPayment = Math.min(payment, balance + periodInterest);
        balance = balance + periodInterest - finalPayment;
        interest += periodInterest;
        payments++;
      }
      return {
        payments,
        interest: Math.round(interest * 10000) / 10000,
        finalPayment: Math.round(finalPayment * 10000) / 10000,
      };
    };

    it("charges the residual payoff, not a full installment, on the last period", () => {
      // 300k at 5% over 25 years paid accelerated biweekly. The analytic payoff
      // count is 558.35 periods, so the 559th payment is a small remainder --
      // billing it as a full 876.885 installment overstated lifetime interest.
      const input: MortgageAmortizationInput = {
        principal: 300000,
        annualRate: 5,
        amortizationMonths: 300,
        paymentFrequency: "ACCELERATED_BIWEEKLY",
        mortgageType: "ANNUITY",
        startDate: new Date(2026, 0, 1),
      };
      const result = calculateMortgageAmortization(input);
      const expected = simulate(300000, 5 / 100 / 26, result.paymentAmount);

      expect(result.totalPayments).toBe(expected.payments);
      expect(result.residualPayoffAmount).toBeCloseTo(expected.finalPayment, 2);
      expect(result.totalInterest).toBeCloseTo(expected.interest, 2);

      // The final payment is genuinely partial, and the old
      // paymentAmount * totalPayments arithmetic overstated interest by the
      // rest of that installment.
      expect(result.residualPayoffAmount).toBeLessThan(result.paymentAmount);
      const overstatement =
        result.paymentAmount * result.totalPayments -
        300000 -
        result.totalInterest;
      expect(overstatement).toBeCloseTo(
        result.paymentAmount - result.residualPayoffAmount,
        2,
      );
      expect(overstatement).toBeGreaterThan(500);
    });

    it("keeps the standard-frequency total consistent with its own schedule", () => {
      // A standard schedule solves its installment for exactly N payments, so
      // the residual final payment is within a rounding step of the
      // installment -- but it is still the residual, not an assumption.
      const input: MortgageAmortizationInput = {
        principal: 300000,
        annualRate: 5,
        amortizationMonths: 300,
        paymentFrequency: "MONTHLY",
        mortgageType: "ANNUITY",
        startDate: new Date(2026, 0, 1),
      };
      const result = calculateMortgageAmortization(input);
      const expected = simulate(300000, 5 / 100 / 12, result.paymentAmount);

      expect(result.totalPayments).toBe(300);
      expect(result.totalInterest).toBeCloseTo(expected.interest, 2);
      expect(result.residualPayoffAmount).toBeCloseTo(result.paymentAmount, 1);
    });

    it("charges no interest and a plain remainder at 0%", () => {
      const input: MortgageAmortizationInput = {
        principal: 120000,
        annualRate: 0,
        amortizationMonths: 120,
        paymentFrequency: "MONTHLY",
        mortgageType: "ANNUITY",
        startDate: new Date(2026, 0, 1),
      };
      const result = calculateMortgageAmortization(input);
      expect(result.totalInterest).toBe(0);
      expect(result.residualPayoffAmount).toBeCloseTo(1000, 4);
    });

    it("reports unknown totals when the installment never covers the interest", () => {
      // The count is finite here, so the old `isFinite(clearing) ? ... :
      // totalPayments` fallback billed 300 installments against a balance that
      // never falls and reported 1,089,423.31 of "lifetime" interest -- a precise
      // number for a schedule that has no end.
      expect(calculateResidualPayoff(100000, 0.01, 500, 300)).toEqual({
        residualPayoffAmount: -1,
        effectivePayments: -1,
        totalInterest: -1,
      });
      // A zero or negative installment is the same answer.
      expect(calculateResidualPayoff(100000, 0.01, 0, 300)).toEqual({
        residualPayoffAmount: -1,
        effectivePayments: -1,
        totalInterest: -1,
      });
    });

    it("reports unknown totals when the payment count is not finite", () => {
      expect(calculateResidualPayoff(300000, 0.004, 100, Infinity)).toEqual({
        residualPayoffAmount: -1,
        effectivePayments: -1,
        totalInterest: -1,
      });
    });

    it("reports a known zero when nothing is owed", () => {
      // A mortgage already paid off reaches this through
      // recalculateMortgageAfterRateChange; zero owed is known, not unknown.
      expect(calculateResidualPayoff(0, 0.004, 1000, 300)).toEqual({
        residualPayoffAmount: 0,
        effectivePayments: 0,
        totalInterest: 0,
      });
    });

    it("ends the schedule where the installment actually clears it", () => {
      // An installment large enough to clear the balance before the caller's
      // count is a count that is too high, so the schedule ends early: 1000 at
      // 1% paying 600 takes two periods (interest 10 then 4.10), not three.
      // Clamping only the final payment to zero while still billing two full
      // installments reported 200 of interest against a true 14.10.
      const result = calculateResidualPayoff(1000, 0.01, 600, 3);
      expect(result.effectivePayments).toBe(2);
      expect(result.residualPayoffAmount).toBeCloseTo(414.1, 4);
      expect(result.totalInterest).toBeCloseTo(14.1, 4);
      expect(result.residualPayoffAmount).toBeGreaterThan(0);
    });

    it("caps the schedule at the contractual count, absorbing the rounding", () => {
      // The other direction: a solved installment rounded DOWN to storage
      // precision leaves a few cents after the contractual count, so the
      // analytic clearing count is one higher. A 300-month mortgage is still 300
      // payments -- the last one absorbs the remainder, as a lender's does --
      // rather than growing a 301st.
      const result = calculateMortgageAmortization({
        principal: 300000,
        annualRate: 5,
        amortizationMonths: 300,
        paymentFrequency: "MONTHLY",
        mortgageType: "ANNUITY",
        startDate: new Date(2026, 0, 1),
      });
      expect(result.totalPayments).toBe(300);
      expect(result.residualPayoffAmount).toBeGreaterThanOrEqual(
        result.paymentAmount,
      );
      // Within one storage-precision step of the installment, not a period more.
      expect(result.residualPayoffAmount - result.paymentAmount).toBeLessThan(
        1,
      );
    });

    it("dates the payoff from the same count it reports", () => {
      // totalPayments and endDate come from one number, so the date and the
      // totals describe one schedule. startDate is payment 1 (INV-LOAN-005), so
      // N payments advance N-1 months.
      const startDate = new Date(2026, 0, 1);
      const result = calculateMortgageAmortization({
        principal: 300000,
        annualRate: 5,
        amortizationMonths: 300,
        paymentFrequency: "MONTHLY",
        mortgageType: "ANNUITY",
        startDate,
      });
      const expectedEnd = new Date(2026, 0, 1);
      expectedEnd.setMonth(expectedEnd.getMonth() + result.totalPayments - 1);
      expect(result.endDate.getTime()).toBe(expectedEnd.getTime());
    });
  });

  describe("calculateMortgageEndDate", () => {
    const startDate = new Date(2026, 0, 1); // Jan 1, 2026

    // startDate is the FIRST payment (the mortgage form labels it "First
    // Payment Date"), so N payments advance N - 1 intervals.
    it("dates the last of 12 monthly payments in the twelfth month", () => {
      const endDate = calculateMortgageEndDate(startDate, "MONTHLY", 12);
      expect(endDate.getFullYear()).toBe(2026);
      expect(endDate.getMonth()).toBe(11); // December
      expect(endDate.getDate()).toBe(1);
    });

    it("dates a single payment on the first payment date itself", () => {
      const endDate = calculateMortgageEndDate(startDate, "MONTHLY", 1);
      expect(endDate.getTime()).toBe(startDate.getTime());
    });

    it("returns the start date when there are no payments", () => {
      const endDate = calculateMortgageEndDate(startDate, "MONTHLY", 0);
      expect(endDate.getTime()).toBe(startDate.getTime());
    });

    it("adds weeks for WEEKLY frequency", () => {
      const endDate = calculateMortgageEndDate(startDate, "WEEKLY", 52);
      const diffDays = Math.round(
        (endDate.getTime() - startDate.getTime()) / (1000 * 60 * 60 * 24),
      );
      expect(diffDays).toBe(51 * 7);
    });

    it("adds biweekly periods for BIWEEKLY frequency", () => {
      const endDate = calculateMortgageEndDate(startDate, "BIWEEKLY", 26);
      const diffDays = Math.round(
        (endDate.getTime() - startDate.getTime()) / (1000 * 60 * 60 * 24),
      );
      expect(diffDays).toBe(25 * 14);
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
      // Stepped by the recurrence engine that posts the payments: the 15th and
      // the last day of the month, so from 2026-01-01 payment 24 is 2026-12-31.
      // The old 1st/15th calendar answered 2026-12-15, which is BEFORE the final
      // installment -- and that date bounds the linked scheduled transaction.
      expect(endDate.getFullYear()).toBe(2026);
      expect(endDate.getMonth()).toBe(11);
      expect(endDate.getDate()).toBe(31);
    });

    it("returns far future for Infinity payments", () => {
      const endDate = calculateMortgageEndDate(startDate, "MONTHLY", Infinity);
      expect(endDate.getFullYear()).toBeGreaterThanOrEqual(2126);
    });

    it("returns far future for the unknown-schedule sentinel", () => {
      // -1 is what calculateResidualPayoff returns for a schedule it could not
      // work out. Read as "at most one payment" it answered with the start date,
      // giving a precise payoff date to a response whose every other figure says
      // unknown.
      const endDate = calculateMortgageEndDate(startDate, "MONTHLY", -1);
      expect(endDate.getFullYear()).toBeGreaterThanOrEqual(2126);
    });

    it("returns far future for very large payment count (>10000)", () => {
      const endDate = calculateMortgageEndDate(startDate, "MONTHLY", 20000);
      expect(endDate.getFullYear()).toBeGreaterThanOrEqual(2126);
    });
  });
});

describe("calculateMortgageAmortization: LINEAR and INTEREST_ONLY (spec 5.1, table 7.5)", () => {
  // EUR 300,000 over 30 years, monthly from 2024-01-01, 2.00% throughout.
  const input = (
    mortgageType: MortgageType,
    overrides: Partial<MortgageAmortizationInput> = {},
  ): MortgageAmortizationInput => ({
    principal: 300000,
    annualRate: 2,
    amortizationMonths: 360,
    paymentFrequency: "MONTHLY",
    mortgageType,
    startDate: new Date("2024-01-01"),
    ...overrides,
  });

  it("ANNUITY (the reference row) is unchanged", () => {
    const result = calculateMortgageAmortization(input("ANNUITY"));
    expect(result.paymentAmount).toBe(1108.8584);
    expect(result.principalPayment).toBe(608.8584);
    expect(result.interestPayment).toBe(500);
    expect(result.totalPayments).toBe(360);
    expect(Math.round(result.totalInterest * 100) / 100).toBe(99189.03);
    expect(result.residualPayoffAmount).toBe(1108.8673);
    expect(result.endDate.toISOString().slice(0, 10)).toBe("2053-12-01");
  });

  it("LINEAR: first installment 1,333.33 of 360, lifetime interest 90,250.00", () => {
    const result = calculateMortgageAmortization(input("LINEAR"));
    expect(result.paymentAmount).toBe(1333.3333);
    expect(result.principalPayment).toBe(833.3333);
    expect(result.interestPayment).toBe(500);
    expect(result.totalPayments).toBe(360);
    expect(result.totalInterest).toBe(90250);
    // c plus the 0.0120 leftover the last payment absorbs, with its interest.
    expect(result.residualPayoffAmount).toBe(834.7342);
    expect(result.endDate.toISOString().slice(0, 10)).toBe("2053-12-01");
    expect(result.effectiveAnnualRate).toBe(2.02);
  });

  it("INTEREST_ONLY: every installment 500.00, lifetime interest 180,000.00, bullet 300,500.00", () => {
    const result = calculateMortgageAmortization(input("INTEREST_ONLY"));
    expect(result.paymentAmount).toBe(500);
    expect(result.principalPayment).toBe(0);
    expect(result.interestPayment).toBe(500);
    expect(result.totalPayments).toBe(360);
    expect(result.totalInterest).toBe(180000);
    expect(result.residualPayoffAmount).toBe(300500);
    expect(result.endDate.toISOString().slice(0, 10)).toBe("2053-12-01");
  });

  it.each([
    ["LINEAR", "ACCELERATED_BIWEEKLY"],
    ["LINEAR", "ACCELERATED_WEEKLY"],
    ["INTEREST_ONLY", "ACCELERATED_BIWEEKLY"],
    ["INTEREST_ONLY", "ACCELERATED_WEEKLY"],
  ] as const)("%s refuses %s with a 400", (type, frequency) => {
    expect(() =>
      calculateMortgageAmortization(
        input(type, { paymentFrequency: frequency }),
      ),
    ).toThrow(/Accelerated payment frequencies apply only to annuity/);
  });

  it.each(["LINEAR", "INTEREST_ONLY"] as const)(
    "%s refuses a missing amortization with a 400 naming it",
    (type) => {
      expect(() =>
        calculateMortgageAmortization(input(type, { amortizationMonths: 0 })),
      ).toThrow(/requires amortizationMonths/);
    },
  );

  it("LINEAR refuses a zero principal: c would be 0", () => {
    expect(() =>
      calculateMortgageAmortization(input("LINEAR", { principal: 0 })),
    ).toThrow(/requires originalPrincipal/);
  });
});

describe("the annuity-only helpers refuse the other methods", () => {
  it.each(["LINEAR", "INTEREST_ONLY"] as const)(
    "%s is not routed through the annuity re-levelling or split",
    (type) => {
      expect(() =>
        recalculateMortgageAfterRateChange(300000, 4, 324, "MONTHLY", type),
      ).toThrow(/nonAnnuityInstallment/);
      expect(() =>
        calculateMortgagePaymentSplit(300000, 2, 1333.33, 12, type),
      ).toThrow(/nonAnnuityInstallment/);
    },
  );

  it("still prices the annuity types", () => {
    expect(
      calculateMortgagePaymentSplit(300000, 2, 1108.8584, 12, "ANNUITY"),
    ).toEqual({ principal: 608.8584, interest: 500 });
  });
});
