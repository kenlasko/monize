import { defineConfig, devices } from '@playwright/test';

const CLUSTER_SPEC = '**/cluster.spec.ts';

export default defineConfig({
  testDir: './tests',
  // Registers a known admin as the very first user (first user => admin role)
  // before any test runs; the admin fixture logs in with these credentials.
  globalSetup: './global-setup.ts',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  // Retry in CI to absorb occasional flakiness (network, animation timing);
  // keep 0 locally for a fast, honest signal while authoring.
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: process.env.CI
    ? [['list'], ['html', { open: 'never' }], ['github']]
    : [['html', { open: 'on-failure' }]],
  timeout: 60000,
  expect: { timeout: 10000 },
  use: {
    baseURL: process.env.BASE_URL || 'http://localhost:3001',
    // Pin the UI locale so the app renders the base English catalog
    // deterministically. Without this, the CI browser's default
    // Accept-Language (en-US) now matches the en-US locale and renders
    // American labels (e.g. "Checking" instead of "Chequing"), breaking
    // label-based selectors. `devices` presets don't set a locale, so this
    // applies to every project.
    locale: 'en',
    // The app's service worker answers a navigation that hangs for 10s with
    // its "Unable to connect" offline page (frontend/public/sw.js,
    // NAVIGATION_TIMEOUT_MS). Against `next dev`, a page the compiler is busy
    // with routinely takes that long, so the fallback replaced the page under
    // test. Only the share-target spec exercises the worker; it opts back in.
    serviceWorkers: 'block',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  // A test that cannot run in a project is left out of it rather than skipped
  // inside it, so a report's skipped count means something.
  projects: [
    {
      name: 'chromium',
      testIgnore: CLUSTER_SPEC,
      use: { ...devices['Desktop Chrome'] },
    },
    {
      name: 'firefox',
      testIgnore: CLUSTER_SPEC,
      // Features Firefox does not offer: share_target's service worker path
      // and mobile viewport emulation (isMobile).
      grepInvert: /@chromium-only/,
      use: { ...devices['Desktop Firefox'] },
    },
    // tests/cluster.spec.ts proves two replicas behind a load balancer, which
    // only the `cluster` compose profile starts. Against one backend every
    // assertion in it is true for the wrong reason, so the project exists only
    // when the run says it has that stack. Chromium alone: the file drives the
    // API directly and never opens a page.
    ...(process.env.E2E_CLUSTER === 'multi'
      ? [
          {
            name: 'cluster',
            testMatch: CLUSTER_SPEC,
            use: { ...devices['Desktop Chrome'] },
          },
        ]
      : []),
  ],
  webServer: process.env.CI
    ? undefined
    : {
        command:
          'docker compose -f docker-compose.e2e.yml up -d --build --wait --wait-timeout 420',
        url: 'http://localhost:3001',
        reuseExistingServer: true,
        timeout: 600000,
        cwd: '..',
      },
});
