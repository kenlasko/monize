import { rawSplit, n } from "../__fixtures__/kmy-raw-builders";
import {
  amountNumber,
  amountPlaces,
  effectiveShares,
  impliedRate,
  isExactAt,
  isIsoDate,
  legRational,
  priceNumber,
  quantityNumber,
  rateNumber,
  toUnits,
  unitsToNumber,
} from "./kmy-amounts";

describe("kmy-amounts", () => {
  const coins = new Map([["BTC", 8]]);

  it("uses 4 places for a fiat and the coin's own for a CRYPTO code", () => {
    expect(amountPlaces("USD", coins)).toBe(4);
    expect(amountPlaces("BTC", coins)).toBe(8);
    expect(amountPlaces("JPY", new Map([["JPY", 0]]))).toBe(4);
  });

  it("rounds half away from zero, once, from the exact rational", () => {
    expect(amountNumber(n("1/3"), "USD", coins)).toBe(0.3333);
    expect(amountNumber(n("-1/3"), "USD", coins)).toBe(-0.3333);
    expect(amountNumber(n("5/20000"), "USD", coins)).toBe(0.0003);
    expect(amountNumber(n("-5/20000"), "USD", coins)).toBe(-0.0003);
    expect(amountNumber(n("1/3"), "BTC", coins)).toBe(0.33333333);
    expect(quantityNumber(n("1/3"))).toBe(0.33333333);
    expect(priceNumber(n("2/3"))).toBe(0.6666666667);
    expect(rateNumber(n("1000/1100"))).toBe(0.9090909091);
  });

  it("keeps numerators above 2^53 exact", () => {
    expect(amountNumber(n("9007199254740993/100"), "USD", coins)).toBe(
      Number("90071992547409.93"),
    );
  });

  it("converts to minor units and back", () => {
    expect(toUnits(n("-120.5"), 4)).toBe(-1205000n);
    expect(toUnits(n("1/3"), 4)).toBe(3333n);
    expect(unitsToNumber(-1205000n, 4)).toBe(-120.5);
    expect(unitsToNumber(0n, 4)).toBe(0);
  });

  it("knows what is exact at a number of places", () => {
    expect(isExactAt(n("1/4"), 8)).toBe(true);
    expect(isExactAt(n("1/3"), 8)).toBe(false);
  });

  it("applies the fix-version compensation only below 12", () => {
    const split = rawSplit({ account: "A", value: "7", shares: "0" });
    expect(effectiveShares(split, "USD", "USD", 12)).toEqual(split.shares);
    expect(effectiveShares(split, "USD", "USD", 11)).toEqual(split.value);
    expect(effectiveShares(split, "EUR", "USD", 11)).toEqual(split.shares);
  });

  it("computes a leg through the parent's ratio, exactly -value in the commodity", () => {
    expect(legRational(n("1100"), n("-1100"), n("-1000"), false)).toEqual(
      n("-1000"),
    );
    expect(legRational(n("5"), n("-1"), n("-9"), true)).toEqual(n("-5"));
    expect(legRational(n("5"), n("0"), n("-9"), false)).toBeNull();
  });

  it("implies a rate from two amounts, null when a side is zero", () => {
    expect(impliedRate(10000000n, 11000000n)).toBe(0.9090909091);
    expect(impliedRate(-10000000n, 11000000n)).toBe(0.9090909091);
    expect(impliedRate(0n, 5n)).toBeNull();
    expect(impliedRate(5n, 0n)).toBeNull();
  });

  it("accepts only real calendar dates", () => {
    expect(isIsoDate("2024-02-29")).toBe(true);
    expect(isIsoDate("2023-02-29")).toBe(false);
    expect(isIsoDate("2024-13-01")).toBe(false);
    expect(isIsoDate("")).toBe(false);
    expect(isIsoDate(null)).toBe(false);
    expect(isIsoDate("24-01-01")).toBe(false);
  });
});
