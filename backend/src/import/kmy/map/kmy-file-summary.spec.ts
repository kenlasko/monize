import { InvestmentAction } from "../../../securities/entities/investment-transaction.entity";
import {
  MappedAccounts,
  MappedInvestments,
  MappedTransactions,
} from "../../mny/model/mny-import-model";
import { computeExpectedBalances } from "../../mny/mny-parser.service";
import {
  rawAccount,
  rawCurrency,
  rawFile,
  rawSecurity,
  rawTransaction,
} from "../__fixtures__/kmy-raw-builders";
import {
  FileExpectations,
  computeFileExpectations,
} from "./kmy-file-expectations";
import { harness } from "./kmy-map.harness";
import { mapKmyFile } from "./kmy-map-file";
import { explainDifferences, mappedTradeValues } from "./kmy-file-summary";

function expectations(
  init: Partial<FileExpectations> & {
    fileBalances: ReadonlyMap<string, number>;
  },
): FileExpectations {
  return {
    rowBalances: init.fileBalances,
    balancePrecision: new Map(
      [...init.fileBalances.keys()].map((key) => [
        key,
        { places: 4, tolerance: 0 },
      ]),
    ),
    holdings: [],
    tradeValues: [],
    otherCurrencyTrades: new Set(),
    ...init,
  };
}

describe("explainDifferences (spec 6.3)", () => {
  const accounts = {
    accounts: [{ key: "acct-6", name: "Checking" }],
  } as unknown as MappedAccounts;
  const compare = (
    file: FileExpectations,
    mapped: ReadonlyMap<string, number>,
  ) =>
    explainDifferences({
      accounts,
      expectations: file,
      expectedBalances: mapped,
      checks: [],
      mappedTrades: new Map(),
    });

  it("holds a balance to the account's own last place, against rows rounded one by one", () => {
    const file = expectations({ fileBalances: new Map([["acct-6", 10]]) });
    expect(compare(file, new Map([["acct-6", 10]]))).toEqual([]);
    // One unit of the fourth place is a difference now, not half a cent.
    expect(compare(file, new Map([["acct-6", 10.0001]]))).toEqual([
      {
        code: "mappedBalanceDiffers",
        subject: "Checking",
        detail: "file 10, mapped 10.0001",
      },
    ]);
    // A coin at eight places: 1e-8 is a difference.
    const coin = expectations({
      fileBalances: new Map([["acct-6", 1.12345678]]),
      rowBalances: new Map([["acct-6", 1.12345677]]),
      balancePrecision: new Map([
        ["acct-6", { places: 8, tolerance: 0.00000001 }],
      ]),
    });
    expect(compare(coin, new Map([["acct-6", 1.12345677]]))).toEqual([]);
    expect(compare(coin, new Map([["acct-6", 1.12345676]]))).toHaveLength(1);
  });

  it("names an account the mapped rows do not reach", () => {
    expect(
      compare(
        expectations({
          fileBalances: new Map([
            ["acct-6", 10],
            ["acct-7", 1],
          ]),
        }),
        new Map([["acct-6", 11]]),
      ),
    ).toEqual([
      {
        code: "mappedBalanceDiffers",
        subject: "Checking",
        detail: "file 10, mapped 11",
      },
      {
        code: "mappedBalanceDiffers",
        subject: "acct-7",
        detail: "file 1, mapped 0",
      },
    ]);
  });

  it("names a holding whose replay does not match", () => {
    const check = {
      accountKey: "a",
      securityHandle: 1,
      symbol: "EXC",
      lotQuantity: 5,
      replayQuantity: 4,
      delta: -1,
      matches: false,
    };
    expect(
      explainDifferences({
        accounts,
        expectations: expectations({ fileBalances: new Map() }),
        expectedBalances: new Map(),
        checks: [check, { ...check, matches: true }],
        mappedTrades: new Map(),
      }),
    ).toEqual([
      {
        code: "holdingsReplayDiffers",
        subject: "EXC",
        detail: "file 5, mapped 4",
      },
    ]);
  });

  it("names a holding whose trade totals do not add up to the file's stock values, allowing a unit per split", () => {
    const file = expectations({
      fileBalances: new Map(),
      tradeValues: [
        {
          accountKey: "b",
          securityHandle: 1,
          transactionOrdinal: 3,
          symbol: "EXC",
          currencyCode: "USD",
          places: 4,
          units: 3_500_000n,
          splits: 2,
        },
      ],
    });
    const run = (units: bigint) =>
      explainDifferences({
        accounts,
        expectations: file,
        expectedBalances: new Map(),
        checks: [],
        mappedTrades: new Map([["b|1|3", units]]),
      });
    expect(run(3_500_002n)).toEqual([]);
    expect(run(3_400_000n)).toEqual([
      {
        code: "tradeAmountsDiffer",
        subject: "EXC",
        detail: "transaction 3: file 350, mapped 340 USD",
      },
    ]);
  });
});

