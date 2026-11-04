import { BenchmarkData } from "../domain/benchmark";
import { BondTerms, parseBondTerms } from "../domain/bond-terms";
import { ExactDecimal } from "../domain/exact-decimal";
import {
  BondEngineInput,
  redemptionSplit,
  valueBondLot,
  valueBondLotSeries,
} from "./bond-engine";

type Doc = Record<string, any>;

const everyDay = { id: "NEUTRAL", isBusinessDay: () => true };

function doc(rounding: Doc, extra: (d: Doc) => void = () => undefined): Doc {
  const d: Doc = {
    schemaVersion: 1,
    instrument: {
      issuerCountryCode: "XX",
      issuerCode: "XX_ISSUER",
      programCode: "TEST",
      seriesCode: "TEST-1",
      currency: "XXX",
      marketability: "RETAIL_REDEEMABLE",
      faceValue: "100",
    },
    saleWindow: null,
    schedule: {
      anchor: "LOT_PURCHASE_DATE",
      periodMonths: 6,
      periodCount: 4,
      rollDay: "ANCHOR_DAY_CLAMPED",
      calendarId: "NEUTRAL",
    },
    accrual: { type: "ACTUAL_DAYS_IN_PERIOD" },
    principalRule: { type: "FIXED_NOMINAL" },
    rateRule: { type: "FIXED", annualRate: "0.0675" },
    capitalization: { type: "NONE" },
    redemption: { type: "MATURITY_ONLY" },
    rounding,
    source: { provider: "TEST", url: "https://example.test", document: "doc" },
  };
  extra(d);
  return d;
}

/** A coupon bond: 6.75 % a year, 100 face, two coupons a year for two years. */
const coupon = (rounding: Doc): BondTerms => parseBondTerms(doc(rounding));

/** The same bond, redeemable on demand: a fee of 0.37 a unit, proceeds floored at the face value in the first period. */
const redeemable = (rounding: Doc): BondTerms =>
  parseBondTerms(
    doc(rounding, (d) => {
      d.redemption = {
        type: "ON_DEMAND",
        earliestDaysAfterPurchase: 7,
        latestDaysBeforeMaturity: 30,
        blackouts: [],
        penalties: [{ type: "FIXED_FEE_PER_UNIT", amount: "0.37" }],
        proceedsFloor: { type: "FACE_VALUE", appliesTo: "FIRST_PERIOD" },
      };
    }),
  );

/** The bill of the spec: 100 face at 97.833694, 2026-10-01 to 2027-04-01 (182 days). */
const bill = (rounding: Doc): BondTerms =>
  parseBondTerms(
    doc(rounding, (d) => {
      d.instrument.issuePrice = "97.833694";
      d.schedule = {
        anchor: "ISSUE_DATE",
        issueDate: "2026-10-01",
        maturityDate: "2027-04-01",
        periodCount: 1,
        calendarId: "NEUTRAL",
      };
      d.rateRule = { type: "ZERO_COUPON_DISCOUNT" };
    }),
  );

function lotOf(
  terms: BondTerms,
  purchaseDate: string,
  quantity: number,
): Omit<BondEngineInput, "asOf"> {
  return {
    terms,
    termsVersion: 1,
    announcedRates: new Map(),
    benchmarks: new Map<string, BenchmarkData>(),
    calendars: new Map([["NEUTRAL", everyDay]]),
    lot: { purchaseDate, quantity },
  };
}

const value = (terms: BondTerms, purchase: string, q: number, asOf: string) =>
  valueBondLot({ ...lotOf(terms, purchase, q), asOf });

const perUnit = { moneyDecimals: 2, mode: "HALF_UP" };
const perHolding = (unitDecimals?: number | null) => ({
  moneyDecimals: 2,
  mode: "HALF_UP",
  basis: "PER_HOLDING",
  ...(unitDecimals === undefined ? {} : { unitDecimals }),
});

