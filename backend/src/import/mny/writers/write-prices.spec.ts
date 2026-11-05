import { EntityManager } from "typeorm";
import {
  mnyExchangeRate,
  mnySecurityPrice,
} from "../__fixtures__/mny-row-builders";
import { roundFxRate } from "../../../common/fx-entry.util";
import {
  MNY_PRICE_SOURCE,
  UPSERT_CHUNK_SIZE,
  dedupePrices,
  resolveExchangeRates,
  writeExchangeRates,
  writeSecurityPrices,
} from "./write-prices";

/**
 * Price and rate history is the largest thing a real Money file carries (68,000
 * `SP` rows in the maintainer's Money Plus file), so these two writers are the
 * ones whose statement shape matters: multi-row upserts on the natural key,
 * deduped before they get there because a `VALUES` list with a repeated
 * conflict key raises "cannot affect row a second time".
 */

const securityIds = new Map([
  [1, "ssssssss-0000-0000-0000-000000000001"],
  [2, "ssssssss-0000-0000-0000-000000000002"],
]);

/**
 * A manager whose raw SQL is `query` and whose `currencies` read answers the
 * CRYPTO codes in `coins` (the writer orients a coin pair coin -> fiat).
 */
function doubles(coins: readonly string[] = []) {
  const query = jest.fn().mockResolvedValue([]);
  const find = jest.fn().mockResolvedValue(coins.map((code) => ({ code })));
  const manager = {
    query,
    getRepository: jest.fn(() => ({ find })),
  } as unknown as EntityManager;
  return { manager, query, find };
}

describe("dedupePrices", () => {
  it("keeps the highest-handle row for a security and date", () => {
    const rows = dedupePrices(
      [
        mnySecurityPrice({
          handle: 1,
          security: 1,
          date: "2026-01-05",
          price: 10,
        }),
        mnySecurityPrice({
          handle: 9,
          security: 1,
          date: "2026-01-05",
          price: 12,
        }),
        mnySecurityPrice({
          handle: 4,
          security: 1,
          date: "2026-01-05",
          price: 11,
        }),
      ],
      securityIds,
    );

    expect(rows).toEqual([
      {
        securityId: securityIds.get(1),
        priceDate: "2026-01-05",
        closePrice: 12,
      },
    ]);
  });

  it("keeps distinct dates and securities apart", () => {
    const rows = dedupePrices(
      [
        mnySecurityPrice({ handle: 1, security: 1, date: "2026-01-05" }),
        mnySecurityPrice({ handle: 2, security: 1, date: "2026-01-06" }),
        mnySecurityPrice({ handle: 3, security: 2, date: "2026-01-05" }),
      ],
      securityIds,
    );

    expect(rows).toHaveLength(3);
  });

  it("drops rows with no date, no security or no price", () => {
    const rows = dedupePrices(
      [
        mnySecurityPrice({ handle: 1, date: null }),
        mnySecurityPrice({ handle: 2, security: null }),
        mnySecurityPrice({ handle: 3, price: 0 }),
        mnySecurityPrice({ handle: 4, price: -5 }),
      ],
      securityIds,
    );

    expect(rows).toEqual([]);
  });

  it("drops rows for a security that was not imported", () => {
    const rows = dedupePrices(
      [mnySecurityPrice({ security: 99 })],
      securityIds,
    );

    expect(rows).toEqual([]);
  });

  it("rounds to the column's six decimal places", () => {
    const rows = dedupePrices(
      [mnySecurityPrice({ security: 1, price: 1.2345678 })],
      securityIds,
    );

    expect(rows[0].closePrice).toBe(1.234568);
  });
});

