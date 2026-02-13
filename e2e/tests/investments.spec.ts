import { test, expect } from '@playwright/test';
import { registerUser } from '../helpers/auth';

test.describe('Investments', () => {
  test.beforeEach(async ({ page }) => {
    await registerUser(page);
  });

  test('can navigate to investments page', async ({ page }) => {
    await page.goto('/investments');

    // Should show the investments page heading
    await expect(page.locator('body')).toContainText(/investments/i);
  });

  test('shows portfolio summary section', async ({ page }) => {
    await page.goto('/investments');

    // Wait for the page to load
    await expect(
      page.getByText(/track your investment portfolio/i).first(),
    ).toBeVisible({ timeout: 10000 });

    // The page heading should be visible
    await expect(
      page.getByRole('heading', { name: /investments/i }).first(),
    ).toBeVisible();
  });

  test('shows price refresh button', async ({ page }) => {
    await page.goto('/investments');

    // Wait for the page to load
    await expect(
      page.getByText(/track your investment portfolio/i).first(),
    ).toBeVisible({ timeout: 10000 });

    // The Refresh button for prices should be visible
    const refreshButton = page.getByRole('button', { name: /refresh/i }).first();
    await expect(refreshButton).toBeVisible();
  });

  test('shows new transaction button', async ({ page }) => {
    await page.goto('/investments');

    // Wait for the page to load
    await expect(
      page.getByText(/track your investment portfolio/i).first(),
    ).toBeVisible({ timeout: 10000 });

    // The New Transaction button should be visible
    const newTxButton = page.getByRole('button', { name: /new transaction/i });
    await expect(newTxButton).toBeVisible();
  });

  test('shows account filter dropdown', async ({ page }) => {
    await page.goto('/investments');

    // Wait for the page to load
    await expect(
      page.getByText(/track your investment portfolio/i).first(),
    ).toBeVisible({ timeout: 10000 });

    // The account filter placeholder should be visible
    await expect(
      page.getByText(/all investment accounts/i).first(),
    ).toBeVisible();
  });

  test('renders portfolio sections when loaded', async ({ page }) => {
    await page.goto('/investments');

    // Wait for loading to complete (the page heading is visible immediately)
    await expect(
      page.getByRole('heading', { name: /investments/i }).first(),
    ).toBeVisible({ timeout: 10000 });

    // Wait for loading spinners to disappear (give data time to load)
    await page.waitForTimeout(3000);

    // The auto-generated symbol footnote should be present in the page footer
    await expect(
      page.getByText(/auto-generated symbol name/i).first(),
    ).toBeVisible();
  });
});
