import {
  SplitInit,
  rawAccount,
  rawFile,
  rawSecurity,
  rawTransaction,
  syntheticKmyFile,
} from "../__fixtures__/kmy-raw-builders";
import { computeFileExpectations } from "./kmy-file-expectations";
import { harness } from "./kmy-map.harness";

const ACCOUNTS = [
  rawAccount({ id: "CHK", name: "Checking", type: 1 }),
  rawAccount({ id: "EUR", name: "Euro", type: 2, currency: "EUR" }),
  rawAccount({ id: "INV", name: "Broker", type: 7 }),
  rawAccount({ id: "BRK", name: "Broker (Brokerage)", type: 1 }),
  rawAccount({
    id: "STK",
    name: "Stock",
    type: 15,
    parentId: "INV",
    currency: "E1",
  }),
  rawAccount({
    id: "STK2",
    name: "Stock again",
    type: 15,
    parentId: "INV",
    currency: "E1",
  }),
  rawAccount({ id: "OUT", name: "Outside", type: 15, currency: "E1" }),
  rawAccount({ id: "GRO", name: "Groceries", type: 13 }),
];

function expectations(
  transactions: { id?: string; postDate?: string; splits: SplitInit[] }[],
  asOf: string,
  security: Parameters<typeof rawSecurity>[0] = { id: "E1" },
  fixVersion = 12,
) {
  const raw = rawFile({
    fixVersion,
    accounts: ACCOUNTS,
    securities: [rawSecurity({ symbol: "EXC", ...security })],
    transactions: transactions.map((tx, i) =>
      rawTransaction({ id: `T${i + 1}`, ...tx }),
    ),
  });
  const h = harness(raw, { asOf });
  return computeFileExpectations({
    context: h.context,
    securities: h.securities,
    asOf,
  });
}

describe("computeFileExpectations: the reference's section 18 file", () => {
  const raw = syntheticKmyFile();
  const h = harness(raw, { asOf: "2030-01-01" });
  const result = computeFileExpectations({
    context: h.context,
    securities: h.securities,
    asOf: "2030-01-01",
  });

  it("reproduces the ground-truth balances", () => {
    const byName = new Map(
      h.mapping.mapped.accounts.map((a) => [
        a.name,
        result.fileBalances.get(a.key),
      ]),
    );
    expect(Object.fromEntries(byName)).toEqual({
      Checking: 2804.5,
      "EUR Savings": 1000,
      "Brokerage Account - Cash": 647.5,
      "Brokerage Account - Brokerage": 0,
      "Old Savings": 0,
    });
  });

  it("replays the holding through buy, split and sell", () => {
    expect(result.holdings).toEqual([
      { accountKey: "acct-8", securityHandle: 1, symbol: "EXC", quantity: 15 },
    ]);
  });

  it("cuts off at asOf", () => {
    const early = computeFileExpectations({
      context: harness(raw, { asOf: "2024-03-31" }).context,
      securities: h.securities,
      asOf: "2024-03-31",
    });
    expect(early.fileBalances.get("acct-9")).toBe(502.5);
    expect(early.holdings[0].quantity).toBe(10);
    const afterSplit = computeFileExpectations({
      context: h.context,
      securities: h.securities,
      asOf: "2024-04-01",
    });
    expect(afterSplit.holdings[0].quantity).toBe(20);
  });
});

describe("computeFileExpectations: details of spec 6.1", () => {
  it("sums shares, never values, and ignores undated and future transactions", () => {
    const result = expectations(
      [
        {
          postDate: "2024-01-01",
          splits: [
            { account: "CHK", value: "-1100" },
            { account: "EUR", value: "1100", shares: "1000" },
          ],
        },
        {
          postDate: "2024-06-01",
          splits: [
            { account: "CHK", value: "-7" },
            { account: "GRO", value: "7" },
          ],
        },
        {
          postDate: "",
          splits: [
            { account: "CHK", value: "-9" },
            { account: "GRO", value: "9" },
          ],
        },
      ],
      "2024-03-01",
    );
    expect(result.fileBalances.get("acct-6")).toBe(-1100);
    expect(result.fileBalances.get("acct-7")).toBe(1000);
    expect(result.fileBalances.get("acct-8")).toBe(0);
  });

  it("sums shares as written at fix version 11: KMyMoney repairs only level 0 (kmy-file-fixes)", () => {
    const transactions = [
      {
        splits: [
          { account: "CHK", value: "300", shares: "0" },
          { account: "GRO", value: "-300" },
        ],
      },
    ];
    expect(
      expectations(
        transactions,
        "2030-01-01",
        { id: "E1" },
        11,
      ).fileBalances.get("acct-6"),
    ).toBe(0);
    expect(
      expectations(transactions, "2030-01-01").fileBalances.get("acct-6"),
    ).toBe(0);
  });

  it("adds the balances of two stock accounts of one security and skips an unparented one", () => {
    const result = expectations(
      [
        {
          postDate: "2024-01-01",
          splits: [{ account: "STK", value: "0", shares: "4", action: "Add" }],
        },
        {
          postDate: "2024-01-02",
          splits: [{ account: "STK2", value: "0", shares: "6", action: "Add" }],
        },
        {
          postDate: "2024-01-03",
          splits: [
            { account: "OUT", value: "0", shares: "100", action: "Add" },
          ],
        },
      ],
      "2030-01-01",
    );
    expect(result.holdings).toHaveLength(1);
    expect(result.holdings[0].quantity).toBe(10);
  });

  it("applies the security's saf and rounding method at each split", () => {
    const history = [
      {
        postDate: "2024-01-01",
        splits: [{ account: "STK", value: "0", shares: "7", action: "Add" }],
      },
      {
        postDate: "2024-02-01",
        splits: [
          { account: "STK", value: "0", shares: "3/2", action: "Split" },
        ],
      },
    ];
    const quantity = (roundingMethod: number) =>
      expectations(history, "2030-01-01", { id: "E1", saf: 1n, roundingMethod })
        .holdings[0].quantity;
    expect(quantity(7)).toBe(10);
    expect(quantity(0)).toBe(10);
    expect(quantity(1)).toBe(10);
    expect(quantity(2)).toBe(11);
    expect(quantity(4)).toBe(11);
    expect(quantity(6)).toBe(11);
    expect(
      expectations(history, "2030-01-01", { id: "E1", saf: 100n }).holdings[0]
        .quantity,
    ).toBe(10.5);
  });
});
