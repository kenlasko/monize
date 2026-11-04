import { BondTerms } from "../domain/bond-terms";
import { ExactDecimal } from "../domain/exact-decimal";
import { buildCouponSchedule } from "../domain/period-schedule";
import {
  couponTerms,
  E4,
  E5,
  E6,
  E7,
  lotOf,
  value,
} from "@/test-helpers/bond-coupon-terms";
import { couponOf, periodInterest, valueAt } from "./accrual";
import { redemptionSplit } from "./bond-engine";
import { marketPriceRequired } from "./price-policy";
import { unitRound } from "./rounding";

const dec = (text: string) => ExactDecimal.parse(text);

function fixedRate(terms: BondTerms): ExactDecimal {
  if (terms.rateRule.type !== "FIXED")
    throw new Error("a fixed rate is needed");
  return dec(terms.rateRule.annualRate);
}

function periodsOf(terms: BondTerms) {
  if (terms.schedule.anchor !== "COUPON_DATES")
    throw new Error("a coupon schedule is needed");
  return buildCouponSchedule(terms.schedule);
}

/**
 * One unit's exact accrued interest on `asOf` inside the period `index`, times
 * ten: the figure per 1,000 par of a unit of 100 par, to `decimals` places.
 */
function accruedPerThousand(
  terms: BondTerms,
  index: number,
  asOf: string,
  decimals = 5,
): string {
  const period = periodsOf(terms)[index - 1];
  return valueAt(terms, [], { period, rate: fixedRate(terms) }, asOf)
    .sub(dec("100"))
    .mul(dec("10"))
    .toFixed(decimals);
}

describe("accrued interest of a coupon lot (spec 5.2)", () => {
  describe("E4: one half-year, 92 of 184 days", () => {
    it("is 16.87500 per 1,000 par", () => {
      expect(accruedPerThousand(E4, 1, "1990-11-15")).toBe("16.87500");
    });

    it("is 2,531.25 on 150,000 par", () => {
      const v = value(E4, "1990-11-15", 1500, "1990-11-15");
      expect(v.status).toBe("OPEN");
      expect(v.accruedInterest).toBe("2531.25");
      expect(v.grossValue).toBe("152531.25");
      expect(v.principal).toBe("100.000000");
    });
  });

  describe("E5: two half-years, 44 of 181 days plus 81 of 184", () => {
    it("is 36.72798 per 1,000 par", () => {
      expect(accruedPerThousand(E5, 1, "1990-11-04")).toBe("36.72798");
    });

    it("is 404.01 on 11,000 par", () => {
      const v = value(E5, "1990-11-04", 110, "1990-11-04");
      expect(v.accruedInterest).toBe("404.01");
      expect(v.grossValue).toBe("11404.01");
    });

    it("accrues only the first quasi period before the second begins", () => {
      // 1990-07-02 to 1990-08-15 is 44 days of the 181 of the period before it.
      expect(accruedPerThousand(E5, 1, "1990-08-15", 6)).toBe("13.066298");
      expect(value(E5, "1990-07-02", 110, "1990-08-15").accruedInterest).toBe(
        "143.73",
      );
    });

    it("is nothing on the dated date", () => {
      expect(value(E5, "1990-07-02", 110, "1990-07-02").accruedInterest).toBe(
        "0.00",
      );
    });
  });

  it("is nothing before the dated date, whatever the lot", () => {
    const v = value(E4, "1990-08-01", 1500, "1990-08-10");
    expect(v.status).toBe("OPEN");
    expect(v.accruedInterest).toBe("0.00");
    expect(v.grossValue).toBe("150000.00");
  });

  it("is nothing at maturity", () => {
    const v = value(E4, "1990-08-15", 1500, "1992-02-15");
    expect(v.status).toBe("MATURED");
    expect(v.accruedInterest).toBe("0.00");
    expect(v.grossValue).toBe("150000.00");
  });
});

