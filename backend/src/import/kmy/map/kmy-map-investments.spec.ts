import { InvestmentAction } from "../../../securities/entities/investment-transaction.entity";
import { TransactionStatus } from "../../../transactions/entities/transaction.entity";
import {
  SplitInit,
  rawAccount,
  rawFile,
  rawPayee,
  rawPrice,
  rawSecurity,
  rawTag,
  rawTransaction,
} from "../__fixtures__/kmy-raw-builders";
import { harness } from "./kmy-map.harness";
import { mapKmyInvestments } from "./kmy-map-investments";

// Ordinals: roots 1-5, INV 6, BRK 7, STK 8, CHK 9, FEE 10, DIV 11, EQ 12, ...
const ACCOUNTS = [
  rawAccount({ id: "INV", name: "Broker", type: 7 }),
  rawAccount({ id: "BRK", name: "Broker (Brokerage)", type: 1 }),
  rawAccount({
    id: "STK",
    name: "Example Corp",
    type: 15,
    parentId: "INV",
    currency: "E1",
  }),
  rawAccount({ id: "CHK", name: "Checking", type: 1 }),
  rawAccount({ id: "FEE", name: "Bank Fees", type: 13 }),
  rawAccount({ id: "DIV", name: "Dividends", type: 12 }),
  rawAccount({ id: "EQ", name: "Opening Balances", type: 16 }),
  rawAccount({ id: "INV2", name: "Other Broker", type: 7 }),
  rawAccount({ id: "BRK2", name: "Other Broker (Brokerage)", type: 1 }),
  rawAccount({
    id: "STK2",
    name: "Example Corp",
    type: 15,
    parentId: "INV2",
    currency: "E1",
  }),
  rawAccount({ id: "EINV", name: "Euro Broker", type: 7, currency: "EUR" }),
  rawAccount({
    id: "EBRK",
    name: "Euro Broker (Brokerage)",
    type: 1,
    currency: "EUR",
  }),
  rawAccount({
    id: "ESTK",
    name: "Example Corp",
    type: 15,
    parentId: "EINV",
    currency: "E1",
  }),
  rawAccount({
    id: "STK3",
    name: "Other Corp",
    type: 15,
    parentId: "INV",
    currency: "E3",
  }),
  rawAccount({ id: "ORPHAN", name: "Orphan", type: 15, currency: "E1" }),
  rawAccount({
    id: "COIN",
    name: "Coin holding",
    type: 15,
    parentId: "INV",
    currency: "E4",
  }),
];

const SECURITIES = [
  rawSecurity({
    id: "E1",
    name: "Example Corp",
    symbol: "EXC",
    tradingCurrency: "USD",
  }),
  rawSecurity({
    id: "E3",
    name: "Other Corp",
    symbol: "OTH",
    tradingCurrency: "USD",
  }),
  rawSecurity({
    id: "E4",
    name: "Coin",
    symbol: "COIN",
    tradingCurrency: "BTC",
  }),
];

interface Tx {
  id?: string;
  postDate?: string | null;
  memo?: string;
  commodity?: string | null;
  splits: SplitInit[];
}

function run(
  transactions: Tx[],
  extra: Partial<Parameters<typeof rawFile>[0]> = {},
  init: Parameters<typeof harness>[1] = {},
) {
  const raw = rawFile({
    accounts: ACCOUNTS,
    securities: SECURITIES,
    payees: [rawPayee("P1", "Broker Joe"), rawPayee("P2", "Payer")],
    tags: [rawTag("G1", "growth")],
    ...extra,
    transactions: transactions.map((tx, index) =>
      rawTransaction({ id: `T${index + 1}`, ...tx }),
    ),
  });
  const { investmentContext } = harness(raw, init);
  return mapKmyInvestments(investmentContext, new Set());
}

const BUY: Tx = {
  splits: [
    { account: "BRK", value: "-505" },
    { account: "STK", value: "500", shares: "10", price: "50", action: "Buy" },
    { account: "FEE", value: "5" },
  ],
};

