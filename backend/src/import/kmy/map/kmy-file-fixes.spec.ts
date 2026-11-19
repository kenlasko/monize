import {
  n,
  rawAccount,
  rawCurrency,
  rawFile,
  rawSchedule,
  rawSecurity,
  rawTransaction,
} from "../__fixtures__/kmy-raw-builders";
import { mapKmyFile } from "./kmy-map-file";
import { applyKmyFileFixes } from "./kmy-file-fixes";

const ACCOUNTS = [
  rawAccount({ id: "CHK", name: "Checking", type: 1 }),
  rawAccount({ id: "CASH", name: "Wallet", type: 3 }),
  rawAccount({ id: "EURA", name: "Euro", type: 1, currency: "EUR" }),
  rawAccount({ id: "FOOD", name: "Food", type: 13 }),
  rawAccount({ id: "INV", name: "Broker", type: 7 }),
  rawAccount({
    id: "STK",
    name: "EXC",
    type: 15,
    parentId: "INV",
    currency: "E1",
  }),
];

function file(fixVersion: number, transactions = [] as never[]) {
  return rawFile({
    fixVersion,
    accounts: ACCOUNTS,
    currencies: [rawCurrency("USD"), rawCurrency("EUR")],
    securities: [rawSecurity({ id: "E1", symbol: "EXC" })],
    transactions,
  });
}

const INPUT = {
  userDefaultCurrency: "USD",
  phoneRegion: null,
  coinDecimals: new Map<string, number>(),
  asOf: "2026-01-01",
};

describe("applyKmyFileFixes: KMyMoney's fixTransactions_0 and fixSchedule_0 (M2)", () => {
  it("leaves a file at any fix version above 0 exactly as written", () => {
    // The review's case: fix version 5, shares 0. KMyMoney runs fixFile_0
    // only at level 0 (`applyFileFixes` steps one level at a time), and its
    // balance is the sum of shares, so Checking shows 0.
    const raw = file(5, [
      rawTransaction({
        splits: [
          { account: "CHK", value: "100", shares: "0" },
          { account: "FOOD", value: "-100", shares: "0" },
        ],
      }),
    ] as never[]);
    expect(applyKmyFileFixes(raw, "USD")).toBe(raw);
    const parsed = mapKmyFile(raw, INPUT);
    const key = parsed.accounts.accounts.find(
      (a) => a.name === "Checking",
    )!.key;
    expect(parsed.fileBalances?.get(key)).toBe(0);
    expect(parsed.expectedBalances.get(key)).toBe(0);
  });

  it("at fix version 0 sets shares to value whenever they differ on an account in the commodity", () => {
    const raw = file(0, [
      rawTransaction({
        commodity: "USD",
        splits: [
          { account: "CHK", value: "100", shares: "90" },
          { account: "EURA", value: "-100", shares: "-91" },
        ],
      }),
      rawTransaction({
        commodity: "USD",
        splits: [
          { account: "CHK", value: "-40", shares: "0" },
          { account: "FOOD", value: "40", shares: "0" },
        ],
      }),
    ] as never[]);
    const fixed = applyKmyFileFixes(raw, "USD");
    expect(fixed.transactions[0].splits.map((s) => s.shares)).toEqual([
      n("100"),
      // EUR account, USD commodity: not touched.
      n("-91"),
    ]);
    expect(fixed.transactions[1].splits.map((s) => s.shares)).toEqual([
      n("-40"),
      n("40"),
    ]);
    // The input is not mutated.
    expect(raw.transactions[0].splits[0].shares).toEqual(n("90"));
    const parsed = mapKmyFile(raw, INPUT);
    const key = parsed.accounts.accounts.find(
      (a) => a.name === "Checking",
    )!.key;
    expect(parsed.fileBalances?.get(key)).toBe(60);
    expect(parsed.expectedBalances.get(key)).toBe(60);
  });

  it("sets an empty commodity to the base currency first, and rounds non-investment splits to the account fraction (RoundRound)", () => {
    const raw = file(0, [
      rawTransaction({
        commodity: null,
        splits: [
          // 1/8 at a fraction of 100 is 0.125, a tie: RoundRound goes to the
          // even neighbour, 0.12.
          { account: "CHK", value: "1/8", shares: "1/8" },
          { account: "FOOD", value: "-1/8", shares: "-1/8" },
          // A stock split (isInvest) is never rounded.
          {
            account: "STK",
            value: "0",
            shares: "1/3",
            action: "Add",
          },
        ],
      }),
      rawTransaction({
        commodity: "USD",
        splits: [
          // Already at the fraction: unchanged.
          { account: "CASH", value: "-3/4", shares: "-3/4" },
          { account: "FOOD", value: "3/4", shares: "3/4" },
        ],
      }),
    ] as never[]);
    const fixed = applyKmyFileFixes(raw, "USD");
    expect(fixed.transactions[0].commodity).toBe("USD");
    expect(
      fixed.transactions[0].splits.map((s) => [s.value, s.shares]),
    ).toEqual([
      [n("12/100"), n("12/100")],
      [n("-12/100"), n("-12/100")],
      [n("0"), n("1/3")],
    ]);
    expect(fixed.transactions[1]).toEqual(raw.transactions[1]);
  });

  it("repairs a schedule template at fix version 0: commodity from the first split's account, shares from value when 0", () => {
    const raw = rawFile({
      fixVersion: 0,
      accounts: ACCOUNTS,
      schedules: [
        rawSchedule({
          template: {
            commodity: null,
            splits: [
              { account: "EURA", value: "-75", shares: "0" },
              { account: "FOOD", value: "75", shares: "0" },
              { account: "FOOD", value: "autoCalc" },
            ],
          },
        }),
      ],
    });
    const template = applyKmyFileFixes(raw, "USD").schedules[0].template!;
    expect(template.commodity).toBe("EUR");
    expect(template.splits.map((s) => s.shares)).toEqual([
      n("-75"),
      n("75"),
      "autoCalc",
    ]);
  });
});
