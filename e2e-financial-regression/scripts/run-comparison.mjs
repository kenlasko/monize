import { spawnSync } from 'node:child_process';
import { HARNESS_ROOT, ARTIFACTS_DIR, info, warn, fail } from './lib/env.mjs';
import { runPreflight } from './preflight.mjs';
import { startRevision, stopRevision, cleanupWorktree } from './lib/docker.mjs';
import { runComparison } from './compare.mjs';
import { mkdirSync, rmSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

// The orchestrator. Runs the two revisions STRICTLY SEQUENTIALLY against one
// external database -- BEFORE fully captured and torn down before AFTER starts
// -- then compares. It fails loudly if the environment is unsafe, if either
// revision cannot start, or if any complete-data value differs.

/** Run the Playwright capture spec for one phase against a running URL. */
function runCapture(phase, baseURL, config) {
  info(`[${phase}] capturing financial values from ${baseURL} ...`);
  const res = spawnSync('npx', ['playwright', 'test', 'capture', '--project=chromium'], {
    cwd: HARNESS_ROOT,
    stdio: 'inherit',
    env: {
      ...process.env,
      REGRESSION_PHASE: phase,
      BASE_URL: baseURL,
      MONIZE_USER_EMAIL: config.MONIZE_USER_EMAIL,
      MONIZE_USER_PASSWORD: config.MONIZE_USER_PASSWORD,
      MONIZE_USER_TOTP_SECRET: config.MONIZE_USER_TOTP_SECRET ?? '',
      MONIZE_BEFORE_REF: config.MONIZE_BEFORE_REF ?? '',
      MONIZE_AFTER_REF: config.MONIZE_AFTER_REF ?? '',
    },
  });
  if (res.status !== 0) {
    fail(
      `[${phase}] capture failed (Playwright exited ${res.status}). ` +
        `Nothing was written for this phase, so no comparison will be produced.`,
    );
  }
}

async function main() {
  const { mode, config } = runPreflight();

  // Start each run from a clean slate so a stale before/after JSON can never be
  // mistaken for this run's output.
  mkdirSync(ARTIFACTS_DIR, { recursive: true });
  for (const f of ['before.json', 'after.json']) {
    const p = resolve(ARTIFACTS_DIR, f);
    if (existsSync(p)) rmSync(p);
  }

  if (mode === 'url') {
    warn('URL mode: assuming you have started each revision yourself against the SAME copy database.');
    runCapture('before', config.MONIZE_BEFORE_URL, config);
    runCapture('after', config.MONIZE_AFTER_URL, config);
  } else {
    // Docker mode: strictly sequential. Each revision is fully stopped before
    // the next starts -- the two never write to the database at the same time.
    let before;
    try {
      before = startRevision({ phase: 'before', ref: config.MONIZE_BEFORE_REF, config });
      runCapture('before', before.url, config);
    } finally {
      stopRevision(before);
    }

    let after;
    try {
      after = startRevision({ phase: 'after', ref: config.MONIZE_AFTER_REF, config });
      runCapture('after', after.url, config);
    } finally {
      stopRevision(after);
    }

    // Tidy the worktrees (best-effort; containers are already down).
    cleanupWorktree(before);
    cleanupWorktree(after);
  }

  // Compare and report. runComparison exits non-zero on a real difference.
  await runComparison();
}

main().catch((err) => {
  fail(err?.stack || String(err));
});