describe("mapKmyInvestments: the activity table (spec 5.7.2)", () => {
  it("maps BuyShares", () => {
    const { investments } = run([
      {
        memo: "tx memo",
        splits: [
          {
            account: "BRK",
            value: "-505",
            payee: "P2",
            reconcileFlag: 1,
            tags: ["G1"],
          },
          {
            account: "STK",
            value: "500",
            shares: "10",
            action: "Buy",
            payee: "P1",
            memo: "Buy EXC",
          },
          { account: "FEE", value: "5" },
        ],
      },
    ]);
    expect(investments.transactions).toHaveLength(1);
    expect(investments.transactions[0]).toMatchObject({
      handle: 1,
      accountKey: "acct-6",
      cashAccountKey: "acct-7",
      fundingAccountKey: null,
      cashTransactionId: null,
      transactionSplitId: null,
      action: InvestmentAction.BUY,
      quantity: 10,
      totalAmount: 505,
      commission: 5,
      price: 50,
      accruedInterest: 0,
      cashAmount: -505,
      exchangeRate: 1,
      currencyCode: "USD",
      securityCurrencyCode: "USD",
      securityHandle: 1,
      status: TransactionStatus.CLEARED,
      payeeHandle: 1,
      categoryHandle: null,
      description: "Buy EXC",
      linkedInvestmentId: null,
      tagHandles: [1],
    });
    expect(investments.warnings).toEqual([]);
    expect([...investments.referencedSecurities]).toEqual([1]);
    expect([...investments.referencedPayees]).toEqual([1]);
  });

  it("maps SellShares with the commission taken out of the proceeds", () => {
    const { investments } = run([
      {
        splits: [
          { account: "BRK", value: "145" },
          { account: "STK", value: "-150", shares: "-5", action: "Buy" },
          { account: "FEE", value: "5" },
        ],
      },
    ]);
    expect(investments.transactions[0]).toMatchObject({
      action: InvestmentAction.SELL,
      quantity: 5,
      totalAmount: 145,
      commission: 5,
      price: 30,
      cashAmount: 145,
    });
  });

  it.each([
    ["Dividend", InvestmentAction.DIVIDEND],
    ["Yield", InvestmentAction.DIVIDEND],
    ["IntIncome", InvestmentAction.INTEREST],
  ])(
    "maps %s with the income split as gross and its category",
    (action, expected) => {
      const { investments } = run([
        {
          splits: [
            { account: "BRK", value: "15/2" },
            { account: "STK", value: "0", shares: "0", action },
            { account: "DIV", value: "-15/2" },
          ],
        },
      ]);
      expect(investments.transactions[0]).toMatchObject({
        action: expected,
        quantity: null,
        totalAmount: 7.5,
        price: 7.5,
        commission: 0,
        cashAmount: 7.5,
        categoryHandle: 11,
      });
      expect([...investments.referencedCategories]).toEqual([11]);
    },
  );

  it("derives a dividend with no income split from the cash and fees", () => {
    const { investments } = run([
      {
        splits: [
          { account: "BRK", value: "9" },
          { account: "STK", value: "0", shares: "0", action: "Dividend" },
          { account: "FEE", value: "1" },
        ],
      },
    ]);
    expect(investments.transactions[0]).toMatchObject({
      totalAmount: 10,
      commission: 1,
      categoryHandle: null,
      cashAmount: 9,
    });
  });

  it("maps ReinvestDividend, with and without a cash split", () => {
    const withCash = run([
      {
        splits: [
          { account: "BRK", value: "-100" },
          { account: "STK", value: "100", shares: "-4", action: "Reinvest" },
          { account: "DIV", value: "-100" },
        ],
      },
    ]).investments.transactions[0];
    expect(withCash).toMatchObject({
      action: InvestmentAction.REINVEST,
      quantity: 4,
      totalAmount: 100,
      price: -25,
      cashAmount: -100,
      categoryHandle: 11,
    });
    const without = run([
      {
        splits: [
          { account: "STK", value: "100", shares: "4", action: "Reinvest" },
          { account: "DIV", value: "-100" },
        ],
      },
    ]).investments.transactions[0];
    expect(without).toMatchObject({
      quantity: 4,
      price: 25,
      cashAccountKey: null,
      cashAmount: 0,
    });
    const zero = run([
      {
        splits: [
          { account: "STK", value: "0", shares: "0", action: "Reinvest" },
        ],
      },
    ]).investments.transactions[0];
    expect(zero.price).toBeNull();
  });

  it("maps AddShares and RemoveShares with no cost and no cash", () => {
    const { investments } = run([
      { splits: [{ account: "STK", value: "0", shares: "10", action: "Add" }] },
      {
        postDate: "2024-01-02",
        splits: [{ account: "STK", value: "0", shares: "-4", action: "Add" }],
      },
    ]);
    expect(
      investments.transactions.map((r) => [
        r.action,
        r.quantity,
        r.totalAmount,
        r.price,
        r.cashAccountKey,
      ]),
    ).toEqual([
      [InvestmentAction.ADD_SHARES, 10, 0, null, null],
      [InvestmentAction.REMOVE_SHARES, 4, 0, null, null],
    ]);
    expect(investments.warnings.map((w) => w.code)).toEqual([
      "sharesAddedWithoutCost",
    ]);
    expect(investments.warnings[0].row).toMatchObject({
      handle: 1,
      accountKey: "acct-6",
    });
  });

  it("maps a stock split of one split with the shares as the multiplier", () => {
    const { investments } = run([
      {
        splits: [{ account: "STK", value: "0", shares: "2", action: "Split" }],
      },
    ]);
    expect(investments.transactions[0]).toMatchObject({
      action: InvestmentAction.SPLIT,
      quantity: 2,
      cashAmount: 0,
    });
    expect(investments.warnings).toEqual([]);
  });

  it("imports a Split action inside a multi-split transaction as added or removed shares", () => {
    const { investments } = run([
      {
        splits: [
          { account: "STK", value: "0", shares: "3", action: "Split" },
          { account: "FEE", value: "0" },
        ],
      },
      {
        splits: [
          { account: "STK", value: "0", shares: "-3", action: "Split" },
          { account: "FEE", value: "0" },
        ],
      },
    ]);
    expect(investments.transactions.map((r) => r.action)).toEqual([
      InvestmentAction.ADD_SHARES,
      InvestmentAction.REMOVE_SHARES,
    ]);
    expect(investments.warnings.map((w) => w.code)).toEqual([
      "splitActionInMultiSplit",
      "splitActionInMultiSplit",
      "sharesAddedWithoutCost",
    ]);
  });

  it("treats an unknown or empty action as a buy", () => {
    const { investments } = run([
      {
        splits: [
          { account: "BRK", value: "-50" },
          { account: "STK", value: "50", shares: "5", action: "" },
        ],
      },
    ]);
    expect(investments.transactions[0]).toMatchObject({
      action: InvestmentAction.BUY,
      quantity: 5,
      price: 10,
    });
  });

  it("makes an INTEREST companion of income on a trade and a fee of a negative one", () => {
    const { investments } = run([
      {
        splits: [
          { account: "BRK", value: "-95" },
          { account: "STK", value: "100", shares: "1", action: "Buy" },
          { account: "DIV", value: "-8" },
          { account: "DIV", value: "3" },
          { account: "FEE", value: "-0" },
        ],
      },
    ]);
    const [main, companion] = investments.transactions;
    expect(investments.transactions).toHaveLength(2);
    expect(main).toMatchObject({
      action: InvestmentAction.BUY,
      commission: 3,
      totalAmount: 103,
      cashAmount: -95,
      linkedInvestmentId: companion.id,
    });
    expect(companion).toMatchObject({
      action: InvestmentAction.INTEREST,
      quantity: null,
      totalAmount: 8,
      price: 8,
      cashAmount: 0,
      cashAccountKey: null,
      categoryHandle: 11,
      linkedInvestmentId: main.id,
    });
  });
});

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

