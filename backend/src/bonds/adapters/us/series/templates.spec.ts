import { parseBondTerms } from "../../../domain/bond-terms";
import {
  fillBill,
  fillCoupon,
  SERIES_TEMPLATES,
  SourceDocument,
  UsProgram,
} from "./templates";

const SOURCE: SourceDocument = {
  provider: "treasurydirect",
  url: "https://www.treasurydirect.gov/TA_WS/securities/search?cusip=X",
  document: "auction 2026-09-29",
};

const COUPON = {
  seriesCode: "91282CZK0",
  datedDate: "2026-09-30",
  firstCouponDate: "2027-03-31",
  maturityDate: "2028-09-30",
  endOfMonth: true,
  annualRate: "0.0375",
  source: SOURCE,
};

describe("US templates", () => {
  it("covers the three programs with their product pages", () => {
    expect(
      Object.values(SERIES_TEMPLATES).map((t) => [t.product, t.infoUrl]),
    ).toEqual([
      [
        "BILL",
        "https://www.treasurydirect.gov/marketable-securities/treasury-bills/",
      ],
      [
        "NOTE",
        "https://www.treasurydirect.gov/marketable-securities/treasury-notes/",
      ],
      [
        "BOND",
        "https://www.treasurydirect.gov/marketable-securities/treasury-bonds/",
      ],
    ]);
  });

  it("states one unit of 100 USD, marketable, for every program", () => {
    for (const t of Object.values(SERIES_TEMPLATES)) {
      expect(t.structure.instrument).toMatchObject({
        issuerCountryCode: "US",
        issuerCode: "US_TREASURY",
        currency: "USD",
        marketability: "MARKETABLE",
        faceValue: "100",
        programCode: t.product,
      });
    }
  });

  it("parses once filled, a bill", () => {
    const terms = parseBondTerms(
      fillBill(SERIES_TEMPLATES.BILL, {
        seriesCode: "912797WM5261001",
        issueDate: "2026-10-01",
        maturityDate: "2027-04-01",
        issuePrice: "97.833694",
        source: SOURCE,
      }),
    );
    expect(terms.rounding).toEqual({
      moneyDecimals: 2,
      mode: "HALF_UP",
      basis: "PER_HOLDING",
      unitDecimals: null,
    });
    expect(terms.redemption).toEqual({ type: "MATURITY_ONLY" });
  });

  it.each<UsProgram>(["NOTE", "BOND"])(
    "parses once filled, a %s",
    (program) => {
      const terms = parseBondTerms(
        fillCoupon(SERIES_TEMPLATES[program], COUPON),
      );
      expect(terms.instrument.programCode).toBe(program);
      expect(terms.principalRule).toEqual({ type: "FIXED_NOMINAL" });
    },
  );

  it("is not changed by a fill", () => {
    const before = JSON.stringify(SERIES_TEMPLATES);
    fillCoupon(SERIES_TEMPLATES.NOTE, COUPON);
    expect(JSON.stringify(SERIES_TEMPLATES)).toBe(before);
  });
});
