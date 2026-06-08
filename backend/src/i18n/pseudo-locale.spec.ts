import { readdirSync, readFileSync } from "fs";
import { join } from "path";

/**
 * Guards the generated `xx` pseudo-locale (see scripts/i18n-pseudo.mjs).
 *
 * The frontend ships an `xx` pseudo-locale so untranslated UI strings stand out
 * during QA; the backend must mirror it so server-sent strings (exception
 * messages such as the backup folder validation errors) are pseudo-localized
 * too, instead of leaking raw English when the request locale is `xx`.
 */
const localesDir = join(__dirname, "locales");
const enDir = join(localesDir, "en");
const xxDir = join(localesDir, "xx");

/** Mirror of pseudoValue in scripts/i18n-pseudo.mjs. */
function pseudoValue(value: unknown): unknown {
  if (typeof value === "string") return `[XX-${value}-XX]`;
  if (Array.isArray(value)) return value.map(pseudoValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, val]) => [
        key,
        pseudoValue(val),
      ]),
    );
  }
  return value;
}

describe("backend pseudo-locale (xx)", () => {
  const namespaceFiles = readdirSync(enDir).filter((f) => f.endsWith(".json"));

  it.each(namespaceFiles)(
    "xx/%s is in sync with the English source (run `npm run i18n:pseudo`)",
    (file) => {
      const source = JSON.parse(readFileSync(join(enDir, file), "utf8"));
      const expected = JSON.stringify(pseudoValue(source), null, 2) + "\n";
      const actual = readFileSync(join(xxDir, file), "utf8");
      expect(actual).toBe(expected);
    },
  );

  it("pseudo-localizes the backup folder validation errors", () => {
    const errors = JSON.parse(readFileSync(join(xxDir, "errors.json"), "utf8"));
    // Wrapped so the string shows as translated during QA...
    expect(errors.backup.folderNotWritable).toMatch(/^\[XX-.*-XX\]$/);
    // ...while the i18next interpolation token is left intact.
    expect(errors.backup.folderNotWritable).toContain("{{ safePath }}");
  });
});
