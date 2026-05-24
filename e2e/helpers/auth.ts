import { Page, expect } from '@playwright/test';
import { randomBytes } from 'crypto';

const uniqueId = () => Date.now().toString(36) + randomBytes(3).toString('hex');

export async function registerUser(
  page: Page,
  options?: { email?: string; password?: string; firstName?: string; lastName?: string },
) {
  const email = options?.email || `e2e-${uniqueId()}@test.example.com`;
  const password = options?.password || 'E2eTestPass123!';
  const firstName = options?.firstName || 'E2E';
  const lastName = options?.lastName || 'Tester';

  await page.goto('/register');
  await page.getByLabel(/email/i).fill(email);
  await page.getByLabel(/first name/i).fill(firstName);
  await page.getByLabel(/last name/i).fill(lastName);
  await page.getByLabel(/^password$/i).fill(password);
  await page.getByLabel(/confirm password/i).fill(password);
  await page.getByRole('button', { name: /create account|register|sign up/i }).click();

  // After submitting we either land on the dashboard directly or hit an
  // optional 2FA-setup step. Race the two so the happy path doesn't sit
  // through a fixed wait, then skip the 2FA step if it appeared.
  const skipButton = page.getByRole('button', { name: /skip for now/i });
  await Promise.race([
    page.waitForURL(/\/dashboard/, { timeout: 15000 }).catch(() => {}),
    skipButton.waitFor({ state: 'visible', timeout: 15000 }).catch(() => {}),
  ]);
  if (await skipButton.isVisible().catch(() => false)) {
    await skipButton.click();
  }

  await page.waitForURL(/\/dashboard/, { timeout: 15000 });

  return { email, password, firstName, lastName };
}

export async function loginUser(
  page: Page,
  email: string,
  password: string,
) {
  // loginUser may run while the app is still finishing its own redirect to
  // /login (e.g. immediately after logout). A second goto would race that and
  // Playwright rejects it as an interrupted navigation, so only navigate when
  // we are not already on the login page, then let it settle.
  if (!new URL(page.url()).pathname.startsWith('/login')) {
    await page.goto('/login');
  }
  await page.waitForURL(/\/login/, { timeout: 15000 });
  await page.getByLabel(/email/i).fill(email);
  await page.getByLabel(/password/i).fill(password);
  await page.getByRole('button', { name: /sign in/i }).click();
  await page.waitForURL(/\/dashboard/, { timeout: 15000 });
}

export async function logout(page: Page) {
  // The Logout button lives in the app header on every authenticated page.
  // Use an auto-waiting click rather than a non-waiting isVisible() guard:
  // isVisible() can run before the client header hydrates, silently skip the
  // click, and leave waitForURL with no navigation to wait for.
  await page.goto('/settings');
  await page.getByRole('button', { name: /log\s?out|sign\s?out/i }).first().click();
  await page.waitForURL(/\/login/, { timeout: 10000 });
}
