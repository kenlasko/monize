import { addDays } from "../domain/calendar-date";
import { BenchmarkData } from "../domain/benchmark";
import {
  BondTerms,
  parseBondTerms,
  scheduleMonthsOf,
} from "../domain/bond-terms";
import { ExactDecimal } from "../domain/exact-decimal";
import { principalAt, yearFraction } from "./accrual";
import {
  BondEngineError,
  BondEngineInput,
  RedemptionSplit,
  redemptionSplit,
  valueBondLot,
} from "./bond-engine";

type Doc = Record<string, any>;

/** A country-neutral bond document; each test changes what it exercises. */
function baseDoc(): Doc {
  return {
    schemaVersion: 1,
    instrument: {
      issuerCountryCode: "XX",
      issuerCode: "XX_ISSUER",
      programCode: "TEST",
      seriesCode: "TEST-1",
      currency: "XXX",
      marketability: "RETAIL_REDEEMABLE",
      faceValue: "100.00",
    },
    saleWindow: null,
    schedule: {
      anchor: "LOT_PURCHASE_DATE",
      periodMonths: 12,
      periodCount: 2,
      rollDay: "ANCHOR_DAY_CLAMPED",
      calendarId: "NEUTRAL",
    },
    accrual: { type: "ACTUAL_DAYS_IN_PERIOD" },
    principalRule: { type: "FIXED_NOMINAL" },
    rateRule: { type: "FIXED", annualRate: "0.0730" },
    capitalization: { type: "COMPOUND_AT_PERIOD_END", baseRounding: "NONE" },
    redemption: {
      type: "ON_DEMAND",
      earliestDaysAfterPurchase: 7,
      latestDaysBeforeMaturity: 30,
      blackouts: [],
      penalties: [{ type: "FIXED_FEE_PER_UNIT", amount: "3.00" }],
      proceedsFloor: { type: "FACE_VALUE", appliesTo: "ALL_PERIODS" },
    },
    rounding: { moneyDecimals: 2, mode: "HALF_UP" },
    source: { provider: "TEST", url: "https://example.test", document: "doc" },
  };
}

/** Compounding bond: two 12-month periods at 7.30 %, fee 3.00, floor at face value. */
const compounding = (): BondTerms => parseBondTerms(baseDoc());

/** Coupon bond: three 12-month periods at 7.30 %, flat fee 2.00, floor in the first period only. */
function coupon(): BondTerms {
  const doc = baseDoc();
  doc.schedule.periodCount = 3;
  doc.capitalization = { type: "NONE" };
  doc.redemption.penalties = [{ type: "FIXED_FEE_PER_UNIT", amount: "2.00" }];
  doc.redemption.proceedsFloor = {
    type: "FACE_VALUE",
    appliesTo: "FIRST_PERIOD",
  };
  return parseBondTerms(doc);
}

/** Discount bill: face 24000.00 bought at 23530.00, one period of 26 days. */
function bill(change: (doc: Doc) => void = () => undefined): BondTerms {
  const doc = baseDoc();
  doc.instrument.faceValue = "24000.00";
  doc.instrument.issuePrice = "23530.00";
  doc.schedule = {
    anchor: "ISSUE_DATE",
    issueDate: "2026-01-01",
    maturityDate: "2026-01-27",
    periodCount: 1,
    calendarId: "NEUTRAL",
  };
  doc.rateRule = { type: "ZERO_COUPON_DISCOUNT" };
  doc.capitalization = { type: "NONE" };
  doc.redemption = { type: "MATURITY_ONLY" };
  change(doc);
  return parseBondTerms(doc);
}

function lot(
  terms: BondTerms,
  purchaseDate: string,
  quantity = 1,
  overrides: Partial<BondEngineInput> = {},
): Omit<BondEngineInput, "asOf"> {
  return {
    terms,
    termsVersion: 1,
    announcedRates: new Map(),
    benchmarks: new Map<string, BenchmarkData>(),
    calendars: new Map(),
    lot: { purchaseDate, quantity },
    ...overrides,
  };
}

const figuresOf = (s: RedemptionSplit) => ({
  principal: s.principal,
  grossInterest: s.grossInterest,
  deduction: s.deduction,
  interest: s.interest,
  principalReturned: s.principalReturned,
  payout: s.payout,
});

const NO_FIGURES = {
  principal: null,
  grossInterest: null,
  deduction: null,
  interest: null,
  principalReturned: null,
  payout: null,
};

