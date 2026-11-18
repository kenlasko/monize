import { MNY_WARNING_CODES } from "../../mny/model/mny-warnings";
import { KMY_WARNING_CODES } from "./kmy-warnings";

describe("KMY_WARNING_CODES", () => {
  it("lists 65 codes, each a known warning code, without repeats", () => {
    expect(KMY_WARNING_CODES).toHaveLength(65);
    expect(new Set(KMY_WARNING_CODES).size).toBe(KMY_WARNING_CODES.length);
    for (const code of KMY_WARNING_CODES) {
      expect(MNY_WARNING_CODES).toContain(code);
    }
  });

  it("starts with the shared codes and appends the 52 KMyMoney codes in order", () => {
    expect(KMY_WARNING_CODES[0]).toBe("unknownAccountType");
    expect(KMY_WARNING_CODES[12]).toBe("crossCurrencyTradeUnconverted");
    expect(KMY_WARNING_CODES.slice(13)).toEqual(
      MNY_WARNING_CODES.slice(
        MNY_WARNING_CODES.indexOf("unsupportedCurrencyCode"),
      ),
    );
  });
});
