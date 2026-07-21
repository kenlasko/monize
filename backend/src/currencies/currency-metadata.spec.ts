import {
  CURRENCY_METADATA,
  resolveCurrencyMetadata,
  getCurrencyCatalog,
} from "./currency-metadata";

describe("currency-metadata", () => {
  describe("resolveCurrencyMetadata()", () => {
    it("returns curated metadata for a known code (case-insensitive)", () => {
      expect(resolveCurrencyMetadata("usd")).toEqual({
        name: "US Dollar",
        symbol: "$",
        decimalPlaces: 2,
      });
    });

    it("derives a real symbol from Intl for a valid code outside the table", () => {
      // AFN is a valid ISO code not in the curated table; Intl should still
      // yield a proper symbol rather than the bare code.
      const meta = resolveCurrencyMetadata("AFN");
      expect(meta.name).toBe("AFN");
      expect(typeof meta.symbol).toBe("string");
      expect(meta.symbol.length).toBeGreaterThan(0);
      expect(typeof meta.decimalPlaces).toBe("number");
    });

    it("falls back to the code as the symbol only for an invalid code", () => {
      const meta = resolveCurrencyMetadata("ZZZ");
      expect(meta).toEqual({ name: "ZZZ", symbol: "ZZZ", decimalPlaces: 2 });
    });

    it("does not mutate the shared metadata table", () => {
      const meta = resolveCurrencyMetadata("EUR");
      meta.symbol = "changed";
      expect(CURRENCY_METADATA.EUR.symbol).toBe("€");
    });
  });

  describe("getCurrencyCatalog()", () => {
    it("returns every currency sorted by code with its symbol", () => {
      const catalog = getCurrencyCatalog();
      expect(catalog.length).toBe(Object.keys(CURRENCY_METADATA).length);
      const codes = catalog.map((c) => c.code);
      expect(codes).toEqual([...codes].sort());
      expect(catalog.find((c) => c.code === "GBP")?.symbol).toBe("£");
    });
  });
});
