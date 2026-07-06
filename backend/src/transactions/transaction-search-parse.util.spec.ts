import { parseSearchTerm } from "./transaction-search-parse.util";

describe("parseSearchTerm", () => {
  describe("amount parsing (en-US: '.' decimal, ',' thousands)", () => {
    const prefs = { numberFormat: "en-US", dateFormat: "YYYY-MM-DD" };

    it("parses a plain decimal", () => {
      expect(parseSearchTerm("1234.56", prefs).amount).toBe(1234.56);
    });

    it("parses a grouped decimal", () => {
      expect(parseSearchTerm("1,234.56", prefs).amount).toBe(1234.56);
    });

    it("parses a bare integer", () => {
      expect(parseSearchTerm("1234", prefs).amount).toBe(1234);
    });

    it("rounds storage-precision trailing zeros", () => {
      expect(parseSearchTerm("1234.5600", prefs).amount).toBe(1234.56);
    });

    it("parses a negative amount", () => {
      expect(parseSearchTerm("-50", prefs).amount).toBe(-50);
    });

    it("parses a leading-plus amount", () => {
      expect(parseSearchTerm("+50", prefs).amount).toBe(50);
    });

    it("falls back to comma-decimal when the value is not valid en-US", () => {
      // "1234,56" is not valid comma-thousands (group of 2), so the lenient
      // fallback reads the comma as a decimal separator.
      expect(parseSearchTerm("1234,56", prefs).amount).toBe(1234.56);
    });

    it("handles space-thousands with comma decimal via fallback", () => {
      expect(parseSearchTerm("1 234,56", prefs).amount).toBe(1234.56);
    });

    it("resolves the '12,3' ambiguity to the decimal reading (12.3)", () => {
      // "12,3" is an invalid thousands group, so it reads as 12.3 -- and
      // exact equality means it must NOT be treated the same as 112.30.
      expect(parseSearchTerm("12,3", prefs).amount).toBe(12.3);
      expect(parseSearchTerm("12,3", prefs).amount).not.toBe(112.3);
    });

    it("returns null for non-numeric text", () => {
      expect(parseSearchTerm("groceries", prefs).amount).toBeNull();
    });

    it("returns null for a value with trailing junk", () => {
      expect(parseSearchTerm("12.5x", prefs).amount).toBeNull();
    });

    it("returns null for a double decimal separator", () => {
      expect(parseSearchTerm("1.2.3", prefs).amount).toBeNull();
    });
  });

  describe("amount parsing (de-DE: ',' decimal, '.' thousands)", () => {
    const prefs = { numberFormat: "de-DE", dateFormat: "DD.MM.YYYY" };

    it("parses a grouped decimal", () => {
      expect(parseSearchTerm("1.234,56", prefs).amount).toBe(1234.56);
    });

    it("parses a plain comma decimal", () => {
      expect(parseSearchTerm("1234,56", prefs).amount).toBe(1234.56);
    });

    it("parses space-thousands with comma decimal", () => {
      expect(parseSearchTerm("1 234,56", prefs).amount).toBe(1234.56);
    });

    it("falls back to dot-decimal for a value typed the en-US way", () => {
      expect(parseSearchTerm("1234.56", prefs).amount).toBe(1234.56);
    });

    it("parses a short decimal", () => {
      expect(parseSearchTerm("12,3", prefs).amount).toBe(12.3);
    });
  });

  describe("date parsing", () => {
    it("parses ISO YYYY-MM-DD", () => {
      expect(
        parseSearchTerm("2026-07-02", { dateFormat: "YYYY-MM-DD" }).date,
      ).toBe("2026-07-02");
    });

    it("parses single-digit ISO parts", () => {
      expect(
        parseSearchTerm("2026-7-2", { dateFormat: "YYYY-MM-DD" }).date,
      ).toBe("2026-07-02");
    });

    it("parses a display-format DD.MM.YYYY date", () => {
      expect(
        parseSearchTerm("02.07.2026", { dateFormat: "DD.MM.YYYY" }).date,
      ).toBe("2026-07-02");
    });

    it("parses MM/DD/YYYY", () => {
      expect(
        parseSearchTerm("07/02/2026", { dateFormat: "MM/DD/YYYY" }).date,
      ).toBe("2026-07-02");
    });

    it("parses DD/MM/YYYY", () => {
      expect(
        parseSearchTerm("02/07/2026", { dateFormat: "DD/MM/YYYY" }).date,
      ).toBe("2026-07-02");
    });

    it("parses DD-MMM-YYYY with a month abbreviation", () => {
      expect(
        parseSearchTerm("02-Jul-2026", { dateFormat: "DD-MMM-YYYY" }).date,
      ).toBe("2026-07-02");
    });

    it("always accepts ISO as a universal fallback", () => {
      expect(
        parseSearchTerm("2026-07-02", { dateFormat: "DD/MM/YYYY" }).date,
      ).toBe("2026-07-02");
    });

    it("resolves the 'browser' format from the number-format locale", () => {
      expect(
        parseSearchTerm("02.07.2026", {
          dateFormat: "browser",
          numberFormat: "de-DE",
        }).date,
      ).toBe("2026-07-02");
    });

    it("rejects an impossible month", () => {
      expect(
        parseSearchTerm("2026-13-01", { dateFormat: "YYYY-MM-DD" }).date,
      ).toBeNull();
    });

    it("rejects an impossible day", () => {
      expect(
        parseSearchTerm("2026-02-30", { dateFormat: "YYYY-MM-DD" }).date,
      ).toBeNull();
    });

    it("does not parse a month-only term", () => {
      expect(
        parseSearchTerm("07", { dateFormat: "YYYY-MM-DD" }).date,
      ).toBeNull();
    });

    it("does not parse a year-only term as a date", () => {
      const result = parseSearchTerm("2026", { dateFormat: "YYYY-MM-DD" });
      expect(result.date).toBeNull();
      expect(result.amount).toBe(2026);
    });
  });

  describe("combined and edge cases", () => {
    it("returns nulls for an empty term", () => {
      expect(parseSearchTerm("", {})).toEqual({ amount: null, date: null });
    });

    it("returns nulls for a whitespace-only term", () => {
      expect(parseSearchTerm("   ", {})).toEqual({ amount: null, date: null });
    });

    it("returns nulls for a plain word", () => {
      expect(parseSearchTerm("coffee", {})).toEqual({
        amount: null,
        date: null,
      });
    });

    it("defaults to en-US / ISO when preferences are absent", () => {
      const result = parseSearchTerm("1,234.50");
      expect(result.amount).toBe(1234.5);
    });

    it("trims surrounding whitespace before parsing", () => {
      expect(
        parseSearchTerm("  1234.56  ", { numberFormat: "en-US" }).amount,
      ).toBe(1234.56);
    });
  });
});
