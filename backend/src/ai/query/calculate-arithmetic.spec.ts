import {
  exactAverage,
  exactDifference,
  exactQuotient,
  exactSum,
} from "./calculate-arithmetic";

describe("calculate arithmetic", () => {
  describe("exactSum", () => {
    it.each<[number[], number]>([
      [[0.1, 0.2], 0.3],
      [[0.00246, 0.00246], 0.00492],
      [Array(10).fill(0.1), 1],
      [[1e-7, 2e-7], 3e-7],
      [[20999999.99999999, 0.00000001], 21000000],
      [[-0.00005, 0.00005], 0],
      [[123456789.1234567, 0.0000001], 123456789.1234568],
    ])("sums %p exactly to %p", (values, expected) => {
      expect(exactSum(values)).toBe(expected);
    });

    it("never answers -0", () => {
      expect(Object.is(exactSum([-0, -0]), 0)).toBe(true);
      expect(Object.is(exactSum([-1.5, 1.5]), 0)).toBe(true);
    });
  });

  describe("exactDifference", () => {
    it("is exact where a float subtraction drifts", () => {
      expect(exactDifference(0.3, 0.1)).toBe(0.2);
      expect(exactDifference(0.00492, 0)).toBe(0.00492);
      expect(exactDifference(-0.00005, 0)).toBe(-0.00005);
    });
  });

  describe("exactQuotient", () => {
    it("divides the decimal values", () => {
      expect(exactQuotient(0.07, 0.1)).toBe(0.7);
      expect(exactQuotient(0.07, 0.1, 100)).toBe(70);
      expect(exactQuotient(1.2345, 1)).toBe(1.2345);
    });

    it("carries a repeating quotient to double precision", () => {
      expect(exactQuotient(1, 3)).toBe(1 / 3);
      expect(exactQuotient(2, 3)).toBe(2 / 3);
      expect(exactQuotient(5000, 3000)).toBe(5 / 3);
    });

    it("signs the quotient by its operands", () => {
      expect(exactQuotient(-1, 4)).toBe(-0.25);
      expect(exactQuotient(1, -4)).toBe(-0.25);
      expect(exactQuotient(-1, -4)).toBe(0.25);
      expect(Object.is(exactQuotient(0, -4), 0)).toBe(true);
    });

    it("keeps significant digits across magnitudes", () => {
      expect(exactQuotient(1e-9, 3e9)).toBe(1 / 3e18);
      expect(exactQuotient(1e15, 7)).toBe(1e15 / 7);
    });
  });

  describe("exactAverage", () => {
    it("divides the exact sum by the count", () => {
      expect(exactAverage([100, 200, 300])).toBe(200);
      expect(exactAverage([0.00246, 0.00246])).toBe(0.00246);
      expect(exactAverage([0.1, 0.2])).toBe(0.15);
      expect(exactAverage([0.1, 0.1, 0.2])).toBe(0.4 / 3);
    });
  });
});