describe("redemptionSplit: the table of spec 3.1", () => {
  it("a discount bill held to maturity: the whole discount is interest", () => {
    const split = redemptionSplit(lot(bill(), "2026-01-01"), "2026-01-27");
    expect(split.refusal).toBeNull();
    expect(figuresOf(split)).toEqual({
      principal: "23530.00",
      grossInterest: "470.00",
      deduction: "0.00",
      interest: "470.00",
      principalReturned: "23530.00",
      payout: "24000.00",
    });
  });

  it("the same bill half way is valued, not split: 23765.00 on day 13 of 26", () => {
    const valuation = valueBondLot({
      ...lot(bill(), "2026-01-01"),
      asOf: "2026-01-14",
    });
    expect(valuation.grossValue).toBe("23765.00");
    expect(valuation.accruedInterest).toBe("235.00");
    expect(valuation.principal).toBe("23530.00");
    expect(
      redemptionSplit(lot(bill(), "2026-01-01"), "2026-01-14").refusal,
    ).toBe("NOT_REDEEMABLE");
  });

  it("a compounding bond at maturity: principal and the capitalised interest", () => {
    // 100 x 1.073 x 1.073 = 115.1329, rounded per bond to 115.13.
    const split = redemptionSplit(
      lot(compounding(), "2026-01-01"),
      "2028-01-01",
    );
    expect(figuresOf(split)).toEqual({
      principal: "100.00",
      grossInterest: "15.13",
      deduction: "0.00",
      interest: "15.13",
      principalReturned: "100.00",
      payout: "115.13",
    });
  });

  it("a coupon bond at maturity: the face value and the last coupon", () => {
    // Period 3 runs a whole 12-month period at 7.30 %: coupon 7.30.
    const split = redemptionSplit(lot(coupon(), "2026-01-01"), "2029-01-01");
    expect(figuresOf(split)).toEqual({
      principal: "100.00",
      grossInterest: "7.30",
      deduction: "0.00",
      interest: "7.30",
      principalReturned: "100.00",
      payout: "107.30",
    });
  });

  it("early, interest above the fee: the fee comes out of the interest", () => {
    // Day 300 of a 365-day period: 100 x (1 + 0.0730 x 300/365) = 106.00; fee 3.00.
    const split = redemptionSplit(
      lot(compounding(), "2026-01-01"),
      "2026-10-28",
    );
    expect(figuresOf(split)).toEqual({
      principal: "100.00",
      grossInterest: "6.00",
      deduction: "3.00",
      interest: "3.00",
      principalReturned: "100.00",
      payout: "103.00",
    });
  });

  it("early, interest below the fee: the floor keeps the principal whole", () => {
    // Day 50: value 101.00, 98.00 after the fee, the floor pays 100.00.
    const split = redemptionSplit(
      lot(compounding(), "2026-01-01"),
      "2026-02-20",
    );
    expect(figuresOf(split)).toEqual({
      principal: "100.00",
      grossInterest: "1.00",
      deduction: "1.00",
      interest: "0.00",
      principalReturned: "100.00",
      payout: "100.00",
    });
  });

  it("early with no floor and a flat fee above the interest: a capital loss of the excess", () => {
    // Period 2, day 60: value 101.20, fee 2.00, no floor after the first period.
    const split = redemptionSplit(lot(coupon(), "2026-01-01"), "2027-03-02");
    expect(figuresOf(split)).toEqual({
      principal: "100.00",
      grossInterest: "1.20",
      deduction: "2.00",
      interest: "0.00",
      principalReturned: "99.20",
      payout: "99.20",
    });
  });

  it("the first period of the same coupon bond is floored at the face value", () => {
    const split = redemptionSplit(lot(coupon(), "2026-01-01"), "2026-03-02");
    expect(figuresOf(split)).toEqual({
      principal: "100.00",
      grossInterest: "1.20",
      deduction: "1.20",
      interest: "0.00",
      principalReturned: "100.00",
      payout: "100.00",
    });
  });
});

