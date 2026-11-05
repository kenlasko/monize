import { redemptionSplit, valueBondLotSeries } from "./bond-engine";
import { lotOf } from "@/test-helpers/bond-coupon-terms";
import {
  FLOAT_CALENDARS,
  FLOAT_ID,
  floatingTerms,
  stepIndex,
  valueFloating,
  weeklyIndex,
} from "@/test-helpers/bond-floating-terms";

// 31 CFR 356 Appendix B I.C and IV: a floating rate note of 100 par per unit,
// 0.103 percent over the index; the weekly index 3.60 percent rising 0.02 a week.
const FRN = floatingTerms({ spread: "0.00103" });
const LOT = { purchaseDate: "2026-04-30", quantity: 100 };
const WEEKLY = weeklyIndex(14); // Mondays 2026-04-27 .. 2026-07-27

describe("the daily accrual (E12, E13)", () => {
  it("is 0.000597286 per 100 par for index 0.095022819 % + spread 0.120 %", () => {
    const terms = floatingTerms({ spread: "0.00120" });
    const v = valueFloating(terms, LOT, "2026-05-10", [
      ["2026-04-27", "0.00095022819"],
    ]);
    expect(v.rateSchedule[0].dailyRates?.[0]).toMatchObject({
      from: "2026-04-30",
      index: "0.00095022819",
      rate: "0.00215022819",
      dailyAccrual: "0.000597286",
      projected: false,
    });
  });

  it("is 0 when a negative spread takes the rate below the floor (index 0.095022819 %, spread -0.150 %)", () => {
    const terms = floatingTerms({ spread: "-0.00150" });
    const v = valueFloating(terms, LOT, "2026-05-10", [
      ["2026-04-27", "0.00095022819"],
    ]);
    expect(v.rateSchedule[0].dailyRates?.[0]).toMatchObject({
      rate: "0.0000",
      dailyAccrual: "0.000000000",
    });
  });
});

describe("the index in force on a day", () => {
  const v = valueFloating(FRN, LOT, "2026-05-10", WEEKLY);
  const runs = v.rateSchedule[0].dailyRates ?? [];

  it("is the latest observation strictly before the day: an auction applies from the next day", () => {
    // 2026-04-27 (3.60 %) applies from 04-28, so it is the index of 04-30; the
    // observation of 2026-05-04 (3.62 %) applies from 05-05, not on 05-04.
    expect(runs[0]).toMatchObject({
      from: "2026-04-30",
      to: "2026-05-05",
      index: "0.0360",
    });
    expect(runs[1]).toMatchObject({
      from: "2026-05-05",
      to: "2026-05-12",
      index: "0.0362",
    });
  });

  it("is shown in runs of equal rates, a 92-day period in about thirteen entries", () => {
    expect(runs).toHaveLength(14);
    expect(runs[runs.length - 1].to).toBe("2026-07-31");
  });
});

describe("the interest of a period: the sum of its days", () => {
  it("rounds the coupon once on the holding: 0.978766668 per 100 par x 100 units = 97.88", () => {
    const v = valueFloating(FRN, LOT, "2026-05-10", WEEKLY);
    expect(v.knownCashflows[0]).toEqual({
      date: "2026-07-31",
      type: "INTEREST",
      amount: "97.88",
      status: "KNOWN",
      period: 1,
    });
    expect(v.rateSchedule[0]).toMatchObject({
      annualRate: null,
      rateSource: "DERIVED",
      interest: "0.9787666680",
      fixedPart: "0.0000000000",
      announcedPart: "0.0000000000",
    });
    // The index part is the sum of the 92 daily index accruals (each the index
    // x 100 / 360, rounded to nine places) and the spread part the rest, worked
    // out apart from the engine with exact decimals (Python; the Memorial Day
    // auction held on Tuesday 05-26): 0.952444449 and 0.026322219, which add up
    // to the interest 0.978766668.
    expect(v.rateSchedule[0]).toMatchObject({
      benchmarkPart: "0.9524444490",
      addendPart: "0.0263222190",
    });
  });

  it("accrues the days before the valuation day only (92 days of 2026-04-30..07-30, 71 elapsed on 07-10)", () => {
    const v = valueFloating(FRN, LOT, "2026-07-10", WEEKLY);
    expect(v.principal).toBe("100.000000");
    expect(v.accruedInterest).toBe("74.94");
    expect(v.grossValue).toBe("10074.94");
    expect(v.status).toBe("OPEN");
    expect(v.currentPeriod).toMatchObject({
      index: 1,
      annualRate: null,
    });
    expect(v.earlyRedemptionRefusal).toBe("NOT_REDEEMABLE");
  });

  it("is dated on the next business day with the accrual end kept, when the payment is adjusted", () => {
    const adjusted = floatingTerms({
      spread: "0.00103",
      paymentAdjustment: "NEXT_BUSINESS_DAY",
    });
    // 2026-10-31 is a Saturday.
    const v = valueFloating(adjusted, LOT, "2026-10-15", WEEKLY);
    const second = v.projectedCashflows.find((f) => f.period === 2);
    expect(second).toMatchObject({
      date: "2026-11-02",
      accrualEndDate: "2026-10-31",
    });
  });
});

