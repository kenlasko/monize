import { redemptionSplit, valueBondLotSeries } from "./bond-engine";
import {
  INDEX_ID,
  indexedTerms,
  monthlyIndex,
  valueIndexed,
} from "@/test-helpers/bond-indexed-terms";
import { lotOf } from "@/test-helpers/bond-coupon-terms";

// 31 CFR 356 Appendix B I.B and 356.30(b): a 3 7/8 percent security dated
// 2026-07-01 on the base reference 164, three half-year periods.
const E8 = indexedTerms({
  datedDate: "2026-07-01",
  firstCouponDate: "2027-01-01",
  maturityDate: "2028-01-01",
  rate: "0.03875",
  base: "164",
});
const LOT = { purchaseDate: "2026-07-01", quantity: 1000 };
const LEVELS = {
  "2026-03": "162.0",
  "2026-04": "163.0",
  "2026-05": "164.0",
  "2026-06": "164.5",
  "2026-07": "165.0",
  "2026-08": "165.5",
  "2026-09": "166.0",
  "2026-10": "166.2",
};

describe("E8: a coupon on the index ratio of its date", () => {
  const v = valueIndexed(E8, LOT, "2026-10-01", LEVELS);

  it("is 1,963.48 on 100,000 par: 1,937.50 x 1.01341", () => {
    expect(v.knownCashflows).toEqual([
      {
        date: "2027-01-01",
        type: "INTEREST",
        amount: "1963.48",
        status: "KNOWN",
        period: 1,
      },
    ]);
    expect(v.nextPayment).toEqual(v.knownCashflows);
  });

  it("shows the unrounded unit interest in the rate schedule, on the ratio of the end", () => {
    expect(v.rateSchedule[0]).toMatchObject({
      annualRate: "0.03875",
      rateSource: "TERMS",
      interest: "1.9634818750",
      fixedPart: "1.9634818750",
    });
    // Period 2 ends on a day whose months are not stored.
    expect(v.rateSchedule[1]).toMatchObject({
      interest: null,
      fixedPart: null,
    });
  });
});

describe("the value of an open lot", () => {
  it("is the principal on the day's ratio plus the unindexed accrued interest times it", () => {
    // 2026-10-01 reads July (165.0): ratio 1.00610; 92 of 184 days accrued.
    const v = valueIndexed(E8, LOT, "2026-10-01", LEVELS);
    expect(v.status).toBe("OPEN");
    expect(v.principal).toBe("100.610000");
    expect(v.accruedInterest).toBe("974.66");
    expect(v.grossValue).toBe("101584.66");
    expect(v.valuationComplete).toBe(true);
    expect(v.missing).toEqual([]);
    expect(v.earlyRedemptionValue).toBeNull();
    expect(v.earlyRedemptionRefusal).toBe("NOT_REDEEMABLE");
  });

  it("interpolates between two months inside a month", () => {
    // 2026-10-15: 165.22581 / 164 = 1.00747.
    const v = valueIndexed(E8, LOT, "2026-10-15", LEVELS);
    expect(v.accruedInterest).toBe("1124.51");
    // 1000 units x 100 x ratio 1.00747 = 100747.00, plus the accrued interest
    // 1124.51 (by hand).
    expect(v.grossValue).toBe("101871.51");
  });

  it("is the principal alone, with no accrued interest, before the dated date", () => {
    const v = valueIndexed(
      E8,
      { purchaseDate: "2026-06-15", quantity: 10 },
      "2026-06-15",
      LEVELS,
    );
    expect(v.accruedInterest).toBe("0.00");
  });
});

