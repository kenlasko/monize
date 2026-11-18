import { SplitKind } from "../../../transactions/entities/split-kind.enum";
import { TransactionStatus } from "../../../transactions/entities/transaction.entity";
import {
  SplitInit,
  rawAccount,
  rawFile,
  rawPayee,
  rawPrice,
  rawTag,
  rawTransaction,
} from "../__fixtures__/kmy-raw-builders";
import { KmyRawFile } from "../model/kmy-raw";
import { harness } from "./kmy-map.harness";
import { mapKmyTransactions } from "./kmy-map-transactions";

const ACCOUNTS = [
  rawAccount({ id: "CHK", name: "Checking", type: 1 }),
  rawAccount({ id: "SAV", name: "Savings", type: 2 }),
  rawAccount({ id: "EUR", name: "EUR Savings", type: 2, currency: "EUR" }),
  rawAccount({ id: "LOAN", name: "Loan", type: 5 }),
  rawAccount({ id: "BRK", name: "Brokerage cash", type: 1 }),
  rawAccount({ id: "GRO", name: "Groceries", type: 13 }),
  rawAccount({ id: "FEE", name: "Bank Fees", type: 13 }),
  rawAccount({ id: "INT", name: "Interest", type: 13 }),
  rawAccount({ id: "SAL", name: "Salary", type: 12 }),
  rawAccount({ id: "TAX", name: "Tax", type: 13 }),
  rawAccount({ id: "EQ", name: "Opening Balances", type: 16 }),
  rawAccount({ id: "EGRO", name: "EUR Groceries", type: 13, currency: "EUR" }),
  rawAccount({ id: "EFEE", name: "EUR Fees", type: 13, currency: "EUR" }),
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
  folded: ReadonlySet<number> = new Set(),
) {
  const raw: KmyRawFile = rawFile({
    accounts: ACCOUNTS,
    payees: [rawPayee("P1", "Corner Market"), rawPayee("P2", "City Power")],
    tags: [rawTag("G1", "household"), rawTag("G2", "trip")],
    ...extra,
    transactions: transactions.map((tx, index) =>
      rawTransaction({ id: `T${index + 1}`, ...tx }),
    ),
  });
  const { context } = harness(raw, init);
  return mapKmyTransactions(context, folded);
}

// Ordinals: the five roots are 1-5, CHK 6, SAV 7, EUR 8, LOAN 9, BRK 10, ...

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
      { prices: [rawPrice("USD", "EUR", "2024-01-15", "9/10")] },
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

describe("mapKmyTransactions: parent, status, numbers, memos, payees, tags", () => {
  it("takes the parent with the largest absolute value, the first on a tie", () => {
    const { transactions } = run([
      {
        splits: [
          { account: "SAV", value: "-100" },
          { account: "CHK", value: "100" },
          { account: "GRO", value: "0" },
        ],
      },
    ]);
    expect(transactions.transactions[0].accountKey).toBe("acct-7");
    const bigger = run([
      {
        splits: [
          { account: "SAV", value: "-50" },
          { account: "CHK", value: "150" },
          { account: "GRO", value: "-100" },
        ],
      },
    ]);
    expect(bigger.transactions.transactions[0].accountKey).toBe("acct-6");
  });

  it("maps each reconcile flag, the number and the memo of the row's own split", () => {
    const flags = [0, 1, 2, 3, 9].map(
      (reconcileFlag) =>
        run([
          {
            memo: "tx memo",
            splits: [
              {
                account: "CHK",
                value: "-1",
                reconcileFlag,
                memo: "",
                number: " 123 ",
              },
              { account: "GRO", value: "1", memo: "ignored" },
            ],
          },
        ]).transactions.transactions[0],
    );
    expect(flags.map((r) => r.status)).toEqual([
      TransactionStatus.UNRECONCILED,
      TransactionStatus.CLEARED,
      TransactionStatus.RECONCILED,
      TransactionStatus.RECONCILED,
      TransactionStatus.UNRECONCILED,
    ]);
    expect(flags[0]).toMatchObject({
      referenceNumber: "123",
      description: "tx memo",
    });
    const own = run([
      {
        memo: "tx memo",
        splits: [
          { account: "CHK", value: "-1", memo: "own", number: "x".repeat(150) },
          { account: "GRO", value: "1" },
        ],
      },
    ]).transactions.transactions[0];
    expect(own.description).toBe("own");
    expect(own.referenceNumber).toHaveLength(100);
    const empty = run([
      {
        splits: [
          { account: "CHK", value: "-1" },
          { account: "GRO", value: "1" },
        ],
      },
    ]).transactions.transactions[0];
    expect(empty).toMatchObject({ description: null, referenceNumber: null });
  });

  it("takes the row's own payee, else the first non-empty among the other splits", () => {
    const own = run([
      {
        splits: [
          { account: "CHK", value: "-1", payee: "P1" },
          { account: "GRO", value: "1", payee: "P2" },
        ],
      },
    ]);
    expect(own.transactions.transactions[0].payeeHandle).toBe(1);
    const fallback = run([
      {
        splits: [
          { account: "CHK", value: "-2" },
          { account: "GRO", value: "1" },
          { account: "FEE", value: "1", payee: "P2" },
        ],
      },
    ]);
    expect(fallback.transactions.transactions[0].payeeHandle).toBe(2);
    expect([...fallback.transactions.referencedPayees]).toEqual([2]);
  });

  it("drops a payee no PAYEE defines and says so on the row", () => {
    const { transactions } = run([
      {
        splits: [
          { account: "CHK", value: "-1", payee: "PX" },
          { account: "GRO", value: "1" },
        ],
      },
    ]);
    expect(transactions.transactions[0].payeeHandle).toBeNull();
    expect(transactions.warnings).toHaveLength(1);
    expect(transactions.warnings[0]).toMatchObject({
      code: "unknownPayeeReference",
      detail: "PX",
    });
  });

  it("carries the union of both splits' tags on a plain row, each split's own on a transfer", () => {
    const plain = run([
      {
        splits: [
          { account: "CHK", value: "-1", tags: ["G2"] },
          { account: "GRO", value: "1", tags: ["G1", "G2"] },
        ],
      },
    ]);
    expect(plain.transactions.transactions[0].tagHandles).toEqual([2, 1]);
    const transfer = run([
      {
        splits: [
          { account: "CHK", value: "-1", tags: ["G2"] },
          { account: "SAV", value: "1", tags: ["G1", "PX"] },
        ],
      },
    ]);
    expect(transfer.transactions.transactions.map((r) => r.tagHandles)).toEqual(
      [[2], [1]],
    );
  });
});

