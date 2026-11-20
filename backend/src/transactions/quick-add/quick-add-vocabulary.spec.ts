import { SUPPORTED_LOCALE_CODES } from "../../i18n/config";
import {
  QUICK_ADD_VOCABULARY,
  QUICK_ADD_VOCABULARY_LANGUAGES,
  QUICK_ADD_VOCABULARY_ROLES,
  QuickAddVocabularyLanguage,
  quickAddVocabularyLanguage,
  resolveQuickAddVocabulary,
} from "./quick-add-vocabulary";
import { foldForComparison } from "./quick-add-text.util";

/** What each supported locale must read; `xx` is the English pseudo-locale. */
const EXPECTED: Record<string, QuickAddVocabularyLanguage> = {
  de: "de",
  en: "en",
  "en-US": "en",
  "en-CA": "en",
  "en-GB": "en",
  es: "es",
  fr: "fr",
  hi: "hi",
  id: "id",
  it: "it",
  ja: "ja",
  ko: "ko",
  nl: "nl",
  pl: "pl",
  pt: "pt",
  "pt-BR": "pt",
  ru: "ru",
  tr: "tr",
  uk: "uk",
  vi: "vi",
  "zh-CN": "zh-CN",
  "zh-TW": "zh-TW",
  xx: "en",
};

describe("Quick Add vocabulary", () => {
  it("resolves every supported locale to its own language", () => {
    for (const code of SUPPORTED_LOCALE_CODES) {
      expect([code, quickAddVocabularyLanguage(code)]).toEqual([
        code,
        EXPECTED[code],
      ]);
    }
    // A new locale fails here until it has an entry (or a reason above).
    expect(Object.keys(EXPECTED).sort()).toEqual(
      [...SUPPORTED_LOCALE_CODES].sort(),
    );
  });

  it("has an entry for every base language a supported locale reads", () => {
    const needed = new Set(
      SUPPORTED_LOCALE_CODES.map((code) => quickAddVocabularyLanguage(code)),
    );
    for (const language of needed) {
      expect(QUICK_ADD_VOCABULARY[language]).toBeDefined();
    }
    expect([...QUICK_ADD_VOCABULARY_LANGUAGES].sort()).toEqual(
      Object.keys(QUICK_ADD_VOCABULARY).sort(),
    );
  });

  it("reads a regional code as its base, and Chinese by script", () => {
    expect(quickAddVocabularyLanguage("de-AT")).toBe("de");
    expect(quickAddVocabularyLanguage("fr-CA")).toBe("fr");
    expect(quickAddVocabularyLanguage("zh")).toBe("zh-CN");
    expect(quickAddVocabularyLanguage("zh-SG")).toBe("zh-CN");
    expect(quickAddVocabularyLanguage("zh-HK")).toBe("zh-TW");
    expect(quickAddVocabularyLanguage("zh-Hant-TW")).toBe("zh-TW");
    expect(quickAddVocabularyLanguage(undefined)).toBe("en");
    expect(quickAddVocabularyLanguage("sw")).toBe("en");
  });

  it.each(QUICK_ADD_VOCABULARY_LANGUAGES)("%s fills every role", (language) => {
    for (const role of QUICK_ADD_VOCABULARY_ROLES) {
      const words = QUICK_ADD_VOCABULARY[language].words[role];
      expect([role, words.length > 0]).toEqual([role, true]);
      for (const word of words) {
        expect(word.trim()).toBe(word);
        expect(word).not.toBe("");
        expect(word).toBe(word.toLowerCase());
      }
    }
  });

  it.each(QUICK_ADD_VOCABULARY_LANGUAGES)(
    "%s lists no word in two roles, compared as the reader compares",
    (language) => {
      const roleOf = new Map<string, string>();
      const clashes: string[] = [];
      for (const role of QUICK_ADD_VOCABULARY_ROLES) {
        for (const word of QUICK_ADD_VOCABULARY[language].words[role]) {
          const folded = foldForComparison(word, language);
          const seen = roleOf.get(folded);
          if (seen && seen !== role) {
            clashes.push(`${word}: ${seen} and ${role}`);
          }
          roleOf.set(folded, role);
        }
      }
      expect(clashes).toEqual([]);
    },
  );

  it("puts the reader's words before English's, so theirs decide a shared word", () => {
    const words = resolveQuickAddVocabulary("es");
    const firstA = words.find((w) => w.word === "a");
    expect(firstA?.role).toBe("to");
    expect(words.filter((w) => w.word === "a").map((w) => w.role)).toEqual([
      "to",
      "filler",
    ]);
    expect(
      resolveQuickAddVocabulary("en").every((w) => w.position === "before"),
    ).toBe(true);
  });

  it("carries each language's connector position", () => {
    const ja = resolveQuickAddVocabulary("ja");
    expect(ja.find((w) => w.word === "から")?.position).toBe("after");
    expect(ja.find((w) => w.word === "from")?.position).toBe("before");
  });
});