describe("mapKmyInvestments: shapes that import as cash (spec 5.7.6)", () => {
  it("imports a stock account outside any investment account for its cash only", () => {
    const { investments, cashRows } = run([
      {
        memo: "m",
        splits: [
          { account: "CHK", value: "-10" },
          {
            account: "ORPHAN",
            value: "10",
            shares: "1",
            action: "Buy",
            memo: "stock memo",
          },
          { account: "FEE", value: "1" },
        ],
      },
    ]);
    expect(investments.transactions).toHaveLength(0);
    expect(cashRows).toHaveLength(1);
    expect(cashRows[0]).toMatchObject({
      accountKey: "acct-9",
      amount: -10,
      categoryHandle: null,
      description: "stock memo",
    });
    expect(investments.warnings.map((w) => w.code)).toEqual([
      "stockAccountWithoutInvestment",
      "investmentImportedAsCash",
    ]);
    expect(investments.skipped).toBe(1);
  });

  it("imports a trade of a security that cannot import for its cash only", () => {
    const { investments, cashRows } = run(
      [
        {
          splits: [
            { account: "BRK", value: "-10" },
            { account: "COIN", value: "10", shares: "1", action: "Buy" },
          ],
        },
      ],
      {},
      { coinDecimals: new Map([["BTC", 8]]) },
    );
    expect(investments.transactions).toHaveLength(0);
    expect(cashRows[0]).toMatchObject({ accountKey: "acct-7", amount: -10 });
    expect(investments.warnings.map((w) => w.code)).toEqual([
      "investmentImportedAsCash",
    ]);
  });

  it("imports a buy of zero shares and a sale whose fees exceed its proceeds as cash only", () => {
    const { investments, cashRows } = run([
      {
        splits: [
          { account: "BRK", value: "-5" },
          { account: "STK", value: "0", shares: "0", action: "Buy" },
          { account: "FEE", value: "5" },
        ],
      },
      {
        splits: [
          { account: "BRK", value: "-3" },
          { account: "STK", value: "-2", shares: "-1", action: "Buy" },
          { account: "FEE", value: "5" },
        ],
      },
      {
        splits: [
          { account: "BRK", value: "-3" },
          { account: "STK", value: "0", shares: "0", action: "Dividend" },
          { account: "FEE", value: "5" },
          { account: "DIV", value: "1" },
        ],
      },
      {
        splits: [
          { account: "BRK", value: "-3" },
          { account: "STK", value: "-9", shares: "1", action: "Reinvest" },
          { account: "FEE", value: "5" },
        ],
      },
    ]);
    expect(investments.transactions).toHaveLength(0);
    expect(cashRows.map((r) => r.amount)).toEqual([-5, -3, -3, -3]);
    expect(investments.warnings.map((w) => w.code)).toEqual(
      Array(4).fill("investmentImportedAsCash"),
    );
  });

  it("imports an extra asset split as its own row", () => {
    const { investments, cashRows } = run([
      {
        splits: [
          { account: "BRK", value: "-10" },
          { account: "STK", value: "10", shares: "1", action: "Buy" },
          { account: "CHK", value: "-4" },
        ],
      },
    ]);
    expect(investments.transactions).toHaveLength(1);
    expect(cashRows).toHaveLength(1);
    expect(cashRows[0]).toMatchObject({
      accountKey: "acct-9",
      amount: -4,
      categoryHandle: null,
    });
    expect(investments.warnings.map((w) => w.code)).toEqual([
      "investmentExtraAssetSplit",
    ]);
  });

  it("imports a stray asset split on an activity that moves no cash as its own row", () => {
    const { investments, cashRows } = run([
      {
        splits: [
          { account: "STK", value: "0", shares: "10", action: "Add" },
          { account: "CHK", value: "-3" },
        ],
      },
    ]);
    expect(investments.transactions).toHaveLength(1);
    expect(cashRows).toHaveLength(1);
    expect(cashRows[0]).toMatchObject({ accountKey: "acct-9", amount: -3 });
    expect(investments.warnings.map((w) => w.code)).toContain(
      "investmentExtraAssetSplit",
    );
  });

  it("adds shares for a dividend that also changed the share count", () => {
    const { investments } = run([
      {
        splits: [
          { account: "BRK", value: "5" },
          { account: "STK", value: "0", shares: "-2", action: "Dividend" },
          { account: "DIV", value: "-5" },
        ],
      },
    ]);
    expect(
      investments.transactions.map((r) => [r.action, r.quantity, r.cashAmount]),
    ).toEqual([
      [InvestmentAction.DIVIDEND, null, 5],
      [InvestmentAction.REMOVE_SHARES, 2, 0],
    ]);
    expect(investments.warnings.map((w) => w.code)).toEqual([
      "investmentSharesOnIncomeAction",
    ]);
  });

  it("imports further stock splits as shares in their own holding", () => {
    const { investments } = run([
      {
        splits: [
          { account: "BRK", value: "-10" },
          { account: "STK", value: "10", shares: "1", action: "Buy" },
          { account: "STK3", value: "5", shares: "3", action: "Buy" },
          { account: "STK3", value: "0", shares: "0", action: "Buy" },
          { account: "ORPHAN", value: "0", shares: "1", action: "Add" },
        ],
      },
    ]);
    const rows = investments.transactions;
    expect(
      rows.map((r) => [r.action, r.quantity, r.securityHandle, r.accountKey]),
    ).toEqual([
      [InvestmentAction.BUY, 1, 1, "acct-6"],
      [InvestmentAction.ADD_SHARES, 3, 2, "acct-6"],
    ]);
    expect(
      investments.warnings.filter((w) => w.code === "multipleStockSplits"),
    ).toHaveLength(3);
  });
});

