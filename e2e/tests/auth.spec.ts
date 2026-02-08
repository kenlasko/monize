import { test, expect } from '@playwright/test';
import { registerUser, loginUser, logout } from '../helpers/auth';

test.describe('Authentication', () => {
  test('can register a new user', async ({ page }) => {
    const { email } = await registerUser(page);

    // Should be on dashboard after registration
    await expect(page).toHaveURL(/\/dashboard/);
    // Dashboard should have some content
    await expect(page.locator('body')).toContainText(/dashboard|welcome|account/i);
  });

  test('can login with valid credentials', async ({ page }) => {
    // Register first to create the user
    const { email, password } = await registerUser(page);

    // Logout
    await logout(page);

    // Login again
    await loginUser(page, email, password);
    await expect(page).toHaveURL(/\/dashboard/);
  });

  test('shows error for invalid login', async ({ page }) => {
    await page.goto('/login');
    await page.getByLabel(/email/i).fill('nonexistent@example.com');
    await page.getByLabel(/password/i).fill('wrongpassword');
    await page.getByRole('button', { name: /sign in/i }).click();

    // Should show error toast or message
    await expect(
      page.getByText(/invalid|error|incorrect/i).first(),
    ).toBeVisible({ timeout: 10000 });
  });

  test('redirects unauthenticated users to login', async ({ page }) => {
    // Try to access a protected page directly
    await page.goto('/accounts');

    // Should be redirected to login
    await expect(page).toHaveURL(/\/login/);
  });

  test('can logout successfully', async ({ page }) => {
    await registerUser(page);

    await logout(page);

    // Should be on login page
    await expect(page).toHaveURL(/\/login/);
  });
});
