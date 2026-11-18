import { SplitKind } from "../../../transactions/entities/split-kind.enum";
import { TransactionStatus } from "../../../transactions/entities/transaction.entity";
import { run } from "./kmy-map-transactions.test-helpers";

describe("mapKmyTransactions: classification (spec 5.6.1)", () => {
  it("does not import a transaction without an asset or liability split", () => {
    const { transactions } = run([
      {
        splits: [
          { account: "GRO", value: "10" },
          { account: "FEE", value: "-10" },
        ],
      },
    ]);
    expect(transactions.transactions).toHaveLength(0);
    expect(transactions.skipped).toBe(1);
    expect(transactions.warnings.map((w) => w.code)).toEqual([
      "unusableTransaction",
    ]);
    expect(transactions.warnings[0].row).toMatchObject({
      handle: 1,
      date: "2024-01-01",
    });
  });

  it("imports a one-split transaction as an uncategorized row with a warning", () => {
    const { transactions } = run([
      { splits: [{ account: "CHK", value: "-5" }] },
    ]);
    expect(transactions.transactions).toHaveLength(1);
    expect(transactions.transactions[0]).toMatchObject({
      accountKey: "acct-6",
      amount: -5,
      categoryHandle: null,
      isTransfer: false,
      splits: [],
      collapsedTradeHandle: null,
    });
    expect(transactions.warnings.map((w) => w.code)).toEqual([
      "singleSplitTransaction",
    ]);
  });

  it("imports an asset plus one category as one row with that category", () => {
    const { transactions } = run([
      {
        splits: [
          { account: "CHK", value: "-100" },
          { account: "GRO", value: "100", tags: ["G1"] },
        ],
      },
    ]);
    expect(transactions.transactions).toHaveLength(1);
    expect(transactions.transactions[0]).toMatchObject({
      amount: -100,
      categoryHandle: 11,
      tagHandles: [1],
    });
    expect([...transactions.referencedCategories]).toEqual([11]);
    expect([...transactions.referencedTags]).toEqual([1]);
  });

  it("imports an asset plus equity as a category and warns", () => {
    const { transactions, equityUsed } = run([
      {
        splits: [
          { account: "CHK", value: "12.34" },
          { account: "EQ", value: "-12.34" },
        ],
      },
    ]);
    expect(transactions.transactions[0].categoryHandle).toBe(16);
    expect(transactions.warnings.map((w) => w.code)).toEqual([
      "equitySplitAsCategory",
    ]);
    expect([...equityUsed]).toEqual([16]);
  });

  it("imports two asset splits as a linked transfer pair", () => {
    const { transactions } = run([
      {
        splits: [
          {
            account: "SAV",
            value: "-100",
            reconcileFlag: 2,
            reconcileDate: "2024-02-02",
          },
          { account: "CHK", value: "100", reconcileFlag: 1 },
        ],
      },
    ]);
    const [out, into] = transactions.transactions;
    expect(out).toMatchObject({
      accountKey: "acct-7",
      amount: -100,
      isTransfer: true,
      linkedTransactionId: into.id,
      status: TransactionStatus.RECONCILED,
      reconciledDate: "2024-02-02",
      exchangeRate: 1,
      handle: 1,
    });
    expect(into).toMatchObject({
      accountKey: "acct-6",
      amount: 100,
      isTransfer: true,
      linkedTransactionId: out.id,
      status: TransactionStatus.CLEARED,
      reconciledDate: null,
      exchangeRate: 1,
      handle: 1,
    });
    expect(transactions.transfersLinked).toBe(1);
  });
});

