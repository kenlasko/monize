import { MappedAccounts } from "../../mny/model/mny-import-model";
import { explainDifferences } from "./kmy-file-summary";

describe("explainDifferences (spec 6.3)", () => {
  const accounts = {
    accounts: [{ key: "acct-6", name: "Checking" }],
  } as unknown as MappedAccounts;

  it("names an account whose mapped balance differs by more than the tolerance", () => {
    expect(
      explainDifferences(
        accounts,
        new Map([["acct-6", 10]]),
        new Map([["acct-6", 10.004]]),
        [],
      ),
    ).toEqual([]);
    expect(
      explainDifferences(
        accounts,
        new Map([
          ["acct-6", 10],
          ["acct-7", 1],
        ]),
        new Map([["acct-6", 11]]),
        [],
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
      explainDifferences(accounts, new Map(), new Map(), [
        check,
        { ...check, matches: true },
      ]),
    ).toEqual([
      {
        code: "holdingsReplayDiffers",
        subject: "EXC",
        detail: "file 5, mapped 4",
      },
    ]);
  });
});
