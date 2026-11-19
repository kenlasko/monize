import { KmyCorruptFileError } from "./kmy-errors";
import {
  KmyRounding,
  ONE,
  ZERO,
  abs,
  add,
  compare,
  div,
  isZero,
  mul,
  neg,
  parseKmyNumber,
  rational,
  roundToDenominator,
  sign,
  sub,
  sum,
  toDecimalString,
  toNumber,
} from "./kmy-rational";

const q = (n: number, d = 1) => rational(BigInt(n), BigInt(d));
const value = (text: string) => {
  const parsed = parseKmyNumber(text);
  if (parsed.kind !== "value") throw new Error(`not a value: ${text}`);
  return parsed.value;
};

describe("rational", () => {
  it("canonicalises to lowest terms with a positive denominator", () => {
    expect(rational(10n, 4n)).toEqual({ num: 5n, den: 2n });
    expect(rational(3n, -6n)).toEqual({ num: -1n, den: 2n });
    expect(rational(0n, -9n)).toEqual({ num: 0n, den: 1n });
  });

  it("refuses a zero denominator", () => {
    expect(() => rational(1n, 0n)).toThrow(RangeError);
  });

  it("does arithmetic exactly", () => {
    expect(add(q(1, 3), q(1, 6))).toEqual(q(1, 2));
    expect(sub(q(1, 3), q(1, 2))).toEqual(q(-1, 6));
    expect(mul(q(2, 3), q(3, 4))).toEqual(q(1, 2));
    expect(div(q(1, 2), q(-1, 4))).toEqual(q(-2));
    expect(neg(q(1, 2))).toEqual(q(-1, 2));
    expect(neg(ZERO)).toEqual(ZERO);
    expect(abs(q(-3, 5))).toEqual(q(3, 5));
    expect(() => div(ONE, ZERO)).toThrow(RangeError);
  });

  it("compares, signs and sums", () => {
    expect(compare(q(1, 3), q(1, 2))).toBe(-1);
    expect(compare(q(2, 4), q(1, 2))).toBe(0);
    expect(compare(q(3), q(1, 2))).toBe(1);
    expect(sign(q(-1, 9))).toBe(-1);
    expect(sign(ZERO)).toBe(0);
    expect(sign(ONE)).toBe(1);
    expect(isZero(sub(q(1, 3), q(1, 3)))).toBe(true);
    expect(sum([q(1, 3), q(1, 3), q(1, 3)])).toEqual(ONE);
    expect(sum([])).toEqual(ZERO);
  });

  it("keeps numerators above 2^53 exact", () => {
    const big = 2n ** 60n + 1n;
    expect(add(rational(big), ONE)).toEqual({ num: big + 1n, den: 1n });
    expect(value("1152921504606846977/3")).toEqual({
      num: 1152921504606846977n,
      den: 3n,
    });
    expect(toDecimalString(rational(big, 1n), 2)).toBe(`${big}.00`);
  });
});

describe("parseKmyNumber", () => {
  it("reads the empty string as 0", () => {
    expect(value("")).toEqual(ZERO);
  });

  it("reads fractions and canonicalises them", () => {
    expect(value("201/2")).toEqual(q(201, 2));
    expect(value("-241/2")).toEqual(q(-241, 2));
    expect(value("10050/100")).toEqual(q(201, 2));
    expect(value("0/1")).toEqual(ZERO);
    expect(value("-218677/25")).toEqual(q(-218677, 25));
  });

  it("reads a mixed fraction as whole plus fraction", () => {
    expect(value("5 8/16")).toEqual(q(11, 2));
  });

  it("does not anchor the fraction at the end", () => {
    expect(value("3/4abc")).toEqual(q(3, 4));
  });

  it("reads decimals with a dot only", () => {
    expect(value("12.50")).toEqual(q(25, 2));
    expect(value("-0.125")).toEqual(q(-1, 8));
    expect(value("7")).toEqual(q(7));
    expect(parseKmyNumber("1,5")).toEqual({ kind: "invalid" });
  });

  it("marks anything else invalid", () => {
    expect(parseKmyNumber("abc")).toEqual({ kind: "invalid" });
    expect(parseKmyNumber("1.")).toEqual({ kind: "invalid" });
    expect(parseKmyNumber("-5 8/16")).toEqual({ kind: "invalid" });
  });

  it("throws a corrupt-file error on a zero denominator", () => {
    expect(() => parseKmyNumber("5/0")).toThrow(KmyCorruptFileError);
  });

  it("recognises the auto-calc sentinel of either sign", () => {
    expect(parseKmyNumber("-9223372036854775807/100")).toEqual({
      kind: "autoCalc",
    });
    expect(parseKmyNumber("9223372036854775807/100")).toEqual({
      kind: "autoCalc",
    });
    expect(parseKmyNumber("9223372036854775807/1").kind).toBe("value");
  });
});

