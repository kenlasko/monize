import {
  quoteSymbolCoinTicker,
  quoteSymbolRefusal,
} from "./currency-kind.util";

/** Section 5 of `docs/specs/crypto-accounts.md`, the currency-write rows. */
describe("quoteSymbolRefusal", () => {
  it.each([
    ["CRYPTO", "BTC-EUR", null],
    ["CRYPTO", null, null],
    ["FIAT", null, null],
    ["FIAT", "BTC-EUR", "quoteSymbolRequiresCrypto"],
    ["CRYPTO", "BTC", "quoteSymbolNotAPair"],
    // The fiat leg must be an ISO 4217 code, as for a crypto security.
    ["CRYPTO", "BTC-USDT", "quoteSymbolNotAPair"],
    ["CRYPTO", "-EUR", "quoteSymbolNotAPair"],
  ] as const)("kind %s with symbol %p is %p", (kind, symbol, refusal) => {
    expect(quoteSymbolRefusal(kind, symbol)).toBe(refusal);
  });
});

describe("quoteSymbolCoinTicker", () => {
  it("is everything before the last hyphen", () => {
    expect(quoteSymbolCoinTicker("BTC-EUR")).toBe("BTC");
    expect(quoteSymbolCoinTicker("DOGE-USD")).toBe("DOGE");
    expect(quoteSymbolCoinTicker("USDT-X-CAD")).toBe("USDT-X");
    expect(quoteSymbolCoinTicker(" btc-cad ")).toBe("BTC");
  });

  it("is null for a symbol that is not a pair", () => {
    expect(quoteSymbolCoinTicker("BTC")).toBeNull();
    expect(quoteSymbolCoinTicker("BTC-USDT")).toBeNull();
  });
});
