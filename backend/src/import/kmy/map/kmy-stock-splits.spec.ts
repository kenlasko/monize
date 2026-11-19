import {
  SplitInit,
  n,
  rawAccount,
  rawFile,
  rawPrice,
  rawSecurity,
  rawTransaction,
} from "../__fixtures__/kmy-raw-builders";
import { KmyRounding, toDecimalString } from "../model/kmy-rational";
import { harness } from "./kmy-map.harness";
import { mapKmyInvestments } from "./kmy-map-investments";
import { journalOrder, replayStockAccount } from "./kmy-stock-splits";

const ACCOUNTS = [
  rawAccount({ id: "INV", name: "Broker", type: 7 }),
  rawAccount({ id: "BRK", name: "Broker (Brokerage)", type: 1 }),
  rawAccount({
    id: "STK",
    name: "Example Corp",
    type: 15,
    parentId: "INV",
    currency: "E1",
  }),
];

function warnings(
  transactions: { id?: string; postDate: string; splits: SplitInit[] }[],
  security: Parameters<typeof rawSecurity>[0] = { id: "E1" },
  prices: ReturnType<typeof rawPrice>[] = [],
) {
  const raw = rawFile({
    accounts: ACCOUNTS,
    securities: [rawSecurity({ symbol: "EXC", ...security })],
    prices,
    transactions: transactions.map((tx, index) =>
      rawTransaction({ id: `T${index + 1}`, ...tx }),
    ),
  });
  const { investmentContext } = harness(raw);
  return mapKmyInvestments(
    investmentContext,
    new Set(),
  ).investments.warnings.filter((w) => w.code.startsWith("stockSplit"));
}

const add = (
  shares: string,
  postDate = "2024-01-01",
): {
  postDate: string;
  splits: SplitInit[];
} => ({
  postDate,
  splits: [{ account: "STK", value: "0", shares, action: "Add" }],
});
const split = (shares: string, postDate = "2024-02-01") => ({
  postDate,
  splits: [
    { account: "STK", value: "0", shares, action: "Split" },
  ] as SplitInit[],
});

describe("stock split checks (spec 5.7.5)", () => {
  it("flags a ratio that is not exact at 8 places, and only that", () => {
    const result = warnings([add("300"), split("1/3")]);
    expect(result.map((w) => w.code)).toEqual(["stockSplitRatioRounded"]);
    expect(result[0]).toMatchObject({
      subject: "EXC",
      detail: "1/3 -> 0.33333333",
      row: { handle: 2, date: "2024-02-01" },
    });
  });

  it("flags a result KMyMoney rounded to the security's saf", () => {
    const result = warnings([add("7"), split("3/2")], {
      id: "E1",
      saf: 1n,
      roundingMethod: 7,
    });
    expect(result.map((w) => w.code)).toEqual(["stockSplitRoundingDiffers"]);
    expect(result[0].detail).toBe("10.00000000 / 10.50000000");
  });

  it("stays quiet for an exact ratio and a result on the saf grid", () => {
    expect(warnings([add("10"), split("2")])).toEqual([]);
    expect(warnings([add("8"), split("3/2")], { id: "E1", saf: 1n })).toEqual(
      [],
    );
  });

  it("flags a split whose surrounding prices move as if the ratio were inverted", () => {
    const prices = [
      rawPrice("E1", "USD", "2024-01-20", "100"),
      rawPrice("E1", "USD", "2024-02-10", "200"),
    ];
    const result = warnings([add("10"), split("2")], { id: "E1" }, prices);
    expect(result.map((w) => w.code)).toEqual(["stockSplitRatioSuspicious"]);
    expect(result[0].detail).toBe("2");
  });

  it("does not flag consistent prices, a missing side, a far price or another currency", () => {
    const consistent = [
      rawPrice("E1", "USD", "2024-01-20", "200"),
      rawPrice("E1", "USD", "2024-02-10", "100"),
    ];
    expect(warnings([add("10"), split("2")], { id: "E1" }, consistent)).toEqual(
      [],
    );
    const oneSide = [rawPrice("E1", "USD", "2024-01-20", "100")];
    expect(warnings([add("10"), split("2")], { id: "E1" }, oneSide)).toEqual(
      [],
    );
    const far = [
      rawPrice("E1", "USD", "2023-11-01", "100"),
      rawPrice("E1", "USD", "2024-04-10", "200"),
    ];
    expect(warnings([add("10"), split("2")], { id: "E1" }, far)).toEqual([]);
    const otherCurrency = [
      rawPrice("E1", "EUR", "2024-01-20", "100"),
      rawPrice("E1", "EUR", "2024-02-10", "200"),
    ];
    expect(
      warnings([add("10"), split("2")], { id: "E1" }, otherCurrency),
    ).toEqual([]);
  });

  it("does not check a split that does not import as a SPLIT row", () => {
    expect(
      warnings([split("1/3")], { id: "E1", tradingCurrency: "TOOLONG" }),
    ).toEqual([]);
  });
});