describe("the lockout", () => {
  // An auction dated 2026-07-29, two business days before the end 2026-07-31.
  const extra: [string, string][] = [...WEEKLY, ["2026-07-29", "0.05"]];

  it("does not use an observation within two business days before the period end, for that period", () => {
    // 07-30 stays on the 07-27 observation (3.86 %): 0.978766668 per 100.
    const v = valueFloating(FRN, LOT, "2026-07-30", extra);
    expect(v.rateSchedule[0].interest).toBe("0.9787666680");
    expect(v.rateSchedule[0].dailyRates?.slice(-1)[0]).toMatchObject({
      from: "2026-07-28",
      to: "2026-07-31",
      index: "0.0386",
    });
  });

  it("uses it in the next period, from the day after it", () => {
    const v = valueFloating(FRN, LOT, "2026-08-10", extra);
    expect(v.rateSchedule[1].dailyRates?.[0]).toMatchObject({
      from: "2026-07-31",
      index: "0.0500",
    });
  });

  it("uses it when the terms have no lockout", () => {
    const none = floatingTerms({
      spread: "0.00103",
      lockoutBusinessDays: 0,
    });
    const v = valueFloating(none, LOT, "2026-07-30", extra);
    // 0.978766668 + 1 day (07-30) of (0.0500 - 0.0386) x 100 / 360, each day
    // rounded to nine places = 0.981933335.
    expect(v.rateSchedule[0].interest).toBe("0.9819333350");
  });
});

