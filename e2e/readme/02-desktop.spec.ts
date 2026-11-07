import { test, expect, type BrowserContext, type Locator, type Page } from '@playwright/test';
import { apiFor, open, openSession, scrollUnderHeader, shoot } from './session';
import { loadIds, type Ids } from './ids';
import { DESKTOP_CONTEXT, showcaseMonth } from './settings';

// The desktop pictures of the main screens, one per test, in dark mode. Each test
// stands alone: a screen that fails to load costs only its own picture.

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

/** A chart has drawn when Recharts has put an SVG surface on the page. */
const chartDrawn = (p: Page) => expect(p.locator('.recharts-surface').first()).toBeVisible();

/** Scroll `locator` to just under the app header, with the header showing. */
const scrollTo = (locator: Locator, gap = 16) => scrollUnderHeader(page, locator, gap);

test('dashboard', async () => {
  await open(page, '/dashboard');
  await expect(page.getByRole('heading', { name: /Good (morning|afternoon|evening)|Welcome/ })).toBeVisible();
  await expect(page.getByText('Car Insurance').first()).toBeVisible();
  await chartDrawn(page);
  await shoot(page, 'dashboard');
});

test('transactions, with tags in the register', async () => {
  await open(page, '/transactions');
  await expect(page.getByRole('table')).toBeVisible();
  await expect(page.getByText('Coffee run').first()).toBeVisible();
  await scrollTo(page.getByText(/Showing 1 - \d+ of/));
  await shoot(page, 'transactions');
});

test('transactions, calendar view', async () => {
  await open(page, '/transactions');
  await page.getByRole('button', { name: 'Calendar', exact: true }).click();
  const grid = page.getByRole('grid');
  await expect(grid).toBeVisible();
  for (let i = 0; i < showcaseMonth().monthsBack; i++) {
    await page.getByRole('button', { name: 'Previous month' }).click();
  }
  await expect(grid.getByText('Parents visiting').first()).toBeVisible();
  await scrollTo(page.getByRole('group', { name: 'Layers' }));
  await shoot(page, 'transactions-calendar');
});

test('accounts', async () => {
  await open(page, '/accounts');
  await expect(page.getByText('Car Loan').first()).toBeVisible();
  await shoot(page, 'accounts');
});

test('chequing account, with the balance forecast', async () => {
  await open(page, `/accounts/${ids.chequing}`);
  await expect(page.getByRole('heading', { name: 'Balance History' })).toBeVisible();
  await chartDrawn(page);
  await shoot(page, 'account-chequing');
});

test('mortgage, with the overpayment scenarios compared', async () => {
  await open(page, `/accounts/${ids.mortgage}`);
  await expect(page.getByText('Rate History')).toBeVisible();
  await page.getByRole('button', { name: 'Show scenario comparison chart' }).click();
  await chartDrawn(page);
  await scrollTo(page.getByRole('heading', { name: 'Overpayment Simulator' }), 40);
  await shoot(page, 'account-mortgage');
});

test('vehicle, with its equity', async () => {
  await open(page, `/accounts/${ids.vehicle}`);
  await expect(page.getByText('Linked to Car Loan')).toBeVisible();
  await chartDrawn(page);
  await scrollTo(page.getByRole('heading', { name: 'Value History' }));
  await shoot(page, 'account-asset');
});

test('car loan', async () => {
  await open(page, `/accounts/${ids.carLoan}`);
  await expect(page.getByRole('heading', { name: 'Loan Schedule' })).toBeVisible();
  await chartDrawn(page);
  await shoot(page, 'account-loan');
});

test('investments', async () => {
  await open(page, '/investments');
  await expect(page.getByRole('heading', { name: /Portfolio Summary/ })).toBeVisible();
  await chartDrawn(page);
  await shoot(page, 'investments');
});

test('a security', async () => {
  await open(page, `/securities/${ids.voo}`);
  await expect(page.getByRole('heading', { name: 'Key information' })).toBeVisible();
  await chartDrawn(page);
  await page.getByRole('tab', { name: 'Country' }).click();
  await expect(page.getByText('unclassified')).toBeVisible();
  await page.evaluate(() => window.scrollTo(0, 0));
  await shoot(page, 'security-detail');
});

test('bills and deposits', async () => {
  await open(page, '/bills');
  await expect(page.getByRole('row', { name: /Massage therapy|Zen Wellness/ }).first()).toBeVisible();
  await shoot(page, 'bills');
});

test('the budget', async () => {
  await open(page, `/budgets/${ids.budget}`);
  await expect(page.getByRole('heading', { name: 'Category Budgets' })).toBeVisible();
  await shoot(page, 'budgets');
});

test('reports', async () => {
  await open(page, '/reports');
  await expect(page.getByText('Income vs Expenses').first()).toBeVisible();
  await shoot(page, 'reports');
});

test('income vs expenses', async () => {
  await open(page, '/reports/income-vs-expenses');
  await chartDrawn(page);
  await expect(page.getByText('Total Income')).toBeVisible();
  await shoot(page, 'report-income-vs-expenses');
});

test('net worth', async () => {
  await open(page, '/reports/net-worth');
  await chartDrawn(page);
  await shoot(page, 'net-worth');
});

test('rules', async () => {
  await open(page, '/rules');
  await expect(page.getByText('Costco receipts')).toBeVisible();
  await shoot(page, 'rules');
});

test('tags', async () => {
  await open(page, '/tags');
  await expect(page.getByText('trip:Lisbon')).toBeVisible();
  await shoot(page, 'tags');
});

test('a payee', async () => {
  await open(page, `/payees/${ids.tim}`);
  await expect(page.getByText('guestexperience@timhortons.example')).toBeVisible();
  await chartDrawn(page);
  await shoot(page, 'payee-detail');
});

test('a category', async () => {
  await open(page, `/categories/${ids.restaurants}`);
  await expect(page.getByRole('heading', { name: 'Monthly Totals' })).toBeVisible();
  await chartDrawn(page);
  await shoot(page, 'category-detail');
});

test('institutions', async () => {
  await open(page, '/institutions');
  await expect(page.getByText('TD Canada Trust')).toBeVisible();
  await shoot(page, 'institutions');
});
