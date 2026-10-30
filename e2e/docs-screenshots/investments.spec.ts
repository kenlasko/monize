import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import { apiFor, scrollUnderHeader, waitForReady } from '../readme/session';
import { loadIds, type Ids } from '../readme/ids';
import { showcaseMonth } from '../readme/settings';
import { cardOf, docShot, openDocsSession } from './capture';

// website/docs/investments.md. Dialogs are opened, filled in for the picture,
// and cancelled; nothing is saved.

test.describe.configure({ timeout: 300_000 });

let context: BrowserContext;
let page: Page;
let ids: Ids;

test.beforeAll(async ({ browser }) => {
  test.setTimeout(300_000);
  context = await openDocsSession(browser);
  page = await context.newPage();
  await page.goto('/dashboard');
  ids = await loadIds(apiFor(page));
});

test.afterAll(async () => {
  await context.close();
});

const top = () => page.evaluate(() => window.scrollTo(0, 0));
const chartDrawn = () => expect(page.locator('.recharts-surface').first()).toBeVisible();

/** Open `path` and wait for it; the development build compiles a route on its first visit. */
async function go(path: string): Promise<void> {
  await page.goto(path);
  await expect(page.getByRole('main').first()).toBeVisible({ timeout: 90_000 });
  // A busy development server can keep a spinner turning past waitForReady's own wait.
  await expect(page.locator('.animate-spin, .animate-pulse')).toHaveCount(0, { timeout: 90_000 });
  await waitForReady(page);
}

async function openInvestments(): Promise<void> {
  await go('/investments');
  await expect(page.getByRole('heading', { name: /^Portfolio Summary/ })).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.getByRole('heading', { name: 'Holdings by Account' })).toBeVisible();
  await chartDrawn();
  await expect(page.locator('.animate-spin, .animate-pulse')).toHaveCount(0, { timeout: 90_000 });
  await waitForReady(page);
}

test('investments-page', async () => {
  await openInvestments();
  await top();
  await docShot(page, 'investments-page');
});

test('investments-portfolio-summary', async () => {
  await openInvestments();
  const card = cardOf(page.getByRole('heading', { name: /^Portfolio Summary/ }));
  await docShot(page, 'investments-portfolio-summary', card);
});

test('investments-asset-allocation', async () => {
  await openInvestments();
  const card = cardOf(page.getByRole('heading', { name: /^Asset Allocation/ }));
  await scrollUnderHeader(page, card);
  await docShot(page, 'investments-asset-allocation', card);
});

test('investments-value-chart', async () => {
  await openInvestments();
  const card = cardOf(page.getByRole('heading', { name: /^Portfolio Value Over Time/ }));
  await scrollUnderHeader(page, card);
  await expect(card.getByRole('status')).toHaveCount(0, { timeout: 30_000 });
  await docShot(page, 'investments-value-chart', card);
});

test('investments-performance', async () => {
  await openInvestments();
  const card = cardOf(page.getByRole('heading', { name: 'Portfolio performance' }));
  await scrollUnderHeader(page, card);
  await docShot(page, 'investments-performance', card);
});

test('portfolio-holdings', async () => {
  await openInvestments();
  const card = cardOf(page.getByRole('heading', { name: 'Holdings by Account' }));
  // Open the first account to show its positions.
  await card.getByRole('button', { name: /^TFSA - Tax Free/ }).click();
  await expect(card.getByRole('columnheader', { name: 'Symbol' }).first()).toBeVisible();
  await scrollUnderHeader(page, card);
  await docShot(page, 'portfolio-holdings', card);
});

test('investment-transaction-form', async () => {
  await openInvestments();
  await page.getByRole('button', { name: '+ New Transaction' }).click();
  await page.getByRole('button', { name: 'Investment Transaction' }).click();
  const dialog = page.getByRole('dialog', { name: 'New Investment Transaction' });
  await expect(dialog).toBeVisible();
  await dialog
    .getByLabel('Brokerage Account')
    .selectOption({ label: 'TFSA - Tax Free - Brokerage (CAD)' });
  await dialog.getByLabel('Security', { exact: true }).selectOption({ index: 4 });
  await dialog.getByLabel('Quantity (Shares)').fill('10');
  await dialog.getByLabel('Price per Share').fill('186.72');
  await dialog.getByLabel('Commission / Fees').fill('9.99');
  await dialog.getByLabel('Quantity (Shares)').click();
  await docShot(page, 'investment-transaction-form', dialog);
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  // A filled-in form asks ("Unsaved Changes") before it throws the entry away.
  await expect(async () => {
    const discard = page.getByRole('button', { name: 'Discard', exact: true });
    if ((await discard.count()) > 0) await discard.click();
    await expect(dialog).toHaveCount(0, { timeout: 1_000 });
  }).toPass({ timeout: 15_000 });
});

