import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import { apiFor, open, openSession } from '../readme/session';
import { loadIds, type Ids } from '../readme/ids';
import { DESKTOP_CONTEXT } from '../readme/settings';
import { docShot } from './capture';

// website/docs/accounts.md and website/docs/settings-and-security.md.

let context: BrowserContext;
let page: Page;
let ids: Ids;

test.beforeAll(async ({ browser }) => {
  context = await openSession(browser, DESKTOP_CONTEXT);
  page = await context.newPage();
  await page.goto('/dashboard');
  ids = await loadIds(apiFor(page));
});

test.afterAll(async () => {
  await context.close();
});

test('loan-detail-page', async () => {
  await open(page, `/accounts/${ids.carLoan}`);
  await expect(page.getByRole('heading', { name: 'Loan Schedule' })).toBeVisible();
  await expect(page.locator('.recharts-surface').first()).toBeVisible();
  await docShot(page, 'loan-detail-page');
});

test('settings-overview', async () => {
  await open(page, '/settings');
  await expect(page.getByRole('heading', { name: 'Profile', level: 2 })).toBeVisible();
  await docShot(page, 'settings-overview');
});
