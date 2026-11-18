import {
  SplitInit,
  rawAccount,
  rawFile,
  rawTransaction,
} from "../__fixtures__/kmy-raw-builders";
import { harness } from "./kmy-map.harness";
import { foldOpeningBalances } from "./kmy-opening-balances";

const ACCOUNTS = [
  rawAccount({ id: "CHK", name: "Checking", type: 1 }),
  rawAccount({ id: "CARD", name: "Card", type: 4 }),
  rawAccount({ id: "INV", name: "Broker", type: 7 }),
  rawAccount({ id: "BRK", name: "Broker (Brokerage)", type: 1 }),
  rawAccount({ id: "EQ", name: "Opening Balances", type: 16 }),
  rawAccount({ id: "EXP", name: "Fees", type: 13 }),
];

function fold(
  transactions: { id: string; postDate: string; splits: SplitInit[] }[],
  asOf = "2030-01-01",
  fixVersion = 12,
) {
  const raw = rawFile({
    fixVersion,
    accounts: ACCOUNTS,
    transactions: transactions.map((t) => rawTransaction(t)),
  });
  const { drafted, tree } = harness(raw, { asOf });
  return foldOpeningBalances(raw, tree, drafted, asOf, new Map());
}

describe("foldOpeningBalances (spec 5.3 examples)", () => {
  it("folds a checking account opened with 5000", () => {
    const result = fold([
      {
        id: "T1",
        postDate: "2024-01-01",
        splits: [
          { account: "CHK", value: "5000" },
          { account: "EQ", value: "-5000" },
        ],
      },
    ]);
    expect(result.balances.get("acct-6")).toBe(5000);
    expect([...result.folded]).toEqual([1]);
  });

  it("keeps a liability negative: a card opened owing 500", () => {
    const result = fold([
      {
        id: "T1",
        postDate: "2024-01-01",
        splits: [
          { account: "CARD", value: "-500" },
          { account: "EQ", value: "500" },
        ],
      },
    ]);
    expect(result.balances.get("acct-7")).toBe(-500);
  });

  it("imports a second balance adjustment as an ordinary transaction", () => {
    const result = fold([
      {
        id: "T1",
        postDate: "2024-01-01",
        splits: [
          { account: "CHK", value: "5000" },
          { account: "EQ", value: "-5000" },
        ],
      },
      {
        id: "T2",
        postDate: "2024-06-01",
        splits: [
          { account: "CHK", value: "1234/100" },
          { account: "EQ", value: "-1234/100" },
        ],
      },
    ]);
    expect(result.balances.get("acct-6")).toBe(5000);
    expect([...result.folded]).toEqual([1]);
  });

  it("collects the brokerage account and the type-7 account in the pair's cash side", () => {
    const result = fold([
      {
        id: "T1",
        postDate: "2024-01-01",
        splits: [
          { account: "BRK", value: "1000" },
          { account: "EQ", value: "-1000" },
        ],
      },
    ]);
    expect(result.balances.get("acct-9")).toBe(1000);
    const viaInvestment = fold([
      {
        id: "T1",
        postDate: "2024-01-01",
        splits: [
          { account: "INV", value: "700" },
          { account: "EQ", value: "-700" },
        ],
      },
    ]);
    expect(viaInvestment.balances.get("acct-9")).toBe(700);
  });

  it("does not fold an opening balance dated after another transaction in the account", () => {
    const result = fold([
      {
        id: "T1",
        postDate: "2024-01-01",
        splits: [
          { account: "CHK", value: "-50" },
          { account: "EXP", value: "50" },
        ],
      },
      {
        id: "T2",
        postDate: "2024-02-01",
        splits: [
          { account: "CHK", value: "5000" },
          { account: "EQ", value: "-5000" },
        ],
      },
    ]);
    expect(result.balances.size).toBe(0);
    expect(result.folded.size).toBe(0);
  });

  it("folds only the earliest of several on one account, by date then ordinal", () => {
    const result = fold([
      {
        id: "T1",
        postDate: "2024-01-01",
        splits: [
          { account: "CHK", value: "20" },
          { account: "EQ", value: "-20" },
        ],
      },
      {
        id: "T2",
        postDate: "2024-01-01",
        splits: [
          { account: "CHK", value: "10" },
          { account: "EQ", value: "-10" },
        ],
      },
    ]);
    expect(result.balances.get("acct-6")).toBe(20);
    expect([...result.folded]).toEqual([1]);
  });

  it("ignores candidates after asOf, transactions with other shapes and invalid dates", () => {
    const result = fold(
      [
        {
          id: "T1",
          postDate: "2030-06-01",
          splits: [
            { account: "CHK", value: "5" },
            { account: "EQ", value: "-5" },
          ],
        },
        {
          id: "T2",
          postDate: "2024-01-01",
          splits: [
            { account: "CHK", value: "5" },
            { account: "EXP", value: "-5" },
          ],
        },
        {
          id: "T3",
          postDate: "2024-01-01",
          splits: [
            { account: "EQ", value: "5" },
            { account: "EQ", value: "-5" },
          ],
        },
        {
          id: "T4",
          postDate: "2024-01-01",
          splits: [
            { account: "CHK", value: "5" },
            { account: "EQ", value: "-3" },
            { account: "EXP", value: "-2" },
          ],
        },
        {
          id: "T5",
          postDate: "",
          splits: [
            { account: "CHK", value: "5" },
            { account: "EQ", value: "-5" },
          ],
        },
      ],
      "2025-01-01",
    );
    expect(result.balances.size).toBe(0);
  });

  it("uses a split's value when fix version 11 left shares at 0", () => {
    const result = fold(
      [
        {
          id: "T1",
          postDate: "2024-01-01",
          splits: [
            { account: "CHK", value: "300", shares: "0" },
            { account: "EQ", value: "-300" },
          ],
        },
      ],
      "2030-01-01",
      11,
    );
    expect(result.balances.get("acct-6")).toBe(300);
  });
});
