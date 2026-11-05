import {
  decimalPlacesFor,
  formatCurrency,
  formatCurrencyAmount,
  getDecimalPlacesForCurrency,
} from "./format-currency.util";

describe("formatCurrency", () => {
  it("supports a recipient locale without changing currency precision or existing defaults", () => {
    expect(formatCurrency(1234.56, "PLN", "pl")).toContain("1234,56");
    expect(formatCurrency(1234.567, "BHD", "pl")).toContain("1234,567");
    expect(formatCurrency(1234, "JPY", "pl")).not.toContain(",00");
    expect(formatCurrency(1234.56, "USD")).toContain("1,234.56");
  });
  it("formats USD with 2 decimal places", () => {
    expect(formatCurrency(1234.56, "USD")).toContain("1,234.56");
  });

  it("formats JPY with 0 decimal places", () => {
    const result = formatCurrency(1234, "JPY");
    expect(result).toContain("1,234");
    expect(result).not.toContain(".");
  });

  it("formats BHD with 3 decimal places", () => {
    expect(formatCurrency(1234.567, "BHD")).toContain("1,234.567");
  });

  it("formats negative amounts", () => {
    const result = formatCurrency(-50, "USD");
    expect(result).toContain("50.00");
  });

  it("formats zero", () => {
    expect(formatCurrency(0, "USD")).toContain("0.00");
  });
});

describe("formatCurrencyAmount", () => {
  it("formats USD amount without symbol", () => {
    const result = formatCurrencyAmount(1234.56, "USD");
    expect(result).toBe("1,234.56");
  });

  it("formats JPY amount with 0 decimals", () => {
    const result = formatCurrencyAmount(1234, "JPY");
    expect(result).toBe("1,234");
  });

  it("formats BHD amount with 3 decimals", () => {
    const result = formatCurrencyAmount(1234.567, "BHD");
    expect(result).toBe("1,234.567");
  });
});

describe("formatCurrency error path", () => {
  it("falls back to plain toFixed when Intl throws", () => {
    // Invalid ISO 4217 code throws; falls into catch-block
    expect(formatCurrency(123.456, "INVALID-X")).toBe("123.46");
  });
});

describe("getDecimalPlacesForCurrency", () => {
  it("returns 2 for USD", () => {
    expect(getDecimalPlacesForCurrency("USD")).toBe(2);
  });

  it("returns 0 for JPY", () => {
    expect(getDecimalPlacesForCurrency("JPY")).toBe(0);
  });

  it("returns 3 for BHD", () => {
    expect(getDecimalPlacesForCurrency("BHD")).toBe(3);
  });

  it("returns 2 for EUR", () => {
    expect(getDecimalPlacesForCurrency("EUR")).toBe(2);
  });

  it("returns 2 for invalid currency", () => {
    expect(getDecimalPlacesForCurrency("INVALID")).toBe(2);
  });
});

/**
 * A coin is not an ISO code, so `Intl` would print it at 2 places; text a
 * model reads states it at its own row's places (a BTC row at 4).
 */
describe("decimalPlacesFor", () => {
  const rows = new Map([
    ["BTC", 4],
    ["XYZ", 3],
    ["USD", 4],
  ]);

  it("takes a non-ISO code's places from its currency row", () => {
    expect(decimalPlacesFor("BTC", rows)).toBe(4);
    expect(decimalPlacesFor("btc", rows)).toBe(4);
    expect(decimalPlacesFor("XYZ", rows)).toBe(3);
  });

  it("keeps the ISO minor unit for an ISO code, whatever its row says", () => {
    expect(decimalPlacesFor("USD", rows)).toBe(2);
    expect(decimalPlacesFor("JPY", rows)).toBe(0);
    expect(decimalPlacesFor("BHD", rows)).toBe(3);
  });

  it("falls back to 2 for a non-ISO code with no row", () => {
    expect(decimalPlacesFor("QQQ", rows)).toBe(2);
  });

  it("feeds formatCurrencyAmount so a BTC balance keeps its four places", () => {
    expect(formatCurrencyAmount(0.0125, "BTC")).toBe("0.01");
    expect(
      formatCurrencyAmount(0.0125, "BTC", decimalPlacesFor("BTC", rows)),
    ).toBe("0.0125");
  });
});
