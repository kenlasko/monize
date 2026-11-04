import { test, expect } from '../fixtures';
import { uniqueId } from '../helpers/api';
import { createAccount, createTransaction } from '../helpers/factories';

// Responsive / mobile-viewport pass. The nav collapses on small screens, so
// these reach pages by direct navigation and then exercise a primary flow to
// prove the page and its modal are usable at phone width. Phase 1 was bitten by
// breakpoint-hidden duplicate nav buttons, hence the `.first()` discipline.
test.use({ viewport: { width: 390, height: 844 } });

test.describe('Mobile viewport', () => {
  test('renders the dashboard', async ({ authedPage: page }) => {
    await page.goto('/dashboard');

    await expect(page.getByText('Net Worth').first()).toBeVisible({
      timeout: 15000,
    });
  });

  test('creates an account from the accounts page', async ({ authedPage: page }) => {
    const name = `Mobile Acct ${uniqueId()}`;

    await page.goto('/accounts');
    await page.getByRole('button', { name: /new account/i }).first().click();

    const dialog = page.getByRole('dialog');
    await dialog.getByLabel(/account name/i).fill(name);
    await dialog.getByLabel(/account type/i).selectOption({ label: 'Chequing' });
    await dialog.getByRole('button', { name: /create account/i }).click();

    await expect(page.locator('tr', { hasText: name })).toBeVisible();
    await page.reload();
    await expect(page.locator('tr', { hasText: name })).toBeVisible();
  });
});

// Regression for the reconcile edit modal rendering off the phone screen: the
// reconcile table laid out wider than the device, and mobile Chrome sizes the
// viewport that position:fixed elements attach to from the page's WIDEST
// content -- a table inside overflow-x-auto still counts -- so the Modal
// opened at the table's width, cut off past the right edge. The plain-viewport
// tests above cannot catch this: only mobile emulation (isMobile) applies that
// viewport behaviour, which Firefox does not support, so the firefox project
// leaves this block out (`@chromium-only`, playwright.config.ts).
test.describe('Mobile reconcile', { tag: '@chromium-only' }, () => {
  test.use({ isMobile: true, hasTouch: true });

  test('keeps the page at device width and the edit modal on screen', async ({
    authedPage: page,
    api,
  }) => {
    const account = await createAccount(api, { openingBalance: 0 });
    await createTransaction(api, {
      accountId: account.id,
      amount: -50,
      payeeName: `Recon ${uniqueId()}`,
      status: 'CLEARED',
    });

    await page.goto('/reconcile');
    await expect(page.getByText(/start reconciliation/i).first()).toBeVisible({
      timeout: 10000,
    });
    await page.getByLabel(/^account$/i).first().selectOption({ value: account.id });
    await page.getByLabel(/statement ending balance/i).first().fill('-50');
    await page.getByRole('button', { name: /start reconciliation/i }).click();
    await expect(
      page.getByRole('button', { name: /finish reconciliation/i }),
    ).toBeVisible({ timeout: 10000 });

    // The defect showed here first: the fixed-position viewport grew past the
    // device width the moment the table mounted.
    expect(await page.evaluate(() => window.innerWidth)).toBe(390);

    // The table card bleeds to the screen edge on phones, so the table gets
    // the full device width -- and not a pixel more.
    const tableBox = (await page.locator('table').boundingBox())!;
    expect(tableBox.width).toBeGreaterThanOrEqual(389);
    expect(tableBox.width).toBeLessThanOrEqual(390);
    expect(tableBox.x).toBeGreaterThanOrEqual(0);

    // Actions live in the long-press / right-click sheet, not in a column:
    // open it on the row and pick Edit to reach the transaction form.
    await page.getByTestId(/^reconcile-row-/).first().click({ button: 'right' });
    await page.getByRole('dialog').getByRole('button', { name: /^edit$/i }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    // Wait for the dynamically imported form's fields before measuring.
    await expect(dialog.getByText(/payee/i).first()).toBeVisible({ timeout: 15000 });

    const box = (await dialog.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(390);
    expect(await page.evaluate(() => window.innerWidth)).toBe(390);
  });
});
