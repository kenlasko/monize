import {
  MORTGAGE_TYPES,
  MORTGAGE_TYPE_TRAITS,
  amortizationMethodFor,
  annualizationFor,
  compoundingFor,
  PREPAYMENT_MODES,
  mortgageTypeOf,
  prepaymentModeColumn,
  prepaymentModeOf,
  storesConstantPayment,
} from "./mortgage-type.util";

describe("mortgageTypeOf", () => {
  it("reads the stored type", () => {
    for (const type of MORTGAGE_TYPES) {
      expect(mortgageTypeOf({ mortgageType: type })).toBe(type);
    }
  });
});

describe("prepayment mode (spec decisions 4 and 10)", () => {
  it("lists the two modes the CHECK admits", () => {
    expect([...PREPAYMENT_MODES]).toEqual([
      "SHORTEN_TERM",
      "LOWER_INSTALLMENT",
    ]);
  });

  it("reads a null mode as SHORTEN_TERM", () => {
    expect(prepaymentModeOf({ prepaymentMode: null })).toBe("SHORTEN_TERM");
    expect(prepaymentModeOf({})).toBe("SHORTEN_TERM");
    expect(prepaymentModeOf({ prepaymentMode: "LOWER_INSTALLMENT" })).toBe(
      "LOWER_INSTALLMENT",
    );
  });

  it("writes the requested mode, else the stored one, for LINEAR", () => {
    expect(prepaymentModeColumn("LINEAR", "LOWER_INSTALLMENT", null)).toBe(
      "LOWER_INSTALLMENT",
    );
    expect(prepaymentModeColumn("LINEAR", undefined, "LOWER_INSTALLMENT")).toBe(
      "LOWER_INSTALLMENT",
    );
    expect(prepaymentModeColumn("LINEAR", null, "LOWER_INSTALLMENT")).toBe(
      null,
    );
    expect(prepaymentModeColumn("LINEAR", undefined)).toBe(null);
  });

  it.each(["ANNUITY", "CANADIAN_FIXED", "INTEREST_ONLY", null] as const)(
    "writes null for %s whatever the request carries",
    (type) => {
      expect(
        prepaymentModeColumn(type, "LOWER_INSTALLMENT", "SHORTEN_TERM"),
      ).toBe(null);
    },
  );
});

describe("storesConstantPayment (spec decision 11)", () => {
  it.each([
    ["ANNUITY", true],
    ["CANADIAN_FIXED", true],
    ["LINEAR", false],
    ["INTEREST_ONLY", false],
  ] as const)("%s: %s", (type, stores) => {
    expect(storesConstantPayment(type)).toBe(stores);
  });
});

describe("MORTGAGE_TYPE_TRAITS", () => {
  // Spec table 4.1.
  it.each([
    ["ANNUITY", "NOMINAL", "ANNUITY", "DAY_COUNT"],
    ["CANADIAN_FIXED", "SEMI_ANNUAL", "ANNUITY", "SEMI_ANNUAL"],
    ["LINEAR", "NOMINAL", "LINEAR", "DAY_COUNT"],
    ["INTEREST_ONLY", "NOMINAL", "INTEREST_ONLY", "DAY_COUNT"],
  ] as const)(
    "%s compounds %s, amortizes %s, annualizes %s",
    (type, compounding, method, annualization) => {
      expect(compoundingFor(type)).toBe(compounding);
      expect(amortizationMethodFor(type)).toBe(method);
      expect(annualizationFor(type)).toBe(annualization);
    },
  );

  it("has a row for every type and no other", () => {
    expect(Object.keys(MORTGAGE_TYPE_TRAITS).sort()).toEqual(
      [...MORTGAGE_TYPES].sort(),
    );
  });

  it("cannot be mutated at runtime", () => {
    expect(Object.isFrozen(MORTGAGE_TYPE_TRAITS)).toBe(true);
    for (const type of MORTGAGE_TYPES) {
      expect(Object.isFrozen(MORTGAGE_TYPE_TRAITS[type])).toBe(true);
    }
  });
});
