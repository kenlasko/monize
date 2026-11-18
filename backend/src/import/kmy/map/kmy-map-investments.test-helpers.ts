import {
  SplitInit,
  rawAccount,
  rawFile,
  rawPayee,
  rawSecurity,
  rawTag,
  rawTransaction,
} from "../__fixtures__/kmy-raw-builders";
import { harness } from "./kmy-map.harness";
import { mapKmyInvestments } from "./kmy-map-investments";

export const ACCOUNTS = [
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

export const SECURITIES = [
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

export const BUY: Tx = {
  splits: [
    { account: "BRK", value: "-505" },
    { account: "STK", value: "500", shares: "10", price: "50", action: "Buy" },
    { account: "FEE", value: "5" },
  ],
};
