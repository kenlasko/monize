import { parseBondTerms } from "../../domain/bond-terms";
import { redemptionSplit, valueBondLot } from "../../engine/bond-engine";
import { inputOf } from "./golden-support";
import { fetchSeries } from "./series/fetch-series";
import {
  fakeFetch,
  fixtureJson,
  treasuryAnswers,
} from "./series/fixture-helpers";

// A bill auctioned at a discount rate of 0.000 % is issued at par: no discount
// accretes, so every figure is the face value and the interest is nothing.
// Expected figures are the face value of 100 units of 100: 10000.00.

describe("a bill issued at par (constructed fixture, 0.000 % rate)", () => {
  async function termsOfParBill() {
    const get = fakeFetch(
      treasuryAnswers("912797WM5", fixtureJson("ta-ws-912797WM5-par.json"), {}),
    );
    const { entry } = await fetchSeries(
      "912797WM5261001",
      get,
      () => new Date("2026-11-04T10:00:00.000Z"),
    );
    return parseBondTerms(entry.terms);
  }

  const lot = { purchaseDate: "2026-10-01", quantity: 100 };
  const base = { id: "par", description: "", source: "constructed", lot };

  it.each(["2026-10-01", "2026-12-31", "2027-03-31"])(
    "is worth 10000.00 on %s with no interest",
    async (asOf) => {
      const terms = await termsOfParBill();
      expect(valueBondLot(inputOf(terms, { ...base, asOf }))).toMatchObject({
        status: "OPEN",
        grossValue: "10000.00",
        accruedInterest: "0.00",
      });
    },
  );

  it("is worth 10000.00 with no interest on a lot of known cost at par", async () => {
    const terms = await termsOfParBill();
    const input = inputOf(terms, {
      ...base,
      lot: { ...lot, cost: "10000.00" },
      asOf: "2026-12-31",
    });
    expect(valueBondLot(input)).toMatchObject({
      grossValue: "10000.00",
      accruedInterest: "0.00",
    });
  });

  it("pays the face value at maturity, all of it principal", async () => {
    const terms = await termsOfParBill();
    const { asOf: _unused, ...rest } = inputOf(terms, {
      ...base,
      asOf: "2026-12-31",
    });
    expect(redemptionSplit(rest, "2027-04-01")).toMatchObject({
      principalReturned: "10000.00",
      interest: "0.00",
      payout: "10000.00",
    });
  });
});