describe("a day with no index is unknown (INV-BOND-002)", () => {
  // Observations through 2026-07-06: stored days run to 07-13 (a week on), 07-14 is stale.
  const stale = weeklyIndex(11);

  it("is known up to 7 calendar days after the newest observation and unknown after", () => {
    const v = valueFloating(FRN, LOT, "2026-07-10", stale);
    const runs = v.rateSchedule[0].dailyRates ?? [];
    // The last known run ends 07-14; the days after it are one run with no index.
    expect(runs.slice(-2).map((r) => [r.from, r.to, r.index])).toEqual([
      ["2026-07-07", "2026-07-14", "0.0380"],
      ["2026-07-14", "2026-07-31", null],
    ]);
    expect(runs[runs.length - 1]).toEqual({
      from: "2026-07-14",
      to: "2026-07-31",
      index: null,
      rate: null,
      dailyAccrual: null,
      projected: false,
    });
    expect(v.rateSchedule[0]).toMatchObject({
      rateSource: null,
      interest: null,
      benchmarkPart: null,
    });
  });

  it("leaves the coupon UNKNOWN, with no amount, and names the benchmark for a projection", () => {
    const v = valueFloating(FRN, LOT, "2026-07-10", stale);
    expect(v.knownCashflows.filter((f) => f.type === "INTEREST")).toEqual([]);
    expect(v.projectedCashflows[0]).toMatchObject({
      period: 1,
      type: "INTEREST",
      amount: null,
      status: "UNKNOWN",
    });
    expect(v.projectionMissing).toEqual([
      { benchmarkId: FLOAT_ID, publisher: "PUBLISHER" },
    ]);
    // Everything up to the valuation day is stored: the accrued interest is known.
    expect(v.accruedInterest).toBe("74.94");
    expect(v.valuationComplete).toBe(true);
  });

  it("nulls the accrued interest of a valuation day it cannot reach and names the first day", () => {
    const v = valueFloating(FRN, LOT, "2026-07-20", stale);
    expect(v.accruedInterest).toBeNull();
    expect(v.grossValue).toBeNull();
    expect(v.principal).toBe("100.000000");
    expect(v.missing).toEqual([
      {
        benchmarkId: FLOAT_ID,
        observation: "2026-07-14",
        publisher: "PUBLISHER",
      },
    ]);
    expect(v.valuationComplete).toBe(false);
  });

  it("is unknown across a gap in the middle of the stored series, not carried from the old observation", () => {
    // Stored: 04-27, 05-04, then nothing until the Tuesday 05-26 auction (Monday
    // 05-25 was Memorial Day). 05-04 is in force to 05-11 (a business-day week
    // on); 05-12 .. 05-26 has no index until the 05-26 auction applies from
    // 05-27. The old index must not carry across the gap.
    const gap: [string, string][] = [
      ["2026-04-27", "0.0360"],
      ["2026-05-04", "0.0362"],
      ["2026-05-26", "0.0368"],
    ];
    const v = valueFloating(FRN, LOT, "2026-05-27", gap);
    expect(v.accruedInterest).toBeNull();
    expect(v.grossValue).toBeNull();
    expect(v.valuationComplete).toBe(false);
    expect(v.missing).toEqual([
      {
        benchmarkId: FLOAT_ID,
        observation: "2026-05-12",
        publisher: "PUBLISHER",
      },
    ]);
    const runs = v.rateSchedule[0].dailyRates ?? [];
    expect(runs.map((r) => [r.from, r.to, r.index])).toEqual([
      ["2026-04-30", "2026-05-05", "0.0360"],
      ["2026-05-05", "2026-05-12", "0.0362"],
      ["2026-05-12", "2026-05-27", null],
      ["2026-05-27", "2026-06-03", "0.0368"],
      ["2026-06-03", "2026-07-31", null],
    ]);
  });

  it("keeps the previous rate over a holiday week: the Tuesday auction after Memorial Day is not a gap", () => {
    // Mondays 04-27 .. 05-18, then Tuesday 05-26 (Monday 05-25 closed), then
    // Mondays 06-01 and 06-08. 05-18 is in force through Tuesday 05-26: the
    // next business day on or after 05-25 is 05-26. Days 04-30 .. 06-09 (41
    // days) at 0.010286111, 0.010341667, 0.010397222, 0.010452778,
    // 0.010508333, 0.010563889, 0.010619444 per 100 par for 5, 7, 7, 8, 6, 7
    // and 1 days: 0.427841667, times 100 units = 42.78.
    const moved: [string, string][] = [
      ["2026-04-27", "0.0360"],
      ["2026-05-04", "0.0362"],
      ["2026-05-11", "0.0364"],
      ["2026-05-18", "0.0366"],
      ["2026-05-26", "0.0368"],
      ["2026-06-01", "0.0370"],
      ["2026-06-08", "0.0372"],
    ];
    const v = valueFloating(FRN, LOT, "2026-06-10", moved);
    expect(v.accruedInterest).toBe("42.78");
    expect(v.grossValue).toBe("10042.78");
    expect(v.missing).toEqual([]);
    expect(v.valuationComplete).toBe(true);
    const runs = v.rateSchedule[0].dailyRates ?? [];
    expect(runs.map((r) => [r.from, r.to, r.index])).toEqual([
      ["2026-04-30", "2026-05-05", "0.0360"],
      ["2026-05-05", "2026-05-12", "0.0362"],
      ["2026-05-12", "2026-05-19", "0.0364"],
      ["2026-05-19", "2026-05-27", "0.0366"],
      ["2026-05-27", "2026-06-02", "0.0368"],
      ["2026-06-02", "2026-06-09", "0.0370"],
      ["2026-06-09", "2026-06-16", "0.0372"],
      ["2026-06-16", "2026-07-31", null],
    ]);
  });

  it("is unknown the day after the first business day on or after the seventh day", () => {
    // 05-18 + 7 = 05-25, a holiday: 05-26 is the last known day; 05-27 is
    // unknown when no auction was stored since.
    const stored: [string, string][] = [
      ["2026-04-27", "0.0360"],
      ["2026-05-04", "0.0362"],
      ["2026-05-11", "0.0364"],
      ["2026-05-18", "0.0366"],
    ];
    const v = valueFloating(FRN, LOT, "2026-05-28", stored);
    expect(v.missing).toEqual([
      {
        benchmarkId: FLOAT_ID,
        observation: "2026-05-27",
        publisher: "PUBLISHER",
      },
    ]);
    const runs = v.rateSchedule[0].dailyRates ?? [];
    expect(runs.slice(-2)).toMatchObject([
      { from: "2026-05-19", to: "2026-05-27", index: "0.0366" },
      { from: "2026-05-27", to: "2026-07-31", index: null },
    ]);
  });

  it("names no day for a series that is not stored, and no publisher", () => {
    const v = valueBondLotSeries({
      ...lotOf(FRN, LOT.purchaseDate, LOT.quantity, FLOAT_CALENDARS),
      days: ["2026-05-10"],
    })[0];
    expect(v.missing).toEqual([
      { benchmarkId: FLOAT_ID, observation: "2026-04-30", publisher: null },
    ]);
    expect(v.grossValue).toBeNull();
  });
});

