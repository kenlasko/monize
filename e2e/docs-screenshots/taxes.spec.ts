import {
  test,
  expect,
  type BrowserContext,
  type Locator,
  type Page,
  type Route,
} from '@playwright/test';
import { scrollUnderHeader, waitForReady } from '../readme/session';
import { STATE_FILE, todayYmd } from '../readme/settings';
import { docShot, openDocsSession } from './capture';

// website/docs/taxes.md. Taxes is owner-only; the demo user owns its data.
//
// Payroll Deductions needs a paycheque bill with deduction lines, which the
// demo data does not have, and a bill seeded for real would also show on the
// Bills page, the cash flow forecast and the dashboard of every other capture.
// So the payroll pictures answer the page's own reads in this page only: the
// scheduled bills and the categories gain a split paycheque and four deduction
// categories, and the payroll routes answer with rules on them. Nothing is
// written; the New Deduction Rule dialog is filled in and cancelled.

// A first visit to a route compiles it on the development server: minutes, not seconds.
test.describe.configure({ timeout: 360_000 });

let context: BrowserContext;
let page: Page;

test.beforeAll(async ({ browser }) => {
  context = await openDocsSession(browser);
  page = await context.newPage();
});

/**
 * Keep the shared session file current. The server rotates the sign-in cookies
 * as a context refreshes them, so a later context (the next file, or a worker
 * restarted after a failure) would otherwise start from cookies that no longer
 * work.
 */
const saveSession = () => context.storageState({ path: STATE_FILE }).catch(() => undefined);

test.afterEach(async () => {
  await page.unrouteAll({ behavior: 'ignoreErrors' });
  await saveSession();
});

test.afterAll(async () => {
  await saveSession();
  await context.close();
});

/**
 * Open `path` and wait for it to settle. The development server compiles a
 * route on its first visit, and the service worker answers a navigation that
 * takes too long with its offline page, so a first attempt can land there.
 * `ready`, when given, is what the page shows once its data has loaded.
 */
async function go(p: Page, path: string, ready?: Locator): Promise<void> {
  await expect(async () => {
    await p.goto(path);
    await expect(p.getByRole('main').first()).toBeVisible({ timeout: 20_000 });
    if (ready) await expect(ready).toBeVisible({ timeout: 30_000 });
  }).toPass({ timeout: 300_000 });
  await waitForReady(p);
}

// ---- the paycheque the payroll pictures show --------------------------------

const BILL_ID = '0d0c5a1e-0000-4000-8000-000000000001';
const PARENT_ID = '0d0c5a1e-0000-4000-8000-0000000000c0';

interface Deduction {
  id: string;
  name: string;
  /** The bill's line, a magnitude; 0 is a line the bill does not collect yet. */
  line: number;
  /** A yearly maximum; null for a line without one (income tax). */
  maximum: number | null;
  /** What it collected in the last two closed periods, newest first. */
  history: [number, number];
  /** Entered per paycheque, for a line of 0. */
  entered?: number;
}

const DEDUCTIONS: Deduction[] = [
  {
    id: '0d0c5a1e-0000-4000-8000-0000000000c1',
    name: 'CPP Contributions',
    line: 176.43,
    maximum: 4034.1,
    history: [4034.1, 3867.5],
  },
  {
    id: '0d0c5a1e-0000-4000-8000-0000000000c2',
    name: 'EI Premiums',
    line: 50.84,
    maximum: 1077.48,
    history: [1077.48, 1049.12],
  },
  {
    id: '0d0c5a1e-0000-4000-8000-0000000000c3',
    name: 'CPP2 Contributions',
    line: 0,
    maximum: 396,
    history: [396, 188],
    entered: 24.8,
  },
  {
    id: '0d0c5a1e-0000-4000-8000-0000000000c4',
    name: 'Income Tax',
    line: 512.6,
    maximum: null,
    history: [0, 0],
  },
];

const GROSS = 3100;
const cents = (n: number) => Math.round(n * 100) / 100;
const NET = cents(GROSS - DEDUCTIONS.reduce((sum, d) => sum + d.line, 0));

