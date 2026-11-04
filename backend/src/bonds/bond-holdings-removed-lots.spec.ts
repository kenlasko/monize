import { BondLot } from "./bond-lots";
import { removedLots } from "./bond-holdings.service";

const lot = (quantity: number, cost: string | null, date = "2026-10-01") =>
  ({
    accountId: "A",
    instrumentId: "S",
    purchaseDate: date,
    quantity,
    purchaseDateAssumed: false,
    cost,
  }) as BondLot;

describe("removedLots", () => {
  it("takes the cost of a lot that leaves whole", () => {
    expect(removedLots([lot(4, "400.0000")], [])).toEqual([lot(4, "400.0000")]);
  });

  it("takes what the lot lost on a partial removal: its cost less the cost that stays", () => {
    expect(removedLots([lot(3, "100.0000")], [lot(2, "66.6667")])).toEqual([
      lot(1, "33.3333"),
    ]);
  });

  it("leaves an untouched lot out", () => {
    expect(removedLots([lot(3, "100.0000")], [lot(3, "100.0000")])).toEqual([]);
  });

  it("has an unknown cost for what leaves a lot of unknown cost", () => {
    expect(removedLots([lot(3, null)], [lot(1, null)])).toEqual([lot(2, null)]);
  });
});
