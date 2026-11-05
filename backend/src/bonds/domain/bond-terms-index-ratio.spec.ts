import { manifestDocument } from "../adapters/pl/pl-test-input";
import { BondTermsError, parseBondTerms } from "./bond-terms";
import { INDEX_ID, indexedDoc } from "@/test-helpers/bond-indexed-terms";

const dates = {
  datedDate: "2026-07-01",
  firstCouponDate: "2027-01-01",
  maturityDate: "2028-01-01",
  rate: "0.03875",
  base: "164",
};

const doc = (change?: (d: Record<string, any>) => void) =>
  indexedDoc(dates, change);

function refusal(document: unknown): BondTermsError {
  try {
    parseBondTerms(document);
  } catch (error) {
    if (error instanceof BondTermsError) return error;
    throw error;
  }
  throw new Error("expected the terms to be refused");
}

describe("principalRule INDEX_RATIO (spec 7.1)", () => {
  it("parses the rule exactly as stated", () => {
    expect(parseBondTerms(doc()).principalRule).toStrictEqual({
      type: "INDEX_RATIO",
      benchmarkId: INDEX_ID,
      baseReference: "164",
      lagMonths: 3,
      interpolation: "DAILY_LINEAR",
      truncateDecimals: 6,
      roundDecimals: 5,
      maturityFloor: "PAR",
    });
  });

  it("accepts maturityFloor NONE", () => {
    const terms = parseBondTerms(
      indexedDoc({ ...dates, maturityFloor: "NONE" }),
    );
    expect(terms.principalRule).toMatchObject({ maturityFloor: "NONE" });
  });

  it("refuses an unknown field, with its path", () => {
    const error = refusal(
      doc((d) => {
        d.principalRule.extra = 1;
      }),
    );
    expect(error.field).toBe("terms.principalRule.extra");
  });

  it("refuses a missing field", () => {
    const error = refusal(
      doc((d) => {
        delete d.principalRule.lagMonths;
      }),
    );
    expect(error.field).toBe("terms.principalRule.lagMonths");
  });

  it("refuses a number where a decimal string is required (INV-BOND-003)", () => {
    const error = refusal(
      doc((d) => {
        d.principalRule.baseReference = 164;
      }),
    );
    expect(error.field).toBe("terms.principalRule.baseReference");
    expect(error.message).toMatch(/not a number/);
  });

  it.each([["0"], ["-1"]])("refuses the base reference %s", (value) => {
    expect(
      refusal(
        doc((d) => {
          d.principalRule.baseReference = value;
        }),
      ).field,
    ).toBe("terms.principalRule.baseReference");
  });

  it("refuses an unsupported interpolation as an unsupported value", () => {
    const error = refusal(
      doc((d) => {
        d.principalRule.interpolation = "STEP";
      }),
    );
    expect(error.field).toBe("terms.principalRule.interpolation");
  });

  it.each([
    ["lagMonths", 0],
    ["lagMonths", 13],
    ["truncateDecimals", 13],
    ["truncateDecimals", -1],
    ["roundDecimals", 7],
    ["maturityFloor", "ALWAYS"],
  ])("refuses %s = %s", (field, value) => {
    expect(
      refusal(
        doc((d) => {
          d.principalRule[field] = value;
        }),
      ).field,
    ).toBe(`terms.principalRule.${field}`);
  });

  it("refuses an unknown principal type as an unsupported primitive", () => {
    const error = refusal(
      doc((d) => {
        d.principalRule = { type: "AMORTISING" };
      }),
    );
    expect(error.code).toBe("UNSUPPORTED_PRIMITIVE");
  });

  describe("only beside the primitives it is defined with", () => {
    it("refuses a lot-anchored schedule", () => {
      const edo = manifestDocument("edo1036");
      edo.principalRule = doc().principalRule;
      expect(refusal(edo).field).toBe("terms.schedule.anchor");
    });

    it("refuses a redemption other than MATURITY_ONLY", () => {
      const error = refusal(
        doc((d) => {
          d.instrument.marketability = "RETAIL_REDEEMABLE";
          d.saleWindow = { from: "2026-01-01", to: "2026-12-31" };
          d.redemption = {
            type: "ON_DEMAND",
            earliestDaysAfterPurchase: 0,
            latestDaysBeforeMaturity: 0,
            blackouts: [],
            penalties: [],
            proceedsFloor: null,
          };
        }),
      );
      expect(error.field).toBe("terms.redemption");
    });

    it("refuses a rate rule that reads the same benchmark (a rate is not an index level)", () => {
      const error = refusal(
        doc((d) => {
          d.rateRule = {
            type: "BENCHMARK_PLUS_SPREAD",
            benchmarkId: INDEX_ID,
            spread: "0.01",
            firstPeriodRate: null,
            benchmarkFloor: null,
            observation: {
              type: "MONTHLY_VALUE_MONTHS_BEFORE_START",
              months: 3,
            },
          };
        }),
      );
      expect(error.field).toBe("terms.principalRule.benchmarkId");
    });
  });

  it("leaves a stored document with a fixed nominal as it parses today", () => {
    const plain = manifestDocument("tos1029");
    expect(parseBondTerms(plain).principalRule).toStrictEqual({
      type: "FIXED_NOMINAL",
    });
  });
});