describe("E1: a bill's price per 100 from its discount rate", () => {
  it("is 97.833694 for 4.285 % over 182 days", () => {
    const one = ExactDecimal.ONE;
    const discount = ExactDecimal.parse("0.04285");
    const price = ExactDecimal.parse("100").mul(
      one.sub(discount.mul(ExactDecimal.ratio(182, 360))),
    );
    expect(price.toFixed(6)).toBe("97.833694");
    expect(bill(perHolding(6)).instrument.issuePrice).toBe("97.833694");
  });
});

describe("a coupon bond on the three bases (150,000 par, 92 of 181 days of a coupon)", () => {
  // Accrued interest per 100: 6.75 % / 2 x 92 / 181 = 1.71546961...
  const on = (rounding: Doc) =>
    value(coupon(rounding), "2026-01-01", 1500, "2026-04-03");

  it("PER_UNIT is unchanged: the unit value 101.72 times 1,500", () => {
    const v = on(perUnit);
    expect(v.grossValue).toBe("152580.00");
    expect(v.accruedInterest).toBe("2580.00");
    expect(v.principal).toBe("100.00");
  });

  it("PER_HOLDING with unitDecimals 6 rounds the accrued interest per unit (1.715470), then the lot", () => {
    const v = on(perHolding(6));
    // 1.71547 x 1,500 = 2,573.205 -> 2,573.21.
    expect(v.accruedInterest).toBe("2573.21");
    expect(v.grossValue).toBe("152573.21");
  });

  it("PER_HOLDING with unitDecimals null keeps the unit exact (2,573.2044 -> 2,573.20)", () => {
    const v = on(perHolding(null));
    expect(v.accruedInterest).toBe("2573.20");
    expect(v.grossValue).toBe("152573.20");
  });

  it("PER_HOLDING with unitDecimals 3 shows the per-unit rounding at work (1.715 x 1,500)", () => {
    expect(on(perHolding(3)).accruedInterest).toBe("2572.50");
  });

  it("pays the regular coupon rounded per unit (3.38 x 1,500) or exact and rounded once (3.375 x 1,500)", () => {
    const interest = (rounding: Doc) =>
      on(rounding)
        .knownCashflows.filter((c) => c.type === "INTEREST")
        .slice(0, 2)
        .map((c) => [c.amount, c.date]);
    expect(interest(perUnit)).toEqual([
      ["5070.00", "2026-07-01"],
      ["5070.00", "2027-01-01"],
    ]);
    expect(interest(perHolding(6))).toEqual([
      ["5062.50", "2026-07-01"],
      ["5062.50", "2027-01-01"],
    ]);
    expect(on(perHolding(6)).nextPayment).toEqual([
      {
        date: "2026-07-01",
        type: "INTEREST",
        amount: "5062.50",
        status: "KNOWN",
        period: 1,
      },
    ]);
  });

  it("matches valueBondLot day by day in a series", () => {
    const terms = coupon(perHolding(6));
    const days = ["2026-01-01", "2026-04-03", "2026-07-01", "2027-02-02"];
    const series = valueBondLotSeries({
      ...lotOf(terms, "2026-01-01", 1500),
      days,
    });
    series.forEach((v, i) => {
      expect(v).toEqual(value(terms, "2026-01-01", 1500, days[i]));
    });
  });
});