/** The current period (a 1 January reset) and how many biweekly paycheques it has paid so far. */
function period() {
  const today = todayYmd();
  const year = Number(today.slice(0, 4));
  const dayOfYear = Math.floor((Date.parse(today) - Date.UTC(year, 0, 1)) / 86_400_000) + 1;
  // The first paycheque of the year is on 9 January, then every two weeks.
  const paid = Math.max(1, Math.floor((dayOfYear - 9) / 14) + 1);
  return { year, paid };
}

type Json = Record<string, unknown>;

async function answer(route: Route, body: unknown): Promise<void> {
  await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
}

const path = (url: URL) => url.pathname.replace(/\/$/, '');

/** The scheduled bills and the categories as the server has them, plus the paycheque and its lines. */
async function routePaycheque(p: Page): Promise<void> {
  await p.route(
    (url) => path(url) === '/api/v1/categories',
    async (route) => {
      const real = (await (await route.fetch()).json()) as Json[];
      const template = real.find((c) => c.name === 'Salary') ?? real[0];
      const category = (id: string, name: string, parentId: string | null): Json => ({
        ...template,
        id,
        name,
        parentId,
        isIncome: false,
        icon: parentId ? null : 'R',
        color: parentId ? null : '#7F8C8D',
        transactionCount: 0,
        effectiveColor: '#7F8C8D',
      });
      await answer(route, [
        ...real,
        category(PARENT_ID, 'Payroll Deductions', null),
        ...DEDUCTIONS.map((d) => category(d.id, d.name, PARENT_ID)),
      ]);
    },
  );
  await p.route(
    (url) => path(url) === '/api/v1/scheduled-transactions',
    async (route) => {
      if (route.request().method() !== 'GET') return route.continue();
      const real = (await (await route.fetch()).json()) as Json[];
      const salary = real.find((s) => s.name === 'Salary');
      if (!salary) throw new Error('The demo Salary bill is missing.');
      const split = (n: number, categoryId: string, amount: number): Json => ({
        id: `0d0c5a1e-0000-4000-8000-00000000005${n}`,
        scheduledTransactionId: BILL_ID,
        categoryId,
        category: null,
        transferAccountId: null,
        transferAccount: null,
        amount: amount.toFixed(4),
        memo: null,
      });
      const bill: Json = {
        ...salary,
        id: BILL_ID,
        name: 'Paycheque',
        amount: NET.toFixed(4),
        categoryId: null,
        category: null,
        isSplit: true,
        splits: [
          split(0, String(salary.categoryId), GROSS),
          ...DEDUCTIONS.map((d, i) => split(i + 1, d.id, -d.line)),
        ],
      };
      await answer(route, [...real, bill]);
    },
  );
  await p.route(
    (url) => path(url) === '/api/v1/payroll-deductions/suggest',
    async (route) => {
      const categoryId = new URL(route.request().url()).searchParams.get('categoryId');
      const d = DEDUCTIONS.find((x) => x.id === categoryId);
      await answer(route, {
        expectedPerPaycheque: d ? (d.line > 0 ? d.line : (d.entered ?? null)) : null,
        expectedSource: d ? (d.line > 0 ? 'line' : 'ledger') : null,
        yearlyMaximum: d?.maximum ? d.history[0] : null,
        yearlyMaximumSource: d?.maximum ? 'previousPeriod' : null,
      });
    },
  );
}

/** The rules of the paycheque: one per deduction that has a yearly maximum. */
function rules(): Json[] {
  const { year, paid } = period();
  return DEDUCTIONS.filter((d) => d.maximum !== null).map((d) => {
    const maximum = d.maximum as number;
    const perPaycheque = d.line > 0 ? d.line : (d.entered as number);
    const paidToDate = d.line > 0 ? cents(Math.min(maximum, paid * d.line)) : 0;
    return {
      id: d.id.replace(/c(\d)$/, 'r$1'),
      userId: '',
      scheduledTransactionId: BILL_ID,
      scheduledTransactionName: 'Paycheque',
      categoryId: d.id,
      categoryName: d.name,
      yearlyMaximum: maximum,
      resetPeriod: 'YEARLY',
      resetDate: `${year}-01-01`,
      periodStart: `${year}-01-01`,
      periodEnd: `${year}-12-31`,
      nextResetOn: `${year + 1}-01-01`,
      paidToDate,
      remaining: cents(maximum - paidToDate),
      foreignCurrencyRows: 0,
      currencyCode: 'CAD',
      expectedPerPaycheque: perPaycheque,
      expectedSource: d.line > 0 ? 'line' : 'entered',
      createdAt: `${year}-01-02T12:00:00.000Z`,
      updatedAt: `${year}-01-02T12:00:00.000Z`,
    };
  });
}

