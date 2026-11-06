import { EntityManager } from "typeorm";
import {
  DEMO_CRYPTO_CURRENCY,
  DEMO_CRYPTO_RATE_SOURCE,
  generateDemoCryptoRates,
  upsertDemoCryptoCurrency,
} from "./crypto-rates";

describe("demo cryptocurrency seed", () => {
  it("is the contract's coin: BTC, CRYPTO, priced from BTC-CAD, eight places", () => {
    expect(DEMO_CRYPTO_CURRENCY).toEqual({
      code: "BTC",
      name: "Bitcoin",
      symbol: "₿",
      decimals: 8,
      kind: "CRYPTO",
      quoteSymbol: "BTC-CAD",
    });
    expect(DEMO_CRYPTO_RATE_SOURCE).toBe("yahoo_crypto");
  });

  it("stores one BTC->CAD rate for every day of the window, weekends included, ending today", () => {
    const rows = generateDemoCryptoRates("2026-11-05", 10);

    expect(rows.map((row) => row.date)).toEqual([
      "2026-10-27",
      "2026-10-28",
      "2026-10-29",
      "2026-10-30",
      "2026-10-31",
      "2026-11-01",
      "2026-11-02",
      "2026-11-03",
      "2026-11-04",
      "2026-11-05",
    ]);
    // From the coin to its fiat; the writer orients the stored row.
    for (const row of rows) {
      expect([row.from, row.to]).toEqual(["BTC", "CAD"]);
    }
  });

  it("moves a little each day around 137,000 CAD, and the same day reseeds the same figure", () => {
    const rows = generateDemoCryptoRates("2026-11-05");

    expect(rows).toHaveLength(366);
    for (const [i, row] of rows.entries()) {
      expect(row.rate).toBeGreaterThan(137_000 * 0.9);
      expect(row.rate).toBeLessThan(137_000 * 1.1);
      if (i > 0) {
        const move = Math.abs(row.rate / rows[i - 1].rate - 1);
        expect(move).toBeLessThan(0.01);
      }
    }
    expect(generateDemoCryptoRates("2026-11-05")).toEqual(rows);
  });

  it("inserts the coin with its kind and price symbol, refreshing an existing row only while it is CRYPTO", async () => {
    const query = jest.fn().mockResolvedValue([{ kind: "CRYPTO" }]);

    const isCoin = await upsertDemoCryptoCurrency({
      query,
    } as unknown as EntityManager);

    const [sql, params] = query.mock.calls[0];
    expect(params).toEqual(["BTC", "Bitcoin", "₿", 8, "CRYPTO", "BTC-CAD"]);
    expect(sql).toContain("quote_symbol = EXCLUDED.quote_symbol");
    expect(sql).toMatch(/WHERE currencies\.kind = 'CRYPTO'\s+RETURNING kind/);
    // The kind is written only by the INSERT, never by the conflict update.
    const setClause = sql.slice(
      sql.indexOf("DO UPDATE SET"),
      sql.indexOf("WHERE currencies.kind"),
    );
    expect(setClause).not.toMatch(/\bkind\s*=/);
    expect(isCoin).toBe(true);
  });

  it("reports an existing FIAT BTC, which the conflict clause left alone, as not the demo's coin", async () => {
    // `DO UPDATE ... WHERE` skipped the row: RETURNING answers nothing.
    const query = jest.fn().mockResolvedValue([]);

    await expect(
      upsertDemoCryptoCurrency({ query } as unknown as EntityManager),
    ).resolves.toBe(false);
  });
});
