import { isPositiveFinite } from "./is-positive-finite";

describe("isPositiveFinite", () => {
  it("admits a finite number above zero", () => {
    expect(isPositiveFinite(0.0001)).toBe(true);
    expect(isPositiveFinite(137250.12)).toBe(true);
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY, null, undefined])(
    "refuses %p",
    (value) => {
      expect(isPositiveFinite(value)).toBe(false);
    },
  );
});
