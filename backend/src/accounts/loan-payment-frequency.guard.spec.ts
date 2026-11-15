import { readFileSync } from "fs";
import { join } from "path";
import {
  PaymentFrequency,
  SCHEDULED_FREQUENCY_BY_PAYMENT_FREQUENCY,
  calculateEndDate,
  getPeriodsPerYear,
} from "./loan-amortization.util";
import {
  MORTGAGE_PAYMENT_FREQUENCIES,
  PAYMENT_FREQUENCIES,
} from "./dto/create-account.dto";
import {
  calculateMortgageAmortization,
  getMortgagePeriodsPerYear,
  toMortgagePaymentFrequency,
} from "./mortgage-amortization.util";
import { formatDateYMD } from "../common/date-utils";
import { calculateNextDueDate } from "../common/recurrence";
import { paymentsToClear } from "./amortization-count.util";

/**
 * `SetupLoanPaymentsDto.paymentFrequency` is a validated string that
 * `LoanPaymentSetupService` casts straight into `calculatePaymentSplit`, so the
 * DTO's accepted set and `getPeriodsPerYear`'s cases are one contract with a
 * cast in the middle. When they drifted, `getPeriodsPerYear` fell through to its
 * `default: 12` and a `SEMIMONTHLY` loan's interest split came out at twice the
 * correct rate -- silently, because a default is not an error.
 *
 * A cast cannot be type-checked, so this is the scan that checks it. It reads
 * the `@IsIn` list out of the DTO source rather than trusting a copy here.
 */