describe("writeSecurityPrices", () => {
  it("upserts on (security, date) and marks the import as the source", async () => {
    const { manager, query } = doubles();

    const written = await writeSecurityPrices(
      manager,
      [mnySecurityPrice({ security: 1, date: "2026-01-05", price: 10 })],
      securityIds,
    );

    expect(written).toBe(1);
    expect(query.mock.calls[0][0]).toContain(
      "ON CONFLICT (security_id, price_date)",
    );
    expect(query.mock.calls[0][1]).toEqual([
      securityIds.get(1),
      "2026-01-05",
      10,
      MNY_PRICE_SOURCE,
    ]);
  });

  it("chunks a large history instead of building one giant statement", async () => {
    const { manager, query } = doubles();
    const prices = Array.from({ length: UPSERT_CHUNK_SIZE + 20 }, (_, index) =>
      mnySecurityPrice({
        handle: index,
        security: 1,
        date: `2026-${String((index % 12) + 1).padStart(2, "0")}-${String((index % 28) + 1).padStart(2, "0")}`,
      }),
    );

    await writeSecurityPrices(manager, prices, securityIds);

    for (const call of query.mock.calls) {
      expect(call[1].length).toBeLessThanOrEqual(UPSERT_CHUNK_SIZE * 4);
    }
  });

  it("issues no statement when nothing survives the dedupe", async () => {
    const { manager, query } = doubles();

    const written = await writeSecurityPrices(manager, [], securityIds);

    expect(written).toBe(0);
    expect(query).not.toHaveBeenCalled();
  });

  it("reports progress after every chunk", async () => {
    const { manager } = doubles();
    const onProgress = jest.fn().mockResolvedValue(undefined);

    await writeSecurityPrices(
      manager,
      [
        mnySecurityPrice({ handle: 1, security: 1, date: "2026-01-05" }),
        mnySecurityPrice({ handle: 2, security: 1, date: "2026-01-06" }),
      ],
      securityIds,
      onProgress,
    );

    expect(onProgress).toHaveBeenCalledWith(2, 2);
  });
});

describe("resolveExchangeRates", () => {
  const currencies = new Map([
    [1, "USD"],
    [2, "GBP"],
  ]);

  it("resolves handles into ISO codes and orients the pair", () => {
    // Money recorded USD->GBP; the table stores each pair once, in the
    // orientation whose codes sort first, so the rate is inverted at ten
    // decimals to match (INV-FX-003).
    const rows = resolveExchangeRates(
      [
        mnyExchangeRate({
          fromCurrency: 1,
          toCurrency: 2,
          rate: 0.79,
          date: "2026-01-05",
        }),
      ],
      currencies,
    );

    expect(rows).toEqual([
      {
        fromCurrency: "GBP",
        toCurrency: "USD",
        rate: roundFxRate(1 / 0.79),
        rateDate: "2026-01-05",
      },
    ]);
  });

  it("collapses the same pair and date recorded in both directions", () => {
    // A file that records USD->GBP and GBP->USD for one day used to become two
    // rows that nothing kept reciprocal. They now share a key, so the later row
    // wins exactly as two recordings of one direction do -- and the multi-row
    // upsert cannot see the same conflict key twice.
    const rows = resolveExchangeRates(
      [
        mnyExchangeRate({
          fromCurrency: 1,
          toCurrency: 2,
          rate: 0.79,
          date: "2026-01-05",
        }),
        mnyExchangeRate({
          fromCurrency: 2,
          toCurrency: 1,
          rate: 1.3,
          date: "2026-01-05",
        }),
      ],
      currencies,
    );

    expect(rows).toEqual([
      {
        fromCurrency: "GBP",
        toCurrency: "USD",
        rate: 1.3,
        rateDate: "2026-01-05",
      },
    ]);
  });

  it("drops a self-rate, which is always 1 and only clutters lookups", () => {
    const rows = resolveExchangeRates(
      [
        mnyExchangeRate({
          fromCurrency: 1,
          toCurrency: 1,
          rate: 1,
          date: "2026-01-05",
        }),
      ],
      currencies,
    );

    expect(rows).toEqual([]);
  });

  it("drops rows with no date, an unknown currency or a non-positive rate", () => {
    const rows = resolveExchangeRates(
      [
        mnyExchangeRate({ fromCurrency: 1, toCurrency: 2, date: null }),
        mnyExchangeRate({
          fromCurrency: 1,
          toCurrency: 99,
          date: "2026-01-05",
        }),
        mnyExchangeRate({
          fromCurrency: 1,
          toCurrency: 2,
          rate: 0,
          date: "2026-01-05",
        }),
      ],
      currencies,
    );

    expect(rows).toEqual([]);
  });

  it("keeps the last row for a currency pair and date", () => {
    const rows = resolveExchangeRates(
      [
        mnyExchangeRate({
          fromCurrency: 1,
          toCurrency: 2,
          rate: 0.7,
          date: "2026-01-05",
        }),
        mnyExchangeRate({
          fromCurrency: 1,
          toCurrency: 2,
          rate: 0.8,
          date: "2026-01-05",
        }),
      ],
      currencies,
    );

    expect(rows).toEqual([
      {
        fromCurrency: "GBP",
        toCurrency: "USD",
        rate: roundFxRate(1 / 0.8),
        rateDate: "2026-01-05",
      },
    ]);
  });
});

