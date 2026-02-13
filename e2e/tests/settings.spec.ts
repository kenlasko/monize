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

    // Wait for settings to load
    await expect(
      page.getByText(/preferences/i).first(),
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

    // Wait for the page to fully load
    await expect(
      page.getByText(/preferences/i).first(),
    ).toBeVisible({ timeout: 15000 });

    // Should show the Danger Zone heading
    await expect(
      page.getByText(/danger zone/i).first(),
    ).toBeVisible();

    // Should show the Delete Account button
    await expect(
      page.getByRole('button', { name: /delete account/i }),
    ).toBeVisible();
  });

  test('shows all major setting sections on one page', async ({ page }) => {
    await page.goto('/settings');

    // Wait for loading to complete
    await expect(
      page.getByText(/preferences/i).first(),
    ).toBeVisible({ timeout: 15000 });

    // Verify all major sections are present
    await expect(page.getByText(/preferences/i).first()).toBeVisible();
    await expect(page.getByText(/security/i).first()).toBeVisible();
    await expect(page.getByText(/danger zone/i).first()).toBeVisible();
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
