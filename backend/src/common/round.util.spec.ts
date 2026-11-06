import {
  FIAT_MONEY_DECIMALS,
  MONEY_DECIMALS,
  MONEY_SCALE,
  moneyDecimalsFor,
  roundToDecimals,
  roundMoney,
  sumMoney,
  toMoneyNumber,
} from "./round.util";

describe("toMoneyNumber", () => {
  it("parses a decimal SQL string to a number", () => {
    expect(toMoneyNumber("12.3400")).toBe(12.34);
  });

  it("maps null/undefined/empty to 0", () => {
    expect(toMoneyNumber(null)).toBe(0);
    expect(toMoneyNumber(undefined)).toBe(0);
    expect(toMoneyNumber("")).toBe(0);
  });

  it("maps non-numeric garbage to 0 (unlike parseFloat)", () => {
    expect(toMoneyNumber("abc")).toBe(0);
    // parseFloat("12.34abc") would be 12.34; Number() rejects it -> 0
    expect(toMoneyNumber("12.34abc")).toBe(0);
  });

  it("rounds to 4dp money precision", () => {
    expect(toMoneyNumber(1.234567)).toBe(1.2346);
  });

  it("passes through plain numbers", () => {
    expect(toMoneyNumber(42)).toBe(42);
  });

  it("reads an 8-place stored value at 8 places when asked", () => {
    expect(toMoneyNumber("0.00002500", 8)).toBe(0.000025);
    expect(toMoneyNumber("0.00002500")).toBe(0);
    expect(toMoneyNumber("5420.50000000")).toBe(5420.5);
  });
});

describe("money precision constants", () => {
  it("stores at 8 places and rounds fiat at 4", () => {
    expect(MONEY_SCALE).toBe(8);
    expect(FIAT_MONEY_DECIMALS).toBe(4);
    expect(MONEY_DECIMALS).toBe(FIAT_MONEY_DECIMALS);
  });
});

describe("moneyDecimalsFor", () => {
  it.each([
    [null, 4],
    [undefined, 4],
    [0, 4],
    [2, 4],
    [3, 4],
    [4, 4],
    [6, 6],
    [8, 8],
    [9, 8],
  ])("decimal_places %p has money precision %p", (places, expected) => {
    expect(moneyDecimalsFor(places)).toBe(expected);
  });
});

