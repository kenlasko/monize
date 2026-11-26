import path from 'node:path';
import { test, expect } from '../fixtures';
import type { Page } from '@playwright/test';
import type { ApiClient } from '../helpers/api';
import { uniqueId } from '../helpers/api';
import { createAccount, createCurrency, type CreatedAccount } from '../helpers/factories';
import { chooseIconSelectOption } from '../helpers/select';

// Provisional amounts, end to end (issue #2401, docs/specs/provisional-amounts.md).
//
// A QIF file for a USD account holds a 100.00 transfer into a EUR account. The
// importer writes the EUR account's leg itself, as an estimate at the day's
// historical rate, and marks it provisional: the register shows an
// "Estimated amount" badge on the row and the accounts list carries a mark on
// the EUR balance. Confirming the amount, or importing the EUR account's own
// file, ends the estimate and both marks go.
//
// The rate comes from the deployment's rate provider for a fixed past date, so
// the spec reads it back from the leg instead of hard-coding a figure.

const DATA_DIR = path.join(__dirname, '..', 'testdata', 'provisional-amounts');
const USD_FILE = path.join(DATA_DIR, 'usd-checking.qif');
const EUR_FILE = path.join(DATA_DIR, 'eur-savings.qif');
const PAYEE = 'E2E Wire to Euro';

interface Accounts {
  usd: CreatedAccount;
  eur: CreatedAccount;
}

async function seedAccounts(api: ApiClient): Promise<Accounts> {
  // A fresh instance creates currencies on demand.
  await createCurrency(api, { code: 'EUR', name: 'Euro', symbol: '€' });
  const usd = await createAccount(api, {
    name: `Checking USD ${uniqueId()}`,
    currencyCode: 'USD',
    openingBalance: 1000,
  });
  const eur = await createAccount(api, {
    name: `Savings EUR ${uniqueId()}`,
    accountType: 'SAVINGS',
    currencyCode: 'EUR',
    openingBalance: 0,
  });
  return { usd, eur };
}

/**
 * Drive the import wizard for one QIF file: upload, pick the destination
 * account, map the file's transfer account, review, import.
 */
async function importQif(
  page: Page,
  file: string,
  target: CreatedAccount,
  transferName: string,
  transferTarget: CreatedAccount,
) {
  await page.goto('/import');
  await page.locator('input[type="file"]').setInputFiles(file);

  await expect(
    page.getByRole('heading', { name: /select destination account/i }),
  ).toBeVisible({ timeout: 15000 });
  await chooseIconSelectOption(page.getByLabel(/import into account/i), { value: target.id });
  await page.getByRole('button', { name: /^next$/i }).click();

  await expect(page.getByRole('heading', { name: 'Map Transfer Accounts' })).toBeVisible({
    timeout: 10000,
  });
  const mapping = page.locator('div', { hasText: transferName }).filter({
    has: page.getByLabel('Map to existing'),
  });
  await chooseIconSelectOption(mapping.last().getByLabel('Map to existing'), {
    value: transferTarget.id,
  });
  await page.getByRole('button', { name: /^next$/i }).click();

  await expect(page.getByRole('heading', { name: /review import/i })).toBeVisible({
    timeout: 10000,
  });
  await page.getByRole('button', { name: /import transactions/i }).click();

  await expect(page.getByRole('heading', { name: /import complete/i })).toBeVisible({
    timeout: 30000,
  });
  await expect(page.locator('li', { hasText: /imported:/i })).toContainText('1');
}

interface Leg {
  amount: number;
  exchangeRate: number;
  amountIsProvisional: boolean;
}

/** The one row an account holds, as the API returns it. */
async function onlyLeg(api: ApiClient, account: CreatedAccount): Promise<Leg> {
  // Money and rates travel as decimal strings; the spec compares numbers.
  const res = await api.get<{ data: Array<Record<keyof Leg, string | boolean>> }>(
    `/transactions?accountId=${account.id}&limit=10`,
  );
  expect(res.data).toHaveLength(1);
  const [row] = res.data;
  return {
    amount: Number(row.amount),
    exchangeRate: Number(row.exchangeRate),
    amountIsProvisional: row.amountIsProvisional === true,
  };
}

const register = (page: Page, account: CreatedAccount) =>
  page.goto(`/transactions?accountId=${account.id}`);

const rowOf = (page: Page) => page.locator('tr', { hasText: PAYEE });
const accountRow = (page: Page, account: CreatedAccount) =>
  page.locator('tr', { hasText: account.name });

