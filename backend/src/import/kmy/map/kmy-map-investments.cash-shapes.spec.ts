import { InvestmentAction } from "../../../securities/entities/investment-transaction.entity";
import { Tx, run, BUY } from "./kmy-map-investments.test-helpers";

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

  it("imports a buy of zero shares and a dividend or reinvestment below zero as cash only, and keeps the shares of a sale whose fees exceed its proceeds", () => {
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
    // The sale that pays cash out is no longer cash only: it fits no trade,
    // so its share movement is kept, embedded in the split row (spec 5.7.7).
    expect(
      investments.transactions.map((r) => [r.handle, r.action, r.quantity]),
    ).toEqual([[2, InvestmentAction.SELL, 1]]);
    expect(cashRows.map((r) => r.amount)).toEqual([-5, -3, -3, -3]);
    expect(cashRows[1].splits.map((split) => split.amount)).toEqual([2, -5]);
    expect(investments.warnings.map((w) => w.code)).toEqual([
      "investmentImportedAsCash",
      "investmentTransactionUnclassified",
      "investmentImportedAsCash",
      "investmentImportedAsCash",
    ]);
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