describe("mapKmyInvestments: shares moved between brokerage accounts (spec 5.7.4)", () => {
  const buy: Tx = {
    postDate: "2024-02-10",
    splits: [
      { account: "BRK", value: "-505" },
      { account: "STK", value: "500", shares: "10", action: "Buy" },
      { account: "FEE", value: "5" },
    ],
  };

  it("pairs a removal and an addition of the same date, security and quantity", () => {
    const { investments } = run([
      buy,
      {
        postDate: "2024-06-01",
        splits: [{ account: "STK", value: "0", shares: "-10", action: "Add" }],
      },
      {
        postDate: "2024-06-01",
        splits: [{ account: "STK2", value: "0", shares: "10", action: "Add" }],
      },
    ]);
    expect(investments.transfersPaired).toBe(1);
    const [bought, out, into] = investments.transactions;
    expect(bought.action).toBe(InvestmentAction.BUY);
    expect(out).toMatchObject({
      action: InvestmentAction.TRANSFER_OUT,
      accountKey: "acct-6",
    });
    expect(into).toMatchObject({
      action: InvestmentAction.TRANSFER_IN,
      accountKey: "acct-13",
    });
    expect(out.linkedInvestmentId).toBe(into.id);
    expect(into.linkedInvestmentId).toBe(out.id);
    expect(investments.warnings).toEqual([]);
  });

  it("leaves a different date or quantity unpaired and warns about every added share", () => {
    const { investments } = run([
      buy,
      {
        postDate: "2024-06-01",
        splits: [{ account: "STK", value: "0", shares: "-10", action: "Add" }],
      },
      {
        postDate: "2024-06-02",
        splits: [{ account: "STK2", value: "0", shares: "10", action: "Add" }],
      },
    ]);
    expect(investments.transfersPaired).toBe(0);
    expect(investments.transactions.map((r) => r.action)).toEqual([
      InvestmentAction.BUY,
      InvestmentAction.REMOVE_SHARES,
      InvestmentAction.ADD_SHARES,
    ]);
    expect(investments.warnings.map((w) => w.code)).toEqual([
      "sharesAddedWithoutCost",
    ]);
  });
});

