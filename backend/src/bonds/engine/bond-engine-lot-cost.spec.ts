import { BenchmarkData } from "../domain/benchmark";
import { BondTerms, parseBondTerms } from "../domain/bond-terms";
import {
  BondEngineInput,
  grossValueSeries,
  redemptionSplit,
  valueBondLot,
  valueBondLotSeries,
} from "./bond-engine";

const everyDay = { id: "NEUTRAL", isBusinessDay: () => true };

function bill(
  rounding: Record<string, unknown> = { moneyDecimals: 2, mode: "HALF_UP" },
): BondTerms {
  return parseBondTerms({
    schemaVersion: 1,
    instrument: {
      issuerCountryCode: "XX",
      issuerCode: "XX_ISSUER",
      programCode: "TEST",
      seriesCode: "BILL-1",
      currency: "XXX",
      marketability: "MARKETABLE",
      faceValue: "100",
      issuePrice: "97.833694",
    },
    saleWindow: null,
    schedule: {
      anchor: "ISSUE_DATE",
      issueDate: "2026-10-01",
      maturityDate: "2027-04-01",
      periodCount: 1,
      calendarId: "NEUTRAL",
    },
    accrual: { type: "ACTUAL_DAYS_IN_PERIOD" },
    principalRule: { type: "FIXED_NOMINAL" },
    rateRule: { type: "ZERO_COUPON_DISCOUNT" },
    capitalization: { type: "NONE" },
    redemption: { type: "MATURITY_ONLY" },
    rounding,
    source: { provider: "TEST", url: "https://example.test", document: "doc" },
  });
}

const perHolding = {
  moneyDecimals: 2,
  mode: "HALF_UP",
  basis: "PER_HOLDING",
  unitDecimals: 6,
};

function lot(
  terms: BondTerms,
  purchaseDate: string,
  cost?: string | null,
  quantity = 100,
): Omit<BondEngineInput, "asOf"> {
  return {
    terms,
    termsVersion: 1,
    announcedRates: new Map(),
    benchmarks: new Map<string, BenchmarkData>(),
    calendars: new Map([["NEUTRAL", everyDay]]),
    lot: { purchaseDate, quantity, ...(cost === undefined ? {} : { cost }) },
  };
}

describe("E2: a bill bought at issue for 9,783.37 (100 units, 182 days)", () => {
  const input = lot(bill(perHolding), "2026-10-01", "9783.37");

  it("values day 91 at 9,891.69: the cost plus half the discount, rounded once", () => {
    const v = valueBondLot({ ...input, asOf: "2026-12-31" });
    expect(v.grossValue).toBe("9891.69");
    expect(v.accruedInterest).toBe("108.32");
    expect(v.principalBasis).toBe("LOT_COST");
  });

  it("splits the maturity payout into principal 9,783.37 and interest 216.63", () => {
    const s = redemptionSplit(input, "2027-04-01");
    expect(s.principalReturned).toBe("9783.37");
    expect(s.interest).toBe("216.63");
    expect(s.payout).toBe("10000.00");
  });

  it("lists the whole discount as the coupon and the cost as the principal flow", () => {
    const v = valueBondLot({ ...input, asOf: "2026-10-01" });
    const flows = v.knownCashflows.map((c) => [c.type, c.amount]);
    expect(flows).toEqual([
      ["INTEREST", "216.63"],
      ["PRINCIPAL", "9783.37"],
    ]);
  });
});

describe("E3: the same bill bought on day 91 for 9,895.00", () => {
  const input = lot(bill(perHolding), "2026-12-31", "9895.00");

  it("is worth its cost on the purchase day", () => {
    const v = valueBondLot({ ...input, asOf: "2026-12-31" });
    expect(v.grossValue).toBe("9895.00");
    expect(v.accruedInterest).toBe("0.00");
  });

  it("accrues from the purchase date: 10,000.00 at maturity, interest 105.00", () => {
    const v = valueBondLot({ ...input, asOf: "2027-04-01" });
    expect(v.status).toBe("MATURED");
    expect(v.grossValue).toBe("10000.00");
    expect(v.accruedInterest).toBe("105.00");
    const s = redemptionSplit(input, "2027-04-01");
    expect(s.principalReturned).toBe("9895.00");
    expect(s.interest).toBe("105.00");
    expect(s.payout).toBe("10000.00");
  });

  it("values the middle of the holding period from the purchase date", () => {
    // 2026-12-31 to 2027-04-01 is 91 days; day 45 is 45/91 of 105.00 = 51.92.
    const v = valueBondLot({ ...input, asOf: "2027-02-14" });
    expect(v.grossValue).toBe("9946.92");
  });
});

describe("a bill without a known cost", () => {
  it.each([undefined, null])(
    "uses the issue price on the holding (cost %s)",
    (cost) => {
      const input = lot(bill(perHolding), "2026-10-01", cost);
      const s = redemptionSplit(input, "2027-04-01");
      expect(s.principalReturned).toBe("9783.37");
      expect(s.interest).toBe("216.63");
      const v = valueBondLot({ ...input, asOf: "2026-12-31" });
      expect(v.principalBasis).toBe("ISSUE_PRICE");
    },
  );

  it("is the same valuation as before the cost existed", () => {
    const withNull = valueBondLot({
      ...lot(bill(perHolding), "2026-10-01", null),
      asOf: "2026-12-31",
    });
    const without = valueBondLot({
      ...lot(bill(perHolding), "2026-10-01"),
      asOf: "2026-12-31",
    });
    expect(withNull).toEqual(without);
  });
});

describe("a cost that cannot be used", () => {
  it("is refused when it is not a non-negative decimal", () => {
    for (const cost of ["abc", "-5", "1e3"]) {
      expect(() =>
        valueBondLot({
          ...lot(bill(perHolding), "2026-10-01", cost),
          asOf: "2026-12-31",
        }),
      ).toThrow(/lot\.cost/);
    }
  });

  it("is ignored by an instrument that is not a discount", () => {
    const coupon = parseBondTerms({
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
      rounding: { moneyDecimals: 2, mode: "HALF_UP" },
      source: { provider: "TEST", url: "https://example.test", document: "d" },
    });
    const plain = valueBondLot({
      ...lot(coupon, "2026-01-01"),
      asOf: "2026-04-03",
    });
    const costed = valueBondLot({
      ...lot(coupon, "2026-01-01", "9000.00"),
      asOf: "2026-04-03",
    });
    expect(costed).toEqual(plain);
    expect(plain.principalBasis).toBeNull();
  });
});

describe("the series functions agree with a single valuation", () => {
  const input = lot(bill(perHolding), "2026-12-31", "9895.00");
  const days = ["2026-12-31", "2027-02-14", "2027-04-01", "2027-05-01"];

  it("gives the same values and gross figures day by day", () => {
    const series = valueBondLotSeries({ ...input, days });
    const gross = grossValueSeries({ ...input, days });
    days.forEach((day, i) => {
      expect(series[i]).toEqual(valueBondLot({ ...input, asOf: day }));
      expect(gross[i].grossValue).toBe(series[i].grossValue);
    });
  });
});

describe("per-unit rounding", () => {
  it("still gives the cost as the principal of the holding", () => {
    const input = lot(
      bill({ moneyDecimals: 2, mode: "HALF_UP" }),
      "2026-10-01",
      "9783.37",
    );
    const s = redemptionSplit(input, "2027-04-01");
    expect(s.principalReturned).toBe("9783.37");
    expect(s.payout).toBe("10000.00");
  });
});