describe("KMyMoney's share replay (reference 15.2)", () => {
  const security = (roundingMethod: number, saf = 1n) => ({
    saf,
    roundingMethod,
  });
  const history = (before: string, ratio: string) =>
    journalOrder([
      rawTransaction({
        id: "A",
        postDate: "2024-01-01",
        splits: [{ account: "S", value: "0", shares: before, action: "Add" }],
      }),
      rawTransaction({
        id: "B",
        postDate: "2024-02-01",
        splits: [{ account: "S", value: "0", shares: ratio, action: "Split" }],
      }),
    ]);
  const replay = (before: string, ratio: string, method: number) =>
    toDecimalString(
      replayStockAccount(history(before, ratio), "S", security(method), null)
        .balance,
      4,
    );

  // 7.5 rounds to 8 (tie to even), 8.5 rounds to 8 as well; negatives mirror.
  it.each([
    [KmyRounding.Never, "8.0000", "-8.0000"],
    [KmyRounding.Floor, "7.0000", "-8.0000"],
    [KmyRounding.Ceil, "8.0000", "-7.0000"],
    [KmyRounding.Truncate, "7.0000", "-7.0000"],
    [KmyRounding.Promote, "8.0000", "-8.0000"],
    [KmyRounding.HalfDown, "7.0000", "-7.0000"],
    [KmyRounding.HalfUp, "8.0000", "-8.0000"],
    [KmyRounding.Round, "8.0000", "-8.0000"],
  ])(
    "rounds 7.5 and -7.5 with method %i to %s and %s (AlkValue::convertDenominator)",
    (method, positive, negative) => {
      expect(replay("5", "3/2", method)).toBe(positive);
      expect(replay("-5", "3/2", method)).toBe(negative);
    },
  );

  it("breaks an exact tie to the even neighbour for RoundRound", () => {
    expect(replay("3", "3/2", KmyRounding.Round)).toBe("4.0000"); // 4.5 -> 4
    expect(replay("5", "5/2", KmyRounding.Round)).toBe("12.0000"); // 12.5 -> 12
  });

  it("rounds to the saf grid and records each split's before, unrounded and after", () => {
    const result = replayStockAccount(
      history("7", "3/2"),
      "S",
      { saf: 100n, roundingMethod: 7 },
      null,
    );
    expect(result.splits).toHaveLength(1);
    expect(result.splits[0]).toMatchObject({
      transactionOrdinal: 0,
      date: "2024-02-01",
      ratio: n("3/2"),
      before: n("7"),
      unrounded: n("21/2"),
      after: n("21/2"),
    });
  });

  it("cuts off at asOf and orders by date then id as a string", () => {
    const ordered = journalOrder([
      rawTransaction({
        id: "T10",
        postDate: "2024-01-01",
        splits: [{ account: "S", value: "0", shares: "2", action: "Split" }],
      }),
      rawTransaction({
        id: "T2",
        postDate: "2024-01-01",
        splits: [{ account: "S", value: "0", shares: "5", action: "Add" }],
      }),
      rawTransaction({
        id: "T3",
        postDate: "2024-06-01",
        splits: [{ account: "S", value: "0", shares: "1", action: "Add" }],
      }),
      rawTransaction({
        id: "T4",
        postDate: null,
        splits: [{ account: "S", value: "0", shares: "1", action: "Add" }],
      }),
    ]);
    expect(ordered.map((t) => t.id)).toEqual(["T10", "T2", "T3"]);
    // "T10" sorts before "T2": the split runs on an empty balance, then 5 are added.
    expect(
      toDecimalString(
        replayStockAccount(ordered, "S", security(7, 100n), "2024-03-01")
          .balance,
        2,
      ),
    ).toBe("5.00");
    expect(
      toDecimalString(
        replayStockAccount(ordered, "S", security(7, 100n), null).balance,
        2,
      ),
    ).toBe("6.00");
  });
});
