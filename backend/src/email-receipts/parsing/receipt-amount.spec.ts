import {
  isPlainReceiptAmount,
  parseReceiptAmount,
  parseReceiptQty,
} from "./receipt-amount";

const NBSP = "\xa0";
const MINUS_SIGN = String.fromCharCode(0x2212);
const EN_DASH = String.fromCharCode(0x2013);
const NARROW_NBSP = String.fromCharCode(0x202f);

describe("parseReceiptAmount: the spec section 2 table", () => {
  it.each([
    ["12.99", 129900],
    ["$1,234.56", 12345600],
    ["1 234,56 zł", 12345600],
    ["1.234,56 €", 12345600],
    ["1,234", 12340000],
    ["1234", 12340000],
    ["12,5", 125000],
    ["0.00", 0],
    ["-5.00", null],
    ["1,23,4", null],
    ["abc", null],
  ])("reads %j as %p", (text, expected) => {
    expect(parseReceiptAmount(text)).toBe(expected);
  });
});

describe("parseReceiptAmount: currency and grouping", () => {
  it.each([
    ["PLN 12.99", 129900],
    ["12.99 EUR", 129900],
    ["USD 5", 50000],
    ["£7.50", 75000],
    ["  $ 3.10  ", 31000],
    ["1'234.56", 12345600],
    [`1${NBSP}234,56`, 12345600],
    [`1${NARROW_NBSP}234,56`, 12345600],
    ["1 234 567,89", 12345678900],
    ["1,234,567", 12345670000],
    ["1.234.567", 12345670000],
    ["12.345", 123450000],
    ["0012.5", 125000],
    [".50", 5000],
    [",5", 5000],
    ["12.5", 125000],
    ["12.05", 120500],
    ["12,05", 120500],
    ["0.01", 100],
  ])("reads %j as %p", (text, expected) => {
    expect(parseReceiptAmount(text)).toBe(expected);
  });

  it("returns an integer with no float residue for every two-decimal value", () => {
    for (let cents = 0; cents < 2000; cents++) {
      const text = `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, "0")}`;
      expect(parseReceiptAmount(text)).toBe(cents * 100);
    }
  });
});

describe("parseReceiptAmount: refusals", () => {
  it.each([
    ["a leading minus", "-5.00"],
    ["a minus after a currency symbol", "$-5.00"],
    ["a minus after a space", "  -5"],
    ["parentheses", "(5.00)"],
    ["parentheses around a symbol", "($5.00)"],
    ["a unicode minus", `${MINUS_SIGN}5.00`],
    ["a unicode minus after a symbol", `$${MINUS_SIGN}5.00`],
    ["an en dash", `${EN_DASH}5.00`],
    ["a minus inside the number", "5-00"],
    ["a trailing minus", "5.00-"],
    ["an empty string", ""],
    ["only spaces", "   "],
    ["only a separator", "."],
    ["only separators", ",."],
    ["a trailing separator", "12."],
    ["a leading thousand group", ",234"],
    ["a thousand group of four digits", "1,2345"],
    ["a thousand group of two digits", "1,23,456"],
    ["two decimal separators", "1.5.5"],
    ["three decimals then more", "1.234.5678"],
    ["no digits, only a symbol", "$"],
    ["13 integer digits", "1234567890123"],
    ["a value above the safe integer range", "999999999999"],
  ])("refuses %s (%j)", (_label, text) => {
    expect(parseReceiptAmount(text)).toBeNull();
  });

  it("accepts 12 integer digits while the result stays a safe integer", () => {
    expect(parseReceiptAmount("100000000000")).toBe(1000000000000000);
    expect(parseReceiptAmount("900719925474")).toBe(9007199254740000);
  });

  it("refuses a non-string without throwing", () => {
    expect(parseReceiptAmount(undefined as unknown as string)).toBeNull();
    expect(parseReceiptAmount(5 as unknown as string)).toBeNull();
    expect(parseReceiptAmount(null as unknown as string)).toBeNull();
  });
});

describe("parseReceiptQty", () => {
  it.each([
    ["1", 1],
    ["2", 2],
    [" 3 ", 3],
    ["2x", 2],
    ["2 x", 2],
    ["2X", 2],
    ["2pcs", 2],
    ["2 pcs", 2],
    ["2 PCS", 2],
    ["9999", 9999],
    ["0005", 5],
  ])("reads %j as %p", (text, expected) => {
    expect(parseReceiptQty(text)).toBe(expected);
  });

  it.each([
    ["0"],
    ["00"],
    ["10000"],
    ["-1"],
    ["1.5"],
    ["1,5"],
    ["abc"],
    ["x"],
    ["x2"],
    ["2 items"],
    ["two"],
    [""],
    ["   "],
  ])("refuses %j", (text) => {
    expect(parseReceiptQty(text)).toBeNull();
  });

  it("refuses a non-string without throwing", () => {
    expect(parseReceiptQty(undefined as unknown as string)).toBeNull();
    expect(parseReceiptQty(3 as unknown as string)).toBeNull();
  });
});

describe("isPlainReceiptAmount", () => {
  it.each([
    ["12.99"],
    ["$1,234.56"],
    ["1 234,56 zł"],
    ["1.234,56 €"],
    ["PLN 12.99"],
    ["12.99 eur"],
    ["kr 5"],
    ["5 Kč"],
    ["USD5"],
  ])("accepts %j", (text) => {
    expect(isPlainReceiptAmount(text)).toBe(true);
  });

  it.each([
    ["cable 19.98"],
    ["USB-C cable 19.98"],
    ["case 1 234,56"],
    ["USB 5.00"],
    ["12.99 each"],
    ["-5.00"],
    ["abc"],
    [""],
  ])("refuses %j", (text) => {
    expect(isPlainReceiptAmount(text)).toBe(false);
  });
});