function acceptedFrequencies(): string[] {
  const source = readFileSync(
    join(__dirname, "dto", "setup-loan-payments.dto.ts"),
    "utf8",
  );
  const match = source.match(/@IsIn\(\[([^\]]*)\]\)\s*\n\s*paymentFrequency:/);
  if (!match) {
    throw new Error(
      "setup-loan-payments.dto.ts no longer declares paymentFrequency with an @IsIn list; " +
        "update this guard to read whatever validates it now",
    );
  }
  return [...match[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
}

describe("loan payment frequency contract", () => {
  it("keeps the account DTO's list and the util's union equal", () => {
    // LoanPaymentSetupService writes dto.paymentFrequency onto
    // accounts.payment_frequency, and UpdateAccountDto / LoanPreviewDto validate
    // that column's value against PAYMENT_FREQUENCIES. When the two lists
    // diverged, an account the app itself created could not be saved again: the
    // util accepted SEMIMONTHLY, the DTO answered 400.
    expect([...PAYMENT_FREQUENCIES].sort()).toEqual(
      [...acceptedFrequencies()].sort(),
    );
  });

  it("schedules every accepted frequency at a recurrence the engine knows", () => {
    // The endDate and the scheduled transaction are derived from this table, and
    // a value the recurrence engine does not recognize makes
    // calculateNextDueDate return the same date forever.
    for (const frequency of acceptedFrequencies()) {
      const recurrence = SCHEDULED_FREQUENCY_BY_PAYMENT_FREQUENCY[frequency];
      expect(recurrence).toBeDefined();
      // A real step, not the pass-through default.
      expect(calculateNextDueDate("2026-01-01", recurrence)).not.toBe(
        "2026-01-01",
      );
    }
  });

  it("covers the mortgage spellings in the same table", () => {
    // Mortgage callers reach the same service carrying mortgage-domain names.
    for (const frequency of MORTGAGE_PAYMENT_FREQUENCIES) {
      const recurrence = SCHEDULED_FREQUENCY_BY_PAYMENT_FREQUENCY[frequency];
      expect(recurrence).toBeDefined();
      expect(calculateNextDueDate("2026-01-01", recurrence)).not.toBe(
        "2026-01-01",
      );
    }
  });

  it("dates the payoff on the same calendar the scheduler will follow", () => {
    // endDate's whole job is to bound the linked scheduled transaction, so it
    // must be a date the scheduler reaches. A hand-rolled semi-monthly step
    // (1st, 15th, 1st...) against the engine's (15th, last day of month...) put
    // the final installment past its own endDate, and 23 of 24 payments posted.
    for (const frequency of acceptedFrequencies()) {
      const recurrence = SCHEDULED_FREQUENCY_BY_PAYMENT_FREQUENCY[frequency];
      let expected = "2026-01-01";
      for (let i = 0; i < 23; i++) {
        expected = calculateNextDueDate(expected, recurrence);
      }
      // A calendar date is a UTC-midnight Date in and out, as every caller
      // builds and reads one (`advancePaymentDates`); a local-midnight start
      // read back with local getters is a day early west of Greenwich.
      const endDate = calculateEndDate(
        new Date("2026-01-01"),
        frequency as PaymentFrequency,
        24,
      );
      expect(formatDateYMD(endDate)).toBe(expected);
    }
  });

  it("refuses a cadence the mortgage helpers cannot express", () => {
    // Casting the DTO's spelling into MortgagePaymentFrequency handed
    // getMortgagePeriodsPerYear values it has no case for, and its default of 12
    // split a semi-monthly Canadian mortgage at twice the correct interest.
    expect(toMortgagePaymentFrequency("SEMIMONTHLY")).toBe("SEMI_MONTHLY");
    expect(toMortgagePaymentFrequency("MONTHLY")).toBe("MONTHLY");
    expect(toMortgagePaymentFrequency("ACCELERATED_BIWEEKLY")).toBe(
      "ACCELERATED_BIWEEKLY",
    );
    // A mortgage in this model has no quarterly or yearly cadence, so the
    // caller must refuse rather than compute a confident wrong split.
    expect(toMortgagePaymentFrequency("QUARTERLY")).toBeNull();
    expect(toMortgagePaymentFrequency("YEARLY")).toBeNull();
    expect(toMortgagePaymentFrequency("NONSENSE")).toBeNull();

    // Every mortgage-expressible frequency has a real period count -- no
    // fall-through to the monthly default.
    const expected: Record<string, number> = {
      MONTHLY: 12,
      SEMI_MONTHLY: 24,
      BIWEEKLY: 26,
      ACCELERATED_BIWEEKLY: 26,
      WEEKLY: 52,
      ACCELERATED_WEEKLY: 52,
    };
    for (const frequency of acceptedFrequencies()) {
      const mortgageFrequency = toMortgagePaymentFrequency(frequency);
      if (!mortgageFrequency) continue;
      expect(getMortgagePeriodsPerYear(mortgageFrequency)).toBe(
        expected[mortgageFrequency],
      );
    }
  });

  it("reads a non-empty accepted set out of the DTO", () => {
    const accepted = acceptedFrequencies();
    expect(accepted.length).toBeGreaterThan(0);
    expect(accepted).toContain("MONTHLY");
  });

  it("gives every DTO-accepted frequency its own period count", () => {
    // A frequency that misses every case silently becomes monthly. Each one is
    // asserted against its own expected count rather than merely "not 12", so a
    // wrong case is caught as well as a missing one.
    const expected: Record<string, number> = {
      WEEKLY: 52,
      BIWEEKLY: 26,
      SEMIMONTHLY: 24,
      MONTHLY: 12,
      QUARTERLY: 4,
      YEARLY: 1,
    };
    for (const frequency of acceptedFrequencies()) {
      expect(expected[frequency]).toBeDefined();
      expect(getPeriodsPerYear(frequency as PaymentFrequency)).toBe(
        expected[frequency],
      );
    }
  });

  it("dates every DTO-accepted frequency, rather than standing still", () => {
    // calculateEndDate's switch had no SEMIMONTHLY case and no default, so that
    // value advanced the date zero times: a 240-payment schedule was dated on
    // its first payment date, and createLoanAccount wrote that onto the linked
    // scheduled transaction's endDate -- which stops the schedule after payment
    // one. Every accepted frequency must move the date.
    const start = new Date("2026-01-01");
    for (const frequency of acceptedFrequencies()) {
      const end = calculateEndDate(start, frequency as PaymentFrequency, 24);
      expect(end.getTime()).toBeGreaterThan(start.getTime());
    }
  });

  it("dates a semi-monthly schedule the way the scheduler steps it", () => {
    // The recurrence engine's semi-monthly convention is the 15th and the last
    // day of the month, not the 1st and the 15th: from 2026-01-01 it steps
    // 01-31, 02-15, 02-28, 03-15, ... so payment 24 falls on 2026-12-31. The
    // amortization helper used to step 1st/15th and answer 2026-12-15 -- before
    // the final installment, so the schedule it bounds posted 23 of 24.
    const end = calculateEndDate(new Date("2026-01-01"), "SEMIMONTHLY", 24);
    expect(formatDateYMD(end)).toBe("2026-12-31");
  });

  it("splits a semi-monthly payment at half a month's interest, not a month's", () => {
    // The defect, stated as money: 100k at 6% semi-monthly accrues 250 per
    // period (6% / 24), not the 500 the monthly fall-through charged.
    const periodsPerYear = getPeriodsPerYear("SEMIMONTHLY");
    expect((100000 * 6) / 100 / periodsPerYear).toBeCloseTo(250, 6);
  });
});

describe("payment-frequency module has no import cycle", () => {
  /**
   * `SCHEDULED_FREQUENCY_BY_PAYMENT_FREQUENCY` is a module-level spread of the
   * two per-domain tables. While those lived in the two amortization utils, the
   * utils imported each other, and under a mortgage-first load order the spread
   * ran before the mortgage module finished initialising: the merged table came
   * out with only the loan keys, so an ACCELERATED_BIWEEKLY mortgage fell to the
   * `?? "MONTHLY"` default and its scheduled transaction was created monthly.
   *
   * A completeness assertion in the same process cannot see that -- by then
   * everything is loaded. The load order has to be exercised, so the tables are
   * required in the hostile order in a fresh registry.
   */
  const inFreshRegistry = (first: string, second: string): string[] => {
    const resolve = (m: string) => require.resolve(m);
    for (const key of Object.keys(require.cache)) {
      if (key.includes("/accounts/") || key.includes("/common/recurrence")) {
        delete require.cache[key];
      }
    }
    /* eslint-disable @typescript-eslint/no-require-imports */
    require(resolve(first));
    const loaded = require(resolve(second));
    const frequencyModule = require(resolve("./payment-frequency.util"));
    const merged = frequencyModule.SCHEDULED_FREQUENCY_BY_PAYMENT_FREQUENCY;
    /* eslint-enable @typescript-eslint/no-require-imports */
    expect(loaded).toBeTruthy();
    return Object.keys(merged);
  };

  const EXPECTED = [
    "WEEKLY",
    "BIWEEKLY",
    "SEMIMONTHLY",
    "MONTHLY",
    "QUARTERLY",
    "YEARLY",
    "SEMI_MONTHLY",
    "ACCELERATED_BIWEEKLY",
    "ACCELERATED_WEEKLY",
  ];

  it("builds the whole merged table with the mortgage util loaded first", () => {
    expect(
      inFreshRegistry(
        "./mortgage-amortization.util",
        "./loan-amortization.util",
      ).sort(),
    ).toEqual([...EXPECTED].sort());
  });

  it("builds the whole merged table with the loan util loaded first", () => {
    expect(
      inFreshRegistry(
        "./loan-amortization.util",
        "./mortgage-amortization.util",
      ).sort(),
    ).toEqual([...EXPECTED].sort());
  });
});

describe("paymentsToClear", () => {
  it("solves the annuity count", () => {
    // 100k at 6% nominal monthly paying 1000: independently
    // n = -ln(1 - 100000*0.005/1000) / ln(1.005) = 138.98 -> 139
    expect(paymentsToClear(100000, 0.005, 1000)).toBe(139);
  });

  it("divides evenly at a 0% rate", () => {
    expect(paymentsToClear(10000, 0, 5000)).toBe(2);
    // A remainder still needs its own period.
    expect(paymentsToClear(10001, 0, 5000)).toBe(3);
  });

  it("is Infinity when the payment never covers the interest", () => {
    // Exactly the interest is not enough either: the balance never falls.
    expect(paymentsToClear(100000, 0.005, 500)).toBe(Infinity);
    expect(paymentsToClear(100000, 0.005, 499)).toBe(Infinity);
    expect(paymentsToClear(100000, 0.005, 0)).toBe(Infinity);
    expect(paymentsToClear(100000, 0.005, -50)).toBe(Infinity);
  });

  it("needs no payments for nothing owed", () => {
    expect(paymentsToClear(0, 0.005, 1000)).toBe(0);
  });

  it("needs no payments for nothing owed even at a zero installment", () => {
    // Settled is decided BEFORE the installment is looked at. The other order
    // answered Infinity here -- "never amortizes" for a debt that is already
    // repaid -- and calculateMortgageAmortization then reported totalPayments:
    // -1 with a year-2126 payoff date on the same response as
    // residualPayoffAmount: 0, so one schedule was unknowable and known-zero at
    // once. Zero needs no rate, and it needs no payment either.
    expect(paymentsToClear(0, 0.005, 0)).toBe(0);
    expect(paymentsToClear(-25, 0.005, 0)).toBe(0);
    expect(paymentsToClear(0, 0, 0)).toBe(0);
  });

  it("answers one schedule, not two, for a repaid mortgage", () => {
    // The end-to-end shape of the same defect: nothing outstanding, so the
    // count, the payoff date and the residual all describe a settled loan.
    const result = calculateMortgageAmortization({
      principal: 0,
      annualRate: 5,
      amortizationMonths: 300,
      paymentFrequency: "ACCELERATED_BIWEEKLY",
      mortgageType: "ANNUITY",
      startDate: new Date("2026-01-15"),
    });
    expect(result.totalPayments).toBe(0);
    expect(result.residualPayoffAmount).toBe(0);
    expect(result.totalInterest).toBe(0);
    // Not the far-future sentinel: a settled debt is paid off today, not in 2126.
    expect(formatDateYMD(result.endDate)).toBe("2026-01-15");
  });
});
