import { manifestDocument } from "../adapters/pl/pl-test-input";
import { BondTermsError, parseBondTerms } from "./bond-terms";

type Doc = Record<string, any>;

/** A country-neutral marketable discount bill (spec `bond-marketable-primitives.md` 3). */
function marketableDoc(change: (doc: Doc) => void = () => undefined): Doc {
  const doc = manifestDocument("tos1029");
  doc.instrument.marketability = "MARKETABLE";
  doc.instrument.faceValue = "100";
  doc.instrument.issuePrice = "97.833694";
  doc.saleWindow = null;
  doc.schedule = {
    anchor: "ISSUE_DATE",
    issueDate: "2026-10-01",
    maturityDate: "2027-04-01",
    periodCount: 1,
    calendarId: "XX",
  };
  doc.rateRule = { type: "ZERO_COUPON_DISCOUNT" };
  doc.capitalization = { type: "NONE" };
  doc.redemption = { type: "MATURITY_ONLY" };
  change(doc);
  return doc;
}

function refusalOf(doc: Doc): BondTermsError {
  try {
    parseBondTerms(doc);
  } catch (error) {
    expect(error).toBeInstanceOf(BondTermsError);
    return error as BondTermsError;
  }
  throw new Error("expected parseBondTerms to throw");
}

describe("parseBondTerms: a marketable bill priced at par", () => {
  it("accepts an issue price equal to the face value (no discount)", () => {
    const doc = marketableDoc((d) => (d.instrument.issuePrice = "100.00"));
    expect(parseBondTerms(doc)).toEqual(doc);
  });

  it.each([
    ["above the face value", "100.000001"],
    ["zero", "0"],
  ])("refuses an issue price %s", (_name, price) => {
    const error = refusalOf(
      marketableDoc((d) => (d.instrument.issuePrice = price)),
    );
    expect(error.field).toBe("terms.instrument.issuePrice");
  });
});

describe("parseBondTerms: MARKETABLE marketability", () => {
  it("accepts a marketable instrument unchanged", () => {
    expect(parseBondTerms(marketableDoc())).toEqual(marketableDoc());
  });

  it("still refuses an unknown marketability", () => {
    expect(
      refusalOf(marketableDoc((d) => (d.instrument.marketability = "TRADED")))
        .field,
    ).toBe("terms.instrument.marketability");
  });

  it("refuses a sale window", () => {
    const error = refusalOf(
      marketableDoc(
        (d) => (d.saleWindow = { from: "2026-09-01", to: "2026-10-01" }),
      ),
    );
    expect(error.field).toBe("terms.saleWindow");
    expect(error.code).toBe("INVALID");
  });

  it("refuses a redemption on demand", () => {
    const error = refusalOf(
      marketableDoc((d) => {
        d.redemption = manifestDocument("ror1027").redemption;
      }),
    );
    expect(error.field).toBe("terms.redemption");
  });

  it("leaves a retail instrument free to have a sale window and early redemption", () => {
    const doc = manifestDocument("ror1027");
    expect(doc.instrument.marketability).toBe("RETAIL_REDEEMABLE");
    expect(parseBondTerms(doc)).toEqual(doc);
  });
});
