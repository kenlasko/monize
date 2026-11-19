import {
  SplitInit,
  rawAccount,
  rawFile,
  rawPayee,
  rawTag,
  rawTransaction,
} from "../__fixtures__/kmy-raw-builders";
import { KmyRawFile } from "../model/kmy-raw";
import { harness } from "./kmy-map.harness";
import { mapKmyTransactions } from "./kmy-map-transactions";

export const ACCOUNTS = [
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

export interface Tx {
  id?: string;
  postDate?: string | null;
  memo?: string;
  commodity?: string | null;
  splits: SplitInit[];
}

export function run(
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
