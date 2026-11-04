import { test, expect } from '../fixtures';
import {
  createInvestmentAccountPair,
  createSecurity,
  createInvestmentTransaction,
} from '../helpers/factories';
import { uniqueId } from '../helpers/api';

// Investments portfolio view. Preconditions (account pair, security, trades)
// are seeded through the API; one test also drives the transaction form in the
// UI. The holdings roll-up renders one collapsed row per brokerage account --
// the backend strips the " - Brokerage" suffix from the displayed name (see
// PortfolioCalculationService), and the row's "N position(s)" count is the
// honest signal that a trade actually rolled into a holding (the account row
// itself shows even with zero holdings).
test.describe('Investments', () => {
  test('shows the investments page chrome', async ({ authedPage: page }) => {
    await page.goto('/investments');

    await expect(
      page.getByRole('heading', { name: 'Investments' }).first(),
    ).toBeVisible();
    await expect(page.getByRole('button', { name: /refresh/i })).toBeVisible();
    await expect(
      page.getByRole('button', { name: /\+ New Transaction/i }),
    ).toBeVisible();
  });

  test('rolls a seeded BUY up into the holdings view', async ({
    authedPage: page,
    api,
  }) => {
    const name = `Invest ${uniqueId()}`;
    const pair = await createInvestmentAccountPair(api, { name });
    const security = await createSecurity(api, { name: `Held ${uniqueId()}` });
    await createInvestmentTransaction(api, {
      accountId: pair.brokerageAccount.id,
      fundingAccountId: pair.cashAccount.id,
      securityId: security.id,
      action: 'BUY',
      quantity: 10,
      price: 100,
    });

    await page.goto('/investments');

    await expect(
      page.getByRole('heading', { name: 'Holdings by Account' }),
    ).toBeVisible({ timeout: 15000 });
    // The display name has the " - Brokerage" suffix stripped; the position
    // count proves the BUY produced a holding rather than just an empty account.
    const accountHeader = page.locator('button', { hasText: name }).first();
    await expect(accountHeader).toBeVisible();
    await expect(accountHeader).toContainText('1 position');
  });

  test('keeps holdings after a reload (persistence)', async ({
    authedPage: page,
    api,
  }) => {
    const name = `Invest ${uniqueId()}`;
    const pair = await createInvestmentAccountPair(api, { name });
    const security = await createSecurity(api, { name: `Held ${uniqueId()}` });
    await createInvestmentTransaction(api, {
      accountId: pair.brokerageAccount.id,
      fundingAccountId: pair.cashAccount.id,
      securityId: security.id,
      action: 'BUY',
      quantity: 5,
      price: 50,
    });

    await page.goto('/investments');
    await expect(
      page.locator('button', { hasText: name }).first(),
    ).toContainText('1 position', { timeout: 15000 });

    await page.reload();
    await expect(
      page.locator('button', { hasText: name }).first(),
    ).toContainText('1 position', { timeout: 15000 });
  });

  test('records a BUY through the transaction form', async ({
    authedPage: page,
    api,
  }) => {
    // The account pair and security are seeded; the trade itself is entered in
    // the UI. The account and type are native selects, driven with selectOption
    // by id; Security is a combobox, picked by clicking its listed option (the
    // list renders in a portal at the page root, outside the dialog).
    const name = `Invest ${uniqueId()}`;
    const pair = await createInvestmentAccountPair(api, { name });
    const security = await createSecurity(api, {
      symbol: `Z${uniqueId().slice(-5).toUpperCase()}`,
      name: `Traded ${uniqueId()}`,
    });

    await page.goto('/investments');
    await page.getByRole('button', { name: /\+ New Transaction/i }).click();
    await page.getByRole('button', { name: 'Investment Transaction' }).click();

    const dialog = page.getByRole('dialog');
    await expect(
      dialog.getByRole('heading', { name: 'New Investment Transaction' }),
    ).toBeVisible();
    await dialog.getByLabel('Brokerage Account').selectOption(pair.brokerageAccount.id);
    await dialog.getByLabel('Transaction Type').selectOption('BUY');
    await dialog.getByRole('textbox', { name: 'Security', exact: true }).click();
    await page.getByText(`${security.symbol} - `, { exact: false }).first().click();
    await dialog.getByLabel('Quantity (Shares)').fill('10');
    await dialog.getByLabel(/Price per Share/).fill('100');
    await dialog.getByRole('button', { name: 'Create Transaction' }).click();

    // The new position rolls into the holdings view.
    const accountHeader = page.locator('button', { hasText: name }).first();
    await expect(accountHeader).toContainText('1 position', { timeout: 15000 });
  });
});
