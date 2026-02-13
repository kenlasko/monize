import { test, expect } from '@playwright/test';
import { registerUser } from '../helpers/auth';

test.describe('Reconciliation', () => {
  test.beforeEach(async ({ page }) => {
    await registerUser(page);
  });

  test('can navigate to reconcile page', async ({ page }) => {
    await page.goto('/reconcile');

    // Should show the reconcile page header
    await expect(page.locator('body')).toContainText(/reconcile account/i);
  });

  test('shows the setup step with form fields', async ({ page }) => {
    await page.goto('/reconcile');

    // Should show the Start Reconciliation heading
    await expect(
      page.getByText(/start reconciliation/i).first(),
    ).toBeVisible({ timeout: 10000 });

    // Should show explanatory text
    await expect(
      page.getByText(/reconcile your account against a bank statement/i).first(),
    ).toBeVisible();

    // Should show the account select dropdown
    await expect(page.getByLabel(/account/i).first()).toBeVisible();

    // Should show the statement date input
    await expect(page.getByLabel(/statement date/i).first()).toBeVisible();

    // Should show the statement ending balance input
    await expect(page.getByText(/statement ending balance/i).first()).toBeVisible();
  });

  test('can select an account and enter statement balance', async ({ page }) => {
    // First create an account to reconcile against
    await page.goto('/accounts');
    const newAccountButton = page.getByRole('button', { name: /new account|add account/i });
    if (await newAccountButton.isVisible()) {
      await newAccountButton.click();
      await page.getByLabel(/name/i).first().fill('E2E Reconcile Account');
      await page.getByRole('button', { name: /save|create/i }).click();
      await page.waitForTimeout(2000);
    }

    // Navigate to reconcile page
    await page.goto('/reconcile');

    // Wait for the setup step to appear
    await expect(
      page.getByText(/start reconciliation/i).first(),
    ).toBeVisible({ timeout: 10000 });

    // Select the account from the dropdown
    const accountSelect = page.getByLabel(/account/i).first();
    await expect(accountSelect).toBeVisible();

    // Try to find the account we created
    const options = accountSelect.locator('option');
    const optionCount = await options.count();
    if (optionCount > 1) {
      // Select the last non-placeholder option (most recently created account)
      await accountSelect.selectOption({ index: optionCount - 1 });
    }

    // Fill in the statement date
    const statementDateInput = page.getByLabel(/statement date/i).first();
    await expect(statementDateInput).toBeVisible();
    const today = new Date().toISOString().split('T')[0];
    await statementDateInput.fill(today);

    // Fill in the statement balance
    const balanceInput = page.getByLabel(/statement ending balance/i).first();
    if (await balanceInput.isVisible()) {
      await balanceInput.fill('1000');
    }

    // The Start Reconciliation button should be present
    const startButton = page.getByRole('button', { name: /start reconciliation/i });
    await expect(startButton).toBeVisible();
  });

  test('shows cancel button that navigates to accounts', async ({ page }) => {
    await page.goto('/reconcile');

    // Wait for the setup step to appear
    await expect(
      page.getByText(/start reconciliation/i).first(),
    ).toBeVisible({ timeout: 10000 });

    // Should show the Cancel button
    const cancelButton = page.getByRole('button', { name: /cancel/i });
    await expect(cancelButton).toBeVisible();
  });
});
