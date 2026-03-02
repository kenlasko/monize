import {
  formatCurrency,
  formatCurrencyAmount,
  getDecimalPlacesForCurrency,
} from "./format-currency.util";

describe("formatCurrency", () => {
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
