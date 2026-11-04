import { readFileSync } from "fs";
import { join } from "path";
import {
  MARKET_INDEXES,
  MARKET_INDEX_CODES,
  catalogExchangesAreCanonical,
  marketIndexByCode,
} from "./market-indexes";
import { SECURITY_EXCHANGES } from "./security-enums";

/**
 * The catalog is a constant, so these are the invariants a constant can break:
 * a duplicate key that makes one index shadow another, an exchange code that no
 * longer exists, or a currency the seeder never inserts (which would make the
 * index's own currency label unresolvable).
 */
describe("market index catalog", () => {
  it("is not empty and covers every region", () => {
    expect(MARKET_INDEXES.length).toBeGreaterThan(0);
    expect(new Set(MARKET_INDEXES.map((index) => index.region))).toEqual(
      new Set(["NORTH_AMERICA", "EUROPE", "ASIA_PACIFIC"]),
    );
  });

  it("has a unique code per index", () => {
    expect(new Set(MARKET_INDEX_CODES).size).toBe(MARKET_INDEXES.length);
  });

  it("has a unique provider symbol per index", () => {
    const symbols = MARKET_INDEXES.map((index) => index.yahooSymbol);
    expect(new Set(symbols).size).toBe(MARKET_INDEXES.length);
  });

  it("keeps every code within the stored column width", () => {
    // market_index_prices.index_code is VARCHAR(32); a longer code would be
    // rejected by the database on the first write rather than here.
    for (const code of MARKET_INDEX_CODES) {
      expect(code.length).toBeLessThanOrEqual(32);
      expect(code).toMatch(/^[A-Z0-9_]+$/);
    }
  });

  it("names only canonical exchanges", () => {
    expect(catalogExchangesAreCanonical()).toBe(true);
    const canonical = new Set<string>(SECURITY_EXCHANGES);
    for (const index of MARKET_INDEXES) {
      for (const exchange of index.exchanges) {
        expect(canonical.has(exchange)).toBe(true);
      }
    }
  });

  /**
   * A currency the seeder does not insert would leave the index's quoted
   * currency unresolvable in the UI, and would break a later change that joins
   * on `currencies.code`.
   */
  it("quotes every index in a seeded currency", () => {
    const seeder = readFileSync(
      join(__dirname, "..", "database", "seed.service.ts"),
      "utf8",
    );
    for (const index of MARKET_INDEXES) {
      expect(seeder).toContain(`code: "${index.currencyCode}"`);
    }
  });

  it("gives every supported exchange at least one benchmark", () => {
    const covered = new Set(
      MARKET_INDEXES.flatMap((index) => [...index.exchanges]),
    );
    // The exchanges deliberately left without one, so adding an exchange is a
    // decision about its benchmark rather than a silent omission. CRYPTO has
    // none: the catalog is equity indexes, and a coin is benchmarked against
    // whichever of them the reader picks, as any other holding can be.
    const withoutBenchmark = SECURITY_EXCHANGES.filter(
      (exchange) => !covered.has(exchange),
    );
    expect(withoutBenchmark).toEqual(["CRYPTO"]);
  });

  it("resolves a code and refuses one it does not know", () => {
    expect(marketIndexByCode("SP500")?.yahooSymbol).toBe("^GSPC");
    expect(marketIndexByCode("NOT_AN_INDEX")).toBeUndefined();
    // Codes are the DTO's allowed values, so a lookup must not be case-loose:
    // accepting "sp500" here would let a request past validation that no stored
    // row could ever match.
    expect(marketIndexByCode("sp500")).toBeUndefined();
  });
});
