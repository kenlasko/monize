import { FrequencyType } from "../../../scheduled-transactions/dto/create-scheduled-transaction.dto";
import { MappedLoans } from "../../mny/model/mny-import-model";
import {
  rawAccount,
  rawFile,
  rawSchedule,
} from "../__fixtures__/kmy-raw-builders";
import { harness } from "./kmy-map.harness";
import { readKmyLoanTerms, withKmyLoanTerms } from "./kmy-loan-terms";

/** Spec 5.11: a KMyMoney loan's stated terms. */

type Kvp = Record<string, string>;

function read(
  kvp: Kvp,
  extra: {
    type?: number;
    schedules?: ReturnType<typeof rawSchedule>[];
    currency?: string;
    coinDecimals?: ReadonlyMap<string, number>;
  } = {},
) {
  const raw = rawFile({
    accounts: [
      rawAccount({
        id: "LOAN",
        name: "House",
        type: extra.type ?? 5,
        currency: extra.currency,
        kvp,
      }),
    ],
    schedules: extra.schedules ?? [],
  });
  const coinDecimals = extra.coinDecimals ?? new Map<string, number>();
  const { mapping } = harness(raw, { coinDecimals });
  return readKmyLoanTerms({ raw, mapping, coinDecimals });
}

function schedule(occurrence: number, multiplier = 1) {
  return rawSchedule({ id: "SCH9", type: 5, occurrence, multiplier });
}

const warned = (result: ReturnType<typeof read>) =>
  result.warnings.map((w) => [w.code, w.subject, w.detail]);

describe("readKmyLoanTerms", () => {
  it("reads the spec 5.11 example", () => {
    const result = read(
      {
        "ir-2023-01-01": "3/1",
        "ir-2024-01-01": "9/2",
        "ir-2024-06-01": "9/2",
        "loan-amount": "250000/1",
        term: "300",
        schedule: "SCH9",
      },
      { schedules: [schedule(32)] },
    );

    expect(result.warnings).toEqual([]);
    expect(result.terms).toEqual([
      {
        accountKey: "acct-6",
        rates: [
          { effectiveDate: "2023-01-01", annualRate: 3 },
          { effectiveDate: "2024-01-01", annualRate: 4.5 },
        ],
        originalPrincipal: 250000,
        amortizationMonths: 300,
      },
    ]);
  });

  describe("rates", () => {
    it("orders by date, keeps a rate that returns to an earlier value, and rounds to 4 places", () => {
      const result = read({
        "ir-2024-01-01": "9/2",
        "ir-2022-05-01": "1/3",
        "ir-2023-01-01": "3/1",
        "ir-2025-01-01": "1/3",
      });

      expect(result.terms[0].rates).toEqual([
        { effectiveDate: "2022-05-01", annualRate: 0.3333 },
        { effectiveDate: "2023-01-01", annualRate: 3 },
        { effectiveDate: "2024-01-01", annualRate: 4.5 },
        { effectiveDate: "2025-01-01", annualRate: 0.3333 },
      ]);
    });

    it("ignores keys that are not a calendar date", () => {
      const result = read({
        "ir-2023-02-30": "3/1",
        "ir-bad": "3/1",
        "ir-2023-01-01x": "3/1",
        "ir-2024-01-01": "4/1",
      });

      expect(result.terms[0].rates).toEqual([
        { effectiveDate: "2024-01-01", annualRate: 4 },
      ]);
      expect(result.warnings).toEqual([]);
    });

    it("leaves out and names a value that does not parse or lies outside 0 to 100", () => {
      const result = read({
        "ir-2023-01-01": "x",
        "ir-2023-06-01": "-1/1",
        "ir-2023-09-01": "101/1",
        "ir-2024-01-01": "0/1",
        "ir-2024-06-01": "100/1",
      });

      expect(result.terms[0].rates).toEqual([
        { effectiveDate: "2024-01-01", annualRate: 0 },
        { effectiveDate: "2024-06-01", annualRate: 100 },
      ]);
      expect(warned(result)).toEqual([
        ["loanInterestRateNotImported", "House", "x"],
        ["loanInterestRateNotImported", "House", "-1/1"],
        ["loanInterestRateNotImported", "House", "101/1"],
      ]);
    });
  });

  describe("original amount", () => {
    it("takes the absolute value at the account currency's places", () => {
      expect(read({ "loan-amount": "-1234567/100" }).terms[0]).toMatchObject({
        originalPrincipal: 12345.67,
      });
    });

    it("reads zero as no amount, without a warning", () => {
      const result = read({ "loan-amount": "0/1" });
      expect(result.terms).toEqual([]);
      expect(result.warnings).toEqual([]);
    });

    it.each(["abc", "1000000000000/1"])(
      "names an amount it cannot import (%s)",
      (text) => {
        const result = read({ "loan-amount": text });
        expect(result.terms).toEqual([]);
        expect(warned(result)).toEqual([
          ["loanTermsNotImported", "House", `loan-amount=${text}`],
        ]);
      },
    );
  });

  describe("term to amortization months", () => {
    it.each([
      ["monthly", 32, 1, "300", 300],
      ["every three months", 32, 3, "100", 300],
      ["yearly", 16384, 1, "25", 300],
      ["every two weeks", 4, 2, "650", 300],
      ["weekly", 4, 1, "1300", 300],
      ["twice a month", 18, 1, "600", 300],
      ["legacy fortnightly (code 8)", 8, 1, "650", 300],
      ["weekly, not a whole number of months", 4, 1, "100", 23],
    ])(
      "converts a %s schedule",
      (_label, occurrence, multiplier, term, months) => {
        const result = read(
          { term, schedule: "SCH9" },
          { schedules: [schedule(occurrence, multiplier)] },
        );
        expect(result.warnings).toEqual([]);
        expect(result.terms[0].amortizationMonths).toBe(months);
      },
    );

    it.each([
      ["a daily schedule", { term: "300", schedule: "SCH9" }, [schedule(2)]],
      ["a once schedule", { term: "300", schedule: "SCH9" }, [schedule(1)]],
      [
        "an unknown occurrence",
        { term: "300", schedule: "SCH9" },
        [schedule(77)],
      ],
      ["no schedule KVP", { term: "300" }, [schedule(32)]],
      ["a schedule the file lacks", { term: "300", schedule: "SCH404" }, []],
      [
        "a term that is not an integer",
        { term: "12.5", schedule: "SCH9" },
        [schedule(32)],
      ],
      ["a zero term", { term: "0", schedule: "SCH9" }, [schedule(32)]],
      [
        "a term past 1,200 months",
        { term: "1201", schedule: "SCH9" },
        [schedule(32)],
      ],
    ])("names the term for %s", (_label, kvp, schedules) => {
      const result = read(kvp, { schedules });
      expect(result.terms).toEqual([]);
      expect(warned(result)).toEqual([
        ["loanTermsNotImported", "House", `term=${kvp.term}`],
      ]);
    });

    it("accepts exactly 1,200 months", () => {
      const result = read(
        { term: "1200", schedule: "SCH9" },
        { schedules: [schedule(32)] },
      );
      expect(result.terms[0].amortizationMonths).toBe(1200);
    });
  });

  it.each([
    ["an asset loan", 14],
    ["a generic liability", 10],
  ])("reads no terms from %s", (_label, type) => {
    const result = read(
      { "ir-2024-01-01": "9/2", "loan-amount": "1000/1", term: "12" },
      { type },
    );
    expect(result.terms).toEqual([]);
  });

  it("reads no terms from a loan in a coin, which imports as a crypto account", () => {
    const result = read(
      { "ir-2024-01-01": "9/2" },
      { currency: "BTC", coinDecimals: new Map([["BTC", 8]]) },
    );
    expect(result.terms).toEqual([]);
  });

  it("returns no entry for a loan that states nothing", () => {
    expect(read({}).terms).toEqual([]);
  });
});

