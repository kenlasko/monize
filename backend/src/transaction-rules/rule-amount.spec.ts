import { parseRuleAmount } from "./rule-amount";

describe("parseRuleAmount", () => {
  it.each([
    ["1200,50", 12005000],
    ["1200.50", 12005000],
    ["450", 4500000],
    ["0,00", 0],
    ["85,40", 854000],
    ["1,2345", 12345],
    ["0,5", 5000],
    ["1 234,56", 12345600],
    ["1 234,56", 12345600],
    ["1 234,56", 12345600],
    ["1 234,56", 12345600],
    ["1.234,56", 12345600],
    ["12.345.678,9", 123456789000],
  ])("reads %j as %d (1/10000 units)", (text, scaled) => {
    expect(parseRuleAmount(text)).toBe(scaled);
  });

  it.each([
    [""],
    ["   "],
    ["-12,00"],
    ["+1,00"],
    ["12,"],
    [",5"],
    ["1,23456"],
    ["1.234.56"],
    ["12 PLN"],
    ["abc"],
    ["1,234.56"],
    ["1.23,456"],
    ["1234.567.890,5"],
  ])("refuses %j", (text) => {
    expect(parseRuleAmount(text)).toBeNull();
  });

  it("refuses a value that is not a string", () => {
    expect(parseRuleAmount(12 as unknown as string)).toBeNull();
    expect(parseRuleAmount(null as unknown as string)).toBeNull();
    expect(parseRuleAmount(undefined as unknown as string)).toBeNull();
  });

  it("refuses a magnitude that is not a safe integer", () => {
    expect(parseRuleAmount("99999999999999999999")).toBeNull();
  });
});
