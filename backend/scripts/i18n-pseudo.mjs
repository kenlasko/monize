#!/usr/bin/env node
/**
 * Regenerate the pseudo-locale (`xx`) translation catalogs from the English
 * source, mirroring `frontend/scripts/i18n-pseudo.mjs`.
 *
 * The pseudo-locale wraps every translatable string with `[XX-...-XX]` markers
 * so that, in dev builds, any backend string that has NOT been routed through
 * `tr()` (and therefore can't be translated) renders as plain English -- making
 * the gap obvious during translation QA. i18next `{{ placeholder }}` tokens are
 * preserved untouched; the markers live outside any `{{...}}` block, so
 * interpolation still works.
 *
 * Usage:
 *   node scripts/i18n-pseudo.mjs          # regenerate locales/xx/*.json
 *   node scripts/i18n-pseudo.mjs --check  # fail if xx is out of date (CI)
 *
 * Run this after editing any `locales/en/*.json` file. Never hand-edit the
 * `locales/xx/*.json` files -- they are generated artifacts.
 */
import { readdirSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const localesDir = join(here, "..", "src", "i18n", "locales");
const enDir = join(localesDir, "en");
const xxDir = join(localesDir, "xx");

/**
 * Wrap a single string value with pseudo markers. The whole value is wrapped;
 * i18next `{{ placeholder }}` tokens inside it stay valid because the markers
 * live outside any `{{...}}` block.
 */
function pseudoString(value) {
  return `[XX-${value}-XX]`;
}

/** Recursively pseudo-localize every string leaf in a parsed JSON value. */
function pseudoValue(value) {
  if (typeof value === "string") return pseudoString(value);
  if (Array.isArray(value)) return value.map(pseudoValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, val]) => [key, pseudoValue(val)]),
    );
  }
  return value;
}

const namespaceFiles = readdirSync(enDir).filter((f) => f.endsWith(".json"));
const checkMode = process.argv.includes("--check");
let outOfDate = false;

if (!checkMode) mkdirSync(xxDir, { recursive: true });

for (const file of namespaceFiles) {
  const source = JSON.parse(readFileSync(join(enDir, file), "utf8"));
  const generated = JSON.stringify(pseudoValue(source), null, 2) + "\n";
  const target = join(xxDir, file);

  if (checkMode) {
    let current = "";
    try {
      current = readFileSync(target, "utf8");
    } catch {
      current = "";
    }
    if (current !== generated) {
      outOfDate = true;
      console.error(`Pseudo-locale out of date: ${file}`);
    }
  } else {
    writeFileSync(target, generated);
    console.log(`Wrote locales/xx/${file}`);
  }
}

if (checkMode && outOfDate) {
  console.error("\nRun `npm run i18n:pseudo` to regenerate the pseudo-locale.");
  process.exit(1);
}