describe("roundToDenominator", () => {
  // Inputs as [num, den]; expectations per method at denominator 1.
  const cases: Array<{
    in: [number, number];
    out: Record<string, number>;
  }> = [
    {
      in: [5, 2], // 2.5
      out: {
        Floor: 2,
        Ceil: 3,
        Truncate: 2,
        Promote: 3,
        HalfDown: 2,
        HalfUp: 3,
        Round: 2,
      },
    },
    {
      in: [7, 2], // 3.5
      out: {
        Floor: 3,
        Ceil: 4,
        Truncate: 3,
        Promote: 4,
        HalfDown: 3,
        HalfUp: 4,
        Round: 4,
      },
    },
    {
      in: [-5, 2], // -2.5
      out: {
        Floor: -3,
        Ceil: -2,
        Truncate: -2,
        Promote: -3,
        HalfDown: -2,
        HalfUp: -3,
        Round: -2,
      },
    },
    {
      in: [-7, 2], // -3.5
      out: {
        Floor: -4,
        Ceil: -3,
        Truncate: -3,
        Promote: -4,
        HalfDown: -3,
        HalfUp: -4,
        Round: -4,
      },
    },
    {
      in: [13, 10], // 1.3
      out: {
        Floor: 1,
        Ceil: 2,
        Truncate: 1,
        Promote: 2,
        HalfDown: 1,
        HalfUp: 1,
        Round: 1,
      },
    },
    {
      in: [17, 10], // 1.7
      out: {
        Floor: 1,
        Ceil: 2,
        Truncate: 1,
        Promote: 2,
        HalfDown: 2,
        HalfUp: 2,
        Round: 2,
      },
    },
    {
      in: [-13, 10],
      out: {
        Floor: -2,
        Ceil: -1,
        Truncate: -1,
        Promote: -2,
        HalfDown: -1,
        HalfUp: -1,
        Round: -1,
      },
    },
    {
      in: [-17, 10],
      out: {
        Floor: -2,
        Ceil: -1,
        Truncate: -1,
        Promote: -2,
        HalfDown: -2,
        HalfUp: -2,
        Round: -2,
      },
    },
    {
      in: [4, 1], // exact
      out: {
        Floor: 4,
        Ceil: 4,
        Truncate: 4,
        Promote: 4,
        HalfDown: 4,
        HalfUp: 4,
        Round: 4,
      },
    },
  ];

  for (const c of cases) {
    for (const [name, expected] of Object.entries(c.out)) {
      it(`${name} of ${c.in[0]}/${c.in[1]} is ${expected}`, () => {
        const method = KmyRounding[name as keyof typeof KmyRounding];
        expect(roundToDenominator(q(c.in[0], c.in[1]), 1n, method)).toEqual(
          q(expected),
        );
      });
    }
  }

  it("treats Never as Round", () => {
    expect(roundToDenominator(q(5, 2), 1n, KmyRounding.Never)).toEqual(q(2));
    expect(roundToDenominator(q(7, 2), 1n, KmyRounding.Never)).toEqual(q(4));
  });

  it("rounds to a non-unit denominator", () => {
    // 1/3 to hundredths, half up: 33/100
    expect(roundToDenominator(q(1, 3), 100n, KmyRounding.HalfUp)).toEqual(
      q(33, 100),
    );
    // 2/3 to hundredths, truncate: 66/100 -> 33/50
    expect(roundToDenominator(q(2, 3), 100n, KmyRounding.Truncate)).toEqual(
      q(33, 50),
    );
    // 3 shares * 7/3 split ratio to saf 100, promote
    expect(roundToDenominator(q(7, 3), 100n, KmyRounding.Promote)).toEqual(
      q(234, 100),
    );
  });

  it("refuses a non-positive denominator", () => {
    expect(() => roundToDenominator(ONE, 0n, KmyRounding.Round)).toThrow(
      RangeError,
    );
  });
});

describe("toDecimalString and toNumber", () => {
  it("prints exact decimals", () => {
    expect(toDecimalString(q(-241, 2), 4)).toBe("-120.5000");
    expect(toDecimalString(q(1, 3), 8)).toBe("0.33333333");
    expect(toDecimalString(q(2, 3), 10)).toBe("0.6666666667");
    expect(toDecimalString(q(1234, 1), 0)).toBe("1234");
  });

  it("never produces a negative zero", () => {
    expect(toDecimalString(q(-1, 200000), 4)).toBe("0.0000");
    expect(toDecimalString(ZERO, 0)).toBe("0");
  });

  it("rounds half away from zero", () => {
    expect(toDecimalString(q(1, 2), 0)).toBe("1");
    expect(toDecimalString(q(-1, 2), 0)).toBe("-1");
    expect(toDecimalString(q(5, 20000), 4)).toBe("0.0003");
    expect(toDecimalString(q(-5, 20000), 4)).toBe("-0.0003");
  });

  it("refuses bad places", () => {
    expect(() => toDecimalString(ONE, -1)).toThrow(RangeError);
    expect(() => toDecimalString(ONE, 1.5)).toThrow(RangeError);
  });

  it("converts to a number through the decimal string", () => {
    expect(toNumber(q(201, 2), 4)).toBe(100.5);
    expect(toNumber(q(-1, 3), 4)).toBe(-0.3333);
  });
});
