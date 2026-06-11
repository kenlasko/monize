import {
  normalizePayeeName,
  significantTokens,
  leadingSignificantToken,
  similarity,
} from "./payee-normalize.util";

describe("payee-normalize.util", () => {
  describe("normalizePayeeName", () => {
    it("collapses the Lidl variants to a common form", () => {
      expect(normalizePayeeName("Lidl")).toBe("LIDL");
      expect(normalizePayeeName("LIDL sp. z o.o.")).toBe("LIDL");
      expect(normalizePayeeName("LIDL WARSZAWA 0421")).toBe("LIDL WARSZAWA");
    });

    it("strips diacritics", () => {
      expect(normalizePayeeName("Café Münchën")).toBe("CAFE MUNCHEN");
    });

    it("transliterates stroke/ligature letters that NFD does not decompose", () => {
      // The L-stroke must become a plain L, not a word break -- otherwise
      // "MALGORZATA" would split into "MA" + "GORZATA" and cluster on "GORZATA".
      expect(normalizePayeeName("MAŁGORZATA")).toBe("MALGORZATA");
      expect(normalizePayeeName("Małgorzata")).toBe("MALGORZATA");
      expect(normalizePayeeName("Łódź")).toBe("LODZ");
      expect(normalizePayeeName("Smørrebrød")).toBe("SMORREBROD");
      expect(normalizePayeeName("Æro")).toBe("AERO");
      expect(normalizePayeeName("Œuvre")).toBe("OEUVRE");
    });

    it("keeps a stroke-letter name as a single significant token", () => {
      // Regression: the leading significant token of "MAŁGORZATA SKLEP" must be
      // the full name, not the fragment after the stroke.
      expect(
        leadingSignificantToken(normalizePayeeName("MAŁGORZATA SKLEP"), 3),
      ).toBe("MALGORZATA");
    });

    it("drops store numbers and punctuation", () => {
      expect(normalizePayeeName("STARBUCKS #1234")).toBe("STARBUCKS");
      expect(normalizePayeeName("Tesco-Express, 99")).toBe("TESCO EXPRESS");
    });

    it("removes legal/business suffixes", () => {
      expect(normalizePayeeName("Acme GmbH")).toBe("ACME");
      expect(normalizePayeeName("Foo Bar Inc")).toBe("FOO BAR");
    });

    it("returns empty string for empty or noise-only input", () => {
      expect(normalizePayeeName("")).toBe("");
      expect(normalizePayeeName("   ")).toBe("");
      expect(normalizePayeeName("12345")).toBe("");
    });
  });

  describe("significantTokens", () => {
    it("filters short and noise tokens", () => {
      expect(significantTokens("LIDL WARSZAWA", 3)).toEqual([
        "LIDL",
        "WARSZAWA",
      ]);
      expect(significantTokens("POS LIDL", 3)).toEqual(["LIDL"]);
      expect(significantTokens("AB LIDL", 3)).toEqual(["LIDL"]);
    });

    it("respects the minimum token length", () => {
      expect(significantTokens("BP FUEL", 3)).toEqual(["FUEL"]);
      expect(significantTokens("BP FUEL", 2)).toEqual(["BP", "FUEL"]);
    });

    it("returns empty array for empty input", () => {
      expect(significantTokens("", 3)).toEqual([]);
    });
  });

  describe("leadingSignificantToken", () => {
    it("returns the first significant token", () => {
      expect(leadingSignificantToken("LIDL WARSZAWA", 3)).toBe("LIDL");
    });

    it("returns null when no token qualifies", () => {
      expect(leadingSignificantToken("", 3)).toBeNull();
      expect(leadingSignificantToken("AB", 3)).toBeNull();
    });
  });

  describe("similarity", () => {
    it("returns 1 for identical strings", () => {
      expect(similarity("LIDL", "LIDL")).toBe(1);
    });

    it("returns 0 when either string is empty", () => {
      expect(similarity("", "LIDL")).toBe(0);
      expect(similarity("LIDL", "")).toBe(0);
    });

    it("scores close typo variants high", () => {
      expect(similarity("LIDL", "LIDI")).toBeGreaterThanOrEqual(0.75);
    });

    it("scores unrelated strings low", () => {
      expect(similarity("LIDL", "TESCO")).toBeLessThan(0.5);
    });

    it("guards against pathologically long inputs", () => {
      expect(similarity("a".repeat(300), "b".repeat(300))).toBe(0);
    });
  });
});
