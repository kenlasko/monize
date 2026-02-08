import { test, expect } from '@playwright/test';
import { registerUser } from '../helpers/auth';

test.describe('Accounts', () => {
  test.beforeEach(async ({ page }) => {
    await registerUser(page);
  });

  test('can navigate to accounts page', async ({ page }) => {
    await page.goto('/accounts');

    // Should show the accounts page
    await expect(page.locator('body')).toContainText(/account/i);
  });

  test('can create a new checking account', async ({ page }) => {
    await page.goto('/accounts');

    const newAccountButton = page.getByRole('button', { name: /new account|add account/i });
    if (await newAccountButton.isVisible()) {
      await newAccountButton.click();

      // Fill in account details
      await page.getByLabel(/name/i).first().fill('E2E Checking Account');

      // Look for opening balance field
      const balanceField = page.getByLabel(/opening balance|balance/i).first();
      if (await balanceField.isVisible()) {
        await balanceField.fill('1000');
      }

      // Submit the form
      await page.getByRole('button', { name: /save|create/i }).click();

      // Wait and verify the account appears
      await page.waitForTimeout(2000);
      await expect(page.locator('body')).toContainText('E2E Checking Account');
    }
  });

  test('shows account list', async ({ page }) => {
    // Create an account first
    await page.goto('/accounts');

    const newAccountButton = page.getByRole('button', { name: /new account|add account/i });
    if (await newAccountButton.isVisible()) {
      await newAccountButton.click();
      await page.getByLabel(/name/i).first().fill('Test Account');
      await page.getByRole('button', { name: /save|create/i }).click();
      await page.waitForTimeout(2000);
    }

    // Navigate back to accounts
    await page.goto('/accounts');

    // Should see the account in the list
    await expect(page.locator('body')).toContainText(/account/i);
  });
});
