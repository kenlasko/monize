import {
  levenshtein,
  suggestClosestNames,
  formatDidYouMean,
  didYouMean,
} from "./name-suggestions.util";

describe("name-suggestions.util", () => {
  describe("levenshtein", () => {
    it("is zero for identical strings", () => {
      expect(levenshtein("groceries", "groceries")).toBe(0);
    });

    it("equals the other length when one string is empty", () => {
      expect(levenshtein("", "abc")).toBe(3);
      expect(levenshtein("abc", "")).toBe(3);
    });

    it("counts single edits", () => {
      expect(levenshtein("kitten", "sitten")).toBe(1); // substitution
      expect(levenshtein("kitten", "kittens")).toBe(1); // insertion
      expect(levenshtein("kittens", "kitten")).toBe(1); // deletion
    });
  });

  describe("suggestClosestNames", () => {
    const accounts = [
      "Chequing",
      "Savings Account",
      "High-Interest Savings",
      "Visa Credit Card",
    ];

    it("ranks substring matches first", () => {
      const result = suggestClosestNames("savings", accounts);
      expect(result[0]).toBe("Savings Account");
      expect(result).toContain("High-Interest Savings");
    });

    it("matches a close typo via edit distance", () => {
      expect(suggestClosestNames("Chequeing", accounts)).toEqual(["Chequing"]);
    });

    it("returns nothing for an unrelated name", () => {
      expect(suggestClosestNames("Mortgage", accounts)).toEqual([]);
    });

    it("is case-insensitive but preserves original casing", () => {
      expect(suggestClosestNames("CHEQUING", accounts)).toEqual(["Chequing"]);
    });

    it("respects the limit", () => {
      const many = ["Food", "Foods", "Fooo", "Foop"];
      expect(suggestClosestNames("Food", many, 2)).toHaveLength(2);
    });

    it("returns an empty array for empty input or candidates", () => {
      expect(suggestClosestNames("", accounts)).toEqual([]);
      expect(suggestClosestNames("savings", [])).toEqual([]);
    });
  });

  describe("formatDidYouMean", () => {
    it("returns an empty string for no suggestions", () => {
      expect(formatDidYouMean([])).toBe("");
    });

    it("formats a single suggestion", () => {
      expect(formatDidYouMean(["Chequing"])).toBe(" Did you mean 'Chequing'?");
    });

    it("joins multiple suggestions with commas and 'or'", () => {
      expect(formatDidYouMean(["A", "B", "C"])).toBe(
        " Did you mean 'A', 'B' or 'C'?",
      );
    });
  });

  describe("didYouMean", () => {
    it("combines lookup and formatting", () => {
      expect(didYouMean("savings", ["Savings Account", "Chequing"])).toBe(
        " Did you mean 'Savings Account'?",
      );
    });

    it("is empty when nothing is close", () => {
      expect(didYouMean("xyz", ["Savings Account", "Chequing"])).toBe("");
    });
  });
});
