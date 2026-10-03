import { readFileSync } from "fs";
import { join } from "path";

import { roundMoney } from "../common/round.util";
import {
  MortgagePaymentFrequency,
  calculateEffectiveAnnualRate,
  calculateMortgageAmortization,
  getPeriodicRate,
} from "./mortgage-amortization.util";
import {
  MORTGAGE_TYPES,
  MORTGAGE_TYPE_TRAITS,
  PREPAYMENT_MODES,
  MortgageType,
  MortgageTypeTraits,
} from "./mortgage-type.util";

/**
 * `MORTGAGE_TYPES` is one list, and this is where that is checked: the
 * `accounts_mortgage_type_check` CHECK in `database/schema.sql` is the only
 * list the database accepts (docs/specs/mortgage-types.md, decision 1), and the
 * two are compared in both directions. A type the constant knows and the
 * database refuses fails a save at runtime; a type the database accepts and the
 * constant does not know reads back as a value no trait describes.
 *
 * The second half reads `mortgage-type-cases.json`, the parity fixture the
 * frontend contract test reads too (the `loan-rate-timeline-cases.json`
 * pattern), and reproduces it through the type-keyed functions.
 */

const SCHEMA_PATH = join(__dirname, "..", "..", "..", "database", "schema.sql");

const CHECK_PATTERN =
  /CONSTRAINT\s+accounts_mortgage_type_check\s+CHECK\s*\(\s*mortgage_type\s+IN\s*\(([^)]*)\)\s*\)/i;

/**
 * The values `accounts_mortgage_type_check` admits. Throws when the constraint
 * is not found: an empty list would make the both-directions comparison check
 * nothing once the constraint is renamed or reworded.
 */
export function parseMortgageTypeCheck(sql: string): string[] {
  const match = CHECK_PATTERN.exec(sql);
  if (!match) {
    throw new Error(
      "No `CONSTRAINT accounts_mortgage_type_check CHECK (mortgage_type IN " +
        "(...))` found in database/schema.sql. The constraint was renamed or " +
        "reworded; update this parser, or this guard is checking nothing.",
    );
  }
  return [...match[1].matchAll(/'([^']*)'/g)].map((m) => m[1]).sort();
}

interface MortgageTypeCase {
  type: MortgageType;
  traits: MortgageTypeTraits;
  example: {
    principal: number;
    annualRate: number;
    periodsPerYear: number;
    totalPayments: number;
    periodicRate: number;
    firstPrincipal: number;
    firstInterest: number;
    effectiveAnnualRate: number;
  };
}

interface MortgageTypeCases {
  types: MortgageTypeCase[];
}

const cases: MortgageTypeCases = JSON.parse(
  readFileSync(join(__dirname, "mortgage-type-cases.json"), "utf8"),
);

/**
 * The first installment's principal, from the preview's method branch
 * (`calculateMortgageAmortization`, spec section 5.1): the annuity split, the
 * LINEAR `c` or the INTEREST_ONLY zero.
 */
function firstPrincipal(
  type: MortgageType,
  example: MortgageTypeCase["example"],
): number {
  const frequency: Record<number, MortgagePaymentFrequency> = {
    12: "MONTHLY",
    24: "SEMI_MONTHLY",
    26: "BIWEEKLY",
    52: "WEEKLY",
  };
  return calculateMortgageAmortization({
    principal: example.principal,
    annualRate: example.annualRate,
    amortizationMonths: (example.totalPayments * 12) / example.periodsPerYear,
    paymentFrequency: frequency[example.periodsPerYear],
    mortgageType: type,
    startDate: new Date("2024-01-01"),
  }).principalPayment;
}

const PREPAYMENT_CHECK_PATTERN =
  /CONSTRAINT\s+accounts_prepayment_mode_check\s+CHECK\s*\(\s*prepayment_mode\s+IN\s*\(([^)]*)\)\s*\)/i;

describe("PREPAYMENT_MODES and the schema CHECK", () => {
  it("matches accounts_prepayment_mode_check in both directions", () => {
    const match = PREPAYMENT_CHECK_PATTERN.exec(
      readFileSync(SCHEMA_PATH, "utf8"),
    );
    if (!match) {
      throw new Error(
        "No `CONSTRAINT accounts_prepayment_mode_check CHECK (prepayment_mode " +
          "IN (...))` found in database/schema.sql; update this parser.",
      );
    }
    expect(
      [...match[1].matchAll(/'([^']*)'/g)].map((m) => m[1]).sort(),
    ).toEqual([...PREPAYMENT_MODES].sort());
  });
});

describe("MORTGAGE_TYPES and the schema CHECK", () => {
  const schema = readFileSync(SCHEMA_PATH, "utf8");

  it("finds the constraint it is meant to check", () => {
    const parsed = parseMortgageTypeCheck(schema);
    expect(parsed.length).toBeGreaterThan(1);
    expect(parsed).toContain("ANNUITY");
  });

  it("throws rather than passing when the constraint is gone", () => {
    expect(() => parseMortgageTypeCheck("CREATE TABLE accounts ();")).toThrow(
      /renamed or reworded/,
    );
  });

  it("matches database/schema.sql in both directions", () => {
    expect(parseMortgageTypeCheck(schema)).toEqual([...MORTGAGE_TYPES].sort());
  });
});

describe("mortgage-type-cases.json", () => {
  it("has exactly one case per type", () => {
    expect(cases.types.map((c) => c.type).sort()).toEqual(
      [...MORTGAGE_TYPES].sort(),
    );
  });

  it.each(cases.types.map((c) => [c.type, c] as const))(
    "%s: traits match MORTGAGE_TYPE_TRAITS",
    (type, c) => {
      expect(MORTGAGE_TYPE_TRAITS[type]).toEqual(c.traits);
    },
  );

  it.each(cases.types.map((c) => [c.type, c.example] as const))(
    "%s: the example reproduces through the type-keyed functions",
    (type, example) => {
      const periodicRate = getPeriodicRate(
        example.annualRate,
        example.periodsPerYear,
        type,
      );
      expect(periodicRate).toBeCloseTo(example.periodicRate, 15);
      expect(roundMoney(example.principal * periodicRate)).toBe(
        example.firstInterest,
      );
      expect(firstPrincipal(type, example)).toBe(example.firstPrincipal);
      expect(
        calculateEffectiveAnnualRate(
          example.annualRate,
          example.periodsPerYear,
          type,
        ),
      ).toBe(example.effectiveAnnualRate);
    },
  );
});