describe("a month that is not stored is unknown, never carried on (INV-BOND-002)", () => {
  const { "2026-07": _july, ...withoutJuly } = LEVELS;

  it("nulls every figure that reads the day's ratio and names the month and its publisher", () => {
    const v = valueIndexed(E8, LOT, "2026-10-01", withoutJuly);
    expect(v.principal).toBeNull();
    expect(v.accruedInterest).toBeNull();
    expect(v.grossValue).toBeNull();
    expect(v.missing).toEqual([
      { benchmarkId: INDEX_ID, observation: "2026-07", publisher: "PUBLISHER" },
    ]);
    expect(v.valuationComplete).toBe(false);
  });

  it("leaves a coupon that does not read it known", () => {
    const v = valueIndexed(E8, LOT, "2026-10-01", withoutJuly);
    expect(v.knownCashflows.map((f) => f.amount)).toEqual(["1963.48"]);
  });

  it("names both months a day inside a month reads", () => {
    const { "2026-08": _august, ...neither } = withoutJuly;
    const v = valueIndexed(E8, LOT, "2026-10-15", neither);
    expect(v.missing.map((m) => m.observation)).toEqual(["2026-07", "2026-08"]);
  });

  it("has no index series at all: every figure of the day is unknown and the publisher is null", () => {
    const v = valueBondLotSeries({
      ...lotOf(E8, LOT.purchaseDate, LOT.quantity),
      days: ["2026-10-01"],
    })[0];
    expect(v.grossValue).toBeNull();
    expect(v.missing).toEqual([
      { benchmarkId: INDEX_ID, observation: "2026-07", publisher: null },
    ]);
  });
});

describe("a payment after the valuation day", () => {
  const later = valueIndexed(E8, LOT, "2026-10-01", LEVELS);

  it("is UNKNOWN with a null amount and the benchmark named when no inflation is assumed", () => {
    expect(later.projectedCashflows).toEqual([
      expect.objectContaining({
        type: "INTEREST",
        period: 2,
        amount: null,
        status: "UNKNOWN",
      }),
      expect.objectContaining({
        type: "INTEREST",
        period: 3,
        amount: null,
        status: "UNKNOWN",
      }),
      expect.objectContaining({
        type: "PRINCIPAL",
        amount: null,
        status: "UNKNOWN",
      }),
    ]);
    expect(later.projectionMissing).toEqual([
      { benchmarkId: INDEX_ID, publisher: "PUBLISHER" },
    ]);
    expect(later.projectionAssumptions).toEqual([]);
    expect(later.maturityValueKnown).toBeNull();
    expect(later.maturityValueProjected).toBeNull();
  });

  it("is PROJECTED from an assumed annual inflation, the newest level grown by inflation x months / 12", () => {
    // 2027-07-01 reads 2027-04: 166.2 x 1.015 = 168.693, ratio 1.02862;
    // 2028-01-01 reads 2027-10: 166.2 x 1.03 = 171.186, ratio 1.04382.
    const v = valueIndexed(E8, LOT, "2026-10-01", LEVELS, "0.03");
    expect(v.knownCashflows.map((f) => [f.period, f.amount])).toEqual([
      [1, "1963.48"],
    ]);
    expect(
      v.projectedCashflows.map((f) => [f.type, f.period, f.amount, f.status]),
    ).toEqual([
      ["INTEREST", 2, "1992.95", "PROJECTED"],
      ["INTEREST", 3, "2022.40", "PROJECTED"],
      ["PRINCIPAL", 3, "104382.00", "PROJECTED"],
    ]);
    expect(v.maturityValueProjected).toBe("106404.40");
    expect(v.maturityValueKnown).toBeNull();
    expect(v.projectionAssumptions).toEqual([
      {
        benchmarkId: INDEX_ID,
        value: "0.0300",
        basis: "SUPPLIED",
        observation: null,
      },
    ]);
    expect(v.projectionMissing).toEqual([]);
  });

  it("never projects a figure of the valuation day itself", () => {
    const { "2026-07": _july, ...withoutJuly } = LEVELS;
    const v = valueIndexed(E8, LOT, "2026-10-01", withoutJuly, "0.03");
    expect(v.grossValue).toBeNull();
    expect(v.missing.map((m) => m.observation)).toEqual(["2026-07"]);
  });
});

