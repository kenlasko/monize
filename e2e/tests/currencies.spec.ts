import { test, expect } from '../fixtures';
import { createCurrency } from '../helpers/factories';
import { uniqueId } from '../helpers/api';

// Currencies are a global catalog (seeded with ~21 real currencies, default
// "active" filter). Tests use distinct fake 3-char codes so they don't collide
// with the seeded set. The context-menu delete/deactivate is left as a
// follow-up; these cover navigate/list/create/edit/validation.
test.describe('Currencies', () => {
  test('navigates to the currencies page', async ({ authedPage: page }) => {
    await page.goto('/currencies');
    await expect(page.locator('body')).toContainText(/currencies/i);
  });

  test('lists the seeded currencies', async ({ authedPage: page }) => {
    await page.goto('/currencies');

    await expect(page.locator('tr', { hasText: 'US Dollar' })).toBeVisible();
    await expect(page.locator('tr', { hasText: 'British Pound' })).toBeVisible();
  });

  test('creates a currency through the UI', async ({ authedPage: page }) => {
    const code = 'ZQA';
    const name = `E2E Dollar ${uniqueId()}`;

    await page.goto('/currencies');
    await page.getByRole('button', { name: /new currency/i }).first().click();

    const dialog = page.getByRole('dialog');
    await dialog.getByLabel(/currency code/i).fill(code);
    await dialog.getByLabel(/^name$/i).fill(name);
    await dialog.getByLabel(/^symbol$/i).fill('Z$');
    await dialog.getByRole('button', { name: /create currency/i }).click();

    await expect(page.locator('tr', { hasText: name })).toBeVisible();
    await page.reload();
    await expect(page.locator('tr', { hasText: name })).toBeVisible();
  });

  test('edits a currency through the UI', async ({ authedPage: page, api }) => {
    const currency = await createCurrency(api, {
      code: 'ZQB',
      name: `Edit Me ${uniqueId()}`,
    });
    const newName = `Edited ${uniqueId()}`;

    await page.goto('/currencies');
    await page
      .locator('tr', { hasText: currency.code })
      .getByRole('button', { name: 'Edit', exact: true })
      .click();

    const dialog = page.getByRole('dialog');
    await dialog.getByLabel(/^name$/i).fill(newName);
    await dialog.getByRole('button', { name: /update currency/i }).click();

    await expect(page.locator('tr', { hasText: newName })).toBeVisible();
    await page.reload();
    await expect(page.locator('tr', { hasText: newName })).toBeVisible();
  });

  test('rejects a too-short currency code', async ({ authedPage: page }) => {
    await page.goto('/currencies');
    await page.getByRole('button', { name: /new currency/i }).first().click();

    const dialog = page.getByRole('dialog');
    await dialog.getByLabel(/currency code/i).fill('ZZ');
    await dialog.getByRole('button', { name: /create currency/i }).click();

    await expect(
      dialog.getByText(/currency code must be exactly 3 characters/i),
    ).toBeVisible();
  });
});
