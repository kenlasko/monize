import { SplitKind } from "../../../transactions/entities/split-kind.enum";
import { TransactionStatus } from "../../../transactions/entities/transaction.entity";
import { rawAccount } from "../__fixtures__/kmy-raw-builders";
import { ACCOUNTS, Tx, run } from "./kmy-map-transactions.test-helpers";

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
