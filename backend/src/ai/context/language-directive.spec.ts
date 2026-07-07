import { aiLanguageName, aiLanguageInstruction } from "./language-directive";

describe("language-directive", () => {
  describe("aiLanguageName", () => {
    it("maps a supported non-English locale to its English name", () => {
      expect(aiLanguageName("fr")).toBe("French");
      expect(aiLanguageName("de")).toBe("German");
      expect(aiLanguageName("pt-BR")).toBe("Brazilian Portuguese");
      expect(aiLanguageName("zh-CN")).toBe("Simplified Chinese");
    });

    it("returns null for English and its regional variants", () => {
      expect(aiLanguageName("en")).toBeNull();
      expect(aiLanguageName("en-US")).toBeNull();
      expect(aiLanguageName("en-CA")).toBeNull();
      expect(aiLanguageName("en-GB")).toBeNull();
    });

    it("returns null for the pseudo-locale, unknown codes, and empty input", () => {
      expect(aiLanguageName("xx")).toBeNull();
      expect(aiLanguageName("zz")).toBeNull();
      expect(aiLanguageName(undefined)).toBeNull();
      expect(aiLanguageName(null)).toBeNull();
      expect(aiLanguageName("")).toBeNull();
    });
  });

  describe("aiLanguageInstruction", () => {
    it("returns an empty string when no directive is needed", () => {
      expect(aiLanguageInstruction("en")).toBe("");
      expect(aiLanguageInstruction("en-GB")).toBe("");
      expect(aiLanguageInstruction("xx")).toBe("");
      expect(aiLanguageInstruction(undefined)).toBe("");
    });

    it("names the target language and preserves structure for non-English", () => {
      const directive = aiLanguageInstruction("ja");
      expect(directive).toContain("Japanese");
      expect(directive).toContain("Do NOT translate");
      expect(directive).toMatch(/^\n\nLANGUAGE:/);
    });
  });
});
