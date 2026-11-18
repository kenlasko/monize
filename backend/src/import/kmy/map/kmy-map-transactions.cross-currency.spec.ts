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

  describe("the rate of a split row's transfer counterpart (spec 5.6.4.1, m2)", () => {
    it("rates a sending counterpart as Monize does, the parent keeping 1, when the parent receives", () => {
      // The review's input: EUR account +100 (parent), Checking -33 USD
      // (value -30 EUR), Salary -70.
      const { transactions } = run([
        {
          commodity: "EUR",
          splits: [
            { account: "EUR", value: "100" },
            { account: "CHK", value: "-30", shares: "-33" },
            { account: "SAL", value: "-70" },
          ],
        },
      ]);
      const [parent, counterpart] = transactions.transactions;
      expect(parent).toMatchObject({
        currencyCode: "EUR",
        amount: 100,
        exchangeRate: 1,
      });
      expect(
        parent.splits.map((s) => [s.transferAccountKey, s.amount]),
      ).toEqual([
        [expect.any(String), 30],
        [null, 70],
      ]);
      // USD per EUR, the counterpart's currency per unit of the parent's: what
      // TransactionSplitService stores on the counterpart in either direction.
      expect(counterpart).toMatchObject({
        currencyCode: "USD",
        amount: -33,
        isTransfer: true,
        linkedTransactionId: parent.id,
        exchangeRate: 1.1,
      });
      expect(transactions.warnings).toEqual([]);
    });

    it("orients the rate the same way when the counterpart receives", () => {
      const { transactions } = run([
        {
          commodity: "EUR",
          splits: [
            { account: "EUR", value: "-100" },
            { account: "CHK", value: "30", shares: "33" },
            { account: "EGRO", value: "70" },
          ],
        },
      ]);
      const [parent, counterpart] = transactions.transactions;
      expect(parent.exchangeRate).toBe(1);
      expect(counterpart).toMatchObject({ amount: 33, exchangeRate: 1.1 });
    });

    it("takes the split's exact shares over value, not the rounded leg", () => {
      // The EUR leg is -10/3 USD, stored as -3.3333: 3 / 3.3333 would be
      // 0.9000090001, the file's own ratio is 0.9 exactly.
      for (const sign of ["", "-"]) {
        const back = sign === "" ? "-" : "";
        const { transactions } = run([
          {
            commodity: "USD",
            splits: [
              { account: "CHK", value: `${back}10` },
              { account: "EUR", value: `${sign}10/3`, shares: `${sign}3` },
              { account: "GRO", value: `${sign}20/3` },
            ],
          },
        ]);
        const counterpart = transactions.transactions.find((r) => r.isTransfer);
        expect(counterpart).toMatchObject({
          amount: Number(`${sign}3`),
          exchangeRate: 0.9,
        });
        expect(transactions.warnings).toEqual([]);
      }
    });

    it("gives a sending counterpart with no implied rate the file's price, else null with the warning sending first", () => {
      const oneSided = [
        {
          postDate: "2024-03-01",
          commodity: "USD",
          splits: [
            { account: "CHK", value: "100" },
            { account: "EUR", value: "0", shares: "-1000" },
            { account: "SAL", value: "-100" },
          ],
        },
      ];
      const missing = run(oneSided).transactions;
      expect(missing.transactions.find((r) => r.isTransfer)).toMatchObject({
        amount: -1000,
        exchangeRate: null,
      });
      expect(missing.transactions[0].exchangeRate).toBe(1);
      expect(missing.warnings).toHaveLength(1);
      expect(missing.warnings[0]).toMatchObject({
        code: "crossCurrencyTransferRateMissing",
        detail: "2024-03-01: EUR Savings (EUR) to Checking (USD)",
      });

      const priced = run(oneSided, {
        prices: [rawPrice("USD", "EUR", "2024-02-15", "9/10")],
      }).transactions;
      expect(priced.transactions.find((r) => r.isTransfer)?.exchangeRate).toBe(
        0.9,
      );
      expect(priced.warnings).toEqual([]);
    });

    it("keeps 1 for a counterpart that moves nothing on either side", () => {
      const { transactions } = run([
        {
          splits: [
            { account: "CHK", value: "-100" },
            { account: "GRO", value: "100" },
            { account: "EUR", value: "0", shares: "0" },
          ],
        },
      ]);
      expect(
        transactions.transactions.find((r) => r.isTransfer)?.exchangeRate,
      ).toBe(1);
      expect(transactions.warnings).toEqual([]);
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
