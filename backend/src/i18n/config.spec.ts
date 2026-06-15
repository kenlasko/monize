import {
  DEFAULT_LOCALE,
  LOCALE_BASES,
  SUPPORTED_LOCALE_CODES,
  isSupportedLocale,
  localeBase,
} from "./config";

describe("i18n config", () => {
  describe("localeBase", () => {
    it("maps each regional English variant to en", () => {
      expect(localeBase("en-US")).toBe("en");
      expect(localeBase("en-CA")).toBe("en");
      expect(localeBase("en-GB")).toBe("en");
    });

    it("returns undefined for full locales and the base locale", () => {
      for (const code of [DEFAULT_LOCALE, "de", "fr", "pt-BR", "xx"]) {
        expect(localeBase(code)).toBeUndefined();
      }
    });

    it("returns undefined for nullish input", () => {
      expect(localeBase(undefined)).toBeUndefined();
      expect(localeBase(null)).toBeUndefined();
    });
  });

  describe("supported locales", () => {
    it("registers the new English variants", () => {
      for (const code of ["en-US", "en-CA", "en-GB"]) {
        expect(SUPPORTED_LOCALE_CODES).toContain(code);
        expect(isSupportedLocale(code)).toBe(true);
      }
    });

    it("every variant and its base are supported locales", () => {
      for (const [variant, base] of Object.entries(LOCALE_BASES)) {
        expect(SUPPORTED_LOCALE_CODES).toContain(variant);
        expect(SUPPORTED_LOCALE_CODES).toContain(base);
      }
    });
  });
});
