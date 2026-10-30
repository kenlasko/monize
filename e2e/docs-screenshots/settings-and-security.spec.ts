import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import { open } from '../readme/session';
import { docShot, openDocsSession } from './capture';

// website/docs/settings-and-security.md.

let context: BrowserContext;
let page: Page;

test.beforeAll(async ({ browser }) => {
  context = await openDocsSession(browser);
  page = await context.newPage();
});

test.afterAll(async () => {
  await context.close();
});

test('settings-overview', async () => {
  await open(page, '/settings');
  await expect(page.getByRole('heading', { name: 'Profile', level: 2 })).toBeVisible();
  await docShot(page, 'settings-overview');
});
