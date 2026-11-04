import {
  cryptoLookupFields,
  cryptoPairFiat,
  isCryptoExchange,
} from "./crypto-pair.util";

describe("cryptoPairFiat", () => {
  it("reads the fiat leg of a Yahoo pair", () => {
    expect(cryptoPairFiat("BTC-EUR")).toBe("EUR");
    expect(cryptoPairFiat("BTC-USD")).toBe("USD");
    expect(cryptoPairFiat("dot-cad")).toBe("CAD");
    // The fiat is the leg after the LAST hyphen.
    expect(cryptoPairFiat("UNI7083-USD")).toBe("USD");
  });

  // Unknown is null, never a default currency.
  it("answers null for a symbol that is not a pair in a known currency", () => {
    expect(cryptoPairFiat("BTC")).toBeNull();
    expect(cryptoPairFiat("BTC-USDT")).toBeNull();
    expect(cryptoPairFiat("ENB-PFU")).toBeNull();
    expect(cryptoPairFiat("-EUR")).toBeNull();
    expect(cryptoPairFiat("AAPL")).toBeNull();
  });
});

describe("cryptoLookupFields", () => {
  it("names the canonical exchange and falls back to the fiat leg", () => {
    expect(cryptoLookupFields("BTC-EUR")).toEqual({
      exchange: "CRYPTO",
      currencyCode: "EUR",
    });
    expect(cryptoLookupFields("BTC-EUR", null)).toEqual({
      exchange: "CRYPTO",
      currencyCode: "EUR",
    });
  });

  // The provider's answer is evidence; the symbol is only a convention.
  it("keeps a currency the provider reported", () => {
    expect(cryptoLookupFields("BTC-EUR", "USD").currencyCode).toBe("USD");
    expect(cryptoLookupFields("BTC", "GBP").currencyCode).toBe("GBP");
  });

  // Unknown is null, never USD.
  it("answers null when neither the provider nor the symbol names one", () => {
    expect(cryptoLookupFields("BTC").currencyCode).toBeNull();
    expect(cryptoLookupFields("BTC-USDT", "").currencyCode).toBeNull();
  });
});

describe("isCryptoExchange", () => {
  // `CCC` is what a coin created before the lookup named `CRYPTO` still carries.
  it("recognises the canonical exchange and Yahoo's legacy venue", () => {
    expect(isCryptoExchange("CRYPTO")).toBe(true);
    expect(isCryptoExchange("CCC")).toBe(true);
    expect(isCryptoExchange(" ccc ")).toBe(true);
  });

  it("does not mistake a listing's exchange, or none, for one", () => {
    expect(isCryptoExchange("TSX")).toBe(false);
    expect(isCryptoExchange("NYSE")).toBe(false);
    expect(isCryptoExchange(null)).toBe(false);
    expect(isCryptoExchange(undefined)).toBe(false);
  });
});