describe("roundToDecimals", () => {
  describe("basic rounding", () => {
    it("rounds to 2 decimal places", () => {
      expect(roundToDecimals(1.234, 2)).toBe(1.23);
      expect(roundToDecimals(1.235, 2)).toBe(1.24);
      expect(roundToDecimals(1.236, 2)).toBe(1.24);
    });

    it("rounds to 0 decimal places", () => {
      expect(roundToDecimals(1.4, 0)).toBe(1);
      expect(roundToDecimals(1.5, 0)).toBe(2);
      expect(roundToDecimals(1.6, 0)).toBe(2);
    });

    it("rounds to 4 decimal places", () => {
      expect(roundToDecimals(1.23456, 4)).toBe(1.2346);
      expect(roundToDecimals(1.23454, 4)).toBe(1.2345);
    });
  });

  describe("IEEE 754 midpoint cases (the actual bug)", () => {
    it("correctly rounds 159.735 to 2dp (10 shares at 15.9735)", () => {
      // 10 * 15.9735 = 159.735 mathematically, but IEEE 754 stores
      // it as 159.73499999999998... which naive rounding gets wrong
      const total = 10 * 15.9735;
      expect(roundToDecimals(total, 2)).toBe(159.74);
    });

    it("correctly rounds 1.005 to 2dp", () => {
      expect(roundToDecimals(1.005, 2)).toBe(1.01);
    });

    it("correctly rounds 2.675 to 2dp", () => {
      expect(roundToDecimals(2.675, 2)).toBe(2.68);
    });

    it("correctly rounds 1.255 to 2dp", () => {
      expect(roundToDecimals(1.255, 2)).toBe(1.26);
    });
  });

  describe("negative values (round half away from zero)", () => {
    it("rounds negative midpoints away from zero", () => {
      expect(roundToDecimals(-1.235, 2)).toBe(-1.24);
      expect(roundToDecimals(-159.735, 2)).toBe(-159.74);
      expect(roundToDecimals(-1.005, 2)).toBe(-1.01);
    });

    it("rounds negative non-midpoints correctly", () => {
      expect(roundToDecimals(-1.234, 2)).toBe(-1.23);
      expect(roundToDecimals(-1.236, 2)).toBe(-1.24);
    });
  });

  describe("edge cases", () => {
    it("handles zero", () => {
      expect(roundToDecimals(0, 2)).toBe(0);
    });

    it("handles integers", () => {
      expect(roundToDecimals(5, 2)).toBe(5);
    });

    it("handles Infinity", () => {
      expect(roundToDecimals(Infinity, 2)).toBe(Infinity);
      expect(roundToDecimals(-Infinity, 2)).toBe(-Infinity);
    });

    it("handles NaN", () => {
      expect(roundToDecimals(NaN, 2)).toBeNaN();
    });

    it("handles very small numbers", () => {
      expect(roundToDecimals(0.001, 2)).toBe(0);
      expect(roundToDecimals(0.005, 2)).toBe(0.01);
    });

    it("handles 3 decimal places (e.g. BHD)", () => {
      expect(roundToDecimals(1.2345, 3)).toBe(1.235);
      expect(roundToDecimals(1.2344, 3)).toBe(1.234);
    });

    it("handles tiny magnitudes that stringify in exponential notation", () => {
      // toString() would give "1e-7", and "1e-7e8" parses to NaN; the
      // exponential decomposition handles it.
      expect(roundToDecimals(1e-7, 8)).toBe(1e-7);
      expect(roundToDecimals(1.2345e-5, 8)).toBe(0.00001235);
      expect(roundToDecimals(8e-7, 6)).toBe(0.000001);
      expect(roundToDecimals(-1e-7, 8)).toBe(-1e-7);
    });

    it("rounds tiny magnitudes to zero at coarser precision", () => {
      expect(roundToDecimals(1e-7, 4)).toBe(0);
      expect(roundToDecimals(8e-7, 4)).toBe(0);
    });

    it("keeps an exact value exact where one ULP is a sizeable part of a unit", () => {
      // The one-ULP nudge used to carry these into the next unit.
      expect(roundToDecimals(21000000, 8)).toBe(21000000);
      expect(roundToDecimals(90000000, 8)).toBe(90000000);
      expect(roundToDecimals(20999999.99999999, 8)).toBe(20999999.99999999);
      expect(roundToDecimals(-21000000.12345678, 8)).toBe(-21000000.12345678);
      expect(roundToDecimals(1e12, 4)).toBe(1e12);
      expect(roundToDecimals(1e21, 4)).toBe(1e21);
    });

    it("does not carry a value just under a midpoint high in the 1e6 to 4.5e6 band at eight places", () => {
      // The shortest decimal string rounds to ...93; a nudge of 0.05 to 0.1
      // unit used to carry it to ...94. Mirrored in the frontend format test.
      expect(roundToDecimals(3422512.090132934, 8)).toBe(3422512.09013293);
      expect(roundToDecimals(-3422512.090132934, 8)).toBe(-3422512.09013293);
      expect(roundToDecimals(3422512.090132935, 8)).toBe(3422512.09013294);
    });

    it("handles zero without producing -0 or NaN", () => {
      expect(roundToDecimals(0, 4)).toBe(0);
      expect(Object.is(roundToDecimals(0, 4), 0)).toBe(true);
    });
  });
});

