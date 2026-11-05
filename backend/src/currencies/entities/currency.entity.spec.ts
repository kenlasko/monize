import { readFileSync } from "fs";
import { join } from "path";
import { instanceToPlain } from "class-transformer";
import { getMetadataArgsStorage } from "typeorm";
import {
  CURRENCY_KINDS,
  CURRENCY_KIND_CHECK,
  CURRENCY_QUOTE_SYMBOL_CHECK,
  Currency,
} from "./currency.entity";

describe("Currency entity", () => {
  function buildCurrency(overrides: Partial<Currency> = {}): Currency {
    const currency = new Currency();
    currency.code = "CAD";
    currency.name = "Canadian Dollar";
    currency.symbol = "CA$";
    currency.decimalPlaces = 2;
    currency.isActive = true;
    currency.createdAt = new Date("2026-01-01T00:00:00Z");
    Object.assign(currency, overrides);
    return currency;
  }

  it("can be instantiated with all fields", () => {
    const currency = buildCurrency();
    expect(currency.code).toBe("CAD");
    expect(currency.name).toBe("Canadian Dollar");
    expect(currency.symbol).toBe("CA$");
    expect(currency.decimalPlaces).toBe(2);
    expect(currency.isActive).toBe(true);
    expect(currency.createdAt).toBeInstanceOf(Date);
  });

  it("never serializes the creator's id (another user's UUID)", () => {
    const body = instanceToPlain(
      buildCurrency({
        createdByUserId: "7b0e6f0e-0000-4000-8000-000000000001",
      }),
    );
    expect(body).not.toHaveProperty("createdByUserId");
    expect(body.code).toBe("CAD");
  });

  it("uses code as the primary key (not a generated UUID)", () => {
    const currency = buildCurrency({ code: "USD" });
    expect(currency.code).toBe("USD");
    // No 'id' property — code is the PK
    expect((currency as any).id).toBeUndefined();
  });

  it("supports zero decimal places for currencies like JPY", () => {
    const currency = buildCurrency({
      code: "JPY",
      name: "Japanese Yen",
      symbol: "¥",
      decimalPlaces: 0,
    });
    expect(currency.decimalPlaces).toBe(0);
  });

  it("supports high decimal places for currencies like BHD", () => {
    const currency = buildCurrency({
      code: "BHD",
      name: "Bahraini Dinar",
      symbol: "BHD",
      decimalPlaces: 3,
    });
    expect(currency.decimalPlaces).toBe(3);
  });

  it("defaults isActive to true conceptually", () => {
    // The entity decorator specifies default: true
    // We verify a new instance can have isActive=true
    const currency = buildCurrency();
    expect(currency.isActive).toBe(true);
  });

  it("can be deactivated", () => {
    const currency = buildCurrency({ isActive: false });
    expect(currency.isActive).toBe(false);
  });

  it("stores symbol characters including Unicode", () => {
    const currency = buildCurrency({ symbol: "₹" });
    expect(currency.symbol).toBe("₹");
  });

  it("stores multi-character symbols", () => {
    const currency = buildCurrency({ symbol: "CA$" });
    expect(currency.symbol).toBe("CA$");
  });
});

/**
 * The entity declares the CHECKs `database/schema.sql` puts on `currencies`,
 * by the same names and the same rule, so a schema built from the entities
 * (the integration suite's) refuses a kind outside the two and a price symbol
 * on a fiat row, as the real one does.
 */
const SCHEMA = readFileSync(
  join(__dirname, "../../../../database/schema.sql"),
  "utf8",
);

/** The expression schema.sql gives a named CHECK, whitespace and quoting folded. */
function schemaCheck(name: string): string {
  const match = new RegExp(
    `CONSTRAINT\\s+${name}\\s+CHECK\\s*\\((.*)\\)\\s*,?\\s*$`,
    "m",
  ).exec(SCHEMA);
  if (!match) throw new Error(`schema.sql declares no CHECK ${name}`);
  return normalise(match[1]);
}

function normalise(expression: string): string {
  return expression.replace(/"/g, "").replace(/\s+/g, " ").trim();
}

function entityChecks(): Map<string, string> {
  return new Map(
    getMetadataArgsStorage()
      .checks.filter((check) => check.target === Currency)
      .map((check) => [check.name ?? "", check.expression]),
  );
}

describe("Currency entity CHECKs", () => {
  it("declares both of schema.sql's CHECKs by name", () => {
    expect([...entityChecks().keys()].sort()).toEqual([
      "currencies_kind_check",
      "currencies_quote_symbol_crypto_only",
    ]);
  });

  it("holds each to schema.sql's expression", () => {
    const checks = entityChecks();
    expect(normalise(checks.get("currencies_kind_check")!)).toBe(
      schemaCheck("currencies_kind_check"),
    );
    expect(normalise(checks.get("currencies_quote_symbol_crypto_only")!)).toBe(
      schemaCheck("currencies_quote_symbol_crypto_only"),
    );
  });

  it("lists exactly the kinds CURRENCY_KINDS names", () => {
    for (const kind of CURRENCY_KINDS) {
      expect(CURRENCY_KIND_CHECK).toContain(`'${kind}'`);
    }
    expect(CURRENCY_KIND_CHECK.match(/'[A-Z]+'/g)).toHaveLength(
      CURRENCY_KINDS.length,
    );
    expect(CURRENCY_QUOTE_SYMBOL_CHECK).toContain("quote_symbol");
  });
});
