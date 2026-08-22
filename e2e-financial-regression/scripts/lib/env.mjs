import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
export const HARNESS_ROOT = resolve(here, '..', '..');
export const REPO_ROOT = resolve(HARNESS_ROOT, '..');
export const ENV_FILE = resolve(HARNESS_ROOT, 'regression.env');
export const ARTIFACTS_DIR = resolve(HARNESS_ROOT, 'artifacts');

/**
 * Parse a dotenv-style file into a plain object. Intentionally tiny: KEY=VALUE
 * per line, `#` comments, surrounding quotes stripped. No interpolation.
 */
export function parseEnvFile(path) {
  const out = {};
  const text = readFileSync(path, 'utf8');
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

/**
 * Load regression.env, failing loudly if it is missing. Returns the parsed
 * config; does NOT mutate process.env (callers choose what to pass to children).
 */
export function loadConfig() {
  if (!existsSync(ENV_FILE)) {
    fail(
      `Missing ${rel(ENV_FILE)}.\n` +
        `This harness refuses to run without an explicit configuration.\n` +
        `  cp regression.env.example regression.env   # then edit it`,
    );
  }
  return parseEnvFile(ENV_FILE);
}

export function rel(p) {
  return p.startsWith(REPO_ROOT) ? p.slice(REPO_ROOT.length + 1) : p;
}

/** Print a red, prefixed error and exit non-zero. */
export function fail(message) {
  process.stderr.write(`\n[31m[regression] FATAL:[0m ${message}\n\n`);
  process.exit(1);
}

export function info(message) {
  process.stdout.write(`[36m[regression][0m ${message}\n`);
}

export function warn(message) {
  process.stdout.write(`[33m[regression] WARNING:[0m ${message}\n`);
}