describe("withKmyLoanTerms", () => {
  const inferred: MappedLoans = {
    loans: [
      {
        accountKey: "acct-7",
        interestCategoryHandle: 3,
        interestBookingMode: "SPLIT",
        sourceAccountKey: "acct-6",
        paymentAmount: 500,
        paymentFrequency: FrequencyType.MONTHLY,
        paymentStartDate: "2024-02-01",
        paymentsObserved: 4,
      },
    ],
    warnings: [{ code: "loanInterestCategoryUnclear", subject: "X" }],
  };

  it("adds the stated terms to an inferred loan and a new entry for a loan with none", () => {
    const merged = withKmyLoanTerms(inferred, [
      {
        accountKey: "acct-7",
        rates: [{ effectiveDate: "2023-01-01", annualRate: 3 }],
        originalPrincipal: 1000,
        amortizationMonths: 12,
      },
      {
        accountKey: "acct-8",
        rates: [],
        originalPrincipal: 2000,
        amortizationMonths: null,
      },
    ]);

    expect(merged.warnings).toBe(inferred.warnings);
    expect(merged.loans).toEqual([
      {
        ...inferred.loans[0],
        rates: [{ effectiveDate: "2023-01-01", annualRate: 3 }],
        originalPrincipal: 1000,
        amortizationMonths: 12,
      },
      {
        accountKey: "acct-8",
        interestCategoryHandle: null,
        interestBookingMode: null,
        sourceAccountKey: null,
        paymentAmount: null,
        paymentFrequency: null,
        paymentStartDate: null,
        paymentsObserved: 0,
        rates: [],
        originalPrincipal: 2000,
        amortizationMonths: null,
      },
    ]);
  });

  it("leaves the inferred loans as they are with no stated terms", () => {
    expect(withKmyLoanTerms(inferred, []).loans).toEqual(inferred.loans);
  });
});