describe("redemptionSplit: the lot, the date and the refusals", () => {
  it("rounds per bond and then multiplies by the quantity", () => {
    // Issue price 98.041667 is 98.04 per bond: 240 bonds hold 23529.60 of
    // principal and 470.40 of interest, not 23530.00 and 470.00.
    const terms = bill((d) => {
      d.instrument.faceValue = "100";
      d.instrument.issuePrice = "98.041667";
    });
    const split = redemptionSplit(lot(terms, "2026-01-01", 240), "2026-01-27");
    expect(split.quantity).toBe(240);
    expect(split.perBond).toEqual({
      principal: "98.04",
      grossInterest: "1.96",
      deduction: "0.00",
      interest: "1.96",
      principalReturned: "98.04",
      payout: "100.00",
    });
    expect(figuresOf(split)).toEqual({
      principal: "23529.60",
      grossInterest: "470.40",
      deduction: "0.00",
      interest: "470.40",
      principalReturned: "23529.60",
      payout: "24000.00",
    });
  });

  it("an early redemption multiplies the rounded bond figures", () => {
    const split = redemptionSplit(
      lot(compounding(), "2026-01-01", 3),
      "2026-10-28",
    );
    expect(split.perBond.interest).toBe("3.00");
    expect(split.interest).toBe("9.00");
    expect(split.payout).toBe("309.00");
    expect(split.principalReturned).toBe("300.00");
  });

  it("after maturity the split is the maturity split, dated as asked", () => {
    const input = lot(compounding(), "2026-01-01", 2);
    const atMaturity = redemptionSplit(input, "2028-01-01");
    const after = redemptionSplit(input, "2028-02-15");
    expect(after).toEqual({ ...atMaturity, date: "2028-02-15" });
    expect(after.deduction).toBe("0.00");
  });

  it.each([
    ["2026-01-08", "TOO_EARLY"],
    ["2027-12-03", "TOO_LATE"],
  ])("refuses %s outside the window: %s, no figures", (day, refusal) => {
    const split = redemptionSplit(lot(compounding(), "2026-01-01"), day);
    expect(split.refusal).toBe(refusal);
    expect(figuresOf(split)).toEqual(NO_FIGURES);
    expect(split.perBond).toEqual(NO_FIGURES);
  });

  it("refuses a record day", () => {
    const doc = baseDoc();
    doc.capitalization = { type: "NONE" };
    doc.redemption.blackouts = [
      {
        type: "RECORD_DAY_BEFORE_COUPON",
        businessDays: 5,
        calendarId: "NEUTRAL",
      },
    ];
    const terms = parseBondTerms(doc);
    // The calendar is unknown: the terms are incomplete, so the day is refused.
    expect(
      redemptionSplit(lot(terms, "2026-01-01"), "2026-06-01").refusal,
    ).toBe("TERMS_INCOMPLETE");
    // Every day a business day: the record day is 5 days before the coupon on 2027-01-01.
    const everyDay = { id: "NEUTRAL", isBusinessDay: () => true };
    expect(
      redemptionSplit(
        lot(terms, "2026-01-01", 1, {
          calendars: new Map([["NEUTRAL", everyDay]]),
        }),
        "2026-12-27",
      ).refusal,
    ).toBe("RECORD_DAY");
  });

  it("refuses a discount bill before its maturity day, whatever the day", () => {
    for (const day of ["2026-01-02", "2026-01-26"]) {
      const split = redemptionSplit(lot(bill(), "2026-01-01"), day);
      expect(split.refusal).toBe("NOT_REDEEMABLE");
      expect(figuresOf(split)).toEqual(NO_FIGURES);
    }
  });

  it("refuses a purchase outside the sale window", () => {
    const terms = bill(
      (d) => (d.saleWindow = { from: "2026-02-01", to: "2026-02-28" }),
    );
    const split = redemptionSplit(lot(terms, "2026-01-01"), "2026-01-27");
    expect(split.refusal).toBe("PURCHASE_OUTSIDE_SALE_WINDOW");
    expect(figuresOf(split)).toEqual(NO_FIGURES);
  });

  it("a day before the series is issued is not a day to redeem", () => {
    const split = redemptionSplit(lot(bill(), "2025-12-01"), "2025-12-15");
    expect(split.refusal).toBe("NOT_REDEEMABLE");
  });

  it("validates the lot and the day like valueBondLot", () => {
    expect(() =>
      redemptionSplit(lot(bill(), "2026-01-01", 0), "2026-01-27"),
    ).toThrow(BondEngineError);
    expect(() =>
      redemptionSplit(lot(bill(), "2026-01-01"), "2026-13-01"),
    ).toThrow(BondEngineError);
    expect(() =>
      redemptionSplit(lot(bill(), "2026-01-10"), "2026-01-09"),
    ).toThrow(BondEngineError);
  });
});