describe("mapKmyTransactions: excluded accounts (spec 5.6.6) and what is skipped", () => {
  const excludeSavings = {
    options: {
      accounts: [{ handle: 7, include: false, currencyOverride: null }],
    },
  };

  it("turns a transfer to an excluded account into one ordinary row", () => {
    const { transactions } = run(
      [
        {
          splits: [
            { account: "CHK", value: "-100" },
            { account: "SAV", value: "100" },
          ],
        },
        {
          splits: [
            { account: "SAV", value: "-5" },
            { account: "GRO", value: "5" },
          ],
        },
      ],
      {},
      excludeSavings,
    );
    expect(transactions.transactions).toHaveLength(1);
    expect(transactions.transactions[0]).toMatchObject({
      accountKey: "acct-6",
      amount: -100,
      isTransfer: false,
      categoryHandle: null,
      linkedTransactionId: null,
    });
    expect(transactions.warnings.map((w) => w.code)).toEqual([
      "transferAcrossExcludedAccount",
    ]);
  });

  it("turns a transfer leg to an excluded account into an uncategorized leg", () => {
    const { transactions } = run(
      [
        {
          splits: [
            { account: "CHK", value: "-300" },
            { account: "SAV", value: "100" },
            { account: "GRO", value: "200" },
          ],
        },
      ],
      {},
      excludeSavings,
    );
    expect(transactions.transactions).toHaveLength(1);
    expect(
      transactions.transactions[0].splits.map((s) => [
        s.kind,
        s.categoryHandle,
        s.amount,
      ]),
    ).toEqual([
      [SplitKind.CATEGORY, null, -100],
      [SplitKind.CATEGORY, 11, -200],
    ]);
    expect(transactions.warnings.map((w) => w.code)).toEqual([
      "transferAcrossExcludedAccount",
    ]);
  });

  it("skips a transaction whose every asset account is excluded, and any folded or investment one", () => {
    const skipAll = run(
      [
        {
          splits: [
            { account: "SAV", value: "-1" },
            { account: "GRO", value: "1" },
          ],
        },
      ],
      {},
      excludeSavings,
    );
    expect(skipAll.transactions.transactions).toHaveLength(0);
    expect(skipAll.transactions.warnings).toEqual([]);
    const folded = run(
      [
        {
          splits: [
            { account: "CHK", value: "5" },
            { account: "EQ", value: "-5" },
          ],
        },
      ],
      {},
      {},
      new Set([1]),
    );
    expect(folded.transactions.transactions).toHaveLength(0);
    const investment = run(
      [
        {
          splits: [
            { account: "STK", value: "5" },
            { account: "CHK", value: "-5" },
          ],
        },
      ],
      {
        accounts: [
          ...ACCOUNTS,
          rawAccount({ id: "INV", type: 7 }),
          rawAccount({ id: "STK", type: 15, parentId: "INV", currency: "E1" }),
        ],
      },
    );
    expect(investment.transactions.transactions).toHaveLength(0);
  });

  it("rejects a transaction with no usable date", () => {
    const { transactions } = run([
      {
        postDate: null,
        splits: [
          { account: "CHK", value: "-1" },
          { account: "GRO", value: "1" },
        ],
      },
      { postDate: "2024-02-30", splits: [{ account: "CHK", value: "-1" }] },
    ]);
    expect(transactions.transactions).toHaveLength(0);
    expect(transactions.skipped).toBe(2);
    expect(transactions.warnings.map((w) => [w.code, w.detail])).toEqual([
      ["unusableTransaction", "no usable date"],
      ["unusableTransaction", "no usable date"],
    ]);
  });

  it("reports the empty model fields Money has nothing for", () => {
    const { transactions } = run([
      {
        splits: [
          { account: "CHK", value: "-1" },
          { account: "GRO", value: "1" },
        ],
      },
    ]);
    expect(transactions).toMatchObject({
      deferredInvestments: 0,
      tradeCashLegs: 0,
      skipped: 0,
    });
    expect(transactions.investmentCashSources.size).toBe(0);
    expect(transactions.tradeCashLegTagHandles.size).toBe(0);
  });

  it("is deterministic apart from the row ids", () => {
    const strip = (value: unknown): unknown =>
      JSON.parse(
        JSON.stringify(value, (key, v) =>
          key === "id" || key === "linkedTransactionId" ? undefined : v,
        ),
      );
    const input: Tx[] = [
      {
        splits: [
          { account: "CHK", value: "-300" },
          { account: "SAV", value: "100" },
          { account: "GRO", value: "200" },
        ],
      },
    ];
    const first = run(input).transactions.transactions;
    const second = run(input).transactions.transactions;
    expect(strip(first)).toEqual(strip(second));
    expect(first[0].id).not.toBe(second[0].id);
  });
});
