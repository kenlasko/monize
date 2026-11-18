import { toNumber } from "../model/kmy-rational";
import {
  n,
  rawAccount,
  rawFile,
  rawPrice,
  rawSchedule,
  rawSecurity,
  rawSplit,
  rawTransaction,
  standardRoots,
  syntheticKmyFile,
} from "./kmy-raw-builders";

describe("kmy-raw-builders", () => {
  it("parses KMyMoney numbers and refuses an auto-calc or invalid one", () => {
    expect(toNumber(n("-241/2"), 4)).toBe(-120.5);
    expect(() => n("not a number")).toThrow("not a plain KMyMoney number");
    expect(() => n("9223372036854775807/100")).toThrow();
  });

  it("fills the reader's defaults for an account and its parent", () => {
    expect(rawAccount({ id: "A" })).toMatchObject({
      isStandard: false,
      parentId: "AStd::Asset",
      currency: "USD",
      type: 1,
    });
    expect(rawAccount({ id: "C", type: 13 }).parentId).toBe("AStd::Expense");
    expect(rawAccount({ id: "I", type: 12 }).parentId).toBe("AStd::Income");
    expect(rawAccount({ id: "E", type: 16 }).parentId).toBe("AStd::Equity");
    expect(rawAccount({ id: "L", type: 4 }).parentId).toBe("AStd::Liability");
    expect(rawAccount({ id: "X", parentId: null }).parentId).toBeNull();
    expect(rawAccount({ id: "Y", currency: null }).currency).toBeNull();
    expect(
      standardRoots().map((a) => [a.id, a.type, a.isStandard, a.parentId]),
    ).toEqual([
      ["AStd::Asset", 9, true, null],
      ["AStd::Liability", 10, true, null],
      ["AStd::Expense", 13, true, null],
      ["AStd::Income", 12, true, null],
      ["AStd::Equity", 16, true, null],
    ]);
  });

  it("defaults a split's shares to its value and numbers its splits from 1", () => {
    expect(rawSplit({ account: "A", value: "5" }).shares).toEqual(n("5"));
    const transaction = rawTransaction({
      splits: [
        { account: "A", value: "1" },
        { account: "B", value: "-1" },
      ],
    });
    expect(transaction.splits.map((s) => s.ordinal)).toEqual([1, 2]);
    expect(
      rawTransaction({ postDate: null, commodity: null, splits: [] }),
    ).toMatchObject({
      postDate: null,
      commodity: null,
    });
  });

  it("builds a schedule with or without a template and auto-calc splits", () => {
    expect(rawSchedule({ template: null }).template).toBeNull();
    const schedule = rawSchedule({
      template: {
        splits: [
          { account: "A", value: "autoCalc" },
          { account: "B", value: "5", shares: "autoCalc" },
        ],
      },
    });
    expect(schedule.template?.splits.map((s) => [s.value, s.shares])).toEqual([
      ["autoCalc", "autoCalc"],
      [n("5"), "autoCalc"],
    ]);
    expect(rawSchedule({ template: { splits: [] } }).template?.postDate).toBe(
      "2024-02-01",
    );
  });

  it("numbers the ordinals of a file and adds the standard roots once", () => {
    const raw = rawFile({
      accounts: [rawAccount({ id: "A" })],
      securities: [rawSecurity({ id: "E1" })],
      prices: [rawPrice("A", "B", "2024-01-01", "2")],
    });
    expect(raw.accounts.map((a) => a.ordinal)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(raw.securities[0].ordinal).toBe(1);
    expect(raw.prices[0].price).toEqual(n("2"));
    expect(
      rawFile({ accounts: [...standardRoots(), rawAccount({ id: "A" })] })
        .accounts,
    ).toHaveLength(6);
  });

  it("builds the reference's section 18 file", () => {
    const raw = syntheticKmyFile();
    expect(raw.transactions).toHaveLength(11);
    expect(raw.accounts[5].name).toBe("Checking");
    expect(raw.schedules[0].template?.postDate).toBe("2024-03-01");
  });
});