describe("redemptionSplit: an unknown rate is null, never 0", () => {
  function benchmarked(): BondTerms {
    const doc = baseDoc();
    doc.rateRule = {
      type: "BENCHMARK_PLUS_SPREAD",
      benchmarkId: "TEST_INDEX",
      spread: "0.0100",
      firstPeriodRate: "0.0500",
      benchmarkFloor: "0",
      observation: { type: "MONTHLY_VALUE_MONTHS_BEFORE_START", months: 2 },
    };
    return parseBondTerms(doc);
  }

  it("early, in a period whose observation is not stored: RATE_UNKNOWN, principal known", () => {
    const split = redemptionSplit(
      lot(benchmarked(), "2026-01-01", 2),
      "2027-03-01",
    );
    expect(split.refusal).toBe("RATE_UNKNOWN");
    expect(figuresOf(split)).toEqual({ ...NO_FIGURES, principal: "200.00" });
    expect(split.perBond).toEqual({ ...NO_FIGURES, principal: "100.00" });
  });

  it("at and after maturity: RATE_UNKNOWN with the principal", () => {
    for (const day of ["2028-01-01", "2028-03-01"]) {
      const split = redemptionSplit(lot(benchmarked(), "2026-01-01"), day);
      expect(split.refusal).toBe("RATE_UNKNOWN");
      expect(figuresOf(split)).toEqual({ ...NO_FIGURES, principal: "100.00" });
    }
  });

  it("the first period's stated rate needs no observation", () => {
    const split = redemptionSplit(
      lot(benchmarked(), "2026-01-01"),
      "2026-10-28",
    );
    expect(split.refusal).toBeNull();
    expect(split.interest).not.toBeNull();
  });

  it("an announced rate makes the split known: 100 x 1.05 x 1.073 = 112.665", () => {
    const split = redemptionSplit(
      lot(benchmarked(), "2026-01-01", 1, {
        announcedRates: new Map([[2, "0.0730"]]),
      }),
      "2028-01-01",
    );
    expect(split.refusal).toBeNull();
    expect(split.payout).toBe("112.67");
  });
});

describe("INV-BOND-009: payout = principalReturned + interest", () => {
  const sum = (a: string, b: string) =>
    ExactDecimal.parse(a).add(ExactDecimal.parse(b));
  const cases: [string, BondTerms, string, number][] = [
    ["compounding", compounding(), "2026-01-01", 7],
    ["coupon", coupon(), "2026-01-01", 5],
    ["bill", bill(), "2026-01-01", 240],
  ];

  it.each(cases)(
    "%s, every day from purchase to past maturity",
    (_n, terms, purchase, quantity) => {
      const input = lot(terms, purchase, quantity);
      let splits = 0;
      for (let i = 0; i < 1200; i += 1) {
        const day = addDays(purchase, i);
        const split = redemptionSplit(input, day);
        if (split.refusal !== null) continue;
        splits += 1;
        for (const f of [split, split.perBond]) {
          expect(
            sum(f.principalReturned!, f.interest!).cmp(
              ExactDecimal.parse(f.payout!),
            ),
          ).toBe(0);
          expect(ExactDecimal.parse(f.interest!).isNegative()).toBe(false);
          expect(
            ExactDecimal.parse(f.principalReturned!).cmp(
              ExactDecimal.parse(f.principal!),
            ),
          ).not.toBe(1);
        }
        if (
          day >= "2028-01-01" &&
          terms.schedule.anchor !== "COUPON_DATES" &&
          terms.schedule.periodCount === 2
        ) {
          expect(ExactDecimal.parse(split.deduction!).isZero()).toBe(true);
        }
      }
      expect(splits).toBeGreaterThan(0);
    },
  );

  it("the deduction is zero at maturity for every instrument", () => {
    for (const [, terms, purchase, quantity] of cases) {
      const input = lot(terms, purchase, quantity);
      const maturity =
        terms.schedule.anchor === "LOT_PURCHASE_DATE"
          ? `${2026 + terms.schedule.periodCount}-01-01`
          : terms.schedule.maturityDate;
      expect(
        ExactDecimal.parse(
          redemptionSplit(input, maturity).deduction!,
        ).isZero(),
      ).toBe(true);
    }
  });
});

