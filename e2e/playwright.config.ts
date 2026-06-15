import { defineConfig, devices } from '@playwright/test';

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
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
    {
      name: 'firefox',
      use: { ...devices['Desktop Firefox'] },
    },
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