describe("writeExchangeRates", () => {
  it("inserts additively on the pair and date", async () => {
    const { manager, query } = doubles();
    query.mockResolvedValueOnce([{ id: 1 }]);

    const written = await writeExchangeRates(
      manager,
      [
        mnyExchangeRate({
          fromCurrency: 1,
          toCurrency: 2,
          rate: 0.79,
          date: "2026-01-05",
        }),
      ],
      new Map([
        [1, "USD"],
        [2, "GBP"],
      ]),
    );

    expect(written).toBe(1);
    expect(query.mock.calls[0][0]).toContain(
      "ON CONFLICT (from_currency, to_currency, rate_date)",
    );
    expect(query.mock.calls[0][1]).toEqual([
      "GBP",
      "USD",
      roundFxRate(1 / 0.79),
      "2026-01-05",
      MNY_PRICE_SOURCE,
    ]);
  });

  // INV-FX-004. `exchange_rates` is shared by every user on the deployment, so a
  // Money file -- which may record what one user's bank charged rather than the
  // market -- must not replace a rate already there. The writer used to
  // `DO UPDATE`, which let one user's import revalue every other user's history.
  it("never overwrites a rate the global table already holds", async () => {
    const { manager, query } = doubles();

    await writeExchangeRates(
      manager,
      [
        mnyExchangeRate({
          fromCurrency: 1,
          toCurrency: 2,
          rate: 4.17,
          date: "2026-01-05",
        }),
      ],
      new Map([
        [1, "EUR"],
        [2, "PLN"],
      ]),
    );

    const sql = query.mock.calls[0][0] as string;
    expect(sql).toMatch(
      /ON CONFLICT \(from_currency, to_currency, rate_date\) DO NOTHING/,
    );
    expect(sql).not.toMatch(/DO\s+UPDATE/i);
  });

  it("counts only the rows that landed, not the ones a conflict skipped", async () => {
    const { manager, query } = doubles();
    // Two usable rates offered; the database already held one of them, so the
    // insert returns a single row.
    query.mockResolvedValueOnce([{ id: 7 }]);

    const written = await writeExchangeRates(
      manager,
      [
        mnyExchangeRate({
          fromCurrency: 1,
          toCurrency: 2,
          rate: 4.17,
          date: "2026-01-05",
        }),
        mnyExchangeRate({
          fromCurrency: 1,
          toCurrency: 2,
          rate: 4.18,
          date: "2026-01-06",
        }),
      ],
      new Map([
        [1, "EUR"],
        [2, "PLN"],
      ]),
    );

    expect(query).toHaveBeenCalledTimes(1);
    expect(written).toBe(1);
  });

  // A coin pair is stored coin -> fiat whichever code sorts first: IDR sorts
  // before XBT, but IDR->XBT at 1/1.52e9 keeps one significant figure at ten
  // decimals and resolves back 6% off.
  it("stores a coin pair coin-first whatever the code order", async () => {
    const { manager, query, find } = doubles(["XBT"]);
    query.mockResolvedValueOnce([{ id: 1 }]);

    await writeExchangeRates(
      manager,
      [
        mnyExchangeRate({
          fromCurrency: 1,
          toCurrency: 2,
          rate: roundFxRate(1 / 1.52e9),
          date: "2026-01-05",
        }),
        mnyExchangeRate({
          fromCurrency: 2,
          toCurrency: 1,
          rate: 1.52e9,
          date: "2026-01-06",
        }),
      ],
      new Map([
        [1, "IDR"],
        [2, "XBT"],
      ]),
    );

    expect(find).toHaveBeenCalledTimes(1);
    const params = query.mock.calls[0][1] as unknown[];
    expect(params.slice(5, 7)).toEqual(["XBT", "IDR"]);
    expect(params[7] as number).toBeCloseTo(1.52e9, 3);
    expect(params.slice(8, 10)).toEqual(["2026-01-06", MNY_PRICE_SOURCE]);
    expect(params[0]).toBe("XBT");
    expect(params[1]).toBe("IDR");
  });

  it("drops a rate the column cannot hold rather than failing the insert", () => {
    const rows = resolveExchangeRates(
      [
        mnyExchangeRate({
          fromCurrency: 1,
          toCurrency: 2,
          rate: 1.1e10,
          date: "2026-01-05",
        }),
      ],
      new Map([
        [1, "BTC"],
        [2, "LBP"],
      ]),
      (code) => code === "BTC",
    );

    expect(rows).toEqual([]);
  });

  it("issues no statement when the file has no usable rates", async () => {
    const { manager, query } = doubles();

    expect(await writeExchangeRates(manager, [], new Map())).toBe(0);
    expect(query).not.toHaveBeenCalled();
  });
});
