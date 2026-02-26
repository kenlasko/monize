import { BadRequestException } from "@nestjs/common";
import { ParseSymbolPipe } from "./parse-symbol.pipe";

describe("ParseSymbolPipe", () => {
  let pipe: ParseSymbolPipe;

  beforeEach(() => {
    pipe = new ParseSymbolPipe();
  });

  describe("valid symbols", () => {
    it("accepts simple ticker", () => {
      expect(pipe.transform("AAPL")).toBe("AAPL");
    });

    it("accepts ticker with dot (TSX)", () => {
      expect(pipe.transform("RY.TO")).toBe("RY.TO");
    });

    it("accepts ticker with dash", () => {
      expect(pipe.transform("BRK-B")).toBe("BRK-B");
    });

    it("accepts single character", () => {
      expect(pipe.transform("X")).toBe("X");
    });

    it("accepts 20-character symbol", () => {
      expect(pipe.transform("A".repeat(20))).toBe("A".repeat(20));
    });

    it("accepts numeric symbols", () => {
      expect(pipe.transform("600519")).toBe("600519");
    });

    it("accepts mixed alphanumeric with dots and dashes", () => {
      expect(pipe.transform("TSM34.SA")).toBe("TSM34.SA");
    });
  });

  describe("invalid symbols", () => {
    it("rejects empty string", () => {
      expect(() => pipe.transform("")).toThrow(BadRequestException);
    });

    it("rejects symbol over 20 characters", () => {
      expect(() => pipe.transform("A".repeat(21))).toThrow(BadRequestException);
    });

    it("rejects non-string value", () => {
      expect(() => pipe.transform(123 as any)).toThrow(BadRequestException);
    });

    it("rejects symbol with spaces", () => {
      expect(() => pipe.transform("AA PL")).toThrow(BadRequestException);
    });

    it("rejects symbol with special characters", () => {
      expect(() => pipe.transform("AAPL!")).toThrow(BadRequestException);
    });

    it("rejects symbol with SQL injection attempt", () => {
      expect(() => pipe.transform("'; DROP TABLE--")).toThrow(
        BadRequestException,
      );
    });

    it("rejects symbol with path traversal", () => {
      expect(() => pipe.transform("../etc/passwd")).toThrow(
        BadRequestException,
      );
    });
  });
});