describe("roundMoney", () => {
  it("rounds to 4 decimal places (storage precision)", () => {
    expect(roundMoney(1.23456)).toBe(1.2346);
    expect(roundMoney(1.23454)).toBe(1.2345);
    expect(roundMoney(1000)).toBe(1000);
    expect(roundMoney(17.99)).toBe(17.99);
  });

  it("preserves sub-cent precision that 2dp rounding would lose", () => {
    expect(roundMoney(1234.5678)).toBe(1234.5678);
    expect(roundMoney(0.0001)).toBe(0.0001);
  });

  it("rounds half away from zero, fixing IEEE 754 midpoints", () => {
    // 10 * 1.59735 = 15.9735 mathematically; naive *10000 would drop the digit
    expect(roundMoney(1.23455)).toBe(1.2346);
    expect(roundMoney(-1.23455)).toBe(-1.2346);
  });

  it("passes through non-finite values", () => {
    expect(roundMoney(Infinity)).toBe(Infinity);
    expect(roundMoney(NaN)).toBeNaN();
  });

  it("rounds at 8 places when the currency carries 8", () => {
    expect(roundMoney(0.000025, 8)).toBe(0.000025);
    expect(roundMoney(0.000025)).toBe(0);
    expect(roundMoney(1700 / 136000.123456789, 8)).toBe(0.01249999);
    expect(roundMoney(0.000000005, 8)).toBe(0.00000001);
    expect(roundMoney(-0.000000005, 8)).toBe(-0.00000001);
  });
});

describe("sumMoney", () => {
  it("sums without floating-point drift", () => {
    expect(sumMoney([0.1, 0.2])).toBe(0.3);
    expect(sumMoney([10.0001, 20.0002])).toBe(30.0003);
  });

  it("returns 0 for an empty array", () => {
    expect(sumMoney([])).toBe(0);
  });

  it("matches a careful reduce over many sub-cent values", () => {
    const values = Array.from({ length: 1000 }, () => 0.0001);
    expect(sumMoney(values)).toBe(0.1);
  });

  it("handles negative values", () => {
    expect(sumMoney([100, -33.33, -33.33, -33.34])).toBe(0);
  });

  it("ignores non-finite entries", () => {
    expect(sumMoney([1.5, NaN, 2.5, Infinity])).toBe(4);
    expect(sumMoney([0.00000001, NaN, -Infinity], 8)).toBe(0.00000001);
  });

  it("rounds each value at the requested precision before summing", () => {
    expect(sumMoney([0.000025, 0.005])).toBe(0.005);
    expect(sumMoney([0.000025, 0.005], 8)).toBe(0.005025);
    expect(sumMoney([-0.005, -0.000025], 8)).toBe(-0.005025);
  });

  it("sums at 8 places exactly where the float form drifts", () => {
    expect(sumMoney([20999999.99999999, 0.00000001], 8)).toBe(21000000);
    expect(sumMoney([0.1, 0.2], 8)).toBe(0.3);
    const tiny = Array.from({ length: 1000 }, () => 0.00000001);
    expect(sumMoney(tiny, 8)).toBe(0.00001);
  });

  it("carries a total whose integer units exceed 2^53", () => {
    // 1e9 at 8 places is 1e17 units, beyond Number.MAX_SAFE_INTEGER (~9e15).
    expect(1e9 * 1e8).toBeGreaterThan(Number.MAX_SAFE_INTEGER);
    expect(sumMoney([1e9, 0.5, 0.5], 8)).toBe(1000000001);
    expect(sumMoney([999999999.5, 0.5], 8)).toBe(1e9);
    expect(sumMoney([1e9, -1e9, 0.00000001], 8)).toBe(0.00000001);
  });

  it("handles magnitudes that stringify in exponential notation", () => {
    expect(sumMoney([1e-7, 1e-7], 8)).toBe(2e-7);
    expect(sumMoney([1e21, 1e21])).toBe(2e21);
  });

  it("returns the same answers at the default precision as before", () => {
    expect(sumMoney([100.12345, 0.00004])).toBe(100.1235);
    expect(sumMoney([12.3456, -2.3456])).toBe(10);
  });
});