/** The amount as the register prints it, without the currency symbol. */
const money = (value: number) => Math.abs(value).toFixed(2);

test.describe('Provisional amounts (import, badge, confirm)', () => {
  test.describe.configure({ timeout: 180000 });

  test('an imported cross-currency transfer shows the estimate, and confirming it clears both marks', async ({
    authedPage: page,
    api,
  }) => {
    const { usd, eur } = await seedAccounts(api);

    await importQif(page, USD_FILE, usd, 'Savings EUR', eur);

    // The EUR leg is the importer's estimate at the date's rate, not the
    // file's 100.00 at par.
    const estimate = await onlyLeg(api, eur);
    expect(estimate.amountIsProvisional).toBe(true);
    expect(estimate.exchangeRate).not.toBe(1);
    expect(Math.abs(estimate.amount - 100 * estimate.exchangeRate)).toBeLessThan(0.01);
    expect(estimate.amount).not.toBe(100);

    // The register shows it with the badge; the USD side is a confirmed row.
    await register(page, eur);
    await expect(rowOf(page)).toBeVisible();
    await expect(rowOf(page)).toContainText(money(estimate.amount));
    await expect(rowOf(page).getByTestId('provisional-amount-badge')).toContainText(
      'Estimated amount',
    );

    await register(page, usd);
    await expect(rowOf(page)).toContainText('100.00');
    await expect(rowOf(page).getByTestId('provisional-amount-badge')).toHaveCount(0);

    // The accounts list marks the EUR balance only.
    await page.goto('/accounts');
    await expect(accountRow(page, eur)).toBeVisible();
    await expect(accountRow(page, eur).getByTestId('provisional-mark')).toBeVisible();
    await expect(accountRow(page, usd).getByTestId('provisional-mark')).toHaveCount(0);

    // Confirm the amount from the register.
    await register(page, eur);
    await rowOf(page).getByRole('button', { name: 'Confirm amount' }).click();
    await expect(page.getByText('Amount confirmed')).toBeVisible();
    await expect(rowOf(page).getByTestId('provisional-amount-badge')).toHaveCount(0);
    await expect(rowOf(page).getByRole('button', { name: 'Confirm amount' })).toHaveCount(0);

    // Persisted: the row, and the accounts list, no longer carry a mark, and
    // the amount is the one that was confirmed.
    await page.reload();
    await expect(rowOf(page)).toContainText(money(estimate.amount));
    await expect(rowOf(page).getByTestId('provisional-amount-badge')).toHaveCount(0);
    const confirmed = await onlyLeg(api, eur);
    expect(confirmed.amountIsProvisional).toBe(false);
    expect(confirmed.amount).toBe(estimate.amount);

    await page.goto('/accounts');
    await expect(accountRow(page, eur)).toBeVisible();
    await expect(accountRow(page, eur).getByTestId('provisional-mark')).toHaveCount(0);
    await expect(page.getByTestId('provisional-mark')).toHaveCount(0);
  });

  test("importing the EUR account's own file replaces the estimate with the file's amount", async ({
    authedPage: page,
    api,
  }) => {
    const { usd, eur } = await seedAccounts(api);

    await importQif(page, USD_FILE, usd, 'Savings EUR', eur);
    const estimate = await onlyLeg(api, eur);
    expect(estimate.amountIsProvisional).toBe(true);

    await page.goto('/accounts');
    await expect(accountRow(page, eur).getByTestId('provisional-mark')).toBeVisible();

    // The EUR file states the amount the bank actually credited: 90.00.
    await importQif(page, EUR_FILE, eur, 'Checking USD', usd);

    const actual = await onlyLeg(api, eur);
    expect(actual.amountIsProvisional).toBe(false);
    expect(actual.amount).toBe(90);
    expect(actual.amount).not.toBe(estimate.amount);

    await register(page, eur);
    await expect(rowOf(page)).toHaveCount(1);
    await expect(rowOf(page)).toContainText('90.00');
    await expect(rowOf(page).getByTestId('provisional-amount-badge')).toHaveCount(0);

    // The transfer is still one pair: the USD side was matched, not duplicated.
    await register(page, usd);
    await expect(rowOf(page)).toHaveCount(1);
    await expect(rowOf(page)).toContainText('100.00');

    await page.goto('/accounts');
    await expect(accountRow(page, eur)).toBeVisible();
    await expect(page.getByTestId('provisional-mark')).toHaveCount(0);
  });
});
