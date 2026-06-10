import { buildDefaultPreferences } from "./user-preference.factory";
import { DEFAULT_LOCALE } from "../i18n/config";

describe("buildDefaultPreferences", () => {
  it("sets the userId and the provided language", () => {
    const prefs = buildDefaultPreferences("user-1", "pl");
    expect(prefs.userId).toBe("user-1");
    expect(prefs.language).toBe("pl");
  });

  it("defaults language to DEFAULT_LOCALE when omitted", () => {
    const prefs = buildDefaultPreferences("user-1");
    expect(prefs.language).toBe(DEFAULT_LOCALE);
  });

  it("uses browser/system sentinels for locale-dependent display settings", () => {
    const prefs = buildDefaultPreferences("user-1", "en");
    expect(prefs.dateFormat).toBe("browser");
    expect(prefs.numberFormat).toBe("browser");
    expect(prefs.timezone).toBe("browser");
    expect(prefs.theme).toBe("system");
  });

  it("applies the standard non-locale defaults", () => {
    const prefs = buildDefaultPreferences("user-1");
    expect(prefs.defaultCurrency).toBe("USD");
    expect(prefs.notificationEmail).toBe(true);
    expect(prefs.notificationBrowser).toBe(true);
    expect(prefs.twoFactorEnabled).toBe(false);
    expect(prefs.gettingStartedDismissed).toBe(false);
    expect(prefs.favouriteReportIds).toEqual([]);
  });
});
