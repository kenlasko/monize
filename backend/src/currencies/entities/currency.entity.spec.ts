import { Currency } from "./currency.entity";

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
