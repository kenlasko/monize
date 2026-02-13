import { test, expect } from '@playwright/test';
import { registerUser } from '../helpers/auth';

test.describe('Bills & Deposits', () => {
  test.beforeEach(async ({ page }) => {
    await registerUser(page);
  });

  test('can navigate to bills page', async ({ page }) => {
    await page.goto('/bills');

    // Should show the bills page header
    await expect(page.locator('body')).toContainText(/bills & deposits/i);
  });

  test('can create a new scheduled transaction', async ({ page }) => {
    // First create an account to use in the scheduled transaction
    await page.goto('/accounts');
    const newAccountButton = page.getByRole('button', { name: /new account|add account/i });
    if (await newAccountButton.isVisible()) {
      await newAccountButton.click();
      await page.getByLabel(/name/i).first().fill('E2E Bills Account');
      await page.getByRole('button', { name: /save|create/i }).click();
      await page.waitForTimeout(2000);
    }

    // Navigate to the bills page
    await page.goto('/bills');
    await expect(page.locator('body')).toContainText(/bills & deposits/i);

    // Click the new schedule button
    const newScheduleButton = page.getByRole('button', { name: /new schedule/i });
    await expect(newScheduleButton).toBeVisible();
    await newScheduleButton.click();

    // The form modal should appear
    await expect(
      page.getByText(/new scheduled transaction/i).first(),
    ).toBeVisible({ timeout: 10000 });

    // Fill in the scheduled transaction form
    await page.getByLabel(/name/i).first().fill('E2E Monthly Rent');

    // Select account
    const accountSelect = page.getByLabel(/account/i).first();
    if (await accountSelect.isVisible()) {
      await accountSelect.selectOption({ label: /E2E Bills Account/i });
    }

    // Fill amount
    const amountField = page.getByLabel(/amount/i).first();
    if (await amountField.isVisible()) {
      await amountField.fill('-1500');
    }

    // Fill due date
    const dueDateField = page.getByLabel(/due date/i).first();
    if (await dueDateField.isVisible()) {
      const today = new Date().toISOString().split('T')[0];
      await dueDateField.fill(today);
    }

    // Submit the form
    const saveButton = page.getByRole('button', { name: /save|create/i }).first();
    if (await saveButton.isVisible()) {
      await saveButton.click();
      await page.waitForTimeout(2000);
    }

    // Verify the scheduled transaction appears in the list
    await expect(page.locator('body')).toContainText('E2E Monthly Rent');
  });

  test('shows summary cards', async ({ page }) => {
    await page.goto('/bills');

    // Should display the summary cards
    await expect(page.getByText(/active bills/i).first()).toBeVisible({ timeout: 10000 });
    await expect(page.getByText(/active deposits/i).first()).toBeVisible();
    await expect(page.getByText(/monthly net/i).first()).toBeVisible();
    await expect(page.getByText(/due now/i).first()).toBeVisible();
  });

  test('can switch to calendar view', async ({ page }) => {
    await page.goto('/bills');

    // Should see the list and calendar view toggle buttons
    const calendarButton = page.getByRole('button', { name: /calendar/i });
    await expect(calendarButton).toBeVisible({ timeout: 10000 });

    // Click on the Calendar tab
    await calendarButton.click();

    // Calendar should render with day-of-week headers
    await expect(page.getByText('Sun')).toBeVisible();
    await expect(page.getByText('Mon')).toBeVisible();
    await expect(page.getByText('Tue')).toBeVisible();
    await expect(page.getByText('Wed')).toBeVisible();
    await expect(page.getByText('Thu')).toBeVisible();
    await expect(page.getByText('Fri')).toBeVisible();
    await expect(page.getByText('Sat')).toBeVisible();

    // Calendar should show a Today button
    await expect(page.getByRole('button', { name: /today/i })).toBeVisible();
  });

  test('can switch between list and calendar views', async ({ page }) => {
    await page.goto('/bills');

    // Start in list view
    const listButton = page.getByRole('button', { name: /^list$/i });
    const calendarButton = page.getByRole('button', { name: /calendar/i });

    await expect(listButton).toBeVisible({ timeout: 10000 });
    await expect(calendarButton).toBeVisible();

    // Switch to calendar
    await calendarButton.click();
    await expect(page.getByText('Sun')).toBeVisible();

    // Switch back to list
    await listButton.click();

    // Filter buttons should be visible in list mode
    await expect(page.getByRole('button', { name: /all/i }).first()).toBeVisible();
  });
});
