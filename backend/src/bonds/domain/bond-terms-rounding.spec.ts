import { ManifestName, manifestDocument } from "../adapters/pl/pl-test-input";
import { BondTermsError, parseBondTerms, roundingBasisOf } from "./bond-terms";

type Doc = Record<string, any>;

const NAMES: ManifestName[] = [
  "tos1029",
  "ror1027",
  "coi1030",
  "edo1036",
  "dor1028",
  "ros1032",
  "rod1038",
  "ots0127",
];

function withRounding(
  rounding: Doc,
  face = "100.00",
  name: ManifestName = "ror1027",
): Doc {
  const doc = manifestDocument(name);
  doc.instrument.faceValue = face;
  doc.rounding = rounding;
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

const base = { moneyDecimals: 2, mode: "HALF_UP" };

describe("parseBondTerms: the rounding basis (P2)", () => {
  describe("a document without a basis", () => {
    it.each(NAMES)(
      "%s parses to the exact object it always did, with no basis field",
      (name) => {
        const doc = manifestDocument(name);
        const parsed = parseBondTerms(doc);
        expect(parsed.rounding).toStrictEqual(doc.rounding);
        expect(Object.keys(parsed.rounding).sort()).toEqual([
          "mode",
          "moneyDecimals",
        ]);
        expect(roundingBasisOf(parsed)).toBe("PER_UNIT");
      },
    );
  });

  it("accepts an explicit PER_UNIT basis and keeps it as written", () => {
    const parsed = parseBondTerms(withRounding({ ...base, basis: "PER_UNIT" }));
    expect(parsed.rounding).toStrictEqual({ ...base, basis: "PER_UNIT" });
    expect(roundingBasisOf(parsed)).toBe("PER_UNIT");
  });

  describe("PER_HOLDING", () => {
    it.each([0, 5, 6, 12, null])("accepts unitDecimals %s", (unitDecimals) => {
      const doc = withRounding({ ...base, basis: "PER_HOLDING", unitDecimals });
      const parsed = parseBondTerms(doc);
      expect(parsed.rounding).toStrictEqual(doc.rounding);
      expect(roundingBasisOf(parsed)).toBe("PER_HOLDING");
    });

    it("accepts it without unitDecimals (the per-unit intermediate is exact)", () => {
      const parsed = parseBondTerms(
        withRounding({ ...base, basis: "PER_HOLDING" }),
      );
      expect(parsed.rounding).toStrictEqual({ ...base, basis: "PER_HOLDING" });
    });

    it.each([
      ["13", 13],
      ["-1", -1],
      ["1.5", 1.5],
      ["a string", "6"],
      ["undefined-like NaN", Number.NaN],
    ])("refuses unitDecimals %s", (_label, unitDecimals) => {
      const error = refusalOf(
        withRounding({ ...base, basis: "PER_HOLDING", unitDecimals }),
      );
      expect(error.field).toBe("terms.rounding.unitDecimals");
    });

    it("refuses a referenceAmount", () => {
      const error = refusalOf(
        withRounding({ ...base, basis: "PER_HOLDING", referenceAmount: "100" }),
      );
      expect(error.field).toBe("terms.rounding.referenceAmount");
    });
  });

  describe("REFERENCE_AMOUNT", () => {
    const reference = (over: Doc = {}) => ({
      ...base,
      basis: "REFERENCE_AMOUNT",
      referenceAmount: "100",
      ...over,
    });

    it("accepts a positive multiple of the face value, with or without unitDecimals", () => {
      const doc = withRounding(reference({ unitDecimals: 6 }), "0.01");
      expect(parseBondTerms(doc).rounding).toStrictEqual(doc.rounding);
      const plain = withRounding(reference(), "0.01");
      expect(parseBondTerms(plain).rounding).toStrictEqual(plain.rounding);
      const same = withRounding(reference({ referenceAmount: "100.00" }));
      expect(parseBondTerms(same).rounding).toStrictEqual(same.rounding);
    });

    it("requires a referenceAmount", () => {
      const doc = withRounding(reference());
      delete doc.rounding.referenceAmount;
      expect(refusalOf(doc).field).toBe("terms.rounding.referenceAmount");
    });

    it.each([
      ["a number", 100],
      ["zero", "0"],
      ["negative", "-100"],
      ["not a multiple of the face value", "150"],
      ["smaller than the face value", "50"],
      ["not a decimal", "x"],
    ])("refuses a referenceAmount that is %s", (_label, referenceAmount) => {
      const error = refusalOf(
        withRounding(reference({ referenceAmount }), "100.00"),
      );
      expect(error.field).toBe("terms.rounding.referenceAmount");
    });
  });

  describe("PER_UNIT refuses what only another basis uses", () => {
    it.each([
      ["unitDecimals", { unitDecimals: 6 }],
      ["unitDecimals null", { unitDecimals: null }],
      ["referenceAmount", { referenceAmount: "100" }],
    ])("an absent basis with %s", (_label, extra) => {
      const error = refusalOf(withRounding({ ...base, ...extra }));
      expect(error.field).toMatch(
        /^terms\.rounding\.(unitDecimals|referenceAmount)$/,
      );
    });

    it("an explicit PER_UNIT with unitDecimals", () => {
      expect(
        refusalOf(withRounding({ ...base, basis: "PER_UNIT", unitDecimals: 6 }))
          .field,
      ).toBe("terms.rounding.unitDecimals");
    });
  });

  it("refuses an unknown basis, an unknown field and a missing mode", () => {
    expect(refusalOf(withRounding({ ...base, basis: "PER_LOT" })).field).toBe(
      "terms.rounding.basis",
    );
    expect(refusalOf(withRounding({ ...base, scale: 2 })).field).toBe(
      "terms.rounding.scale",
    );
    expect(refusalOf(withRounding({ moneyDecimals: 2 })).field).toBe(
      "terms.rounding.mode",
    );
  });
});
