import { Test, TestingModule } from "@nestjs/testing";
import { I18nService } from "nestjs-i18n";
import { I18nModule } from "./i18n.module";

/**
 * Boots the real I18nModule and verifies the lean regional-variant model on the
 * backend: a variant catalogue (en-US) carries only the keys that differ, while
 * every other key -- and a variant that ships no catalogue at all (en-GB) --
 * falls back to `en` via `fallbackLanguage`/`fallbacks`.
 */
describe("i18n regional-variant fallback (real catalogue)", () => {
  let i18n: I18nService;
  let moduleRef: TestingModule;

  // A key that en-US overrides ("favourites" -> "favorites").
  const KEY = "errors.accounts.useFavouriteUpdateEndpoint";

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [I18nModule],
    }).compile();
    i18n = moduleRef.get<I18nService>(I18nService);
  });

  afterAll(async () => {
    await moduleRef.close();
  });

  it("serves the base (Canadian) spelling for en", () => {
    expect(i18n.translate(KEY, { lang: "en" })).toBe(
      "Use the account update endpoint to change favourites",
    );
  });

  it("applies the American override for en-US", () => {
    expect(i18n.translate(KEY, { lang: "en-US" })).toBe(
      "Use the account update endpoint to change favorites",
    );
  });

  it("falls back to en for en-GB, which ships no backend catalogue", () => {
    expect(i18n.translate(KEY, { lang: "en-GB" })).toBe(
      i18n.translate(KEY, { lang: "en" }),
    );
  });
});
