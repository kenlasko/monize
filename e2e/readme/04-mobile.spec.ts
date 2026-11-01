import { test, expect, type BrowserContext, type Locator, type Page } from '@playwright/test';
import { apiFor, open, openSession, scrollUnderHeader, shoot, waitForReady } from './session';
import { loadIds, type Ids } from './ids';
import { MOBILE_CONTEXT, showcaseMonth } from './settings';

// The same app on a phone: 390x844 at 2x, with touch. The register is a list of
// cards, the menu a drawer, the tables stack.

let context: BrowserContext;
let page: Page;
let ids: Ids;

test.beforeAll(async ({ browser }) => {
  context = await openSession(browser, MOBILE_CONTEXT);
  page = await context.newPage();
  await page.goto('/dashboard');
  ids = await loadIds(apiFor(page));
});

test.afterAll(async () => {
  await context.close();
});

const chartDrawn = (p: Page) => expect(p.locator('.recharts-surface').first()).toBeVisible();

/** Scroll `locator` to just under the app header, with the header showing. */
const scrollTo = (locator: Locator, gap = 16) => scrollUnderHeader(page, locator, gap);

test('dashboard', async () => {
  await open(page, '/dashboard');
  await expect(page.getByText('Car Insurance').first()).toBeVisible();
  await shoot(page, 'mobile-dashboard');
});

test('transactions, as cards with their tags', async () => {
  await open(page, '/transactions');
  await expect(page.getByText('Coffee run').first()).toBeVisible();
  await scrollTo(page.getByText('2026-09-28').first(), 4);
  await shoot(page, 'mobile-transactions');
});

test('transactions, calendar view', async () => {
  await open(page, '/transactions');
  await page.getByRole('button', { name: 'Calendar', exact: true }).click();
  const grid = page.getByRole('grid');
  await expect(grid).toBeVisible();
  for (let i = 0; i < showcaseMonth().monthsBack; i++) {
    await page.getByRole('button', { name: 'Previous month' }).click();
  }
  await waitForReady(page);
  await scrollTo(page.getByRole('group', { name: 'Layers' }));
  await shoot(page, 'mobile-calendar');
});

test('the navigation drawer', async () => {
  await open(page, '/dashboard');
  await page.getByRole('button', { name: 'Toggle menu' }).click();
  await expect(page.getByRole('button', { name: 'Investments', exact: true })).toBeVisible();
  await shoot(page, 'mobile-menu');
});

test('investments', async () => {
  await open(page, '/investments');
  await expect(page.getByRole('heading', { name: /Portfolio Summary/ })).toBeVisible();
  const holdings = page.getByRole('heading', { name: 'Holdings by Account' });
  await expect(holdings).toBeVisible();
  await page.getByText('TFSA - Tax Free').first().click();
  await expect(page.getByText('VFV').first()).toBeVisible();
  await waitForReady(page);
  await scrollTo(holdings, 24);
  await shoot(page, 'mobile-investments');
});

test('the mortgage, with its overpayment scenarios', async () => {
  // Not the loan schedule: the demo data records a payment as an expense on
  // chequing and a separate principal-only deposit here, so every row reads
  // $0.00 interest. The saved scenarios and their comparison show the feature.
  await open(page, `/accounts/${ids.mortgage}`);
  await expect(page.getByText('Rate History')).toBeVisible();
  await page.getByRole('button', { name: 'Show scenario comparison chart' }).click();
  await expect(page.getByRole('button', { name: 'Hide scenario comparison chart' })).toBeVisible();
  await waitForReady(page);
  // On a phone the simulator's inputs fill the whole screen, so the picture
  // starts at its saved scenarios, where the heading would push them off it.
  await scrollTo(page.getByText('Saved Scenarios', { exact: true }), 24);
  await shoot(page, 'mobile-account-mortgage');
});

test('bills and deposits', async () => {
  await open(page, '/bills');
  await expect(page.getByText('Massage therapy').first()).toBeVisible();
  // The schedule type sits inside the folded filter panel, so the picture
  // starts at the panel's header, just above the list.
  await scrollTo(page.getByRole('button', { name: /Show filters|Hide/ }), 40);
  await shoot(page, 'mobile-bills');
});

test('a report with a donut chart', async () => {
  await open(page, '/reports/spending-by-category');
  await chartDrawn(page);
  await scrollTo(page.locator('.recharts-wrapper'), 12);
  await shoot(page, 'mobile-report');
});

test('the budget', async () => {
  await open(page, `/budgets/${ids.budget}`);
  const categories = page.getByRole('heading', { name: 'Category Budgets' });
  await expect(categories).toBeVisible();
  await scrollTo(categories, 24);
  await shoot(page, 'mobile-budget');
});

test('the budget wizard, on the step with the suggested amounts', async () => {
  await open(page, '/budgets');
  await page.getByRole('button', { name: /New Budget/ }).first().click();
  // On a phone no strategy is chosen until the reader picks one.
  await page.getByRole('button', { name: /^Fixed/ }).first().click();
  await page.getByRole('button', { name: '12 months' }).click();
  await page.getByRole('button', { name: 'Analyze My Spending' }).click();
  await expect(page.getByRole('heading', { name: 'Review Categories' })).toBeVisible();
  await expect(page.getByText('Food: Groceries')).toBeVisible();
  await waitForReady(page);
  await scrollTo(page.getByRole('heading', { name: 'Review Categories' }), 12);
  await shoot(page, 'mobile-budget-wizard');

  await page.getByRole('button', { name: 'Back' }).click();
  await page.getByRole('button', { name: 'Cancel' }).click();
  await expect(page.getByRole('heading', { name: 'Create Budget' })).toHaveCount(0);
});
