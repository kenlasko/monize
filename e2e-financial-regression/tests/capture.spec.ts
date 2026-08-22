import { test } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { capture } from '../src/capture';

// Captures every targeted financial value for ONE revision and writes it to
// artifacts/<phase>.json. The orchestrator runs this twice -- once per phase
// (before/after) -- against the two revisions in turn, never concurrently.
//
// Driven entirely by environment:
//   REGRESSION_PHASE   'before' | 'after'   (which JSON to write)
//   BASE_URL           the running revision's frontend URL
//   MONIZE_*_REF       recorded into the JSON for the report header
//   MONIZE_USER_*      existing-user credentials (see src/auth.ts)

const here = dirname(fileURLToPath(import.meta.url));
const artifactsDir = resolve(here, '..', 'artifacts');

test('capture financial values (read-only)', async ({ page }) => {
  // 14 screens with per-screen settle waits; well beyond the default 60s.
  test.setTimeout(600_000);

  // Accept any non-empty label (the version-walk uses per-version labels like
  // "baseline", "pr-1050", "pr-06"), sanitised for use as a filename. The
  // classic before/after flow still works unchanged.
  const rawPhase = (process.env.REGRESSION_PHASE || '').toLowerCase().trim();
  const phase = rawPhase.replace(/[^a-z0-9._-]/g, '-');
  if (!phase) {
    throw new Error(
      `REGRESSION_PHASE must be a non-empty label (got "${process.env.REGRESSION_PHASE}").`,
    );
  }

  const revisionRef =
    process.env.MONIZE_REVISION_REF ??
    (phase === 'before'
      ? process.env.MONIZE_BEFORE_REF
      : phase === 'after'
        ? process.env.MONIZE_AFTER_REF
        : phase);

  const result = await capture(page, {
    phase,
    revisionRef: revisionRef ?? null,
    capturedAt: new Date().toISOString(),
  });

  mkdirSync(artifactsDir, { recursive: true });
  const outFile = resolve(artifactsDir, `${phase}.json`);
  writeFileSync(outFile, JSON.stringify(result, null, 2), 'utf8');

  const known = result.signals.filter((s) => s.status === 'value').length;
  const unknown = result.signals.filter((s) => s.status === 'unknown').length;
  // eslint-disable-next-line no-console -- this is a developer CLI tool, not app code
  console.log(
    `[${phase}] captured ${result.signals.length} signals ` +
      `(${known} known, ${unknown} unknown) -> ${outFile}`,
  );
});
