import { InvestmentAction } from "../../../securities/entities/investment-transaction.entity";
import { TransactionStatus } from "../../../transactions/entities/transaction.entity";
import { run } from "./kmy-map-investments.test-helpers";

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
