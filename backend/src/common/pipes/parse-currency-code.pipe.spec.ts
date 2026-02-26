import { BadRequestException } from "@nestjs/common";
import { ParseCurrencyCodePipe } from "./parse-currency-code.pipe";

describe("ParseCurrencyCodePipe", () => {
  let pipe: ParseCurrencyCodePipe;

  beforeEach(() => {
    pipe = new ParseCurrencyCodePipe();
  });

  describe("valid currency codes", () => {
    it("accepts uppercase 3-letter code", () => {
      expect(pipe.transform("USD")).toBe("USD");
    });

    it("uppercases lowercase input", () => {
      expect(pipe.transform("cad")).toBe("CAD");
    });

    it("uppercases mixed case input", () => {
      expect(pipe.transform("Eur")).toBe("EUR");
    });

    it("accepts various valid codes", () => {
      expect(pipe.transform("JPY")).toBe("JPY");
      expect(pipe.transform("GBP")).toBe("GBP");
      expect(pipe.transform("CHF")).toBe("CHF");
    });
  });

  describe("invalid currency codes", () => {
    it("rejects empty string", () => {
      expect(() => pipe.transform("")).toThrow(BadRequestException);
    });

    it("rejects 2-letter code", () => {
      expect(() => pipe.transform("US")).toThrow(BadRequestException);
    });

    it("rejects 4-letter code", () => {
      expect(() => pipe.transform("USDC")).toThrow(BadRequestException);
    });

    it("rejects numeric code", () => {
      expect(() => pipe.transform("123")).toThrow(BadRequestException);
    });

    it("rejects mixed alphanumeric", () => {
      expect(() => pipe.transform("U2D")).toThrow(BadRequestException);
    });

    it("rejects non-string value", () => {
      expect(() => pipe.transform(42 as any)).toThrow(BadRequestException);
    });

    it("rejects code with special characters", () => {
      expect(() => pipe.transform("US$")).toThrow(BadRequestException);
    });

    it("rejects code with spaces", () => {
      expect(() => pipe.transform("U S")).toThrow(BadRequestException);
    });
  });
});
