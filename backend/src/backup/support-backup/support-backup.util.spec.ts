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
  it("multiplies and rounds to 4 dp via integer arithmetic", () => {
    expect(scaleMoney(100, 2.5)).toBe(250);
    expect(scaleMoney("388.14", 2.5)).toBe(970.35);
    expect(scaleMoney(0.01, 3.333)).toBe(0.0333);
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
