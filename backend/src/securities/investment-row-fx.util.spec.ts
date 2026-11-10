import { investmentRowRateInto, usableRowRate } from "./investment-row-fx.util";

describe("investmentRowRateInto", () => {
  const row = (over: Partial<Parameters<typeof investmentRowRateInto>[1]>) => ({
    amountCurrency: "USD",
    settlementCurrency: "CAD",
    exchangeRate: 1.35,
    date: "2025-03-04",
    ...over,
  });

  it("is 1 for a row already in the target", async () => {
    const market = jest.fn();
    await expect(
      investmentRowRateInto("USD", row({}), market),
    ).resolves.toEqual({ rate: 1, basis: null, onward: false });
    expect(market).not.toHaveBeenCalled();
  });

  it("takes the row's own rate where it settled into the target (INV-FX-002)", async () => {
    const market = jest.fn().mockResolvedValue(1.5);
    await expect(
      investmentRowRateInto("CAD", row({}), market),
    ).resolves.toEqual({
      rate: 1.35,
      basis: "transaction",
      onward: false,
    });
    expect(market).not.toHaveBeenCalled();
  });

  it("carries the own rate onward at the market rate on the row's date", async () => {
    const market = jest.fn().mockReturnValue(0.7);
    const result = await investmentRowRateInto("EUR", row({}), market);

    expect(result.rate).toBeCloseTo(0.945, 10);
    expect(result).toMatchObject({ basis: "transaction", onward: true });
    expect(market).toHaveBeenCalledWith("CAD", "EUR", "2025-03-04");
  });

  it("falls back to the market rate for the pair when no onward rate exists", async () => {
    const market = jest.fn((from: string) => (from === "USD" ? 0.9 : null));
    await expect(
      investmentRowRateInto("EUR", row({}), market),
    ).resolves.toEqual({
      rate: 0.9,
      basis: "market",
      onward: false,
    });
  });

  it("ignores a stored 1 across two currencies and answers null with no rate", async () => {
    const market = jest.fn().mockReturnValue(null);
    await expect(
      investmentRowRateInto("CAD", row({ exchangeRate: 1 }), market),
    ).resolves.toEqual({ rate: null, basis: null, onward: false });
    await expect(
      investmentRowRateInto("CAD", row({ amountCurrency: null }), market),
    ).resolves.toEqual({ rate: null, basis: null, onward: false });
  });

  it("refuses an unusable stored rate", () => {
    expect(usableRowRate(null, "USD", "CAD")).toBeNull();
    expect(usableRowRate("0", "USD", "CAD")).toBeNull();
    expect(usableRowRate(1, "USD", "USD")).toBe(1);
    expect(usableRowRate("1.2", "USD", "CAD")).toBe(1.2);
  });
});
