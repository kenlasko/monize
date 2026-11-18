import { InvestmentAction } from "../../../securities/entities/investment-transaction.entity";
import { SplitKind } from "../../../transactions/entities/split-kind.enum";
import { MnyParsedFile } from "../../mny/mny-parser.service";
import {
  SplitInit,
  rawAccount,
  rawFile,
  rawSecurity,
  rawTransaction,
} from "../__fixtures__/kmy-raw-builders";
import { mapKmyFile } from "./kmy-map-file";

/**
 * Spec 5.7.7 (M4): a transaction with a stock split that KMyMoney cannot
 * classify as an investment activity (`MyMoneyFile::isInvestmentTransaction`:
 * no stock split with a recognised action), or a trade whose cash moves the
 * wrong way for its activity (a buy that pays cash in, a sale that pays it
 * out), is never coerced into a trade. Its cash and category legs become an
 * ordinary split row, the share movement its own investment row costed at
 * the stock split's value and embedded in that row's INVESTMENT leg.
 */

const ACCOUNTS = [
  rawAccount({ id: "CHK", name: "Checking", type: 1 }),
  rawAccount({ id: "INV", name: "Broker", type: 7 }),
  rawAccount({ id: "BRK", name: "Broker (Brokerage)", type: 1 }),
  rawAccount({
    id: "STK",
    name: "Example Corp",
    type: 15,
    parentId: "INV",
    currency: "E1",
  }),
  rawAccount({ id: "TAX", name: "Taxes", type: 13 }),
  rawAccount({ id: "SAL", name: "Salary", type: 12 }),
  rawAccount({ id: "FEE", name: "Bank Fees", type: 13 }),
];

function parse(...splits: SplitInit[][]): MnyParsedFile {
  return mapKmyFile(
    rawFile({
      accounts: ACCOUNTS,
      securities: [rawSecurity({ id: "E1", symbol: "EXC" })],
      transactions: splits.map((list, index) =>
        rawTransaction({
          id: `T${index + 1}`,
          postDate: `2024-01-${String(index + 10)}`,
          memo: `tx ${index + 1}`,
          splits: list,
        }),
      ),
    }),
    {
      userDefaultCurrency: "USD",
      phoneRegion: null,
      coinDecimals: new Map(),
      asOf: "2026-01-01",
    },
  );
}

function names(parsed: MnyParsedFile) {
  const accountOf = (key: string | null) =>
    parsed.accounts.accounts.find((a) => a.key === key)?.name ?? key;
  return { accountOf };
}

/** Everything verification can see agrees with the file. */
function expectVerified(parsed: MnyParsedFile): void {
  for (const [key, balance] of parsed.fileBalances!) {
    expect([key, parsed.expectedBalances.get(key)]).toEqual([key, balance]);
  }
  expect(parsed.holdingChecks.every((check) => check.matches)).toBe(true);
  expect(
    parsed.warnings.filter((w) =>
      [
        "mappedBalanceDiffers",
        "holdingsReplayDiffers",
        "tradeAmountsDiffer",
      ].includes(w.code),
    ),
  ).toEqual([]);
}

