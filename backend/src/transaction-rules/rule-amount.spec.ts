import { parseRuleAmount } from "./rule-amount";

describe("parseRuleAmount", () => {
  it.each([
    ["1200,50", 1200.5],
    ["1200.50", 1200.5],
    ["450", 450],
    ["0,00", 0],
    ["85,40", 85.4],
    ["1,2345", 1.2345],
    ["0,5", 0.5],
    ["1 234,56", 1234.56],
    ["1 234,56", 1234.56],
    ["1 234,56", 1234.56],
    ["1 234,56", 1234.56],
    ["1.234,56", 1234.56],
    ["12.345.678,9", 12345678.9],
    // A coin's eight places survive whole.
    ["0,00002500", 0.000025],
    ["0.00002500", 0.000025],
    ["1,23456789", 1.23456789],
  ])("reads %j as the decimal %d", (text, magnitude) => {
    expect(parseRuleAmount(text)).toBe(magnitude);
  });

  it.each([
    [""],
    ["   "],
    ["-12,00"],
    ["+1,00"],
    ["12,"],
    [",5"],
    ["1,234567891"],
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

  it("refuses a magnitude beyond what a rule may name", () => {
    expect(parseRuleAmount("99999999999999999999")).toBeNull();
  });
});
