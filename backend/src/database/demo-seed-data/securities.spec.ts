import { generatePriceHistory, demoSecurities } from "./securities";

describe("generatePriceHistory", () => {
  const testSecurity = demoSecurities[0]; // XIU
  const referenceDate = new Date("2025-06-15");

  it("generates prices for 12 months of trading days", () => {
    const prices = generatePriceHistory(testSecurity, referenceDate, 12);

    // ~250 trading days in a year (excluding weekends)
    expect(prices.length).toBeGreaterThan(200);
    expect(prices.length).toBeLessThan(270);
  });

  it("skips weekends (Saturday and Sunday)", () => {
    const prices = generatePriceHistory(testSecurity, referenceDate, 12);

    for (const p of prices) {
      const day = new Date(p.date).getDay();
      expect(day).not.toBe(0); // Not Sunday
      expect(day).not.toBe(6); // Not Saturday
    }
  });

  it("starts near the basePrice", () => {
    const prices = generatePriceHistory(testSecurity, referenceDate, 12);
    const firstPrice = prices[0].close;

    // First price should be close to basePrice (within 5%)
    const ratio = firstPrice / testSecurity.basePrice;
    expect(ratio).toBeGreaterThan(0.95);
    expect(ratio).toBeLessThan(1.05);
  });

  it("ends near the currentPrice", () => {
    const prices = generatePriceHistory(testSecurity, referenceDate, 12);
    const lastPrice = prices[prices.length - 1].close;

    // Last price should be close to currentPrice (within 5%)
    const ratio = lastPrice / testSecurity.currentPrice;
    expect(ratio).toBeGreaterThan(0.95);
    expect(ratio).toBeLessThan(1.05);
  });

  it("produces deterministic results for the same security", () => {
    const prices1 = generatePriceHistory(testSecurity, referenceDate, 12);
    const prices2 = generatePriceHistory(testSecurity, referenceDate, 12);

    expect(prices1).toEqual(prices2);
  });

  it("produces different results for different securities", () => {
    const security1 = demoSecurities[0]; // XIU
    const security2 = demoSecurities[5]; // AAPL

    const prices1 = generatePriceHistory(security1, referenceDate, 12);
    const prices2 = generatePriceHistory(security2, referenceDate, 12);

    // First prices should differ (different base prices)
    expect(prices1[0].close).not.toBe(prices2[0].close);
  });

  it("returns prices with two decimal places", () => {
    const prices = generatePriceHistory(testSecurity, referenceDate, 12);

    for (const p of prices) {
      const decimals = p.close.toString().split(".")[1];
      if (decimals) {
        expect(decimals.length).toBeLessThanOrEqual(2);
      }
    }
  });

  it("returns dates in YYYY-MM-DD format", () => {
    const prices = generatePriceHistory(testSecurity, referenceDate, 12);

    for (const p of prices) {
      expect(p.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });

  it("generates positive prices", () => {
    const prices = generatePriceHistory(testSecurity, referenceDate, 12);

    for (const p of prices) {
      expect(p.close).toBeGreaterThan(0);
    }
  });

  it("returns empty array when no trading days exist", () => {
    const prices = generatePriceHistory(testSecurity, referenceDate, 0);
    // 0 months range will have at most 1 day
    expect(prices.length).toBeLessThanOrEqual(1);
  });

  it("generates prices for all demo securities", () => {
    for (const sec of demoSecurities) {
      const prices = generatePriceHistory(sec, referenceDate, 12);
      expect(prices.length).toBeGreaterThan(0);

      // All prices should be positive
      for (const p of prices) {
        expect(p.close).toBeGreaterThan(0);
      }
    }
  });
});

describe("demoSecurities data", () => {
  it("has 8 securities", () => {
    expect(demoSecurities.length).toBe(8);
  });

  it("includes both ETFs and stocks", () => {
    const types = new Set(demoSecurities.map((s) => s.type));
    expect(types.has("ETF")).toBe(true);
    expect(types.has("STOCK")).toBe(true);
  });

  it("includes both CAD and USD securities", () => {
    const currencies = new Set(demoSecurities.map((s) => s.currency));
    expect(currencies.has("CAD")).toBe(true);
    expect(currencies.has("USD")).toBe(true);
  });

  it("maps to valid investment account keys", () => {
    const validKeys = ["rrsp", "tfsa", "us_stocks"];
    for (const sec of demoSecurities) {
      expect(validKeys).toContain(sec.accountKey);
    }
  });

  it("has positive quantities and costs", () => {
    for (const sec of demoSecurities) {
      expect(sec.quantity).toBeGreaterThan(0);
      expect(sec.averageCost).toBeGreaterThan(0);
      expect(sec.basePrice).toBeGreaterThan(0);
      expect(sec.currentPrice).toBeGreaterThan(0);
    }
  });
});