describe("mappedTradeValues", () => {
  const row = (action: InvestmentAction, total: number, commission: number) =>
    ({
      handle: 1,
      accountKey: "b",
      securityHandle: 1,
      securityCurrencyCode: "USD",
      action,
      totalAmount: total,
      commission,
      transactionDate: "2024-01-01",
      status: "UNRECONCILED",
    }) as unknown as MappedInvestments["transactions"][number];

  it("nets buys and reinvestments of commission and sales plus it; other actions count nothing", () => {
    const investments = {
      transactions: [
        row(InvestmentAction.BUY, 505, 5),
        row(InvestmentAction.SELL, 145, 5),
        row(InvestmentAction.REINVEST, 42, 2),
        row(InvestmentAction.DIVIDEND, 7.5, 0),
        row(InvestmentAction.ADD_SHARES, 0, 0),
      ],
    } as unknown as MappedInvestments;
    expect(
      mappedTradeValues(investments, "2030-01-01", new Set(), () => 4),
    ).toEqual(new Map([["b|1|1", 3_900_000n]]));
    expect(
      mappedTradeValues(investments, "2030-01-01", new Set([1]), () => 4),
    ).toEqual(new Map());
  });
});

/**
 * M1: the review's three mutations, each applied to the mapped model of a file
 * the mapper gets right, must each surface as a difference. The file side is
 * computed from the raw splits alone, so a wrong mapped model cannot bring it
 * along.
 */
