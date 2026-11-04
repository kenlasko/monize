import { BenchmarkData } from "../domain/benchmark";
import { BondTerms, parseBondTerms } from "../domain/bond-terms";
import {
  BondEngineInput,
  grossValueSeries,
  redemptionSplit,
  valueBondLot,
} from "./bond-engine";

type Doc = Record<string, any>;

/** A country-neutral marketable bill: face 100, issue price 97.833694, 182 days. */
function marketableBill(
  change: (doc: Doc) => void = () => undefined,
): BondTerms {
  const doc: Doc = {
    schemaVersion: 1,
    instrument: {
      issuerCountryCode: "XX",
      issuerCode: "XX_ISSUER",
      programCode: "BILL",
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
    rounding: { moneyDecimals: 2, mode: "HALF_UP" },
    source: { provider: "TEST", url: "https://example.test", document: "doc" },
  };
  change(doc);
  return parseBondTerms(doc);
}

function lotOf(
  terms: BondTerms,
  purchaseDate: string,
  over: Partial<BondEngineInput["lot"]> = {},
): Omit<BondEngineInput, "asOf"> {
  return {
    terms,
    termsVersion: 1,
    announcedRates: new Map(),
    benchmarks: new Map<string, BenchmarkData>(),
    calendars: new Map(),
    lot: { purchaseDate, quantity: 100, ...over },
  };
}

describe("a lot of a MARKETABLE series bought on or after its maturity", () => {
  const terms = marketableBill();

  it.each(["2027-04-01", "2027-04-02", "2028-01-01"])(
    "is refused when bought on %s",
    (purchaseDate) => {
      const v = valueBondLot({
        ...lotOf(terms, purchaseDate),
        asOf: "2028-06-01",
      });
      expect(v.status).toBe("REFUSED");
      expect(v.refusal).toEqual({
        code: "PURCHASE_AFTER_MATURITY",
        params: { maturityDate: "2027-04-01", purchaseDate },
      });
      expect(v.grossValue).toBeNull();
      expect(v.valuationComplete).toBe(false);
    },
  );

  it("is valued when bought the day before maturity", () => {
    const v = valueBondLot({
      ...lotOf(terms, "2027-03-31"),
      asOf: "2027-03-31",
    });
    expect(v.status).toBe("OPEN");
    expect(v.refusal).toBeNull();
    expect(v.grossValue).not.toBeNull();
  });

  it("is valued when bought before the series is issued (when-issued)", () => {
    const v = valueBondLot({
      ...lotOf(terms, "2026-09-20"),
      asOf: "2026-10-15",
    });
    expect(v.status).toBe("OPEN");
    expect(v.refusal).toBeNull();
  });

  it("is not refused when its purchase date is an assumed stand-in", () => {
    const v = valueBondLot({
      ...lotOf(terms, "2027-05-01", { purchaseDateAssumed: true }),
      asOf: "2027-05-01",
    });
    expect(v.refusal).toBeNull();
    expect(v.status).toBe("MATURED");
  });

  it("is refused by the redemption split with the same code", () => {
    const split = redemptionSplit(lotOf(terms, "2027-04-01"), "2027-04-01");
    expect(split.refusal).toBe("PURCHASE_AFTER_MATURITY");
    expect(split.payout).toBeNull();
  });

  it("has no gross value in a series, so no price for the day", () => {
    const points = grossValueSeries({
      ...lotOf(terms, "2027-04-01"),
      days: ["2027-04-01", "2027-04-02"],
    });
    expect(points.map((p) => [p.status, p.grossValue])).toEqual([
      ["REFUSED", null],
      ["REFUSED", null],
    ]);
  });

  it("does not apply to a retail instrument, whose maturity-day purchase is valued", () => {
    const retail = marketableBill((d) => {
      d.instrument.marketability = "RETAIL_REDEEMABLE";
    });
    const v = valueBondLot({
      ...lotOf(retail, "2027-04-01"),
      asOf: "2027-04-01",
    });
    expect(v.refusal).toBeNull();
    expect(v.status).toBe("MATURED");
  });
});