describe("a supplied index projects the days after the valuation day", () => {
  const stale = weeklyIndex(11);

  it("fills the unknown days with the assumed index (4 %) and says PROJECTED", () => {
    // Days 07-14..07-30 take 4 % + 0.103 %: 0.986544443 per 100 par -> 98.65.
    const v = valueFloating(FRN, LOT, "2026-07-10", stale, "0.04");
    expect(v.projectedCashflows[0]).toMatchObject({
      period: 1,
      type: "INTEREST",
      amount: "98.65",
      status: "PROJECTED",
    });
    expect(v.rateSchedule[0].rateSource).toBe("PROJECTED");
    expect(v.rateSchedule[0].dailyRates?.slice(-1)[0]).toMatchObject({
      from: "2026-07-14",
      index: "0.0400",
      projected: true,
    });
    expect(v.projectionAssumptions).toEqual([
      {
        benchmarkId: FLOAT_ID,
        value: "0.0400",
        basis: "SUPPLIED",
        observation: null,
      },
    ]);
    expect(v.projectionMissing).toEqual([]);
  });

  it("never fills a day before the valuation day", () => {
    const v = valueFloating(FRN, LOT, "2026-07-20", stale, "0.04");
    expect(v.accruedInterest).toBeNull();
    expect(v.missing.map((m) => m.observation)).toEqual(["2026-07-14"]);
  });
});

describe("maturity", () => {
  it("values a matured lot at its face value, the last coupon being a past cash flow", () => {
    const v = valueFloating(FRN, LOT, "2028-04-30", WEEKLY);
    expect(v.status).toBe("MATURED");
    expect(v.grossValue).toBe("10000.00");
    expect(v.accruedInterest).toBe("0.00");
  });

  it("pays no cash at maturity that it cannot add up while the last coupon is unknown", () => {
    const v = valueFloating(FRN, LOT, "2027-06-01", WEEKLY);
    expect(v.maturityValueKnown).toBeNull();
    expect(v.projectedCashflows.slice(-1)[0]).toMatchObject({
      type: "INTEREST",
      amount: null,
      status: "UNKNOWN",
    });
  });

  it("splits a redemption at maturity into the face value and the last coupon only when the coupon is known", () => {
    const known = redemptionSplit(
      {
        ...lotOf(FRN, LOT.purchaseDate, LOT.quantity, FLOAT_CALENDARS),
        benchmarks: stepIndex(WEEKLY),
      },
      "2026-07-31",
    );
    // Before maturity: not a redemption.
    expect(known.refusal).toBe("NOT_REDEEMABLE");
    const unknown = redemptionSplit(
      {
        ...lotOf(FRN, LOT.purchaseDate, LOT.quantity, FLOAT_CALENDARS),
        benchmarks: stepIndex(WEEKLY),
      },
      "2028-04-30",
    );
    expect(unknown.refusal).toBe("RATE_UNKNOWN");
    expect(unknown.principal).toBe("10000.00");
    expect(unknown.payout).toBeNull();
  });
});

describe("a calendar the lockout needs but the caller lacks", () => {
  it("leaves the terms incomplete and every day unknown, never an approximation", () => {
    const v = valueBondLotSeries({
      ...lotOf(FRN, LOT.purchaseDate, LOT.quantity, new Map()),
      benchmarks: stepIndex(WEEKLY),
      days: ["2026-05-10"],
    })[0];
    expect(v.dataCompleteness.termsComplete).toBe(false);
    expect(v.grossValue).toBeNull();
  });
});

describe("a series of days", () => {
  it("equals the valuation of each day, projection and missing days included", () => {
    const stale = weeklyIndex(11);
    const days = ["2026-05-10", "2026-07-10", "2026-07-20", "2026-08-10"];
    const series = valueBondLotSeries({
      ...lotOf(FRN, LOT.purchaseDate, LOT.quantity, FLOAT_CALENDARS),
      benchmarks: stepIndex(stale),
      projection: new Map([[FLOAT_ID, "0.04"]]),
      days,
    });
    days.forEach((day, i) => {
      expect(series[i]).toEqual(valueFloating(FRN, LOT, day, stale, "0.04"));
    });
  });
});
