import { InvestmentAction } from "../../../securities/entities/investment-transaction.entity";
import { SplitKind } from "../../../transactions/entities/split-kind.enum";
import { MnyParsedFile } from "../../mny/mny-parser.service";
import {
  SplitInit,
  rawAccount,
  rawFile,
  rawSecurity,
  rawTransaction,
} from "../__fixtures__/kmy-raw-builders";
import { KmyCorruptFileError } from "../model/kmy-errors";
import { KmyAccount } from "../model/kmy-raw";
import { mapKmyFile } from "./kmy-map-file";

/** The review's minor findings (m1, m3, m4, m6, m7, m8), through the whole mapper. */

const ACCOUNTS = [
  rawAccount({ id: "CHK", name: "Checking", type: 1 }),
  rawAccount({ id: "FOOD", name: "Food", type: 13 }),
  rawAccount({ id: "DIV", name: "Dividends", type: 12 }),
  rawAccount({ id: "FEE", name: "Fees", type: 13 }),
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

function parse(
  transactions: SplitInit[][],
  accounts: KmyAccount[] = ACCOUNTS,
): MnyParsedFile {
  return mapKmyFile(
    rawFile({
      accounts,
      securities: [rawSecurity({ id: "E1", symbol: "EXC" })],
      transactions: transactions.map((splits, index) =>
        rawTransaction({
          id: `T${index + 1}`,
          postDate: `2024-02-${String(index + 10)}`,
          splits,
        }),
      ),
    }),
    {
      userDefaultCurrency: "USD",
      phoneRegion: null,
      coinDecimals: new Map(),
      asOf: "2026-01-01",
    },
  );
}

const codes = (parsed: MnyParsedFile) => parsed.warnings.map((w) => w.code);

function expectBalancesAgree(parsed: MnyParsedFile): void {
  for (const [key, balance] of parsed.fileBalances!) {
    expect([key, parsed.expectedBalances.get(key)]).toEqual([key, balance]);
  }
  expect(codes(parsed)).not.toContain("mappedBalanceDiffers");
}

describe("two splits on one account (m1)", () => {
  it("imports a transfer from an account to itself as two unlinked rows, warned", () => {
    const parsed = parse([
      [
        { account: "CHK", value: "-50" },
        { account: "CHK", value: "50" },
      ],
    ]);
    expect(
      parsed.transactions.transactions.map((r) => [
        r.amount,
        r.isTransfer,
        r.linkedTransactionId,
      ]),
    ).toEqual([
      [-50, false, null],
      [50, false, null],
    ]);
    expect(codes(parsed)).toContain("sameAccountTransferUnlinked");
    expectBalancesAgree(parsed);
  });

  it("keeps a split on the parent's own account as its own row, not a transfer leg", () => {
    const parsed = parse([
      [
        { account: "CHK", value: "-100" },
        { account: "CHK", value: "40" },
        { account: "FOOD", value: "60" },
      ],
    ]);
    const [parent, own] = parsed.transactions.transactions;
    expect(parent.amount).toBe(-100);
    expect(
      parent.splits.map((s) => [s.kind, s.amount, s.transferAccountKey]),
    ).toEqual([
      [SplitKind.CATEGORY, -40, null],
      [SplitKind.CATEGORY, -60, null],
    ]);
    expect(parent.splits[0].categoryHandle).toBeNull();
    expect(own).toMatchObject({
      amount: 40,
      isTransfer: false,
      linkedTransactionId: null,
    });
    expect(codes(parsed)).toContain("sameAccountTransferUnlinked");
    expectBalancesAgree(parsed);
  });
});

describe("amounts and shares the columns cannot hold (m3)", () => {
  it("warns when a share count is finer than eight places", () => {
    const parsed = parse([
      [
        { account: "BRK", value: "-10" },
        {
          account: "STK",
          value: "10",
          shares: "123456789/1000000000",
          action: "Buy",
        },
      ],
    ]);
    expect(parsed.investments.transactions[0].quantity).toBe(0.12345679);
    expect(parsed.warnings).toContainEqual(
      expect.objectContaining({
        code: "sharesRounded",
        detail: "0.123456789000",
      }),
    );
  });

  it("refuses an amount whose integer part exceeds the 16 digits the columns store", () => {
    expect(() =>
      parse([
        [
          { account: "CHK", value: "123456789012345678901234567890/7" },
          { account: "FOOD", value: "-123456789012345678901234567890/7" },
        ],
      ]),
    ).toThrow(KmyCorruptFileError);
    // Fifteen integer digits still import.
    expect(() =>
      parse([
        [
          { account: "CHK", value: "123456789012345" },
          { account: "FOOD", value: "-123456789012345" },
        ],
      ]),
    ).not.toThrow();
  });
});

describe("reconciliation history (m4)", () => {
  it("names an account whose statement history does not import, with its latest date", () => {
    const reconciled: KmyAccount = {
      ...ACCOUNTS[0],
      lastReconciled: "2024-01-31",
      reconciliations: [
        { date: "2023-12-31", value: { num: 10n, den: 1n } },
        { date: "2024-01-31", value: { num: 20n, den: 1n } },
      ],
    };
    const parsed = parse([], [reconciled, ...ACCOUNTS.slice(1)]);
    expect(parsed.warnings).toContainEqual({
      code: "reconciliationHistoryNotImported",
      subject: "Checking",
      detail: "2024-01-31",
    });
    expect(codes(parse([]))).not.toContain("reconciliationHistoryNotImported");
  });
});

describe("a reinvestment that also pays cash out (m6)", () => {
  it("records all of the income: the shares bought and the cash paid out", () => {
    const parsed = parse([
      [
        { account: "STK", value: "40", shares: "2", action: "Reinvest" },
        { account: "BRK", value: "8" },
        { account: "DIV", value: "-50" },
        { account: "FEE", value: "2" },
      ],
    ]);
    const rows = parsed.investments.transactions.map((r) => [
      r.action,
      r.quantity,
      r.totalAmount,
      r.cashAmount,
      r.cashAccountKey === null,
      r.categoryHandle,
    ]);
    // Dividends is ordinal 8.
    expect(rows).toEqual([
      [InvestmentAction.REINVEST, 2, 42, 0, true, 8],
      [InvestmentAction.DIVIDEND, null, 8, 8, false, 8],
    ]);
    // The Dividends category's 50: 42 reinvested (with the 2 fee) and 8 paid
    // out. Before, only the 42 was recorded.
    const income = parsed.investments.transactions.reduce(
      (total, r) => total + r.totalAmount,
      0,
    );
    expect(income).toBe(50);
    expectBalancesAgree(parsed);
  });
});

describe("a trade with no cash split (m7)", () => {
  it("imports the trade as recorded and says KMyMoney sees it unbalanced", () => {
    const parsed = parse([
      [{ account: "STK", value: "500", shares: "10", action: "Buy" }],
    ]);
    expect(parsed.investments.transactions[0]).toMatchObject({
      action: InvestmentAction.BUY,
      totalAmount: 500,
      cashAccountKey: null,
    });
    expect(parsed.warnings).toContainEqual(
      expect.objectContaining({
        code: "unbalancedTransaction",
        subject: "transaction 1",
      }),
    );
  });
});

describe("a split on an account in no class (m8)", () => {
  it("leaves its value as an unbalanced difference instead of giving it to the category", () => {
    const parsed = parse(
      [
        [
          { account: "CHK", value: "-100" },
          { account: "ODD", value: "40" },
          { account: "FOOD", value: "60" },
        ],
      ],
      [...ACCOUNTS, rawAccount({ id: "ODD", name: "Odd", type: 99 })],
    );
    const [row] = parsed.transactions.transactions;
    expect(row.amount).toBe(-100);
    expect(row.splits.map((s) => [s.categoryHandle, s.amount])).toEqual([
      [7, -60],
      [null, -40],
    ]);
    expect(codes(parsed)).toContain("unbalancedTransaction");
  });
});
