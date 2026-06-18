import { test, expect } from '../fixtures';
import { createAccount, createTransaction } from '../helpers/factories';
import { uniqueId } from '../helpers/api';

// Transactions run through a tabbed normal/split/transfer form. The payee field
// is a custom-value combobox that's awkward to drive, so create/edit identify
// the transaction by a distinctive amount (the CurrencyInput drives cleanly)
// rather than a payee; the edit target seeds its payee via the API for a stable
// row handle. Date defaults to today.
test.describe('Transactions', () => {
  test('creates a transaction through the UI', async ({ authedPage: page, api }) => {
    const account = await createAccount(api, { name: `Txn Account ${uniqueId()}` });

    await page.goto('/transactions');
    await page.getByRole('button', { name: /new transaction/i }).first().click();

    const dialog = page.getByRole('dialog');
    await dialog.getByLabel(/^account$/i).selectOption({ value: account.id });
    await dialog.getByLabel(/amount/i).first().fill('987.65');
    await dialog.getByRole('button', { name: /create transaction/i }).click();

    await expect(page.locator('tr', { hasText: '987.65' })).toBeVisible();
    await page.reload();
    await expect(page.locator('tr', { hasText: '987.65' })).toBeVisible();
  });

  test('lists transactions seeded via the API', async ({ authedPage: page, api }) => {
    const account = await createAccount(api);
    const coffee = await createTransaction(api, {
      accountId: account.id,
      payeeName: `Coffee ${uniqueId()}`,
    });
    const rent = await createTransaction(api, {
      accountId: account.id,
      payeeName: `Rent ${uniqueId()}`,
    });

    await page.goto('/transactions');

    await expect(page.locator('tr', { hasText: coffee.payeeName! })).toBeVisible();
    await expect(page.locator('tr', { hasText: rent.payeeName! })).toBeVisible();
  });

  test('edits a transaction through the UI', async ({ authedPage: page, api }) => {
    const account = await createAccount(api);
    const payeeName = `Edit Me ${uniqueId()}`;
    await createTransaction(api, { accountId: account.id, amount: 73.19, payeeName });

    await page.goto('/transactions');

    const dialog = page.getByRole('dialog');
    // Clicking the row opens the edit modal; the amount cell doesn't stop
    // propagation (unlike the payee/category/action cells). first() since the
    // running-balance cell shows the same value for a single transaction.
    // The list is client-rendered, so a click that lands before the row's
    // handler hydrates is a no-op -- retry the click until the dialog opens
    // rather than clicking once into the void.
    await expect(async () => {
      await page
        .locator('tr', { hasText: payeeName })
        .getByText(/73\.19/)
        .first()
        .click();
      await expect(dialog).toBeVisible({ timeout: 2000 });
    }).toPass({ timeout: 30000 });

    await dialog.getByLabel(/amount/i).first().fill('88.88');
    await dialog.getByRole('button', { name: /update transaction/i }).click();

    await expect(page.locator('tr', { hasText: payeeName })).toContainText('88.88');
    await page.reload();
    await expect(page.locator('tr', { hasText: payeeName })).toContainText('88.88');
  });

  test('deletes a transaction through the UI', async ({ authedPage: page, api }) => {
    const account = await createAccount(api);
    const txn = await createTransaction(api, {
      accountId: account.id,
      payeeName: `Delete Me ${uniqueId()}`,
    });

    await page.goto('/transactions');

    // The list is client-rendered, so a click that lands before the row's
    // delete handler hydrates is a no-op -- retry the click until the confirm
    // dialog opens rather than clicking once into the void.
    const dialog = page.getByRole('dialog');
    await expect(async () => {
      await page
        .locator('tr', { hasText: txn.payeeName! })
        .getByRole('button', { name: 'Delete', exact: true })
        .click();
      await expect(dialog).toBeVisible({ timeout: 2000 });
    }).toPass({ timeout: 30000 });

    await dialog.getByRole('button', { name: 'Delete', exact: true }).click();

    await expect(page.locator('tr', { hasText: txn.payeeName! })).toHaveCount(0);

    // The confirm triggers a background list refetch. Firefox can reject
    // reload() with NS_ERROR_FAILURE when it fires while that request is still
    // in flight (the navigation aborts it), so retry the reload until it lands.
    await expect(async () => {
      await page.reload();
    }).toPass({ timeout: 30000 });
    await expect(page.locator('tr', { hasText: txn.payeeName! })).toHaveCount(0);
  });

  test('rejects a transaction with no amount', async ({ authedPage: page, api }) => {
    // Seed an account so the form opens normally; amount is still required.
    await createAccount(api);

    await page.goto('/transactions');
    await page.getByRole('button', { name: /new transaction/i }).first().click();

    const dialog = page.getByRole('dialog');
    await dialog.getByRole('button', { name: /create transaction/i }).click();

    await expect(dialog.getByText(/amount is required/i)).toBeVisible();
  });
});