describe("the discount instrument in the engine (spec 3)", () => {
  const everyDay = { id: "NEUTRAL", isBusinessDay: () => true };
  const value = (asOf: string, terms = bill()) =>
    valueBondLot({
      ...lot(terms, "2026-01-01", 1, {
        calendars: new Map([["NEUTRAL", everyDay]]),
      }),
      asOf,
    });

  it("principalAt is the issue price on every date of the period", () => {
    for (const date of ["2026-01-01", "2026-01-14", "2026-01-27"]) {
      expect(principalAt(bill(), { date }).toFixed(2)).toBe("23530.00");
    }
  });

  it.each([
    ["2026-01-01", "23530.00", "0.00"],
    ["2026-01-02", "23548.08", "18.08"],
    ["2026-01-14", "23765.00", "235.00"],
    ["2026-01-26", "23981.92", "451.92"],
  ])("ratable value on %s is %s", (day, gross, accrued) => {
    const v = value(day);
    expect(v.status).toBe("OPEN");
    expect(v.grossValue).toBe(gross);
    expect(v.accruedInterest).toBe(accrued);
    expect(v.principal).toBe("23530.00");
    expect(v.valuationComplete).toBe(true);
  });

  it("is worth the face value on the maturity day and after", () => {
    for (const day of ["2026-01-27", "2026-03-01"]) {
      const v = value(day);
      expect(v.status).toBe("MATURED");
      expect(v.grossValue).toBe("24000.00");
      expect(v.accruedInterest).toBe("470.00");
    }
  });

  it("pays the face value at maturity and states no rate", () => {
    const v = value("2026-01-14");
    expect(v.maturityValueKnown).toBe("24000.00");
    expect(v.knownCashflows.map((c) => [c.type, c.amount, c.date])).toEqual([
      ["INTEREST", "470.00", "2026-01-27"],
      ["PRINCIPAL", "23530.00", "2026-01-27"],
    ]);
    expect(v.rateRule).toEqual({
      type: "ZERO_COUPON_DISCOUNT",
      benchmarkId: null,
      annualRate: null,
      firstPeriodRate: null,
      addend: null,
      benchmarkFloor: null,
    });
    expect(v.currentPeriod).toMatchObject({
      index: 1,
      start: "2026-01-01",
      end: "2026-01-27",
      annualRate: null,
      rateSource: null,
    });
    expect(v.rateSchedule).toHaveLength(1);
    expect(v.rateSchedule[0]).toMatchObject({
      annualRate: null,
      rateSource: null,
      interest: "470.0000000000",
    });
    expect(v.nextRateReset).toBeNull();
    expect(v.earlyRedemptionRefusal).toBe("NOT_REDEEMABLE");
    expect(v.earlyRedemptionValue).toBeNull();
  });

  it("rounds the value per bond by the terms", () => {
    const down = bill((d) => (d.rounding.mode = "DOWN"));
    expect(value("2026-01-02", down).grossValue).toBe("23548.07");
  });

  it("does not depend on the lot's purchase date: the period is the series'", () => {
    const early = valueBondLot({
      ...lot(bill(), "2025-12-01", 1, {
        calendars: new Map([["NEUTRAL", everyDay]]),
      }),
      asOf: "2026-01-14",
    });
    expect(early.grossValue).toBe("23765.00");
    expect(early.maturityDate).toBe("2026-01-27");
  });

  it("has no value before the series is issued, not a made-up one", () => {
    const v = valueBondLot({
      ...lot(bill(), "2025-12-01"),
      asOf: "2025-12-15",
    });
    expect(v.status).toBe("OPEN");
    expect(v.grossValue).toBeNull();
  });

  it("has no periods per year, so no coupon rate can be applied to it", () => {
    const period = { start: "2026-01-01", end: "2026-01-27" };
    expect(() =>
      yearFraction(bill(), period, period.start, period.end),
    ).toThrow(RangeError);
  });

  it("scheduleMonthsOf counts the whole months of a single period, at least one", () => {
    expect(scheduleMonthsOf(bill().schedule)).toEqual({
      periodMonths: 1,
      periodCount: 1,
    });
    const long = bill((d) => (d.schedule.maturityDate = "2027-03-31"));
    expect(scheduleMonthsOf(long.schedule)).toEqual({
      periodMonths: 14,
      periodCount: 1,
    });
    expect(scheduleMonthsOf(compounding().schedule)).toEqual({
      periodMonths: 12,
      periodCount: 2,
    });
  });
});
