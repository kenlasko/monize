import { BondLotTransaction, bondLotsFromTransactions } from "./bond-lots";

const buy = (
  quantity: string,
  cost: string | null,
  date = "2026-10-01",
): BondLotTransaction => ({
  action: "BUY",
  status: "ACTIVE",
  transactionDate: date,
  quantity,
  cost,
  pairedTransfer: false,
  accountId: "A",
  instrumentId: "S",
});

const redeem = (quantity: string): BondLotTransaction => ({
  action: "REDEEM",
  status: "ACTIVE",
  transactionDate: "2027-04-01",
  quantity,
  pairedTransfer: false,
  accountId: "A",
  instrumentId: "S",
});

const taken = (rows: readonly BondLotTransaction[]) => {
  const result = bondLotsFromTransactions(rows);
  if (result.refusal !== null) throw new Error("the lots are unknown");
  return result.takenByLastRow.map((l) => [l.quantity, l.cost]);
};

describe("takenByLastRow: what a removal takes, with the exact cost", () => {
  it("takes a lot that leaves whole with its whole cost", () => {
    expect(taken([buy("4", "400.0000"), redeem("4")])).toEqual([
      [4, "400.0000"],
    ]);
  });

  it("splits the cost of a partial removal pro rata: 1 of 3 bonds of 100.0000 is 33.3333", () => {
    expect(taken([buy("3", "100.0000"), redeem("1")])).toEqual([
      [1, "33.3333"],
    ]);
  });

  it("takes from the first of two same-day lots of different cost: 3 of 5 for 500.0000 is 300.0000", () => {
    expect(
      taken([buy("5", "500.0000"), buy("5", "600.0000"), redeem("3")]),
    ).toEqual([[3, "300.0000"]]);
  });

  it("spans lots oldest first, each portion with its own cost", () => {
    expect(
      taken([
        buy("5", "600.0000", "2026-11-01"),
        buy("2", "190.0000", "2026-10-01"),
        redeem("4"),
      ]),
    ).toEqual([
      [2, "190.0000"],
      [2, "240.0000"],
    ]);
  });

  it("has an unknown cost for what leaves a lot of unknown cost", () => {
    expect(taken([buy("3", null), redeem("2")])).toEqual([[2, null]]);
  });

  it("takes nothing when the last row is not a removal", () => {
    expect(
      taken([buy("3", "300.0000"), redeem("1"), buy("2", "1.0000")]),
    ).toEqual([]);
  });
});
