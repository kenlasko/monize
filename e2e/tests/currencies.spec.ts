import { test, expect } from '../fixtures';
import { createCurrency } from '../helpers/factories';
import { uniqueId, randomCurrencyCode } from '../helpers/api';

// Currencies are created on demand rather than pre-seeded: a fresh instance
// only has the default-preference currency (USD, ensured on startup as an
// inactive row and given to each user whose default it is), and any other
// currency is added when a user creates or picks it. Tests create their
// own currencies with distinct fake 3-char codes. These cover
// navigate/list/create/edit/deactivate/validation.
test.describe('Currencies', () => {
  test('navigates to the currencies page', async ({ authedPage: page }) => {
    await page.goto('/currencies');
    await expect(page.locator('body')).toContainText(/currencies/i);
  });

  test('lists the default currency and created currencies', async ({
    authedPage: page,
    api,
  }) => {
    const created = await createCurrency(api, {
      code: randomCurrencyCode(),
      name: `Listed ${uniqueId()}`,
    });

    await page.goto('/currencies');

    // USD is the user's default-preference currency, so it is listed for them
    // even after they added another currency first.
    await expect(page.locator('tr', { hasText: 'US Dollar' })).toBeVisible();
    // A user-created currency shows up in the list.
    await expect(page.locator('tr', { hasText: created.name })).toBeVisible();
  });

  test('creates a currency through the UI', async ({ authedPage: page }) => {
    const code = randomCurrencyCode();
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
      code: randomCurrencyCode(),
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

  test('deactivates a currency to hide it', async ({ authedPage: page, api }) => {
    const created = await createCurrency(api, {
      code: randomCurrencyCode(),
      name: `Hide Me ${uniqueId()}`,
    });

    await page.goto('/currencies');

    // A non-default, unused currency can be deactivated, which removes it from
    // the default "active" view.
    const row = page.locator('tr', { hasText: created.code });
    await expect(row).toBeVisible();
    await row.getByRole('button', { name: /deactivate/i }).click();

    await expect(page.locator('tr', { hasText: created.code })).toHaveCount(0);
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