describe("mapKmyTransactions: worked examples (spec 5.6.7)", () => {
  it("splits a purchase into category legs", () => {
    const { transactions } = run([
      {
        splits: [
          { account: "CHK", value: "-241/2" },
          { account: "GRO", value: "201/2", memo: "Food", tags: ["G1"] },
          { account: "FEE", value: "20" },
        ],
      },
    ]);
    const [row] = transactions.transactions;
    expect(row.amount).toBe(-120.5);
    expect(
      row.splits.map((s) => [
        s.kind,
        s.categoryHandle,
        s.amount,
        s.memo,
        s.tagHandles,
      ]),
    ).toEqual([
      [SplitKind.CATEGORY, 11, -100.5, "Food", [1]],
      [SplitKind.CATEGORY, 12, -20, null, []],
    ]);
    expect(transactions.warnings).toEqual([]);
  });

  it("pays a loan: a transfer leg with its counterpart, and an interest leg", () => {
    const { transactions } = run([
      {
        splits: [
          { account: "CHK", value: "-500" },
          { account: "LOAN", value: "400", action: "Amortization" },
          { account: "INT", value: "100" },
        ],
      },
    ]);
    const [parent, counterpart] = transactions.transactions;
    expect(transactions.transactions).toHaveLength(2);
    expect(parent.amount).toBe(-500);
    const [transfer, interest] = parent.splits;
    expect(transfer).toMatchObject({
      kind: SplitKind.TRANSFER,
      transferAccountKey: "acct-9",
      amount: -400,
      categoryHandle: null,
      linkedTransactionId: counterpart.id,
    });
    expect(interest).toMatchObject({
      kind: SplitKind.CATEGORY,
      categoryHandle: 13,
      amount: -100,
    });
    expect(counterpart).toMatchObject({
      accountKey: "acct-9",
      amount: 400,
      isTransfer: true,
      linkedTransactionId: parent.id,
      exchangeRate: 1,
    });
    expect(transactions.transfersLinked).toBe(1);
  });

  it("books a paycheque: income and tax categories and a transfer leg to savings", () => {
    const { transactions } = run([
      {
        splits: [
          { account: "CHK", value: "2000" },
          { account: "SAL", value: "-2500" },
          { account: "TAX", value: "400" },
          { account: "SAV", value: "100" },
        ],
      },
    ]);
    const [parent, counterpart] = transactions.transactions;
    expect(parent).toMatchObject({ accountKey: "acct-6", amount: 2000 });
    expect(parent.splits.map((s) => [s.kind, s.amount])).toEqual([
      [SplitKind.CATEGORY, 2500],
      [SplitKind.CATEGORY, -400],
      [SplitKind.TRANSFER, -100],
    ]);
    expect(counterpart).toMatchObject({ accountKey: "acct-7", amount: 100 });
  });

  it("makes two transfer legs and two counterparts from a three-way transfer", () => {
    const { transactions } = run([
      {
        splits: [
          { account: "CHK", value: "-300" },
          { account: "SAV", value: "100" },
          { account: "BRK", value: "200" },
        ],
      },
    ]);
    expect(
      transactions.transactions.map((r) => [r.accountKey, r.amount]),
    ).toEqual([
      ["acct-6", -300],
      ["acct-7", 100],
      ["acct-10", 200],
    ]);
    expect(transactions.transactions[0].splits.map((s) => s.amount)).toEqual([
      -100, -200,
    ]);
    expect(transactions.transfersLinked).toBe(2);
  });

  it("adds an uncategorized leg for an unbalanced asset-plus-category pair", () => {
    const { transactions } = run([
      {
        splits: [
          { account: "CHK", value: "-50" },
          { account: "GRO", value: "40" },
        ],
      },
    ]);
    const [row] = transactions.transactions;
    expect(row).toMatchObject({ amount: -50, categoryHandle: null });
    expect(row.splits.map((s) => [s.categoryHandle, s.amount])).toEqual([
      [11, -40],
      [null, -10],
    ]);
    expect(transactions.warnings[0]).toMatchObject({
      code: "unbalancedTransaction",
      detail: "-10",
    });
  });

  it("flags an unbalanced split row with the residual as detail", () => {
    const { transactions } = run([
      {
        splits: [
          { account: "CHK", value: "-50" },
          { account: "GRO", value: "30" },
          { account: "FEE", value: "10" },
        ],
      },
    ]);
    const [row] = transactions.transactions;
    expect(row.splits.map((s) => [s.categoryHandle, s.amount])).toEqual([
      [11, -30],
      [12, -10],
      [null, -10],
    ]);
    expect(transactions.warnings).toHaveLength(1);
    expect(transactions.warnings[0]).toMatchObject({
      code: "unbalancedTransaction",
      detail: "-10",
    });
  });
});
