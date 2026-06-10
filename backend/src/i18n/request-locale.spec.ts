import { I18nContext } from "nestjs-i18n";
import { currentRequestLocale } from "./request-locale";
import { DEFAULT_LOCALE } from "./config";

describe("currentRequestLocale", () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("returns DEFAULT_LOCALE outside a request context", () => {
    jest.spyOn(I18nContext, "current").mockReturnValue(undefined as never);
    expect(currentRequestLocale()).toBe(DEFAULT_LOCALE);
  });

  it("returns the resolved locale when it is a supported language", () => {
    jest.spyOn(I18nContext, "current").mockReturnValue({ lang: "pl" } as never);
    expect(currentRequestLocale()).toBe("pl");
  });

  it("preserves a supported region-tagged locale", () => {
    jest
      .spyOn(I18nContext, "current")
      .mockReturnValue({ lang: "pt-BR" } as never);
    expect(currentRequestLocale()).toBe("pt-BR");
  });

  it("never persists the xx pseudo-locale", () => {
    jest.spyOn(I18nContext, "current").mockReturnValue({ lang: "xx" } as never);
    expect(currentRequestLocale()).toBe(DEFAULT_LOCALE);
  });

  it("falls back to DEFAULT_LOCALE for an unsupported locale", () => {
    jest.spyOn(I18nContext, "current").mockReturnValue({ lang: "zz" } as never);
    expect(currentRequestLocale()).toBe(DEFAULT_LOCALE);
  });
});
