import { InvestmentAction } from "../../../securities/entities/investment-transaction.entity";
import { TransactionStatus } from "../../../transactions/entities/transaction.entity";
import { MappedInvestmentTransaction } from "../../mny/model/mny-import-model";
import { rawTransaction } from "../__fixtures__/kmy-raw-builders";
import { warningRowFor, warningRowForInvestment } from "./kmy-warning-row";

const context = {
  keyById: new Map([["A", "acct-6"]]),
  payeeHandleById: new Map([["P1", 3]]),
  placesOf: () => 4,
};

describe("warningRowFor", () => {
  it("identifies a transaction by ordinal, date, the lead imported split, payee, number and memo", () => {
    const transaction = {
      ...rawTransaction({
        postDate: "2024-03-04",
        memo: "tx memo",
        splits: [
          { account: "X", value: "1" },
          {
            account: "A",
            value: "-12.5",
            payee: "P1",
            number: "42",
            memo: "split memo",
          },
        ],
      }),
      ordinal: 9,
    };
    expect(warningRowFor(transaction, context)).toEqual({
      handle: 9,
      accountKey: "acct-6",
      date: "2024-03-04",
      amount: -12.5,
      payeeHandle: 3,
      reference: "42",
      memo: "split memo",
    });
  });

  it("falls back to the first split, the transaction memo and an unknown payee", () => {
    const transaction = rawTransaction({
      memo: "tx memo",
      splits: [{ account: "X", value: "1", payee: "PX" }],
    });
    expect(warningRowFor(transaction, context)).toMatchObject({
      accountKey: null,
      payeeHandle: null,
      reference: null,
      memo: "tx memo",
    });
    expect(
      warningRowFor({ ...transaction, splits: [] }, context),
    ).toMatchObject({
      accountKey: null,
      amount: null,
      payeeHandle: null,
      memo: "tx memo",
    });
  });

  it("finds a payee on any split when the lead has none", () => {
    const transaction = rawTransaction({
      splits: [
        { account: "A", value: "1" },
        { account: "X", value: "-1", payee: "P1" },
      ],
    });
    expect(warningRowFor(transaction, context).payeeHandle).toBe(3);
  });
});

describe("warningRowForInvestment", () => {
  const row = {
    handle: 4,
    accountKey: "acct-8",
    transactionDate: "2024-05-05",
    cashAmount: 0,
    totalAmount: 505,
    payeeHandle: 2,
    description: "Buy",
    action: InvestmentAction.BUY,
    status: TransactionStatus.UNRECONCILED,
  } as MappedInvestmentTransaction;

  it("shows the cash, else the total", () => {
    expect(warningRowForInvestment(row)).toEqual({
      handle: 4,
      accountKey: "acct-8",
      date: "2024-05-05",
      amount: 505,
      payeeHandle: 2,
      reference: null,
      memo: "Buy",
    });
    expect(warningRowForInvestment({ ...row, cashAmount: -3 }).amount).toBe(-3);
    expect(warningRowForInvestment({ ...row, handle: null }).handle).toBe(0);
  });
});
