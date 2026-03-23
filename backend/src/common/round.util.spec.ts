import { roundToDecimals } from "./round.util";

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
  });
});
