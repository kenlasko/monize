import { readdirSync, readFileSync } from "fs";
import { join } from "path";
import { localeBase } from "./config";

/**
 * Structural parity between the English source catalogues and every translated
 * backend locale.
 *
 * Full translations must be complete mirrors of `en`. Regional variants (those
 * listed in `LOCALE_BASES`, e.g. en-US) hold only the keys that differ and let
 * nestjs-i18n fall back to `en` per key, so they are checked as a *subset* of
 * `en`. In both cases a `{{ placeholder }}` that drifts from the source would
 * interpolate nothing, so that is guarded for every locale under `locales/`.
 */

const localesDir = join(__dirname, "locales");

// Translated locales discovered on disk. `xx` is the generated pseudo-locale,
// covered by pseudo-locale.spec.ts and `npm run i18n:check`.
const TRANSLATED_LOCALES = readdirSync(localesDir, { withFileTypes: true })
  .filter((d) => d.isDirectory() && d.name !== "en" && d.name !== "xx")
  .map((d) => d.name);

const enFiles = readdirSync(join(localesDir, "en")).filter((f) =>
  f.endsWith(".json"),
);

type Json = string | number | boolean | null | Json[] | { [k: string]: Json };

function flatten(value: Json, prefix = ""): Record<string, Json> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return Object.entries(value).reduce<Record<string, Json>>(
      (acc, [k, v]) =>
        Object.assign(acc, flatten(v, prefix ? `${prefix}.${k}` : k)),
      {},
    );
  }
  return { [prefix]: value };
}

function load(locale: string, file: string): Record<string, Json> {
  return flatten(
    JSON.parse(readFileSync(join(localesDir, locale, file), "utf8")),
  );
}

function placeholders(value: string): string[] {
  return (value.match(/\{\{.*?\}\}/g) ?? []).sort();
}

function localeFilesOf(locale: string): string[] {
  return readdirSync(join(localesDir, locale)).filter((f) =>
    f.endsWith(".json"),
  );
}

describe.each(TRANSLATED_LOCALES)("backend locale '%s'", (locale) => {
  const base = localeBase(locale);

  if (base) {
    // Regional variant: overrides are a subset of `en`; nestjs-i18n fills every
    // other key (and any omitted catalogue) from the base via fallbackLanguage.
    const localeFiles = localeFilesOf(locale);

    it("only contains catalogue files that exist in en", () => {
      expect(localeFiles.filter((f) => !enFiles.includes(f))).toEqual([]);
    });

    describe.each(localeFiles)("%s", (file) => {
      const en = load("en", file);
      const variant = load(locale, file);

      it("only overrides keys that exist in en", () => {
        const enKeys = new Set(Object.keys(en));
        expect(Object.keys(variant).filter((k) => !enKeys.has(k))).toEqual([]);
      });

      it("changes the value of every key it overrides", () => {
        for (const [key, value] of Object.entries(variant)) {
          if (typeof value !== "string" || typeof en[key] !== "string")
            continue;
          expect(value).not.toEqual(en[key]);
        }
      });

      it("preserves every {{ placeholder }} from en for overridden keys", () => {
        for (const [key, value] of Object.entries(variant)) {
          if (typeof value !== "string" || typeof en[key] !== "string")
            continue;
          expect(placeholders(value)).toEqual(placeholders(en[key] as string));
        }
      });
    });
    return;
  }

  // Full translation: must be a complete mirror of `en`.
  it("has the same catalogue files as en", () => {
    expect(localeFilesOf(locale).sort()).toEqual(enFiles.slice().sort());
  });

  describe.each(enFiles)("%s", (file) => {
    const en = load("en", file);
    const translated = load(locale, file);

    it("has identical key structure to en", () => {
      expect(Object.keys(translated).sort()).toEqual(Object.keys(en).sort());
    });

    it("preserves every {{ placeholder }} from en", () => {
      for (const [key, value] of Object.entries(en)) {
        if (typeof value !== "string") continue;
        const localeValue = translated[key];
        expect(typeof localeValue).toBe("string");
        expect(placeholders(localeValue as string)).toEqual(
          placeholders(value),
        );
      }
    });
  });
});
