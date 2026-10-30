import { resolve } from 'node:path';
import { defineConfig } from '@playwright/test';
import readme from './playwright.readme.config';

// Documentation capture: the screenshots in website/docs/images/, taken from a
// running Monize instance that holds the built-in demo data, once per theme.
// The `dark` project writes `<name>.png` and the `light` project
// `<name>.light.png`; the docs show the one matching the reader's theme. It
// reuses the README capture's seed (readme/01-seed.spec.ts, the `seed` project
// both depend on), its signed-in session and its settling `shoot()`; see
// "Screenshots" in website/README.md.
//
//   npm run docs:screenshots                                          everything
//   npm run docs:screenshots -- docs-screenshots/warranties.spec.ts   one page's pictures
//   npm run docs:screenshots -- -g warranties-list                    one picture, both themes
//
// DOCS_RUN names a run's own output folder and session, so runs for different
// pages can go side by side without signing each other out.
//
// Not part of the test suite: `playwright.config.ts` only looks in ./tests.
const run = process.env.DOCS_RUN ?? 'all';
const outputDir = `test-results-docs-${run}`;
process.env.SHOTS_STATE_FILE ??= resolve(__dirname, outputDir, 'session', 'state.json');

export default defineConfig({
  ...readme,
  testDir: '.',
  outputDir,
  reporter: [['list']],
  projects: [
    // Run on its own (`npm run docs:admin`), before the demo seed: not a dependency.
    { name: 'admin', testMatch: ['docs-screenshots/register-admin.setup.ts'] },
    { name: 'seed', testMatch: ['readme/01-seed.spec.ts'], use: { browserName: 'chromium' } },
    {
      name: 'dark',
      testMatch: ['docs-screenshots/*.spec.ts'],
      use: { browserName: 'chromium', colorScheme: 'dark' },
      dependencies: ['seed'],
    },
    {
      name: 'light',
      testMatch: ['docs-screenshots/*.spec.ts'],
      use: { browserName: 'chromium', colorScheme: 'light' },
      dependencies: ['seed'],
    },
  ],
});
