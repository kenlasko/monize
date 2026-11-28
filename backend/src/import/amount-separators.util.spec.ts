import { normalizeAmountSeparators } from "./amount-separators.util";

describe("normalizeAmountSeparators", () => {
  it.each([
    // comma and dot: the last one is the decimal separator
    ["1,234.56", "1234.56"],
    ["1.234,56", "1234.56"],
    ["-1.234.567,89", "-1234567.89"],
    ["1,234,567.89", "1234567.89"],
    // a single comma
    ["18,36", "18.36"],
    ["-18,36", "-18.36"],
    ["12,3456", "12.3456"],
    ["1,234", "1234"],
    ["-1,234", "-1234"],
    // a zero or missing integer part cannot be grouped: a decimal comma
    ["0,125", "0.125"],
    ["-0,500", "-0.500"],
    [",125", ".125"],
    // several commas, or several dots, are grouping
    ["1,234,567", "1234567"],
    ["1.234.567", "1234567"],
    // a single dot keeps its US reading
    ["1.234", "1.234"],
    ["18.36", "18.36"],
    ["42", "42"],
    // the lakh pattern
    ["12,34,567", "1234567"],
    ["12,34,567.89", "1234567.89"],
  ])("%s -> %s", (input, expected) => {
    expect(normalizeAmountSeparators(input)).toBe(expected);
  });

  // Malformed grouping is returned as it came, so the plain-number check
  // refuses it instead of reading a number the file did not say.
  it.each([
    "1,2.3",
    "1.2.3",
    "12.03.26",
    "1,234,56.78",
    "12,34,56",
    "1,2,3",
    "1.234.56,7",
  ])("leaves %s unread", (input) => {
    expect(normalizeAmountSeparators(input)).toBe(input);
  });
});
