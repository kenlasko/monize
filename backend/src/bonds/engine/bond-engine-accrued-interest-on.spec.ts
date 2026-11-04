import { E4, E5, E6, E7, value } from "@/test-helpers/bond-coupon-terms";
import { accruedInterestOn } from "./bond-engine";

describe("accruedInterestOn (spec 6.2)", () => {
  it.each([
    [E4, "1990-11-15", 1500, "2531.25"],
    [E5, "1990-11-04", 110, "404.01"],
    [E4, "1991-04-01", 1500, "1258.63"],
    [E4, "1991-02-15", 1500, "0.00"],
    [E4, "1990-08-01", 1500, "0.00"],
  ])(
    "answers the accrued interest of a purchase on the day (%#)",
    (terms, date, quantity, expected) => {
      expect(accruedInterestOn(terms, date, quantity)).toBe(expected);
    },
  );

  it("is the accrued interest of the valuation of that lot on that day, whichever the day", () => {
    for (const day of [
      "1990-08-15",
      "1990-09-01",
      "1990-12-31",
      "1991-02-14",
      "1991-02-15",
      "1991-07-04",
      "1992-02-14",
    ]) {
      expect(accruedInterestOn(E4, day, 37)).toBe(
        value(E4, day, 37, day).accruedInterest,
      );
    }
  });

  it("is the same through a short and a long first period", () => {
    for (const [terms, day] of [
      [E6, "1990-10-01"],
      [E7, "1991-01-15"],
      [E7, "1991-04-02"],
    ] as const) {
      expect(accruedInterestOn(terms, day, 123)).toBe(
        value(terms, day, 123, day).accruedInterest,
      );
    }
  });

  it("is null for a marketable lot bought on or after maturity", () => {
    expect(accruedInterestOn(E4, "1992-02-15", 10)).toBeNull();
  });

  it("refuses a quantity that is not a positive integer", () => {
    expect(() => accruedInterestOn(E4, "1990-11-15", 0)).toThrow();
  });
});
