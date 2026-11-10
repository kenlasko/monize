import { isBlankCsvAmount, parseCsvAmount } from "./csv-amount.util";

describe("parseCsvAmount", () => {
  it.each([
    ["12.34", 12.34],
    ["-12.34", -12.34],
    ["+12.34", 12.34],
    // a trailing sign
    ["12.34-", -12.34],
    ["12.34+", 12.34],
    ["1,234.56-", -1234.56],
    // the Unicode minus forms
    ["−12.34", -12.34],
    ["12.34−", -12.34],
    ["–12.34", -12.34],
    ["－12.34", -12.34],
    // parentheses
    ["(12.34)", -12.34],
    ["($12.34)", -12.34],
    ["$(12.34)", -12.34],
    // DR / CR markers
    ["DR 12.34", -12.34],
    ["12.34 DR", -12.34],
    ["12.34dr", -12.34],
    ["CR 12.34", 12.34],
    ["12.34 CR", 12.34],
    ["12.34 DR.", -12.34],
    ["Dr. 12.34", -12.34],
    ["12.34 Cr.", 12.34],
    // currency symbols and codes on either side
    ["$12.34", 12.34],
    ["-$50.00", -50],
    ["$-50.00", -50],
    ["CHF 12.34", 12.34],
    ["CHF -12.34", -12.34],
    ["-12.34 CHF", -12.34],
    ["12.34 kr", 12.34],
    ["12,34 €", 12.34],
    ["R$ 1.234,56", 1234.56],
    ["US$12.34", 12.34],
    ["$12.34 USD", 12.34],
    // an abbreviation's period belongs to the currency, not the number
    ["Fr. 12.34", 12.34],
    ["Rs. 12.50", 12.5],
    ["Rs.12.50", 12.5],
    ["Rs. 1,234.56", 1234.56],
    ["12,34 kr.", 12.34],
    ["SFr. 1'234.50", 1234.5],
    ["12.34 Kr", 12.34],
    ["12.34 USD DR", -12.34],
    // grouping
    ["1,234.56", 1234.56],
    ["1.234,56", 1234.56],
    ["1 234,56", 1234.56],
    ["1 234,56", 1234.56],
    ["1'234.56", 1234.56],
    ["18,36", 18.36],
    [".5", 0.5],
    ["  42  ", 42],
  ])("reads %j as %d", (value, expected) => {
    expect(parseCsvAmount(value)).toBe(expected);
  });

  it("reads a negative zero as 0", () => {
    expect(Object.is(parseCsvAmount("-0.00"), 0)).toBe(true);
    expect(Object.is(parseCsvAmount("0.00 DR"), 0)).toBe(true);
  });

  it.each([
    // text the parser does not know is never read as its first digits
    "12.34 abcd",
    "abcd 12.34",
    "12.34 pending",
    // a short word is a currency only as a symbol, a code or a known one
    "Tax 5",
    "abc 12",
    "12 ea",
    // a stray separator next to another one is never grouping
    ".12.50",
    "12.50.",
    "$.12.50",
    "N/A",
    "NaN",
    "Infinity",
    "1e5",
    "12.34.56,78,9",
    "1-2",
    // contradicting signs
    "--12.34",
    "-12.34-",
    "(-12.34)",
    "-12.34 CR",
    "DR -12.34",
    "DR 12.34 CR",
    // two currencies on one side
    "$ CHF X 12.34",
    "$",
    "CHF",
  ])("refuses %j", (value) => {
    expect(parseCsvAmount(value)).toBeNull();
  });

  it.each(["", "   ", "-", "--", "—", "−"])("treats %j as blank", (value) => {
    expect(isBlankCsvAmount(value)).toBe(true);
    expect(parseCsvAmount(value)).toBeNull();
  });

  it("does not treat a value as blank", () => {
    expect(isBlankCsvAmount("0")).toBe(false);
    expect(isBlankCsvAmount("x")).toBe(false);
  });
});
