import { rawPrice } from "../__fixtures__/kmy-raw-builders";
import { run } from "./kmy-map-transactions.test-helpers";

describe("mapKmyTransactions: cross-currency (spec 5.6.4, 4.7)", () => {
  it("gives the receiving row the exact implied rate and each side its own shares", () => {
    const { transactions } = run([
      {
        commodity: "USD",
        splits: [
          { account: "CHK", value: "-1100" },
          { account: "EUR", value: "1100", shares: "1000", price: "11/10" },
        ],
      },
    ]);
    const [checking, savings] = transactions.transactions;
    expect(checking).toMatchObject({
      amount: -1100,
      currencyCode: "USD",
      exchangeRate: 1,
    });
    expect(savings).toMatchObject({
      amount: 1000,
      currencyCode: "EUR",
      exchangeRate: 0.9090909091,
    });
  });

  it("puts the rate on the second row when the first receives", () => {
    const { transactions } = run([
      {
        commodity: "USD",
        splits: [
          { account: "EUR", value: "1100", shares: "1000" },
          { account: "CHK", value: "-1100" },
        ],
      },
    ]);
    expect(transactions.transactions.map((r) => r.exchangeRate)).toEqual([
      0.9090909091, 1,
    ]);
  });

  it("uses 1 on both rows for zero amounts and no rate for a one-sided zero", () => {
    const both = run([
      {
        splits: [
          { account: "CHK", value: "0" },
          { account: "EUR", value: "0" },
        ],
      },
    ]);
    expect(both.transactions.transactions.map((r) => r.exchangeRate)).toEqual([
      1, 1,
    ]);
    const one = run([
      {
        splits: [
          { account: "CHK", value: "-5" },
          { account: "EUR", value: "0", shares: "0" },
        ],
      },
    ]);
    // The sending row is 1; the receiving row's rate is unknown, so it is null
    // (never 1).
    expect(one.transactions.transactions.map((r) => r.exchangeRate)).toEqual([
      1,
      null,
    ]);
  });

  describe("a transfer leg that ends up with no exchange rate (spec 9)", () => {
    const noRate = [
      {
        postDate: "2024-03-01",
        splits: [
          { account: "CHK", value: "-5" },
          { account: "EUR", value: "0", shares: "0" },
        ],
      },
    ];

    it("warns with the date, both accounts and the currency pair, sending first", () => {
      const { transactions } = run(noRate);
      expect(transactions.warnings).toHaveLength(1);
      expect(transactions.warnings[0]).toMatchObject({
        code: "crossCurrencyTransferRateMissing",
        detail: "2024-03-01: Checking (USD) to EUR Savings (EUR)",
        row: { date: "2024-03-01" },
      });
    });

    it("names the pair the other way round when the first account receives", () => {
      const { transactions } = run([
        {
          postDate: "2024-03-01",
          splits: [
            { account: "EUR", value: "0", shares: "0" },
            { account: "CHK", value: "-5" },
          ],
        },
      ]);
      expect(transactions.warnings[0]).toMatchObject({
        detail: "2024-03-01: Checking (USD) to EUR Savings (EUR)",
      });
    });

    it("says nothing when the file prices the pair, when the amounts imply a rate, or for the same currency", () => {
      expect(
        run(noRate, { prices: [rawPrice("USD", "EUR", "2024-02-15", "9/10")] })
          .transactions.warnings,
      ).toEqual([]);
      expect(
        run([
          {
            commodity: "USD",
            splits: [
              { account: "CHK", value: "-1100" },
              { account: "EUR", value: "1100", shares: "1000" },
            ],
          },
        ]).transactions.warnings,
      ).toEqual([]);
      expect(
        run([
          {
            splits: [
              { account: "CHK", value: "-5" },
              { account: "SAV", value: "5" },
            ],
          },
        ]).transactions.warnings,
      ).toEqual([]);
      expect(
        run([
          {
            splits: [
              { account: "CHK", value: "0" },
              { account: "EUR", value: "0" },
            ],
          },
        ]).transactions.warnings,
      ).toEqual([]);
    });

    it("warns for the receiving counterpart of a split row too", () => {
      const { transactions } = run([
        {
          postDate: "2024-03-01",
          splits: [
            { account: "CHK", value: "-100" },
            { account: "GRO", value: "100" },
            { account: "EUR", value: "0", shares: "1000" },
          ],
        },
      ]);
      const counterpart = transactions.transactions.find((r) => r.isTransfer);
      expect(counterpart).toMatchObject({ amount: 1000, exchangeRate: null });
      expect(transactions.warnings).toHaveLength(1);
      expect(transactions.warnings[0]).toMatchObject({
        code: "crossCurrencyTransferRateMissing",
        detail: "2024-03-01: Checking (USD) to EUR Savings (EUR)",
      });
    });
  });

  it("does not take a one-sided zero's rate from a file price older than FX_MAX_RATE_AGE_DAYS (B1)", () => {
    const { transactions } = run(
      [
        {
          postDate: "2024-03-01",
          splits: [
            { account: "CHK", value: "-5" },
            { account: "EUR", value: "0", shares: "0" },
          ],
        },
      ],
      // 46 days before the transfer: no longer a rate for its date.
      { prices: [rawPrice("USD", "EUR", "2024-01-15", "9/10")] },
    );
    expect(transactions.transactions.map((r) => r.exchangeRate)).toEqual([
      1,
      null,
    ]);
    expect(transactions.warnings.map((w) => w.code)).toEqual([
      "crossCurrencyTransferRateMissing",
    ]);
  });

  it("takes a one-sided zero's rate from the file's own price for the pair", () => {
    const { transactions } = run(
      [
        {
          postDate: "2024-03-01",
          splits: [
            { account: "CHK", value: "-5" },
            { account: "EUR", value: "0", shares: "0" },
          ],
        },
      ],
      { prices: [rawPrice("USD", "EUR", "2024-02-15", "9/10")] },
    );
    expect(transactions.transactions.map((r) => r.exchangeRate)).toEqual([
      1, 0.9,
    ]);
  });

  it("converts a foreign category leg through the parent's ratio and rates a split-row counterpart", () => {
    const { transactions } = run([
      {
        commodity: "USD",
        splits: [
          { account: "CHK", value: "-1200" },
          { account: "EGRO", value: "100", shares: "90" },
          { account: "EUR", value: "1100", shares: "1000" },
        ],
      },
    ]);
    const [parent, counterpart] = transactions.transactions;
    expect(parent.amount).toBe(-1200);
    expect(parent.splits.map((s) => s.amount)).toEqual([-100, -1100]);
    expect(counterpart).toMatchObject({
      amount: 1000,
      exchangeRate: 0.9090909091,
    });
  });

  it("converts the legs of a foreign-currency parent at its own ratio", () => {
    const { transactions } = run([
      {
        commodity: "USD",
        splits: [
          { account: "EUR", value: "-1100", shares: "-1000" },
          { account: "GRO", value: "1000" },
          { account: "FEE", value: "100" },
        ],
      },
    ]);
    const [row] = transactions.transactions;
    expect(row.currencyCode).toBe("EUR");
    expect(row.amount).toBe(-1000);
    expect(row.splits.map((s) => s.amount)).toEqual([-909.0909, -90.9091]);
    expect(row.splits.reduce((sum, s) => sum + s.amount, 0)).toBeCloseTo(
      -1000,
      10,
    );
  });

  it("puts a rounding residual onto the largest leg so the legs sum to the parent exactly", () => {
    const { transactions } = run([
      {
        commodity: "USD",
        splits: [
          { account: "EUR", value: "-1", shares: "-2/3" },
          { account: "GRO", value: "1/3" },
          { account: "FEE", value: "1/3" },
          { account: "INT", value: "1/3" },
        ],
      },
    ]);
    const [row] = transactions.transactions;
    expect(row.amount).toBe(-0.6667);
    expect(row.splits.map((s) => s.amount)).toEqual([
      -0.2223, -0.2222, -0.2222,
    ]);
    expect(transactions.warnings).toEqual([]);
  });

  it("handles a parent whose value is 0", () => {
    const sameCurrency = run([
      {
        commodity: "USD",
        splits: [
          { account: "EUR", value: "0", shares: "-50" },
          { account: "EGRO", value: "0", shares: "20" },
          { account: "EFEE", value: "0", shares: "30" },
        ],
      },
    ]);
    const [parent] = sameCurrency.transactions.transactions;
    expect(parent.amount).toBe(-50);
    expect(parent.splits.map((s) => s.amount)).toEqual([-20, -30]);
    expect(sameCurrency.transactions.warnings).toEqual([]);
    const otherCurrency = run([
      {
        commodity: "USD",
        splits: [
          { account: "EUR", value: "0", shares: "-50" },
          { account: "GRO", value: "0", shares: "50" },
          { account: "FEE", value: "0", shares: "0" },
        ],
      },
    ]);
    const [row] = otherCurrency.transactions.transactions;
    expect(row.splits.map((s) => s.amount)).toEqual([0, 0, -50]);
    expect(otherCurrency.transactions.warnings.map((w) => w.code)).toEqual([
      "unbalancedTransaction",
    ]);
  });
});
