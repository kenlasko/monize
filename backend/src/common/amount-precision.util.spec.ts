import { BadRequestException } from "@nestjs/common";
import {
  assertAmountPrecision,
  decimalPlacesOf,
} from "./amount-precision.util";

describe("decimalPlacesOf", () => {
  it.each([
    [0, 0],
    [12, 0],
    [12.345, 3],
    [-12.345, 3],
    [0.000025, 6],
    [0.00002501, 8],
    [1e-7, 7],
    [1.5e-8, 9],
    [21000000, 0],
    [20999999.99999999, 8],
    [1e21, 0],
  ])("counts %p as %p places", (value, expected) => {
    expect(decimalPlacesOf(value)).toBe(expected);
  });

  it.each([
    ["0.00002500", 6],
    ["12.3400", 2],
    ["12.34000000", 2],
    ["-0.00502500", 6],
    ["100", 0],
    ["100.", 0],
    [".5", 1],
    ["1e-7", 7],
    ["2.5E-5", 6],
    ["1.23e2", 0],
    ["0.123456789012345678901", 21],
  ])("counts the string %p as %p places", (value, expected) => {
    expect(decimalPlacesOf(value)).toBe(expected);
  });

  it("reads a value with nothing to count as 0", () => {
    expect(decimalPlacesOf(NaN)).toBe(0);
    expect(decimalPlacesOf(Infinity)).toBe(0);
    expect(decimalPlacesOf("")).toBe(0);
    expect(decimalPlacesOf("abc")).toBe(0);
  });
});

describe("assertAmountPrecision", () => {
  const CAD = { code: "CAD", decimalPlaces: 2 };
  const JPY = { code: "JPY", decimalPlaces: 0 };
  const BTC = { code: "BTC", decimalPlaces: 8 };
  const COIN6 = { code: "XSIX", decimalPlaces: 6 };

  const refuses =
    (
      amount: number | string,
      currency: { code: string; decimalPlaces: number | null },
    ) =>
    () =>
      assertAmountPrecision(amount, currency, "amount");

  // Section 5 of docs/specs/money-precision.md, row by row.
  it("accepts up to four places on a fiat currency and refuses more", () => {
    expect(refuses(12.345, CAD)).not.toThrow();
    expect(refuses(12.3456, CAD)).not.toThrow();
    expect(refuses(12.345, JPY)).not.toThrow();
    expect(refuses(12.34567, CAD)).toThrow(BadRequestException);
    expect(refuses(0.000025, CAD)).toThrow(BadRequestException);
    expect(refuses("0.00002500", JPY)).toThrow(BadRequestException);
  });

  it("accepts eight places on a coin carrying eight", () => {
    expect(refuses(0.000025, BTC)).not.toThrow();
    expect(refuses("0.00002500", BTC)).not.toThrow();
    expect(refuses(-0.005025, BTC)).not.toThrow();
    expect(refuses(0.000000015, BTC)).toThrow(BadRequestException);
  });

  // Trailing zeros are not precision: `0.00002500` is `0.000025`, which a coin
  // at six places holds exactly (a JSON number loses the zeros before the
  // server sees it anyway). The spec's section 5 row reads the typed string
  // as eight places; the contract's shortest-string count is what is enforced.
  it("holds a coin carrying six to six", () => {
    expect(refuses(0.000025, COIN6)).not.toThrow();
    expect(refuses("0.00002500", COIN6)).not.toThrow();
    expect(refuses(0.00002501, COIN6)).toThrow(BadRequestException);
  });

  it("reads a missing decimal_places as the column default", () => {
    expect(refuses(1.2345, { code: "XTS", decimalPlaces: null })).not.toThrow();
    expect(refuses(1.23456, { code: "XTS", decimalPlaces: null })).toThrow(
      BadRequestException,
    );
  });

  it("names the currency, its places and the field", () => {
    expect(() =>
      assertAmountPrecision(0.00002501, COIN6, "splits[1].amount"),
    ).toThrow(
      'The amount in "splits[1].amount" has more decimal places than XSIX carries (6).',
    );
  });
});