describe("a bill on PER_HOLDING (100 units, issue price 97.833694, 182 days)", () => {
  const terms = bill(perHolding(6));

  it("rounds the issue price on the holding: 9,783.3694 -> 9,783.37, not 97.83 x 100", () => {
    const v = value(terms, "2026-10-01", 100, "2026-12-31");
    expect(v.principal).toBe("97.833694");
    const split = redemptionSplit(
      lotOf(terms, "2026-10-01", 100),
      "2027-04-01",
    );
    expect(split.principal).toBe("9783.37");
  });

  it("values day 91 of 182 at 9,891.68 (9,891.6847 rounded once); PER_UNIT would say 9,892.00", () => {
    const v = value(terms, "2026-10-01", 100, "2026-12-31");
    expect(v.grossValue).toBe("9891.68");
    expect(v.accruedInterest).toBe("108.31");
    expect(
      value(bill(perUnit), "2026-10-01", 100, "2026-12-31").grossValue,
    ).toBe("9892.00");
  });

  it("is worth the face value at maturity, with the discount as interest", () => {
    const v = value(terms, "2026-10-01", 100, "2027-04-01");
    expect(v.status).toBe("MATURED");
    expect(v.grossValue).toBe("10000.00");
    expect(v.accruedInterest).toBe("216.63");
    const open = value(terms, "2026-10-01", 100, "2026-12-31");
    expect(open.maturityValueKnown).toBe("10000.00");
    expect(open.knownCashflows.map((c) => [c.type, c.amount])).toEqual([
      ["INTEREST", "216.63"],
      ["PRINCIPAL", "9783.37"],
    ]);
  });

  it("splits the maturity payout into the rounded principal and the rest as interest", () => {
    const split = redemptionSplit(
      lotOf(terms, "2026-10-01", 100),
      "2027-04-01",
    );
    expect(split.refusal).toBeNull();
    expect({
      principal: split.principal,
      grossInterest: split.grossInterest,
      deduction: split.deduction,
      interest: split.interest,
      principalReturned: split.principalReturned,
      payout: split.payout,
    }).toEqual({
      principal: "9783.37",
      grossInterest: "216.63",
      deduction: "0.00",
      interest: "216.63",
      principalReturned: "9783.37",
      payout: "10000.00",
    });
  });
});

describe("INV-BOND-009: payout = principalReturned + interest under every basis", () => {
  const cases: Array<[string, BondTerms, string, string[]]> = [
    [
      "a coupon bond, PER_UNIT",
      coupon(perUnit),
      "2026-01-01",
      ["2026-04-03", "2026-07-01", "2028-01-01"],
    ],
    [
      "a coupon bond, PER_HOLDING",
      coupon(perHolding(6)),
      "2026-01-01",
      ["2026-04-03", "2026-07-01", "2028-01-01"],
    ],
    [
      "a coupon bond, REFERENCE_AMOUNT",
      coupon({
        moneyDecimals: 2,
        mode: "HALF_EVEN",
        basis: "REFERENCE_AMOUNT",
        referenceAmount: "1000",
        unitDecimals: 6,
      }),
      "2026-01-01",
      ["2026-04-03", "2028-01-01"],
    ],
    [
      "an early redemption, PER_UNIT",
      redeemable(perUnit),
      "2026-01-01",
      ["2026-01-20", "2026-04-03", "2026-09-15"],
    ],
    [
      "an early redemption, PER_HOLDING",
      redeemable(perHolding(6)),
      "2026-01-01",
      ["2026-01-20", "2026-04-03", "2026-09-15"],
    ],
    [
      "an early redemption, REFERENCE_AMOUNT",
      redeemable({
        moneyDecimals: 2,
        mode: "HALF_UP",
        basis: "REFERENCE_AMOUNT",
        referenceAmount: "1000",
      }),
      "2026-01-01",
      ["2026-01-20", "2026-04-03", "2026-09-15"],
    ],
    [
      "a bill, PER_UNIT",
      bill(perUnit),
      "2026-10-01",
      ["2027-04-01", "2027-05-01"],
    ],
    ["a bill, PER_HOLDING", bill(perHolding(6)), "2026-10-01", ["2027-04-01"]],
    [
      "a bill, PER_HOLDING DOWN",
      bill({ moneyDecimals: 0, mode: "DOWN", basis: "PER_HOLDING" }),
      "2026-10-01",
      ["2027-04-01"],
    ],
  ];

  it.each(cases)("%s", (_name, terms, purchase, days) => {
    let checked = 0;
    for (const quantity of [1, 7, 100, 3459]) {
      for (const day of days) {
        const split = redemptionSplit(lotOf(terms, purchase, quantity), day);
        if (split.refusal !== null) continue;
        checked += 1;
        const parse = (figure: string | null) =>
          ExactDecimal.parse(figure as string);
        for (const figures of [split, split.perBond]) {
          expect(
            parse(figures.principalReturned)
              .add(parse(figures.interest))
              .cmp(parse(figures.payout)),
          ).toBe(0);
          expect(parse(figures.interest).isNegative()).toBe(false);
        }
      }
    }
    expect(checked).toBeGreaterThan(0);
  });
});
