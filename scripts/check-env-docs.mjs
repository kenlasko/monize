#!/usr/bin/env node
// Verify every env var referenced from code is documented in .env.example.
//
// Scans backend/src and frontend/src for:
//   - process.env.NAME
//   - process.env['NAME']
//   - configService.get('NAME')  / get<T>('NAME')
//
// Compares against names declared in .env.example (commented or assigned).
// Exits non-zero with a list of undocumented vars on failure.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const REPO_ROOT = new URL('..', import.meta.url).pathname;
const ENV_EXAMPLE = join(REPO_ROOT, '.env.example');
const SOURCE_DIRS = [
  join(REPO_ROOT, 'backend', 'src'),
  join(REPO_ROOT, 'frontend', 'src'),
];
// docker-compose files where service environments declare vars that are
// derived in-compose (e.g. DATABASE_NAME mapped from POSTGRES_DB). Counts as
// documentation since self-hosters consume these files alongside .env.example.
const COMPOSE_FILES = [
  'docker-compose.yml',
  'docker-compose.dev.yml',
  'docker-compose.prod.yml',
  'docker-compose.e2e.yml',
];

// Built-ins and runtime-injected vars that don't belong in .env.example.
const IGNORED = new Set([
  'NODE_ENV',
  'PORT',
  'HOSTNAME',
  'HOME',
  'PATH',
  'PWD',
  'USER',
  'CI',
  'NEXT_RUNTIME',
  'VERCEL',
  '__NEXT_PRIVATE_PREBUNDLED_REACT',
  // Auto-injected at build time via next.config.js from package.json
  'NEXT_PUBLIC_APP_VERSION',
]);

const REFERENCE_PATTERNS = [
  /process\.env\.([A-Z][A-Z0-9_]+)/g,
  /process\.env\[\s*['"]([A-Z][A-Z0-9_]+)['"]\s*\]/g,
  /configService\.get(?:<[^>]+>)?\(\s*['"]([A-Z][A-Z0-9_]+)['"]/g,
  /this\.config\.get(?:<[^>]+>)?\(\s*['"]([A-Z][A-Z0-9_]+)['"]/g,
];

function walk(dir, files = []) {
  for (const entry of readdirSync(dir)) {
    if (entry.startsWith('.') || entry === 'node_modules') continue;
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) walk(full, files);
    else if (/\.(ts|tsx|js|mjs|cjs)$/.test(entry) && !/\.spec\.|\.test\./.test(entry))
      files.push(full);
  }
  return files;
}

function collectFromSource() {
  const found = new Map(); // name -> Set of files
  for (const dir of SOURCE_DIRS) {
    try {
      statSync(dir);
    } catch {
      continue;
    }
    for (const file of walk(dir)) {
      const text = readFileSync(file, 'utf8');
      for (const re of REFERENCE_PATTERNS) {
        for (const match of text.matchAll(re)) {
          const name = match[1];
          if (IGNORED.has(name)) continue;
          if (!found.has(name)) found.set(name, new Set());
          found.get(name).add(relative(REPO_ROOT, file));
        }
      }
    }
  }
  return found;
}

function collectFromEnvExample() {
  const text = readFileSync(ENV_EXAMPLE, 'utf8');
  const documented = new Set();
  for (const rawLine of text.split('\n')) {
    const line = rawLine.replace(/^#\s*/, '').trim();
    const match = line.match(/^([A-Z][A-Z0-9_]+)=/);
    if (match) documented.add(match[1]);
  }
  return documented;
}

function collectFromComposeFiles() {
  const documented = new Set();
  // Match YAML keys at any indentation: KEY: value or KEY: ${...}
  const re = /^[\s-]*([A-Z][A-Z0-9_]+):\s*[^\n]+/gm;
  for (const name of COMPOSE_FILES) {
    let text;
    try {
      text = readFileSync(join(REPO_ROOT, name), 'utf8');
    } catch {
      continue;
    }
    for (const match of text.matchAll(re)) {
      documented.add(match[1]);
    }
  }
  return documented;
}

const referenced = collectFromSource();
const fromEnvExample = collectFromEnvExample();
const fromCompose = collectFromComposeFiles();
const documented = new Set([...fromEnvExample, ...fromCompose]);

const undocumented = [...referenced.keys()]
  .filter((name) => !documented.has(name))
  .sort();

if (undocumented.length === 0) {
  console.log(`OK: all ${referenced.size} referenced env vars are documented`);
  console.log(`  .env.example: ${fromEnvExample.size}`);
  console.log(`  docker-compose*.yml: ${fromCompose.size}`);
  process.exit(0);
}

console.error(`FAIL: ${undocumented.length} env var(s) referenced in code but not documented:\n`);
for (const name of undocumented) {
  const files = [...referenced.get(name)].slice(0, 3).join(', ');
  const more = referenced.get(name).size > 3 ? ` (+${referenced.get(name).size - 3} more)` : '';
  console.error(`  ${name}\n    used in: ${files}${more}`);
}
console.error('\nFix: document the var in .env.example or a docker-compose*.yml service env,');
console.error('or add it to IGNORED in scripts/check-env-docs.mjs if it is runtime-injected.');
process.exit(1);
