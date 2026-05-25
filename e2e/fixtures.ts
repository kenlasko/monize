import { test as base, expect, type Page } from '@playwright/test';
import { registerUser, loginUser } from './helpers/auth';
import { createApiClient, type ApiClient, type TestUser } from './helpers/api';
import { ADMIN_CREDS } from './helpers/admin-creds';

type Fixtures = {
  /** A fresh user (unique email per test), authenticated in the browser. */
  user: TestUser;
  /** CSRF-aware API client reusing the current user's authenticated cookies. */
  api: ApiClient;
  /** A page already logged in -- just `goto` the route under test. */
  authedPage: Page;
  /** The known admin's credentials (registered in global setup as user #1). */
  adminUser: TestUser;
  /** A page logged in as the admin, in its own browser context. */
  adminPage: Page;
};

export const test = base.extend<Fixtures>({
  // Authenticate through the UI: the auth store only persists `isAuthenticated`
  // to localStorage (it re-fetches the profile via cookie on rehydrate), so an
  // API-only login would NOT make the browser page authenticated. UI
  // registration populates both the store and the cookies; the api fixture then
  // reuses those same context cookies for fast data seeding.
  user: async ({ page }, use) => {
    const user = await registerUser(page);
    await use(user);
  },
  api: async ({ page, user }, use) => {
    void user; // ensure registration ran first (cookies/CSRF primed)
    await use(createApiClient(page.request));
  },
  authedPage: async ({ page, user }, use) => {
    void user;
    await use(page);
  },
  adminUser: async ({}, use) => {
    await use(ADMIN_CREDS);
  },
  // The admin lives in its own context so it never collides with a test's
  // per-test user in the default `page`.
  adminPage: async ({ browser, adminUser }, use) => {
    const context = await browser.newContext();
    const page = await context.newPage();
    await loginUser(page, adminUser.email, adminUser.password);
    await use(page);
    await context.close();
  },
});

export { expect };
