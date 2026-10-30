import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import { apiFor, waitForReady } from '../readme/session';
import { cardOf, docShot, openDocsSession } from './capture';
import {
  CHEQUING_CSV,
  INVESTMENT_QIF,
  bankQif,
  fieldSelect,
  leaveWizard,
  nextButton,
  openImport,
  stepCard,
  upload,
} from './import-files';

// website/docs/importing-transactions.md (and the QIF steps the Microsoft Money
// and Quicken pages share). Each wizard is walked to its review step and left:
// nothing is imported into the demo data.

let context: BrowserContext;
let page: Page;

/** A saved CSV mapping, so the Saved Mappings box shows one. Created once. */
const SAVED_MAPPING = 'Primary Chequing CSV';

test.beforeAll(async ({ browser }) => {
  context = await openDocsSession(browser);
  page = await context.newPage();
  await page.goto('/dashboard');
  const api = apiFor(page);
  const mappings = await api.get<Array<{ name: string }>>('/import/column-mappings');
  if (!mappings.some((m) => m.name === SAVED_MAPPING)) {
    await api.post('/import/column-mappings', {
      name: SAVED_MAPPING,
      columnMappings: {
        date: 0,
        amount: 3,
        payee: 1,
        category: 2,
        memo: 4,
        referenceNumber: 5,
        dateFormat: 'YYYY-MM-DD',
        hasHeader: true,
        delimiter: ',',
      },
      transferRules: [],
    });
  }
});

test.afterAll(async () => {
  await context.close();
});

test('import-upload-step', async () => {
  await openImport(page);
  await docShot(page, 'import-upload-step');
});

test.describe('the CSV wizard', () => {
  test.describe.configure({ mode: 'serial' });

  test('import-csv-column-mapping', async () => {
    await openImport(page);
    await upload(page, [{ name: 'chequing-october.csv', content: CHEQUING_CSV }]);
    const card = stepCard(page, 'CSV Column Mapping');
    await expect(card).toBeVisible({ timeout: 60_000 });
    await expect(page.getByRole('cell', { name: 'LOBLAWS #1043' })).toBeVisible();
    await waitForReady(page);
    await docShot(page, 'import-csv-column-mapping', card);
  });

  test('import-csv-saved-mappings', async () => {
    const box = cardOf(page.getByRole('heading', { name: 'Saved Mappings' }));
    await expect(box.locator('span', { hasText: SAVED_MAPPING })).toBeVisible();
    await box.scrollIntoViewIfNeeded();
    await docShot(page, 'import-csv-saved-mappings', box);
  });

  test('import-csv-transfer-rules', async () => {
    await page.getByRole('button', { name: 'Add Rule' }).click();
    await page.getByPlaceholder('Pattern...').fill('TRANSFER TO SAVINGS');
    await page
      .getByRole('main')
      .locator('select')
      .filter({ has: page.locator('option', { hasText: 'Select account...' }) })
      .selectOption('Emergency Fund');
    const rules = page
      .getByRole('heading', { name: 'Transfer Detection Rules' })
      .locator('xpath=ancestor::div[contains(@class, "space-y-3")][1]');
    await rules.scrollIntoViewIfNeeded();
    await docShot(page, 'import-csv-transfer-rules', rules);
  });

  test('import-select-account', async () => {
    await nextButton(page).click();
    const card = stepCard(page, 'Select Destination Account');
    await expect(card).toBeVisible({ timeout: 60_000 });
    await expect(page.getByLabel('Import into account')).toHaveValue(/.+/);
    await waitForReady(page);
    await docShot(page, 'import-select-account', card);
  });

  test('import-create-account', async () => {
    await page.getByRole('button', { name: '+ Create new account' }).click();
    const card = stepCard(page, 'Select Destination Account');
    await expect(card.getByText('Create New Account')).toBeVisible();
    await card.getByLabel('Account name').fill('Joint Chequing');
    await docShot(page, 'import-create-account', card);
    await card.getByRole('button', { name: 'Cancel' }).click();
  });

  test('import-map-categories', async () => {
    await nextButton(page).click();
    const card = stepCard(page, 'Map Categories');
    await expect(card).toBeVisible({ timeout: 60_000 });
    await expect(card.getByText('Loan: Car Loan')).toBeVisible();
    // A new category, to show the parent picker it brings up.
    const pets = card.getByPlaceholder('New category name').nth(1);
    await pets.fill('Pets');
    await pets.blur();
    await expect(card.getByText('Parent category')).toBeVisible();
    await waitForReady(page);
    await docShot(page, 'import-map-categories', card);
  });

  test('import-map-accounts', async () => {
    await nextButton(page).click();
    const card = stepCard(page, 'Map Transfer Accounts');
    await expect(card).toBeVisible({ timeout: 60_000 });
    await waitForReady(page);
    await docShot(page, 'import-map-accounts', card);
  });

  test('import-review-step', async () => {
    await nextButton(page).click();
    const card = stepCard(page, 'Review Import');
    await expect(card).toBeVisible({ timeout: 60_000 });
    await expect(card.getByRole('button', { name: 'Import Transactions' })).toBeVisible();
    await waitForReady(page);
    await docShot(page, 'import-review-step', card);
    await leaveWizard(page);
  });
});