describe("unclassifiable investment transactions (spec 5.7.7, M4)", () => {
  it("imports a paycheque that also buys shares as a split row with the purchase embedded", () => {
    const parsed = parse([
      { account: "SAL", value: "-5000" },
      { account: "TAX", value: "1000" },
      { account: "CHK", value: "3500" },
      { account: "STK", value: "500", shares: "10", action: "Buy" },
    ]);
    const { accountOf } = names(parsed);

    const [row] = parsed.transactions.transactions;
    expect(parsed.transactions.transactions).toHaveLength(1);
    expect(accountOf(row.accountKey)).toBe("Checking");
    expect(row.amount).toBe(3500);
    const legs = row.splits.map((split) => [
      split.kind,
      split.amount,
      split.categoryHandle,
      split.investmentHandle,
    ]);
    // Salary (ordinal 11) +5000, Taxes (10) -1000, the purchase -500.
    expect(legs).toEqual([
      [SplitKind.CATEGORY, 5000, 11, null],
      [SplitKind.CATEGORY, -1000, 10, null],
      [SplitKind.INVESTMENT, -500, null, 1],
    ]);

    // The share movement, costed at the stock split's own value; no salary
    // turned into investment income, no tax turned into commission.
    expect(parsed.investments.transactions).toHaveLength(1);
    const [buy] = parsed.investments.transactions;
    expect(buy).toMatchObject({
      action: InvestmentAction.BUY,
      quantity: 10,
      totalAmount: 500,
      commission: 0,
      price: 50,
      categoryHandle: null,
      cashAccountKey: row.accountKey,
      fundingAccountKey: null,
      transactionSplitId: row.splits[2].id,
      cashTransactionId: null,
      cashAmount: -500,
    });
    expect(accountOf(buy.accountKey)).toBe("Broker - Brokerage");

    const named = parsed.warnings.filter(
      (w) => w.code === "investmentTransactionUnclassified",
    );
    expect(named).toHaveLength(1);
    expect(named[0]).toMatchObject({
      subject: "transaction 1",
      detail: "Buy",
      row: { date: "2024-01-10" },
    });
    expect(parsed.warnings.map((w) => w.code)).not.toContain(
      "investmentImportedAsCash",
    );
    expectVerified(parsed);
  });

  it("does the same for a buy whose cash split pays cash in", () => {
    const parsed = parse([
      { account: "BRK", value: "100" },
      { account: "STK", value: "500", shares: "10", action: "Buy" },
      { account: "SAL", value: "-600" },
    ]);
    const { accountOf } = names(parsed);
    const [row] = parsed.transactions.transactions;
    expect(accountOf(row.accountKey)).toBe("Broker - Cash");
    expect(row.amount).toBe(100);
    expect(row.splits.map((s) => [s.kind, s.amount])).toEqual([
      [SplitKind.INVESTMENT, -500],
      [SplitKind.CATEGORY, 600],
    ]);
    expect(parsed.investments.transactions).toEqual([
      expect.objectContaining({
        action: InvestmentAction.BUY,
        quantity: 10,
        totalAmount: 500,
        transactionSplitId: row.splits[0].id,
      }),
    ]);
    expectVerified(parsed);
  });

  it("does the same for a sale whose cash split pays cash out", () => {
    const parsed = parse(
      [
        { account: "BRK", value: "-1000" },
        { account: "STK", value: "1000", shares: "10", action: "Buy" },
      ],
      [
        { account: "BRK", value: "-50" },
        { account: "STK", value: "-150", shares: "-5", action: "Buy" },
        { account: "FEE", value: "200" },
      ],
    );
    const sale = parsed.investments.transactions.find(
      (r) => r.action === InvestmentAction.SELL,
    );
    expect(sale).toMatchObject({ quantity: 5, totalAmount: 150 });
    const row = parsed.transactions.transactions.find((r) => r.handle === 2)!;
    expect(row.amount).toBe(-50);
    expect(row.splits.map((s) => [s.kind, s.amount])).toEqual([
      [SplitKind.INVESTMENT, 150],
      [SplitKind.CATEGORY, -200],
    ]);
    expect(sale!.transactionSplitId).toBe(row.splits[0].id);
    expectVerified(parsed);
  });

  it("treats a stock split with an action KMyMoney does not recognise as unclassified", () => {
    const parsed = parse([
      { account: "CHK", value: "-500" },
      { account: "STK", value: "500", shares: "10", action: "Transfer" },
    ]);
    expect(parsed.transactions.transactions[0].splits).toEqual([
      expect.objectContaining({ kind: SplitKind.INVESTMENT, amount: -500 }),
    ]);
    expect(parsed.investments.transactions[0]).toMatchObject({
      action: InvestmentAction.BUY,
      totalAmount: 500,
    });
    expect(
      parsed.warnings.find(
        (w) => w.code === "investmentTransactionUnclassified",
      ),
    ).toMatchObject({ detail: "Transfer" });
    expectVerified(parsed);
  });

  it("leaves an ordinary buy and sale exactly as they were", () => {
    const parsed = parse(
      [
        { account: "BRK", value: "-505" },
        { account: "STK", value: "500", shares: "10", action: "Buy" },
        { account: "FEE", value: "5" },
      ],
      [
        { account: "CHK", value: "145" },
        { account: "STK", value: "-150", shares: "-5", action: "Buy" },
        { account: "FEE", value: "5" },
      ],
    );
    expect(
      parsed.investments.transactions.map((r) => [
        r.action,
        r.totalAmount,
        r.commission,
        r.transactionSplitId,
      ]),
    ).toEqual([
      [InvestmentAction.BUY, 505, 5, null],
      [InvestmentAction.SELL, 145, 5, null],
    ]);
    expect(parsed.warnings.map((w) => w.code)).not.toContain(
      "investmentTransactionUnclassified",
    );
    expectVerified(parsed);
  });
});
