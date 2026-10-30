import { defineConfig } from '@playwright/test';
import readme from './playwright.readme.config';

// Documentation capture: the screenshots in website/docs/images/, taken from a
// running Monize instance that holds the built-in demo data. It reuses the
// README capture's seed (readme/01-seed.spec.ts runs first), its signed-in
// session and its settling `shoot()`; see "Screenshots" in website/README.md.
//
//   npm run docs:screenshots                       every documentation picture
//   npm run docs:screenshots -- -g budget-dashboard   one picture, by file name
//
// Not part of the test suite: `playwright.config.ts` only looks in ./tests.
export default defineConfig({
  ...readme,
  testDir: '.',
  testMatch: ['readme/01-seed.spec.ts', 'docs-screenshots/*.spec.ts'],
  reporter: [['list']],
});
