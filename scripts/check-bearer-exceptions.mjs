#!/usr/bin/env node
// Scan .github/workflows/ci.yml for Bearer exception entries with review-by
// dates and report any that are past due. Used by a scheduled workflow that
// opens an issue when exceptions become stale debt.
//
// Comment format expected:
//   # <fingerprint> - <description> - review-by: YYYY-MM-DD

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CI_YML = join(REPO_ROOT, '.github', 'workflows', 'ci.yml');

const today = new Date();
today.setUTCHours(0, 0, 0, 0);

const text = readFileSync(CI_YML, 'utf8');
const re = /#\s*(\S+)\s*-\s*(.+?)\s*-\s*review-by:\s*(\d{4}-\d{2}-\d{2})/g;

const stale = [];
const upcoming = [];

for (const match of text.matchAll(re)) {
  const [, fingerprint, description, dateStr] = match;
  const reviewBy = new Date(`${dateStr}T00:00:00Z`);
  const daysLeft = Math.ceil((reviewBy.getTime() - today.getTime()) / 86400000);
  const entry = { fingerprint, description, dateStr, daysLeft };
  if (daysLeft <= 0) stale.push(entry);
  else if (daysLeft <= 14) upcoming.push(entry);
}

if (stale.length === 0 && upcoming.length === 0) {
  console.log('OK: no Bearer exceptions are stale or due soon.');
  process.exit(0);
}

if (upcoming.length > 0) {
  console.log(`Note: ${upcoming.length} Bearer exception(s) due for review within 14 days:`);
  for (const e of upcoming) {
    console.log(`  ${e.fingerprint} (in ${e.daysLeft} day(s)) - ${e.description}`);
  }
}

if (stale.length > 0) {
  console.error(`\nFAIL: ${stale.length} Bearer exception(s) past their review-by date:\n`);
  for (const e of stale) {
    console.error(`  ${e.fingerprint} (review-by ${e.dateStr}, ${-e.daysLeft} day(s) overdue)`);
    console.error(`    ${e.description}\n`);
  }
  console.error('Either re-evaluate and remediate the underlying finding, or extend the');
  console.error('review-by date in .github/workflows/ci.yml after confirming the exception still holds.');
  process.exit(1);
}
