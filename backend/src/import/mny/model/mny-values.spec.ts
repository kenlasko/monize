import {
  MNY_MAX_YEAR,
  MNY_MIN_YEAR,
  toAmount,
  toBoolean,
  toDate,
  toHandle,
  toInteger,
  toNumber,
  toOptionalText,
  toText,
} from "./mny-values";

describe("toText", () => {
  it("trims text", () => {
    expect(toText("  Acme Ltd  ")).toBe("Acme Ltd");
  });

  it.each([[null], [undefined], [42], [true], [new Date()]])(
    "returns an empty string for %p",
    (value) => {
      expect(toText(value as never)).toBe("");
    },
  );
});

describe("toOptionalText", () => {
  it("returns trimmed text", () => {
    expect(toOptionalText(" memo ")).toBe("memo");
  });

  it.each([[null], [""], ["   "]])("returns null for %p", (value) => {
    expect(toOptionalText(value as never)).toBeNull();
  });
});

describe("toHandle", () => {
  it("passes real handles through", () => {
    expect(toHandle(131)).toBe(131);
  });

  it.each([[null], [0], [-1], [Number.NaN], ["131"]])(
    "returns null for %p",
    (value) => {
      // Money writes null, 0 or -1 for "no reference" depending on the
      // release: money2002 leaves TRN.hpay null, money2008 writes lHpay -1.
      expect(toHandle(value as never)).toBeNull();
    },
  );
});

describe("toInteger", () => {
  it("truncates towards zero", () => {
    expect(toInteger(3.9)).toBe(3);
    expect(toInteger(-3.9)).toBe(-3);
  });

  it("falls back when the column is absent", () => {
    expect(toInteger(null)).toBe(0);
    expect(toInteger(null, -1)).toBe(-1);
    expect(toInteger("7", -1)).toBe(-1);
  });
});

describe("toNumber", () => {
  it("keeps fractional values", () => {
    expect(toNumber(12.375)).toBe(12.375);
  });

  it("falls back when the column is absent", () => {
    expect(toNumber(null)).toBe(0);
    expect(toNumber(null, 1)).toBe(1);
  });
});

describe("toAmount", () => {
  it("parses the decimal strings Jet currency columns produce", () => {
    expect(toAmount("0.0800")).toBe(0.08);
    expect(toAmount("-1234.5678")).toBe(-1234.5678);
  });

  it("rounds to the four decimal places Monize stores", () => {
    expect(toAmount("1.000049")).toBe(1);
    expect(toAmount(2.00005)).toBe(2.0001);
  });

  it("reads a large amount back unchanged (Discussion #2343)", () => {
    // 300000000000.03 * 10000 is 3000000000000300.5 in doubles, which the
    // float scaling rounded to 300000000000.0301.
    expect(toAmount("300000000000.03")).toBe(300_000_000_000.03);
    expect(toAmount("-300000000000.03")).toBe(-300_000_000_000.03);
  });

  it("returns zero for absent or unparseable values", () => {
    expect(toAmount(null)).toBe(0);
    expect(toAmount("not a number")).toBe(0);
  });
});

describe("toBoolean", () => {
  it.each([
    [true, true],
    [false, false],
    [null, false],
    [1, false],
  ])("maps %p to %p", (value, expected) => {
    expect(toBoolean(value as never)).toBe(expected);
  });
});

describe("toDate", () => {
  it("formats as YYYY-MM-DD", () => {
    expect(toDate(new Date(Date.UTC(2011, 5, 24)))).toBe("2011-06-24");
  });

  it("zero-pads month and day", () => {
    expect(toDate(new Date(Date.UTC(2003, 0, 5)))).toBe("2003-01-05");
  });

  it("is independent of the process timezone", () => {
    // mdb-reader builds dates from an absolute epoch value, so the UTC parts
    // are the stored ones. Reading local parts would shift the day west of
    // Greenwich.
    const original = process.env.TZ;
    try {
      process.env.TZ = "Pacific/Auckland";
      expect(toDate(new Date(Date.UTC(2011, 5, 24)))).toBe("2011-06-24");
      process.env.TZ = "America/Los_Angeles";
      expect(toDate(new Date(Date.UTC(2011, 5, 24)))).toBe("2011-06-24");
    } finally {
      process.env.TZ = original;
    }
  });

  it("rejects Money's year-10000 no-date sentinel", () => {
    // What the sample files actually contain for "no date": ACCT.dtOpen reads
    // +010000-02-28 in every money2002 account row.
    expect(toDate(new Date(Date.UTC(10000, 1, 28)))).toBeNull();
  });

  it("rejects the Jet zero date", () => {
    expect(toDate(new Date(Date.UTC(1899, 11, 30)))).toBeNull();
  });

  it.each([
    [MNY_MIN_YEAR, "1900-01-01"],
    [MNY_MAX_YEAR, "2199-01-01"],
  ])("accepts the boundary year %p", (year, expected) => {
    expect(toDate(new Date(Date.UTC(year, 0, 1)))).toBe(expected);
  });

  it.each([[null], ["2011-06-24"], [new Date(Number.NaN)]])(
    "returns null for %p",
    (value) => {
      expect(toDate(value as never)).toBeNull();
    },
  );
});