describe("verification catches a wrong mapped model (M1 mutations)", () => {
  const raw = rawFile({
    currencies: [rawCurrency("USD"), rawCurrency("EUR")],
    securities: [rawSecurity({ id: "E1", symbol: "EXC" })],
    accounts: [
      rawAccount({ id: "CHK", name: "Checking", type: 1 }),
      rawAccount({ id: "EUR", name: "Euro", type: 1, currency: "EUR" }),
      rawAccount({ id: "CARD", name: "Card", type: 4 }),
      rawAccount({ id: "FOOD", name: "Food", type: 13 }),
      rawAccount({ id: "FEE", name: "Fees", type: 13 }),
      rawAccount({ id: "INV", name: "Broker", type: 7 }),
      rawAccount({ id: "BRK", name: "Broker (Brokerage)", type: 1 }),
      rawAccount({
        id: "STK",
        name: "EXC",
        type: 15,
        parentId: "INV",
        currency: "E1",
      }),
    ],
    transactions: [
      rawTransaction({
        id: "T1",
        postDate: "2024-01-05",
        splits: [
          { account: "CHK", value: "-110" },
          { account: "EUR", value: "110", shares: "100" },
        ],
      }),
      rawTransaction({
        id: "T2",
        postDate: "2024-01-06",
        splits: [
          { account: "CARD", value: "-50" },
          { account: "FOOD", value: "50" },
        ],
      }),
      rawTransaction({
        id: "T3",
        postDate: "2024-01-07",
        splits: [
          { account: "BRK", value: "-505" },
          { account: "STK", value: "500", shares: "10", action: "Buy" },
          { account: "FEE", value: "5" },
        ],
      }),
      rawTransaction({
        id: "T4",
        postDate: "2024-01-08",
        splits: [
          { account: "BRK", value: "145" },
          { account: "STK", value: "-150", shares: "-5", action: "Buy" },
          { account: "FEE", value: "5" },
        ],
      }),
    ],
  });
  const parsed = mapKmyFile(raw, {
    userDefaultCurrency: "USD",
    phoneRegion: null,
    coinDecimals: new Map(),
    asOf: "2026-01-01",
  });
  const key = (name: string) =>
    parsed.accounts.accounts.find((a) => a.name === name)!.key;
  const recheck = (
    accounts: MappedAccounts,
    transactions: MappedTransactions,
    investments: MappedInvestments,
  ) => {
    // What mapKmyFile does after mapping, over the mutated model; the file
    // side is computed from the raw splits, untouched by the mutation.
    const h = harness(raw, { asOf: "2026-01-01" });
    const file = computeFileExpectations({
      raw,
      tree: h.tree,
      mapping: h.mapping,
      securities: h.securities,
      coinDecimals: new Map(),
      asOf: "2026-01-01",
    });
    return explainDifferences({
      accounts,
      expectations: file,
      expectedBalances: computeExpectedBalances(
        accounts,
        transactions,
        "2026-01-01",
        investments,
        new Map([...parsed.balancePrecision!].map(([k, r]) => [k, r.places])),
      ),
      checks: [],
      mappedTrades: mappedTradeValues(
        investments,
        "2026-01-01",
        new Set(),
        () => 4,
      ),
    }).map((warning) => `${warning.code} ${warning.subject}`);
  };

  it("finds nothing to report for the mapper's own model", () => {
    expect(
      parsed.warnings.filter((w) =>
        ["mappedBalanceDiffers", "tradeAmountsDiffer"].includes(w.code),
      ),
    ).toEqual([]);
    expect(
      recheck(parsed.accounts, parsed.transactions, parsed.investments),
    ).toEqual([]);
  });

  it("catches a mapper that books a split's value instead of its shares", () => {
    const transactions = {
      ...parsed.transactions,
      transactions: parsed.transactions.transactions.map((row) =>
        row.accountKey === key("Euro") ? { ...row, amount: 110 } : row,
      ),
    };
    expect(recheck(parsed.accounts, transactions, parsed.investments)).toEqual([
      "mappedBalanceDiffers Euro",
    ]);
  });

  it("catches a mapper that negates every amount", () => {
    const transactions = {
      ...parsed.transactions,
      transactions: parsed.transactions.transactions.map((row) => ({
        ...row,
        amount: -row.amount,
      })),
    };
    const investments = {
      ...parsed.investments,
      transactions: parsed.investments.transactions.map((row) => ({
        ...row,
        cashAmount: -row.cashAmount,
      })),
    };
    expect(recheck(parsed.accounts, transactions, investments)).toEqual([
      "mappedBalanceDiffers Checking",
      "mappedBalanceDiffers Euro",
      "mappedBalanceDiffers Card",
      "mappedBalanceDiffers Broker - Cash",
    ]);
  });

  it("catches a mapper that takes twice the commission off each trade's total", () => {
    const investments = {
      ...parsed.investments,
      transactions: parsed.investments.transactions.map((row) => ({
        ...row,
        totalAmount: (row.totalAmount ?? 0) - 2 * (row.commission ?? 0),
      })),
    };
    // The buy and the sale each, though their errors cancel over the holding.
    expect(recheck(parsed.accounts, parsed.transactions, investments)).toEqual([
      "tradeAmountsDiffer EXC",
      "tradeAmountsDiffer EXC",
    ]);
  });
});