describe("the coupon of a period (spec 5.2, 5.3)", () => {
  const first = (terms: BondTerms) => {
    const period = periodsOf(terms)[0];
    return { period, rate: fixedRate(terms) };
  };

  it("E6: a short first coupon is 41.419837 per 1,000 par, 828.40 on 20,000", () => {
    const { period, rate } = first(E6);
    expect(
      periodInterest(E6, dec("100"), period, rate).mul(dec("10")).toFixed(6),
    ).toBe("41.419837");
    // rounded per unit to six decimals before the holding: 4.141984 x 200
    expect(couponOf(E6, { period, rate })?.toFixed(6)).toBe("4.141984");
    const v = value(E6, "1990-07-02", 200, "1990-07-02");
    expect(v.knownCashflows[0]).toMatchObject({
      date: "1990-12-31",
      type: "INTEREST",
      amount: "828.40",
      period: 1,
    });
  });

  it("E7: a long first coupon is 55.210598 per 1,000 par, 386.47 on 7,000", () => {
    const { period, rate } = first(E7);
    expect(
      periodInterest(E7, dec("100"), period, rate).mul(dec("10")).toFixed(6),
    ).toBe("55.210598");
    const v = value(E7, "1990-12-03", 70, "1990-12-03");
    expect(v.knownCashflows[0]).toMatchObject({
      date: "1991-08-15",
      amount: "386.47",
    });
  });

  it("a regular coupon is par x rate / 2 whatever its days, exact until the holding is rounded", () => {
    const v = value(E7, "1990-12-03", 70, "1990-12-03");
    const regular = v.knownCashflows.filter((f) => f.type === "INTEREST");
    expect(regular.map((f) => f.amount)).toEqual([
      "386.47",
      "275.63",
      "275.63",
      "275.63",
      "275.63",
    ]);
    // 181 and 184 day periods earn the same coupon
    const { period, rate } = first(E4);
    const perUnit = unitRound(E4, periodInterest(E4, dec("100"), period, rate));
    expect(perUnit.toFixed(6)).toBe("3.375000");
    const second = periodsOf(E4)[1];
    expect(periodInterest(E4, dec("100"), second, rate).toFixed(6)).toBe(
      "3.375000",
    );
  });

  it("a regular coupon of 3 units at 6 3/4 % is exact, not rounded per unit, under PER_HOLDING", () => {
    const terms = couponTerms({
      datedDate: "2026-01-15",
      firstCouponDate: "2026-07-15",
      maturityDate: "2027-01-15",
      rate: "0.0675",
    });
    // 3.375 per unit exact: 3 units pay 10.125 -> 10.13, not 3 x 3.38 = 10.14
    const v = value(terms, "2026-01-15", 3, "2026-01-15");
    expect(v.knownCashflows[0].amount).toBe("10.13");
  });
});

describe("the cash flows of a lot (spec 5.1)", () => {
  it("lists every coupon and the principal at maturity", () => {
    const v = value(E4, "1990-08-15", 1500, "1990-08-15");
    expect(
      v.knownCashflows.map((f) => [f.date, f.type, f.amount, f.period]),
    ).toEqual([
      ["1991-02-15", "INTEREST", "5062.50", 1],
      ["1991-08-15", "INTEREST", "5062.50", 2],
      ["1992-02-15", "INTEREST", "5062.50", 3],
      ["1992-02-15", "PRINCIPAL", "150000.00", 3],
    ]);
    expect(v.projectedCashflows).toEqual([]);
    expect(v.maturityDate).toBe("1992-02-15");
    expect(v.valuationComplete).toBe(true);
  });

  it("holds the coupon of the period it was bought in, in full", () => {
    const v = value(E4, "1991-04-01", 1500, "1991-04-01");
    expect(
      v.knownCashflows.map((f) => [f.date, f.type, f.amount, f.period]),
    ).toEqual([
      ["1991-08-15", "INTEREST", "5062.50", 1],
      ["1992-02-15", "INTEREST", "5062.50", 2],
      ["1992-02-15", "PRINCIPAL", "150000.00", 2],
    ]);
    // 45 of the 181 days of the period are the seller's: 3.375 x 45 / 181 per unit
    expect(v.accruedInterest).toBe("1258.63");
    expect(v.currentPeriod).toMatchObject({
      start: "1991-02-15",
      end: "1991-08-15",
    });
  });

  it("drops a coupon once its date has passed", () => {
    const v = value(E4, "1990-08-15", 1500, "1991-02-15");
    expect(v.knownCashflows.map((f) => f.date)).toEqual([
      "1991-08-15",
      "1992-02-15",
      "1992-02-15",
    ]);
    expect(v.nextPayment.map((f) => [f.date, f.type])).toEqual([
      ["1991-08-15", "INTEREST"],
    ]);
  });

  it("pays the last coupon and the principal together at maturity", () => {
    const v = value(E4, "1990-08-15", 1500, "1992-01-01");
    expect(v.nextPayment.map((f) => [f.type, f.amount])).toEqual([
      ["INTEREST", "5062.50"],
      ["PRINCIPAL", "150000.00"],
    ]);
    expect(v.maturityValueKnown).toBe("155062.50");
  });

  it("values a lot bought on the maturity as refused, like any marketable lot", () => {
    const v = value(E4, "1992-02-15", 1500, "1992-02-15");
    expect(v.status).toBe("REFUSED");
    expect(v.refusal?.code).toBe("PURCHASE_AFTER_MATURITY");
  });

  it("is a marketable coupon series the engine writes no price for", () => {
    expect(marketPriceRequired([E4])).toBe(true);
  });
});

describe("the redemption at maturity (spec 5.1)", () => {
  it("is the principal and the last coupon, kept apart", () => {
    const split = redemptionSplit(lotOf(E7, "1990-12-03", 70), "1993-08-15");
    expect(split.refusal).toBeNull();
    expect(split).toMatchObject({
      principal: "7000.00",
      grossInterest: "275.63",
      deduction: "0.00",
      interest: "275.63",
      principalReturned: "7000.00",
      payout: "7275.63",
    });
  });

  it("pays the same after the maturity date", () => {
    const split = redemptionSplit(lotOf(E7, "1990-12-03", 70), "1994-01-01");
    expect(split.payout).toBe("7275.63");
  });

  it("refuses a sale before maturity as a redemption (MATURITY_ONLY)", () => {
    const split = redemptionSplit(lotOf(E7, "1990-12-03", 70), "1992-01-01");
    expect(split.refusal).toBe("NOT_REDEEMABLE");
  });
});
