import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import { waitForReady } from '../readme/session';
import { docShot, openDocsSession } from './capture';
import {
  FULL_FILE_QIF,
  bankQif,
  leaveWizard,
  nextButton,
  openImport,
  stepCard,
  upload,
} from './import-files';

// website/docs/importing-from-quicken.md. Each file is read and reviewed, and
// the wizard is left before Import: nothing is imported into the demo data.
// The steps every QIF import shares are taken by importing-transactions.spec.ts.

let context: BrowserContext;
let page: Page;

test.beforeAll(async ({ browser }) => {
  context = await openDocsSession(browser);
  page = await context.newPage();
});

test.afterAll(async () => {
  await context.close();
});

test('import-multi-account-review', async () => {
  await openImport(page);
  await upload(page, [{ name: 'Quicken export.qif', content: FULL_FILE_QIF }]);
  const heading = page.getByRole('heading', { name: 'Multi-Account QIF Import' });
  await expect(heading).toBeVisible({ timeout: 60_000 });
  await expect(page.getByRole('heading', { name: 'Tags (2)' })).toBeVisible();
  await waitForReady(page);
  await docShot(page, 'import-multi-account-review');
  await leaveWizard(page);
});

test('import-quicken-map-categories', async () => {
  await openImport(page);
  await upload(page, [{ name: 'Joint Chequing.qif', content: bankQif() }]);
  await expect(stepCard(page, 'Select Destination Account')).toBeVisible({ timeout: 60_000 });
  await nextButton(page).click();
  const card = stepCard(page, 'Map Categories');
  await expect(card).toBeVisible({ timeout: 60_000 });
  // Quicken's colon paths come pre-filled as a new category under its parent.
  await expect(card.getByRole('textbox', { name: /New parent category name/ }).first()).toHaveValue(
    'Auto',
  );
  // The list scrolls inside the card; show it from the top.
  await card.locator('.overflow-y-auto').evaluate((el) => el.scrollTo(0, 0));
  await waitForReady(page);
  await docShot(page, 'import-quicken-map-categories', card);
  await leaveWizard(page);
});