describe("mapKmyInvestments: the rest", () => {
  it("rejects a transaction with no usable date", () => {
    const { investments } = run([{ postDate: null, ...BUY }]);
    expect(investments.transactions).toHaveLength(0);
    expect(investments.skipped).toBe(1);
    expect(investments.warnings.map((w) => w.code)).toEqual([
      "unusableTransaction",
    ]);
  });

  it("silently imports the cash of an investment account that was left out", () => {
    const { investments, cashRows } = run(
      [BUY],
      {},
      {
        options: {
          accounts: [{ handle: 6, include: false, currencyOverride: null }],
        },
      },
    );
    expect(investments.transactions).toHaveLength(0);
    expect(investments.warnings).toEqual([]);
    expect(cashRows).toHaveLength(0);
  });

  it("reports an unknown payee and keeps transactions with no stock split out", () => {
    const { investments } = run([
      {
        splits: [
          { account: "BRK", value: "-1", payee: "PX" },
          { account: "STK", value: "1", shares: "1", action: "Buy" },
        ],
      },
      {
        splits: [
          { account: "CHK", value: "-1" },
          { account: "FEE", value: "1" },
        ],
      },
    ]);
    expect(investments.transactions[0].payeeHandle).toBeNull();
    expect(investments.warnings.map((w) => w.code)).toEqual([
      "unknownPayeeReference",
    ]);
    expect(investments.transactions).toHaveLength(1);
  });

  it("orders the rows by date and carries the model's empty fields", () => {
    const { investments } = run([
      { postDate: "2024-03-01", ...BUY },
      { postDate: "2024-01-01", ...BUY },
    ]);
    expect(investments.transactions.map((r) => r.transactionDate)).toEqual([
      "2024-01-01",
      "2024-03-01",
    ]);
    expect(investments.rateGaps).toEqual([]);
  });
});
