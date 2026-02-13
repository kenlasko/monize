import { test, expect } from '@playwright/test';
import { registerUser } from '../helpers/auth';

test.describe('Import Transactions', () => {
  test.beforeEach(async ({ page }) => {
    await registerUser(page);
  });

  test('can navigate to import page', async ({ page }) => {
    await page.goto('/import');

    // Should show the import page header
    await expect(page.locator('body')).toContainText(/import transactions/i);
  });

  test('shows the upload step by default', async ({ page }) => {
    await page.goto('/import');

    // The upload step heading should be visible
    await expect(
      page.getByText(/upload qif files/i).first(),
    ).toBeVisible({ timeout: 10000 });

    // Should show instructions about selecting files
    await expect(
      page.getByText(/select one or more qif files/i).first(),
    ).toBeVisible();
  });

  test('shows file input for QIF upload', async ({ page }) => {
    await page.goto('/import');

    // Wait for page to load
    await expect(
      page.getByText(/upload qif files/i).first(),
    ).toBeVisible({ timeout: 10000 });

    // The file input should be present (even if hidden for styling)
    const fileInput = page.locator('input[type="file"][accept=".qif"]');
    await expect(fileInput).toBeAttached();
  });

  test('shows progress indicator steps', async ({ page }) => {
    await page.goto('/import');

    // Wait for the page to load
    await expect(
      page.getByText(/import transactions/i).first(),
    ).toBeVisible({ timeout: 10000 });

    // The progress indicator should have step circles rendered
    // There should be at least a few step circles visible
    const stepCircles = page.locator('.rounded-full.flex.items-center.justify-center');
    await expect(stepCircles.first()).toBeVisible();
  });
});
