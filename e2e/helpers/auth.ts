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
  await page.goto('/login');
  await page.getByLabel(/email/i).fill(email);
  await page.getByLabel(/password/i).fill(password);
  await page.getByRole('button', { name: /sign in/i }).click();
  await page.waitForURL(/\/dashboard/, { timeout: 15000 });
}

export async function logout(page: Page) {
  // Navigate to settings or click logout
  await page.goto('/settings');
  const logoutButton = page.getByRole('button', { name: /log\s?out|sign\s?out/i });
  if (await logoutButton.isVisible()) {
    await logoutButton.click();
  }
  await page.waitForURL(/\/login/, { timeout: 10000 });
}