/** The payroll routes, answering with the paycheque's rules (or none). */
async function routeRules(p: Page, withRules: boolean): Promise<void> {
  const { year } = period();
  await p.route(
    (url) => path(url) === '/api/v1/payroll-deductions',
    async (route) => {
      if (route.request().method() !== 'GET') return route.continue();
      await answer(route, withRules ? rules() : []);
    },
  );
  await p.route(
    (url) => path(url) === '/api/v1/payroll-deductions/history',
    (route) =>
      answer(
        route,
        DEDUCTIONS.filter((d) => d.maximum !== null).map((d) => ({
          categoryId: d.id,
          categoryName: d.name,
          currencyCode: 'CAD',
          periods: d.history.map((paidToDate, i) => ({
            periodStart: `${year - 1 - i}-01-01`,
            periodEnd: `${year - 1 - i}-12-31`,
            paidToDate,
            foreignCurrencyRows: 0,
          })),
        })),
      ),
  );
}

async function openPayroll(withRules: boolean): Promise<void> {
  await routePaycheque(page);
  await routeRules(page, withRules);
  await go(
    page,
    '/taxes/payroll-deductions',
    withRules
      ? page.getByRole('cell', { name: 'EI Premiums', exact: true })
      : page.getByText('No deduction rules yet'),
  );
}

// ---- the pictures ------------------------------------------------------------

test('taxes-page', async () => {
  await go(page, '/taxes', page.getByRole('heading', { name: 'Payroll Deductions' }));
  await docShot(page, 'taxes-page');
});

test('taxes-payroll-list', async () => {
  await openPayroll(true);
  await docShot(page, 'taxes-payroll-list');
});

test('taxes-payroll-form', async () => {
  await openPayroll(false);
  await page.getByRole('button', { name: '+ New Rule' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('heading', { name: 'New Deduction Rule' })).toBeVisible();
  await dialog.getByLabel('Payroll scheduled bill').selectOption({ label: 'Paycheque' });

  // The category picker is named by its placeholder; it takes typed text, not fill().
  const pick = async (index: number, typed: string, option: string) => {
    const box = dialog.getByPlaceholder('Select a deduction line').nth(index - 1);
    await box.click();
    await box.pressSequentially(typed, { delay: 50 });
    await page.getByText(option, { exact: true }).click();
  };
  // Two rows, so the dialog fits the screen: a deduction the bill's line gives,
  // and one whose line is zero, which takes an expected amount per paycheque.
  await pick(1, 'CPP Con', 'Payroll Deductions: CPP Contributions');
  await expect(dialog.getByLabel('Yearly maximum').first()).not.toHaveValue('');
  await dialog.getByRole('button', { name: '+ Add another category' }).click();
  await pick(2, 'CPP2', 'Payroll Deductions: CPP2 Contributions');
  await expect(dialog.getByLabel('Expected per paycheque')).not.toHaveValue('');
  await waitForReady(page);
  await docShot(page, 'taxes-payroll-form', dialog);
  await dialog.getByRole('button', { name: 'Cancel' }).click();
});

test('taxes-payroll-year-to-date', async () => {
  await openPayroll(true);
  await page.getByRole('button', { name: 'Show year-to-date' }).click();
  const table = page.getByRole('region', { name: 'Paid this period' });
  await expect(table.getByRole('cell', { name: 'CPP2 Contributions', exact: true })).toBeVisible();
  await waitForReady(page);
  await docShot(page, 'taxes-payroll-year-to-date', table);
});

test('taxes-payroll-previous-periods', async () => {
  await openPayroll(true);
  await page.getByRole('button', { name: 'Show previous periods' }).click();
  const table = page.getByRole('region', { name: 'Previous Periods' });
  await expect(
    table.getByRole('cell', { name: 'CPP2 Contributions', exact: true }).first(),
  ).toBeVisible();
  await waitForReady(page);
  await scrollUnderHeader(page, page.getByRole('button', { name: 'Hide previous periods' }));
  await docShot(page, 'taxes-payroll-previous-periods', table);
});
