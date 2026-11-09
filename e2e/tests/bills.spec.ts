import { test, expect } from '../fixtures';
import {
  createAccount,
  createScheduledTransaction,
} from '../helpers/factories';
import { uniqueId } from '../helpers/api';

// Full CRUD matrix for Bills & Deposits (scheduled transactions). Preconditions
// seeded via the API; behaviour driven through the UI. Account is required, so
// each test that needs one seeds it first.
test.describe('Bills & Deposits', () => {
  test('navigates to the bills page', async ({ authedPage: page }) => {
    await page.goto('/bills');
    await expect(page.locator('body')).toContainText(/bills & deposits/i);
  });

  test('creates a scheduled transaction through the UI', async ({ authedPage: page, api }) => {
    await createAccount(api, { name: `Bills Account ${uniqueId()}` });
    const name = `E2E Rent ${uniqueId()}`;

    await page.goto('/bills');
    await page.getByRole('button', { name: /new schedule/i }).click();

    const dialog = page.getByRole('dialog');
    await expect(
      dialog.getByText(/new scheduled transaction/i).first(),
    ).toBeVisible({ timeout: 10000 });
    await dialog.getByLabel(/^name$/i).first().fill(name);
    // First real option after the "Select account..." placeholder.
    await dialog.getByLabel(/^account$/i).first().selectOption({ index: 1 });
    await dialog.getByLabel(/amount/i).first().fill('1500');
    await dialog.getByRole('button', { name: /^create$/i }).first().click();

    await expect(page.locator('tr', { hasText: name })).toBeVisible();
    await page.reload();
    await expect(page.locator('tr', { hasText: name })).toBeVisible();
  });

  test('lists scheduled transactions seeded via the API', async ({ authedPage: page, api }) => {
    const account = await createAccount(api);
    const rent = await createScheduledTransaction(api, {
      accountId: account.id,
      name: `Rent ${uniqueId()}`,
    });
    const salary = await createScheduledTransaction(api, {
      accountId: account.id,
      name: `Salary ${uniqueId()}`,
      amount: 2000,
    });

    await page.goto('/bills');

    await expect(page.locator('tr', { hasText: rent.name })).toBeVisible();
    await expect(page.locator('tr', { hasText: salary.name })).toBeVisible();
  });

  test('edits a scheduled transaction through the UI', async ({ authedPage: page, api }) => {
    const account = await createAccount(api);
    const sched = await createScheduledTransaction(api, {
      accountId: account.id,
      name: `Edit Me ${uniqueId()}`,
    });
    const newName = `Edited ${uniqueId()}`;

    await page.goto('/bills');
    await page
      .locator('tr', { hasText: sched.name })
      .getByTitle('Edit schedule')
      .click();

    const dialog = page.getByRole('dialog');
    await expect(
      dialog.getByText(/edit scheduled transaction/i).first(),
    ).toBeVisible({ timeout: 10000 });
    await dialog.getByLabel(/^name$/i).first().fill(newName);
    await dialog.getByRole('button', { name: /^update$/i }).first().click();

    await expect(page.locator('tr', { hasText: newName })).toBeVisible();
    await page.reload();
    await expect(page.locator('tr', { hasText: newName })).toBeVisible();
    await expect(page.locator('tr', { hasText: sched.name })).toHaveCount(0);
  });

  test('deletes a scheduled transaction through the UI', async ({ authedPage: page, api }) => {
    const account = await createAccount(api);
    const sched = await createScheduledTransaction(api, {
      accountId: account.id,
      name: `Delete Me ${uniqueId()}`,
    });

    await page.goto('/bills');
    await page
      .locator('tr', { hasText: sched.name })
      .getByTitle('Delete')
      .click();

    await page
      .getByRole('dialog')
      .getByRole('button', { name: 'Delete', exact: true })
      .click();

    await expect(page.locator('tr', { hasText: sched.name })).toHaveCount(0);
    await page.reload();
    await expect(page.locator('tr', { hasText: sched.name })).toHaveCount(0);
  });

  test('shows summary cards', async ({ authedPage: page }) => {
    await page.goto('/bills');

    await expect(page.getByText(/active bills/i).first()).toBeVisible({ timeout: 10000 });
    await expect(page.getByText(/active deposits/i).first()).toBeVisible();
    await expect(page.getByText(/monthly net/i).first()).toBeVisible();
    await expect(page.getByText(/due now/i).first()).toBeVisible();
  });

  test('switches to calendar view', async ({ authedPage: page }) => {
    await page.goto('/bills');

    const calendarButton = page.getByRole('button', { name: /calendar/i });
    await expect(calendarButton).toBeVisible({ timeout: 10000 });
    await expect(page.getByRole('heading', { name: 'No scheduled transactions' })).toBeVisible({
      timeout: 10000,
    });
    // The toolbar still moves after that, when the forecast and the banners
    // above it settle, and a press can land where the button just was. Pressing
    // an already pressed segment does nothing, so the click can simply repeat.
    await expect(async () => {
      await calendarButton.click();
      await expect(calendarButton).toHaveAttribute('aria-pressed', 'true', { timeout: 1000 });
    }).toPass({ timeout: 10000 });

    // Exact matching so short labels like "Mon" don't collide with
    // "Monize" / "Monthly Net".
    await expect(page.getByText('Sun', { exact: true })).toBeVisible();
    await expect(page.getByText('Mon', { exact: true })).toBeVisible();
    await expect(page.getByText('Sat', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: /today/i })).toBeVisible();
  });
});
