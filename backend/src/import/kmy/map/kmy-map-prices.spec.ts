import {
  n,
  rawAccount,
  rawCurrency,
  rawFile,
  rawPrice,
  rawSecurity,
} from "../__fixtures__/kmy-raw-builders";
import { harness } from "./kmy-map.harness";
import { buildRateLookup, mapKmyPrices } from "./kmy-map-prices";

function build(
  prices: ReturnType<typeof rawPrice>[],
  options: Parameters<typeof harness>[1] = {},
  used = ["USD", "EUR"],
) {
  const raw = rawFile({
    accounts: [
      rawAccount({ id: "INV", name: "Broker", type: 7 }),
      rawAccount({
        id: "S1",
        name: "S1",
        type: 15,
        parentId: "INV",
        currency: "E1",
      }),
      rawAccount({
        id: "S2",
        name: "S2",
        type: 15,
        parentId: "INV",
        currency: "E2",
      }),
    ],
    securities: [
      rawSecurity({ id: "E1", symbol: "EXC", tradingCurrency: "USD" }),
      rawSecurity({ id: "E2", symbol: "OUT" }),
      rawSecurity({ id: "E9", symbol: "NOT" }),
    ],
    currencies: ["USD", "EUR", "GBP", "JPY"].map((id) => rawCurrency(id)),
    prices,
  });
  const h = harness(raw, options);
  return {
    raw,
    mapped: mapKmyPrices({
      raw,
      securities: h.securities,
      options: h.options,
      usedCurrencies: new Set(used),
    }),
  };
}

describe("mapKmyPrices (spec 5.9)", () => {
  it("writes a security's price in its trading currency, a later duplicate winning", () => {
    const { mapped } = build([
      rawPrice("E1", "USD", "2024-02-10", "50"),
      rawPrice("E1", "USD", "2024-05-01", "30"),
      rawPrice("E1", "USD", "2024-02-10", "51"),
    ]);
    expect(mapped.rawPrices).toEqual([
      { handle: 3, security: 1, date: "2024-02-10", price: 51, split: null },
      { handle: 2, security: 1, date: "2024-05-01", price: 30, split: null },
    ]);
  });

  it("counts a price in another currency, ignores unimported securities, zero prices and security pairs", () => {
    const { mapped } = build([
      rawPrice("E1", "EUR", "2024-02-10", "45"),
      rawPrice("E9", "USD", "2024-02-10", "1"),
      rawPrice("E1", "USD", "2024-02-11", "0"),
      rawPrice("E1", "E2", "2024-02-11", "1"),
      rawPrice("USD", "E1", "2024-02-11", "1"),
      rawPrice("junk", "USD", "2024-02-11", "1"),
    ]);
    expect(mapped.rawPrices).toEqual([]);
    expect(mapped.warnings).toEqual([
      { code: "priceCurrencyMismatch", subject: "EXC", detail: "EUR" },
    ]);
  });

  it("keeps rates between used currencies and counts the rest as skipped", () => {
    const { mapped } = build([
      rawPrice("EUR", "USD", "2024-01-15", "11573/10000"),
      rawPrice("GBP", "USD", "2024-01-15", "5/4"),
      rawPrice("JPY", "GBP", "2024-01-15", "1/200"),
      rawPrice("EUR", "EUR", "2024-01-15", "1"),
      rawPrice("EUR", "USD", "2024-01-16", "0"),
    ]);
    expect(mapped.rawExchangeRates).toEqual([
      {
        fromCurrency: 1,
        toCurrency: 2,
        rate: 1.1573,
        date: "2024-01-15",
        historical: true,
      },
    ]);
    expect(mapped.currencyByHandle).toEqual(
      new Map([
        [1, "EUR"],
        [2, "USD"],
      ]),
    );
    expect(mapped.warnings.map((w) => [w.code, w.subject])).toEqual([
      ["unusedCurrencyRatesSkipped", "GBP/USD"],
      ["unusedCurrencyRatesSkipped", "JPY/GBP"],
    ]);
  });

  it("collapses the two orientations of one pair and date onto the later row", () => {
    const { mapped } = build([
      rawPrice("EUR", "USD", "2024-01-15", "11/10"),
      rawPrice("USD", "EUR", "2024-01-15", "10/11"),
      rawPrice("USD", "EUR", "2024-01-16", "9/10"),
    ]);
    expect(mapped.rawExchangeRates).toHaveLength(2);
    expect(mapped.rawExchangeRates[0]).toMatchObject({
      date: "2024-01-15",
      rate: 0.9090909091,
    });
    expect(mapped.currencyByHandle.get(1)).toBe("EUR");
  });

  it("respects the importPrices and importExchangeRates options", () => {
    const prices = [
      rawPrice("E1", "USD", "2024-02-10", "50"),
      rawPrice("EUR", "USD", "2024-01-15", "11/10"),
    ];
    const none = build(prices, {
      options: { importPrices: false, importExchangeRates: false },
    });
    expect(none.mapped.rawPrices).toEqual([]);
    expect(none.mapped.rawExchangeRates).toEqual([]);
    expect(none.mapped.warnings).toEqual([]);
  });
});

describe("buildRateLookup (spec 5.7.3)", () => {
  const lookup = buildRateLookup(
    rawFile({
      securities: [rawSecurity({ id: "E1" })],
      prices: [
        rawPrice("EUR", "USD", "2024-01-01", "11/10"),
        rawPrice("EUR", "USD", "2024-03-01", "6/5"),
        rawPrice("USD", "GBP", "2024-02-01", "4/5"),
        rawPrice("E1", "USD", "2024-01-01", "3"),
        rawPrice("EUR", "JPY", "2024-01-01", "0"),
      ],
    }),
  );

  it("answers the newest price on or before the date, in either direction", () => {
    expect(lookup("EUR", "USD", "2024-02-15")).toEqual(n("11/10"));
    expect(lookup("EUR", "USD", "2024-03-01")).toEqual(n("6/5"));
    expect(lookup("USD", "EUR", "2024-02-15")).toEqual(n("10/11"));
    expect(lookup("GBP", "USD", "2024-02-02")).toEqual(n("5/4"));
  });

  it("answers 1 for the same currency and null when the file has nothing usable", () => {
    expect(lookup("USD", "USD", "2024-01-01")).toEqual(n("1"));
    expect(lookup("EUR", "USD", "2023-12-31")).toBeNull();
    expect(lookup("EUR", "JPY", "2024-06-01")).toBeNull();
    expect(lookup("E1", "USD", "2024-06-01")).toBeNull();
  });

  it("prefers the direct series when it is as recent as the inverse", () => {
    const tie = buildRateLookup(
      rawFile({
        prices: [
          rawPrice("EUR", "USD", "2024-01-01", "11/10"),
          rawPrice("USD", "EUR", "2024-01-01", "1/2"),
        ],
      }),
    );
    expect(tie("EUR", "USD", "2024-01-02")).toEqual(n("11/10"));
    expect(tie("USD", "EUR", "2024-01-02")).toEqual(n("1/2"));
  });
});
