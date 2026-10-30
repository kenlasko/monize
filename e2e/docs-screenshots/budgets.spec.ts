import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import { apiFor, open, openSession, waitForReady } from '../readme/session';
import { loadIds, type Ids } from '../readme/ids';
import { DESKTOP_CONTEXT } from '../readme/settings';
import { cardOf, docShot } from './capture';

// website/docs/budgets.md. The wizard is walked to its last step and left
// without creating a budget.

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

const top = () => page.evaluate(() => window.scrollTo(0, 0));

test('budgets-page', async () => {
  await open(page, '/budgets');
  await expect(page.getByRole('heading', { name: 'Budgets', level: 1 })).toBeVisible();
  await expect(page.getByRole('table')).toBeVisible();
  await docShot(page, 'budgets-page');
});

test.describe('the budget wizard', () => {
  test.describe.configure({ mode: 'serial' });

  test('budget-wizard-step1', async () => {
    await open(page, '/budgets');
    await page
      .getByRole('button', { name: /New Budget/ })
      .first()
      .click();
    await expect(page.getByRole('heading', { name: 'Choose a Budget Strategy' })).toBeVisible();
    await page.getByRole('button', { name: '12 months' }).click();
    await waitForReady(page);
    await top();
    await docShot(page, 'budget-wizard-step1');
  });

  test('budget-wizard-step2', async () => {
    await page.getByRole('button', { name: 'Analyze My Spending' }).click();
    await expect(page.getByRole('heading', { name: 'Review Categories' })).toBeVisible();
    await expect(page.getByText('Food: Groceries')).toBeVisible();
    await waitForReady(page);
    await top();
    await docShot(page, 'budget-wizard-step2');
  });

  test('budget-wizard-step3', async () => {
    await page.getByRole('button', { name: 'Next: Configure' }).click();
    await expect(page.getByRole('heading', { name: 'Configure Your Budget' })).toBeVisible();
    await waitForReady(page);
    await top();
    await docShot(page, 'budget-wizard-step3');
  });

  test('budget-wizard-step4', async () => {
    await page.getByRole('button', { name: 'Next: Review' }).click();
    await expect(page.getByRole('heading', { name: 'Review Your Budget' })).toBeVisible();
    await waitForReady(page);
    await top();
    await docShot(page, 'budget-wizard-step4');
  });
});

test('budget-dashboard', async () => {
  await open(page, `/budgets/${ids.budget}`);
  await expect(page.getByRole('heading', { name: 'Health Score' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Spending Velocity' })).toBeVisible();
  await docShot(page, 'budget-dashboard');
});

test('budget-category-list', async () => {
  await open(page, `/budgets/${ids.budget}`);
  const list = cardOf(page.getByRole('heading', { name: 'Category Budgets' }));
  await expect(list).toBeVisible();
  await docShot(page, 'budget-category-list', list);
});
