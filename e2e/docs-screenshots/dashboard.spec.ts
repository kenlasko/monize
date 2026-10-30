import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import { open, openSession } from '../readme/session';
import { DESKTOP_CONTEXT } from '../readme/settings';
import { cardOf, docShot } from './capture';

// website/docs/dashboard.md: one widget per picture, cropped to its card.

let context: BrowserContext;
let page: Page;

test.beforeAll(async ({ browser }) => {
  context = await openSession(browser, DESKTOP_CONTEXT);
  page = await context.newPage();
});

test.afterAll(async () => {
  await context.close();
});

for (const [name, title] of [
  ['dashboard-budget-status', 'Budget Status'],
  ['dashboard-assets-liabilities', 'Assets vs Liabilities'],
] as const) {
  test(name, async () => {
    await open(page, '/dashboard');
    const widget = cardOf(page.getByRole('heading', { name: title, level: 3 }));
    await widget.scrollIntoViewIfNeeded();
    await expect(widget).toBeVisible();
    await docShot(page, name, widget);
  });
}