test('import-csv-type-column', async () => {
  await openImport(page);
  await upload(page, [
    {
      name: 'budget-app-export.csv',
      content: [
        'Date,Payee,Type,Amount,Account',
        '2026-10-01,Acme Corp,Income,2450.00,',
        '2026-10-03,Loblaws,Expense,84.12,',
        '2026-10-08,To savings,Transfer-Out,500.00,Emergency Fund',
        '2026-10-20,From savings,Transfer-In,200.00,Emergency Fund',
      ].join('\n'),
    },
  ]);
  await expect(stepCard(page, 'CSV Column Mapping')).toBeVisible({ timeout: 60_000 });
  // "Type" is also a category header; this file's type column is not one.
  await fieldSelect(page, 'Category').selectOption('');
  await fieldSelect(page, 'Sign').selectOption('type-column');
  await fieldSelect(page, 'Transaction type column').selectOption({ label: 'Type (Col 3)' });
  const main = page.getByRole('main');
  const keyword = (label: string) =>
    main
      .locator('label')
      .filter({ hasText: new RegExp(`^${label}$`) })
      .locator('xpath=following-sibling::input[1]');
  await keyword('Income keywords').fill('Income');
  await keyword('Expense keywords').fill('Expense');
  await keyword('Transfer-out keywords').fill('Transfer-Out');
  await keyword('Transfer-in keywords').fill('Transfer-In');
  await fieldSelect(page, 'Transfer account column').selectOption({ label: 'Account (Col 5)' });
  const panel = cardOf(page.getByText('Transaction type column', { exact: true }));
  await expect(panel.getByText(/Values found:/)).toBeVisible();
  await panel.scrollIntoViewIfNeeded();
  await docShot(page, 'import-csv-type-column', panel);
  await leaveWizard(page);
});

test('import-csv-investment-mapping', async () => {
  await openImport(page);
  await upload(page, [
    {
      name: 'brokerage-activity.csv',
      content: [
        'Trade Date,Action,Symbol,Description,Quantity,Price,Commission,Amount',
        '2026-10-01,Buy,VOO,Vanguard S&P 500 ETF,4,512.40,0.00,-2049.60',
        '2026-10-06,Buy,XIU,iShares S&P/TSX 60 Index ETF,50,36.10,4.95,-1809.95',
        '2026-10-15,Dividend,VOO,Vanguard S&P 500 ETF,,,,18.20',
        '2026-10-20,Contribution,,Cash contribution,,,,1000.00',
        '2026-10-28,Sell,XIU,iShares S&P/TSX 60 Index ETF,10,36.85,4.95,363.55',
      ].join('\n'),
    },
  ]);
  const card = stepCard(page, 'CSV Column Mapping');
  await expect(card).toBeVisible({ timeout: 60_000 });
  // Investment mode is switched on by the brokerage headers.
  await expect(fieldSelect(page, 'File contains')).toHaveValue('investment');
  await waitForReady(page);
  await docShot(page, 'import-csv-investment-mapping', card);
  await leaveWizard(page);
});

test('import-select-account-bulk', async () => {
  await openImport(page);
  await upload(page, [
    { name: 'Primary Chequing.qif', content: bankQif() },
    { name: 'Visa Rewards.qif', content: bankQif('Primary Chequing') },
    { name: 'Old Savings.qif', content: bankQif('Primary Chequing') },
  ]);
  const card = stepCard(page, 'Select Destination Accounts');
  await expect(card).toBeVisible({ timeout: 60_000 });
  await waitForReady(page);
  await docShot(page, 'import-select-account-bulk', card);
  await leaveWizard(page);
});

test('import-map-securities', async () => {
  await openImport(page);
  await upload(page, [{ name: 'RRSP - Retirement.qif', content: INVESTMENT_QIF }]);
  await expect(stepCard(page, 'Select Destination Account')).toBeVisible({ timeout: 60_000 });
  await nextButton(page).click();
  const card = stepCard(page, 'Map Securities');
  await expect(card).toBeVisible({ timeout: 60_000 });
  // The automatic lookup of the unmatched securities runs first.
  await expect(card.getByText('Looking up securities...')).toHaveCount(0, { timeout: 60_000 });
  await waitForReady(page);
  await docShot(page, 'import-map-securities', card);
  await leaveWizard(page);
});
