import { BondTermsError, parseBondTerms } from "./bond-terms";
import { FLOAT_ID, floatingDoc } from "@/test-helpers/bond-floating-terms";

const doc = (change?: (d: Record<string, any>) => void) =>
  floatingDoc({ spread: "0.00103" }, change);

function refusal(document: unknown): BondTermsError {
  try {
    parseBondTerms(document);
  } catch (error) {
    if (error instanceof BondTermsError) return error;
    throw error;
  }
  throw new Error("expected the terms to be refused");
}

describe("rateRule DAILY_INDEX_PLUS_SPREAD (spec 7.2)", () => {
  it("parses the rule exactly as stated", () => {
    expect(parseBondTerms(doc()).rateRule).toStrictEqual({
      type: "DAILY_INDEX_PLUS_SPREAD",
      benchmarkId: FLOAT_ID,
      spread: "0.00103",
      floor: "0",
      lockoutBusinessDays: 2,
      calendarId: "TEST",
      dailyDecimals: 9,
    });
  });

  it("accepts a negative spread, and only the spread (signedDecimal)", () => {
    const negative = floatingDoc({ spread: "-0.0015" });
    expect(parseBondTerms(negative).rateRule).toMatchObject({
      spread: "-0.0015",
    });
    const error = refusal(
      doc((d) => {
        d.rateRule.floor = "-0.01";
      }),
    );
    expect(error.field).toBe("terms.rateRule.floor");
  });

  it("refuses a number where a decimal string is required (INV-BOND-003)", () => {
    const error = refusal(
      doc((d) => {
        d.rateRule.spread = 0.00103;
      }),
    );
    expect(error.field).toBe("terms.rateRule.spread");
  });

  it("refuses an unknown field and a missing field, with the path", () => {
    expect(
      refusal(
        doc((d) => {
          d.rateRule.extra = 1;
        }),
      ).field,
    ).toBe("terms.rateRule.extra");
    expect(
      refusal(
        doc((d) => {
          delete d.rateRule.calendarId;
        }),
      ).field,
    ).toBe("terms.rateRule.calendarId");
  });

  it("refuses more than 12 daily decimals and a negative lockout", () => {
    expect(
      refusal(
        doc((d) => {
          d.rateRule.dailyDecimals = 13;
        }),
      ).field,
    ).toBe("terms.rateRule.dailyDecimals");
    expect(
      refusal(
        doc((d) => {
          d.rateRule.lockoutBusinessDays = -1;
        }),
      ).field,
    ).toBe("terms.rateRule.lockoutBusinessDays");
  });

  it("refuses the rule without the accrual ACTUAL_360_DAILY_SUM, and the accrual without the rule", () => {
    expect(() =>
      parseBondTerms(
        doc((d) => {
          d.accrual = { type: "ACTUAL_ACTUAL_ICMA" };
        }),
      ),
    ).toThrow(BondTermsError);
    expect(() =>
      parseBondTerms(
        doc((d) => {
          d.rateRule = { type: "FIXED" };
        }),
      ),
    ).toThrow(BondTermsError);
  });

  it("refuses a capitalising schedule", () => {
    expect(() =>
      parseBondTerms(
        doc((d) => {
          d.capitalization = "AT_PERIOD_END";
        }),
      ),
    ).toThrow(BondTermsError);
  });
});