/**
 * Tick (or untick) the two accounts held in the reporting currency in the
 * account filter. The list closes again if the page re-renders while the
 * accounts finish loading, so the whole open-and-tick step is retried as one
 * unit. The filter's button reads "All Investment Accounts" or "2 selected".
 */
async function filterToCadAccounts(on: boolean): Promise<void> {
  const rrsp = page.getByRole('checkbox', { name: 'RRSP - Retirement' });
  const tfsa = page.getByRole('checkbox', { name: 'TFSA - Tax Free' });
  await expect(async () => {
    if ((await rrsp.count()) === 0) {
      await page
        .getByRole('main')
        .getByRole('button', { name: /^All Investment Accounts$|selected$/ })
        .first()
        .click();
    }
    await rrsp.setChecked(on, { timeout: 3_000 });
    await tfsa.setChecked(on, { timeout: 3_000 });
  }).toPass({ timeout: 30_000 });
  await page.keyboard.press('Escape');
}

/** The register in calendar view, on the showcase month, with both value layers. */
async function openCalendar(): Promise<void> {
  await openInvestments();
  // Only the accounts held in the reporting currency: a calendar that must add
  // in another currency withholds its totals where no exchange rate is stored.
  await filterToCadAccounts(true);
  await expect(page.getByRole('heading', { name: /^Portfolio Summary \(/ })).toBeVisible();
  await waitForReady(page);
  const grid = page.getByRole('grid');
  await expect(async () => {
    const calendar = page.getByRole('button', { name: 'Calendar', exact: true });
    if ((await calendar.getAttribute('aria-pressed')) !== 'true') {
      await calendar.click();
    }
    await expect(grid).toBeVisible({ timeout: 3_000 });
  }).toPass({ timeout: 20_000 });
  for (let i = 0; i < showcaseMonth().monthsBack; i++) {
    await page.getByRole('button', { name: 'Previous month' }).click();
  }
  // The layers are remembered, so each is switched on only if it is off.
  for (const name of ['Values', 'Daily change']) {
    const layer = page
      .getByRole('group', { name: 'Layers' })
      .getByRole('button', { name, exact: true });
    if ((await layer.getAttribute('aria-pressed')) !== 'true') await layer.click();
    await expect(layer).toHaveAttribute('aria-pressed', 'true');
  }
  await expect(grid).toContainText('%');
  await waitForReady(page);
}

/** Put the page back as the other pictures expect it: every account, in the table view. */
async function closeCalendar(): Promise<void> {
  await page.keyboard.press('Escape');
  await top();
  await filterToCadAccounts(false);
  await page.getByRole('button', { name: 'Table', exact: true }).click();
}

test('investments-calendar', async () => {
  await openCalendar();
  await scrollUnderHeader(page, page.getByRole('group', { name: 'Layers' }));
  await docShot(page, 'investments-calendar');
  await closeCalendar();
});

test('investments-daily-movement', async () => {
  await openCalendar();
  await page.getByRole('button', { name: 'Show what moved on this day' }).last().click();
  const dialog = page.getByRole('dialog', { name: /^What moved on/ });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText('Market movement')).toBeVisible({ timeout: 30_000 });
  await expect(dialog.locator('.animate-spin, .animate-pulse')).toHaveCount(0);
  await docShot(page, 'investments-daily-movement', dialog);
  await closeCalendar();
});

test('securities-list', async () => {
  await go('/securities');
  await expect(page.getByRole('heading', { name: 'Securities', level: 1 })).toBeVisible();
  await expect(page.getByRole('row', { name: /VOO/ })).toBeVisible();
  await docShot(page, 'securities-list');
});

test('security-form', async () => {
  await go('/securities');
  await page
    .getByRole('row', { name: /VOO/ })
    .getByRole('button', { name: 'Edit', exact: true })
    .click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('heading', { name: 'Edit Security' })).toBeVisible();
  await waitForReady(page);
  await docShot(page, 'security-form', dialog);
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog).toHaveCount(0);
});

test('security-detail', async () => {
  await go(`/securities/${ids.voo}`);
  await expect(page.getByRole('heading', { name: 'Key information' })).toBeVisible({
    timeout: 30_000,
  });
  await chartDrawn();
  await waitForReady(page);
  await top();
  await docShot(page, 'security-detail');
});

test('security-price-history', async () => {
  await go(`/securities/${ids.voo}?tab=prices`);
  const tabs = page.getByRole('tablist', { name: 'Security sections' });
  await expect(tabs).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole('button', { name: '+ Add Price' })).toBeVisible();
  await waitForReady(page);
  await scrollUnderHeader(page, tabs);
  await docShot(page, 'security-price-history');
});