describe("E10: the principal at maturity is at least par", () => {
  const E10 = indexedTerms({
    datedDate: "2026-07-01",
    firstCouponDate: "2027-01-01",
    maturityDate: "2028-01-01",
    rate: "0.04",
    base: "200",
  });
  const lot = { purchaseDate: "2026-07-01", quantity: 10 };
  // 2028-01-01 reads 2027-10: 196 / 200 = 0.98000; 2027-12-01 reads 2027-09.
  const levels = { "2027-09": "196.0", "2027-10": "196.0" };

  it("pays 1,000.00 of principal and a final coupon on 980.00 (19.60)", () => {
    const v = valueIndexed(E10, lot, "2027-12-01", levels);
    expect(
      v.knownCashflows
        .filter((f) => f.date === "2028-01-01")
        .map((f) => [f.type, f.amount]),
    ).toEqual([
      ["INTEREST", "19.60"],
      ["PRINCIPAL", "1000.00"],
    ]);
    expect(v.maturityValueKnown).toBe("1019.60");
    // Before maturity the principal is the adjusted one, below par.
    expect(v.principal).toBe("98.000000");
  });

  it("pays the adjusted principal, below par, with no floor", () => {
    const unfloored = indexedTerms({
      datedDate: "2026-07-01",
      firstCouponDate: "2027-01-01",
      maturityDate: "2028-01-01",
      rate: "0.04",
      base: "200",
      maturityFloor: "NONE",
    });
    const v = valueIndexed(unfloored, lot, "2027-12-01", levels);
    expect(v.maturityValueKnown).toBe("999.60");
  });

  it("pays the adjusted principal when it is above par, and the final coupon on it", () => {
    const v = valueIndexed(E10, lot, "2027-12-01", {
      "2027-09": "210.0",
      "2027-10": "210.0",
    });
    // ratio 1.05000: principal 1,050.00, coupon 21.00.
    expect(v.maturityValueKnown).toBe("1071.00");
  });

  it("values a matured lot at its floored principal and no accrued interest", () => {
    const v = valueIndexed(E10, lot, "2028-01-01", levels);
    expect(v.status).toBe("MATURED");
    expect(v.principal).toBe("100.000000");
    expect(v.grossValue).toBe("1000.00");
    expect(v.accruedInterest).toBe("0.00");
  });

  it("reads the maturity date's own ratio for a matured lot: unknown without it", () => {
    const v = valueIndexed(E10, lot, "2028-01-01", {});
    expect(v.grossValue).toBeNull();
    expect(v.missing.map((m) => m.observation)).toEqual(["2027-10"]);
  });

  describe("the redemption split at maturity (INV-BOND-009)", () => {
    const input = (benchmarks: ReturnType<typeof monthlyIndex>) => ({
      ...lotOf(E10, lot.purchaseDate, lot.quantity),
      benchmarks,
    });

    it("returns 1,000.00 of principal and 19.60 of interest: payout = principal + interest", () => {
      const split = redemptionSplit(input(monthlyIndex(levels)), "2028-01-01");
      expect(split).toMatchObject({
        principal: "1000.00",
        interest: "19.60",
        principalReturned: "1000.00",
        payout: "1019.60",
        refusal: null,
      });
    });

    it("refuses before maturity: a MARKETABLE security is sold, not redeemed", () => {
      const split = redemptionSplit(input(monthlyIndex(levels)), "2027-12-01");
      expect(split.refusal).toBe("NOT_REDEEMABLE");
      expect(split.payout).toBeNull();
    });

    it("gives no figure while the ratio of the maturity date is unknown", () => {
      const split = redemptionSplit(input(monthlyIndex({})), "2028-01-01");
      expect(split.refusal).toBe("RATE_UNKNOWN");
      expect(split.payout).toBeNull();
      expect(split.principal).toBeNull();
    });
  });
});

describe("a series of days", () => {
  it("equals the valuation of each day, projection and missing months included", () => {
    const days = ["2026-10-01", "2026-10-02", "2026-12-15", "2027-01-01"];
    const input = {
      ...lotOf(E8, LOT.purchaseDate, LOT.quantity),
      benchmarks: monthlyIndex(LEVELS),
      projection: new Map([[INDEX_ID, "0.03"]]),
    };
    const series = valueBondLotSeries({ ...input, days });
    days.forEach((day, i) => {
      expect(series[i]).toEqual(valueIndexed(E8, LOT, day, LEVELS, "0.03"));
    });
  });
});
