import { BondTerms, parseBondTerms } from "../domain/bond-terms";
import { ExactDecimal } from "../domain/exact-decimal";
import { roundLot, unitRound, unitText } from "./rounding";

type Doc = Record<string, any>;

function termsWith(rounding: Doc, face = "100"): BondTerms {
  const doc: Doc = {
    schemaVersion: 1,
    instrument: {
      issuerCountryCode: "XX",
      issuerCode: "XX_ISSUER",
      programCode: "TEST",
      seriesCode: "TEST-1",
      currency: "XXX",
      marketability: "RETAIL_REDEEMABLE",
      faceValue: face,
    },
    saleWindow: null,
    schedule: {
      anchor: "LOT_PURCHASE_DATE",
      periodMonths: 6,
      periodCount: 2,
      rollDay: "ANCHOR_DAY_CLAMPED",
      calendarId: "NEUTRAL",
    },
    accrual: { type: "ACTUAL_DAYS_IN_PERIOD" },
    principalRule: { type: "FIXED_NOMINAL" },
    rateRule: { type: "FIXED", annualRate: "0.05" },
    capitalization: { type: "NONE" },
    redemption: { type: "MATURITY_ONLY" },
    rounding,
    source: { provider: "TEST", url: "https://example.test", document: "doc" },
  };
  return parseBondTerms(doc);
}

const d = (text: string) => ExactDecimal.parse(text);
const q = (n: number) => ExactDecimal.fromInt(n);

describe("roundLot: the one place the rounding basis is applied", () => {
  describe("PER_UNIT (the default): each unit rounded, then multiplied", () => {
    const terms = termsWith({ moneyDecimals: 2, mode: "HALF_UP" });

    it("rounds the unit figure first", () => {
      // 1.005 -> 1.01, x 3 = 3.03 (not 3.015 rounded once).
      expect(roundLot(terms, d("1.005"), q(3)).toFixed(2)).toBe("3.03");
    });

    it("is the same for an accrued interest: unitDecimals is not read", () => {
      expect(roundLot(terms, d("1.005"), q(3), "ACCRUED").toFixed(2)).toBe(
        "3.03",
      );
    });

    it("honours the mode", () => {
      const down = termsWith({ moneyDecimals: 2, mode: "DOWN" });
      expect(roundLot(down, d("1.009"), q(3)).toFixed(2)).toBe("3.00");
      const even = termsWith({ moneyDecimals: 2, mode: "HALF_EVEN" });
      expect(roundLot(even, d("1.005"), q(3)).toFixed(2)).toBe("3.00");
    });
  });

  describe("PER_HOLDING: the lot rounded once", () => {
    it("rounds the product, not the unit", () => {
      const terms = termsWith({
        moneyDecimals: 2,
        mode: "HALF_UP",
        basis: "PER_HOLDING",
      });
      // 1.005 x 3 = 3.015 -> 3.02.
      expect(roundLot(terms, d("1.005"), q(3)).toFixed(2)).toBe("3.02");
    });

    it("rounds an accrued interest to unitDecimals first, and any other figure not at all", () => {
      const terms = termsWith({
        moneyDecimals: 2,
        mode: "HALF_UP",
        basis: "PER_HOLDING",
        unitDecimals: 3,
      });
      // 0.0149 -> 0.015 per unit, x 1000 = 15.00; exact would be 14.90.
      expect(roundLot(terms, d("0.0149"), q(1000), "ACCRUED").toFixed(2)).toBe(
        "15.00",
      );
      expect(roundLot(terms, d("0.0149"), q(1000)).toFixed(2)).toBe("14.90");
    });

    it("leaves the unit exact when unitDecimals is null", () => {
      const terms = termsWith({
        moneyDecimals: 2,
        mode: "HALF_UP",
        basis: "PER_HOLDING",
        unitDecimals: null,
      });
      expect(roundLot(terms, d("0.0149"), q(1000), "ACCRUED").toFixed(2)).toBe(
        "14.90",
      );
    });

    it("gives the lot figure on the money grid, so its text is exact", () => {
      const terms = termsWith({
        moneyDecimals: 2,
        mode: "HALF_UP",
        basis: "PER_HOLDING",
        unitDecimals: 6,
      });
      const lot = roundLot(terms, d("1.71546961325"), q(1500), "ACCRUED");
      expect(lot.toFixed(2)).toBe("2573.21");
      expect(lot.cmp(ExactDecimal.parse(lot.toFixed(2)))).toBe(0);
    });
  });

  describe("REFERENCE_AMOUNT: the value of one reference amount, scaled and rounded again", () => {
    // E15: a 100 USD savings bond is worth 101.96; par 34.59 is 3,459 units of 0.01.
    const terms = termsWith(
      {
        moneyDecimals: 2,
        mode: "HALF_UP",
        basis: "REFERENCE_AMOUNT",
        referenceAmount: "100",
      },
      "0.01",
    );

    it("E15: 0.3459 x 101.96 = 35.267964 -> 35.27", () => {
      expect(roundLot(terms, d("0.010196"), q(3459)).toFixed(2)).toBe("35.27");
    });

    it("rounds the reference value before scaling it, which a single rounding does not", () => {
      expect(roundLot(terms, d("0.010196"), q(10000)).toFixed(2)).toBe(
        "101.96",
      );
      // Unit 0.0101954: 100 USD is worth 101.954 -> 101.95, and 0.3459 of it is
      // 35.2646 -> 35.26; rounded once on the holding, 35.2659 is 35.27.
      expect(roundLot(terms, d("0.0101954"), q(3459)).toFixed(2)).toBe("35.26");
      const holding = termsWith(
        { moneyDecimals: 2, mode: "HALF_UP", basis: "PER_HOLDING" },
        "0.01",
      );
      expect(roundLot(holding, d("0.0101954"), q(3459)).toFixed(2)).toBe(
        "35.27",
      );
    });
  });

  describe("unitRound and unitText", () => {
    it("print a unit's figure at the money decimals under PER_UNIT", () => {
      const terms = termsWith({ moneyDecimals: 2, mode: "HALF_UP" });
      expect(unitRound(terms, d("97.833694")).toFixed(6)).toBe("97.830000");
      expect(unitText(terms, d("97.833694"))).toBe("97.83");
    });

    it("print it at the finer of the money decimals and unitDecimals under another basis", () => {
      const fine = termsWith({
        moneyDecimals: 2,
        mode: "HALF_UP",
        basis: "PER_HOLDING",
        unitDecimals: 6,
      });
      expect(unitText(fine, d("97.8336944"))).toBe("97.833694");
      const plain = termsWith({
        moneyDecimals: 2,
        mode: "HALF_UP",
        basis: "PER_HOLDING",
      });
      expect(unitText(plain, d("97.8336944"))).toBe("97.83");
    });
  });
});
