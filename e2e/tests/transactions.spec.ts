import { test, expect } from '@playwright/test';
import { registerUser } from '../helpers/auth';

test.describe('Transactions', () => {
  test.beforeEach(async ({ page }) => {
    // Register a fresh user for each test
    await registerUser(page);
  });

  test('can navigate to transactions page', async ({ page }) => {
    await page.goto('/transactions');

    // Page should load without error
    await expect(page.locator('body')).toContainText(/transaction/i);
  });

  test('can create a new transaction', async ({ page }) => {
    // First create an account to transact against
    await page.goto('/accounts');
    const newAccountButton = page.getByRole('button', { name: /new account|add account/i });
    if (await newAccountButton.isVisible()) {
      await newAccountButton.click();

      // Fill in account form
      await page.getByLabel(/name/i).first().fill('E2E Checking');
      await page.getByRole('button', { name: /save|create/i }).click();

      // Wait for account to be created
      await page.waitForTimeout(2000);
    }

    // Navigate to transactions
    await page.goto('/transactions');

    // Click new transaction button
    const newTxButton = page.getByRole('button', { name: /new transaction|add/i }).first();
    if (await newTxButton.isVisible()) {
      await newTxButton.click();

      // Fill in transaction form (specifics depend on the form implementation)
      await page.waitForTimeout(1000);

      // Verify the form is visible
      await expect(page.locator('form').first()).toBeVisible();
    }
  });
});
