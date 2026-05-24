import { test, expect } from '@playwright/test';
import { registerUser } from '../helpers/auth';

test.describe('Settings', () => {
  test.beforeEach(async ({ page }) => {
    await registerUser(page);
  });

  test('can navigate to settings page', async ({ page }) => {
    await page.goto('/settings');

    // Should show the settings page header
    await expect(page.locator('body')).toContainText(/settings/i);
  });

  test('shows preferences section', async ({ page }) => {
    await page.goto('/settings');

    // Settings is one scrolling page. Target the section heading specifically
    // -- the responsive nav duplicates these labels as buttons, the inactive
    // breakpoint's copy is hidden, and getByText().first() would pick it.
    await expect(
      page.getByRole('heading', { name: 'Preferences', exact: true }),
    ).toBeVisible({ timeout: 15000 });

    // Should show the Save Preferences button
    await expect(
      page.getByRole('button', { name: /save preferences/i }),
    ).toBeVisible();
  });

  test('shows security section', async ({ page }) => {
    await page.goto('/settings');

    // Wait for settings to load
    await expect(
      page.getByText(/security/i).first(),
    ).toBeVisible({ timeout: 15000 });

    // Should show the Change Password button
    await expect(
      page.getByRole('button', { name: /change password/i }),
    ).toBeVisible();

    // Should show two-factor authentication section
    await expect(
      page.getByText(/two-factor authentication/i).first(),
    ).toBeVisible();
  });

  test('shows danger zone section', async ({ page }) => {
    await page.goto('/settings');

    // Should show the Danger Zone heading (not the nav button of the same name)
    await expect(
      page.getByRole('heading', { name: /danger zone/i }),
    ).toBeVisible({ timeout: 15000 });

    // Should show the Delete Account button
    await expect(
      page.getByRole('button', { name: /delete account/i }),
    ).toBeVisible();
  });

  test('shows all major setting sections on one page', async ({ page }) => {
    await page.goto('/settings');

    // All sections render on one scrolling page. Assert their headings rather
    // than the duplicated, breakpoint-hidden nav labels.
    await expect(
      page.getByRole('heading', { name: 'Preferences', exact: true }),
    ).toBeVisible({ timeout: 15000 });
    await expect(
      page.getByRole('heading', { name: 'Security', exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole('heading', { name: /danger zone/i }),
    ).toBeVisible();
  });

  test('security section has password change fields', async ({ page }) => {
    await page.goto('/settings');

    // Wait for the page to load
    await expect(
      page.getByText(/security/i).first(),
    ).toBeVisible({ timeout: 15000 });

    // Should show password-related input fields
    await expect(page.getByLabel(/current password/i).first()).toBeVisible();
    await expect(page.getByLabel(/new password/i).first()).toBeVisible();
    await expect(page.getByLabel(/confirm.*password/i).first()).toBeVisible();
  });
});
