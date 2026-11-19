import { rawPrice } from "../__fixtures__/kmy-raw-builders";
import { Tx, run } from "./kmy-map-investments.test-helpers";

describe("mapKmyInvestments: where the cash moves (spec 5.7.3)", () => {
  it("has no cash for a trade with no asset split", () => {
    const { investments } = run([
      { splits: [{ account: "STK", value: "10", shares: "1", action: "Buy" }] },
    ]);
    expect(investments.transactions[0]).toMatchObject({
      cashAccountKey: null,
      fundingAccountKey: null,
      cashAmount: 0,
      exchangeRate: 1,
    });
  });

  it("funds a trade from another imported account", () => {
    const { investments } = run([
      {
        splits: [
          { account: "CHK", value: "-10" },
          { account: "STK", value: "10", shares: "1", action: "Buy" },
        ],
      },
    ]);
    expect(investments.transactions[0]).toMatchObject({
      accountKey: "acct-6",
      cashAccountKey: "acct-9",
      fundingAccountKey: "acct-9",
      cashAmount: -10,
    });
  });

  it("counts the type-7 account itself as the pair's cash side", () => {
    const { investments } = run([
      {
        splits: [
          { account: "INV", value: "-10" },
          { account: "STK", value: "10", shares: "1", action: "Buy" },
        ],
      },
    ]);
    expect(investments.transactions[0]).toMatchObject({
      cashAccountKey: "acct-7",
      fundingAccountKey: null,
    });
  });

  it("imports the position of a trade paid from equity without its cash", () => {
    const { investments } = run([
      {
        splits: [
          { account: "EQ", value: "-10" },
          { account: "STK", value: "10", shares: "1", action: "Buy" },
        ],
      },
    ]);
    expect(investments.transactions[0]).toMatchObject({
      cashAccountKey: null,
      cashAmount: 0,
      totalAmount: 10,
    });
    expect(investments.warnings.map((w) => w.code)).toEqual([
      "tradeFundedFromEquity",
    ]);
  });

  it("ignores cash in an account that does not import", () => {
    const { investments } = run(
      [
        {
          splits: [
            { account: "CHK", value: "-10" },
            { account: "STK", value: "10", shares: "1", action: "Buy" },
          ],
        },
      ],
      {},
      {
        options: {
          accounts: [{ handle: 9, include: false, currencyOverride: null }],
        },
      },
    );
    expect(investments.transactions[0]).toMatchObject({
      cashAccountKey: null,
      cashAmount: 0,
    });
  });

  it("converts a cross-currency trade at the cash account's own amount", () => {
    const { investments } = run([
      {
        splits: [
          { account: "EBRK", value: "-505", shares: "-459.09" },
          {
            account: "ESTK",
            value: "500",
            shares: "10",
            price: "50",
            action: "Buy",
          },
          { account: "FEE", value: "5" },
        ],
      },
    ]);
    expect(investments.transactions[0]).toMatchObject({
      accountKey: "acct-16",
      cashAmount: -459.09,
      totalAmount: 505,
      commission: 5,
      price: 50,
      currencyCode: "EUR",
      securityCurrencyCode: "USD",
      exchangeRate: 0.9090891089,
    });
  });

  it("converts amounts at the file's price when the commodity is not the trading currency", () => {
    const converted = run(
      [
        {
          commodity: "EUR",
          splits: [
            { account: "BRK", value: "-100" },
            { account: "STK", value: "100", shares: "2", action: "Buy" },
          ],
        },
      ],
      { prices: [rawPrice("EUR", "USD", "2023-12-01", "11/10")] },
    ).investments.transactions[0];
    expect(converted).toMatchObject({
      totalAmount: 110,
      price: 55,
      securityCurrencyCode: "USD",
      cashAmount: -100,
    });
    const inverse = run(
      [
        {
          commodity: "EUR",
          splits: [
            { account: "BRK", value: "-100" },
            { account: "STK", value: "100", shares: "2", action: "Buy" },
          ],
        },
      ],
      { prices: [rawPrice("USD", "EUR", "2023-12-01", "1/2")] },
    ).investments.transactions[0];
    expect(inverse.totalAmount).toBe(200);
  });

  it("keeps the commodity and warns when the file has no price for the pair", () => {
    const { investments } = run([
      {
        commodity: "EUR",
        splits: [
          { account: "BRK", value: "-100" },
          { account: "STK", value: "100", shares: "2", action: "Buy" },
        ],
      },
    ]);
    expect(investments.transactions[0]).toMatchObject({
      totalAmount: 100,
      securityCurrencyCode: "EUR",
    });
    expect(investments.warnings.map((w) => w.code)).toEqual([
      "crossCurrencyTradeUnconverted",
    ]);
  });

  it("never converts at a rate older than FX_MAX_RATE_AGE_DAYS (B1, INV-FX-001)", () => {
    const trade: Tx = {
      commodity: "EUR",
      postDate: "2024-06-03",
      splits: [
        { account: "BRK", value: "-100" },
        { account: "STK", value: "100", shares: "2", action: "Buy" },
      ],
    };
    const stale = run([trade], {
      prices: [rawPrice("EUR", "USD", "2015-03-01", "105/100")],
    });
    expect(stale.investments.transactions[0]).toMatchObject({
      totalAmount: 100,
      securityCurrencyCode: "EUR",
    });
    expect(stale.investments.warnings).toEqual([
      expect.objectContaining({
        code: "crossCurrencyTradeUnconverted",
        // The detail names the pair and the date of the rate that was too old.
        detail: "EUR->USD (2015-03-01)",
      }),
    ]);
    // Forty-five days old is still a rate for the date.
    const fresh = run([trade], {
      prices: [rawPrice("EUR", "USD", "2024-04-19", "11/10")],
    });
    expect(fresh.investments.transactions[0]).toMatchObject({
      totalAmount: 110,
      securityCurrencyCode: "USD",
    });
    expect(fresh.investments.warnings).toEqual([]);
  });
});
