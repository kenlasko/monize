import { TransactionStatus } from "../transactions/entities/transaction.entity";
import { deletionBalanceEffect } from "./deletion-balance.util";

describe("deletionBalanceEffect", () => {
  const past = "2020-01-15";

  it("reverses a fiat row's stored amount", () => {
    expect(
      deletionBalanceEffect({ amount: "-42.5000", transactionDate: past }),
    ).toEqual({
      delta: 42.5,
      needsRecalc: false,
    });
  });

  it("reverses a coin row's satoshis exactly, never at four places", () => {
    expect(
      deletionBalanceEffect({ amount: "-0.00002500", transactionDate: past })
        .delta,
    ).toBe(0.000025);
    expect(
      deletionBalanceEffect({ amount: "0.01249993", transactionDate: past })
        .delta,
    ).toBe(-0.01249993);
  });

  it("moves nothing for a VOID row and recomputes for a future one", () => {
    expect(
      deletionBalanceEffect({
        amount: "-0.00002500",
        status: TransactionStatus.VOID,
        transactionDate: past,
      }),
    ).toEqual({ delta: 0, needsRecalc: false });
    expect(
      deletionBalanceEffect({ amount: "-10", transactionDate: "2999-01-01" }),
    ).toEqual({ delta: 0, needsRecalc: true });
  });
});
