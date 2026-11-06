import { FIAT_MONEY_DECIMALS } from "../../common/round.util";
import { maskText, scaleMoney, scaleQuantity } from "./support-backup.util";

describe("maskText", () => {
  it("keeps the first and last two characters, stars the middle", () => {
    expect(maskText("Biedronka")).toBe("Bi*****ka");
    expect(maskText("Netflix")).toBe("Ne***ix");
  });

  it("fully masks strings of four characters or fewer", () => {
    expect(maskText("abcd")).toBe("****");
    expect(maskText("ab")).toBe("**");
    expect(maskText("x")).toBe("*");
  });

  it("counts unicode code points, not UTF-16 units", () => {
    // Zażółć -> Z,a,ż,ó,ł,ć: head "Za" + 2 stars + tail "łć"
    expect(maskText("Zażółć")).toBe("Za**łć");
    expect([...(maskText("Zażółć") as string)]).toHaveLength(6);
  });

  it("passes through empty strings and non-strings", () => {
    expect(maskText("")).toBe("");
    expect(maskText(null)).toBeNull();
    expect(maskText(42)).toBe(42);
  });
});

describe("scaleMoney", () => {
  it("multiplies and rounds a fiat value at 4 dp by default via integer arithmetic", () => {
    expect(scaleMoney(100, 2.5)).toBe(250);
    expect(scaleMoney("388.14", 2.5)).toBe(970.35);
    expect(scaleMoney(0.01, 3.333)).toBe(0.0333);
    expect(scaleMoney(1, 3.123456789)).toBe(3.1235);
  });

  it("scales a fiat value byte for byte as it always did", () => {
    // 16.913472 would be a six-place value a four-place fiat row refuses.
    expect(scaleMoney(12.3456, 1.37)).toBe(16.9135);
    expect(scaleMoney("12.3456", 1.37, FIAT_MONEY_DECIMALS)).toBe(16.9135);
  });

  it("keeps a coin amount's sub-4-place digits when given the coin's places", () => {
    expect(scaleMoney("0.00002500", 1.5, 8)).toBe(0.0000375);
    expect(scaleMoney(0.00000005, 2, 8)).toBe(0.0000001);
    expect(scaleMoney("0.12345678", 1, 8)).toBe(0.12345678);
    expect(scaleMoney(150000000, 2.5, 8)).toBe(375000000);
    expect(scaleMoney(1, 3.123456789, 8)).toBe(3.12345679);
  });

  it("passes through null/undefined and unparseable input", () => {
    expect(scaleMoney(null, 2)).toBeNull();
    expect(scaleMoney(undefined, 2)).toBeUndefined();
    expect(scaleMoney("n/a", 2)).toBe("n/a");
  });
});

describe("scaleQuantity", () => {
  it("multiplies and rounds to 8 dp", () => {
    expect(scaleQuantity(1.5, 2)).toBe(3);
    expect(scaleQuantity("0.123456789", 2)).toBe(0.24691358);
  });
});
