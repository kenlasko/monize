import {
  test,
  expect,
  request as playwrightRequest,
  type APIRequestContext,
  type Browser,
  type BrowserContext,
  type Locator,
  type Page,
} from '@playwright/test';
import { apiFor, dismissNotificationPrompt, open, waitForReady } from '../readme/session';
import { DESKTOP_CONTEXT } from '../readme/settings';
import { createApiClient, loginViaApi, type ApiClient } from '../helpers/api';
import { loginUser } from '../helpers/auth';
import { E2E_DEFAULT_PASSWORD } from '../helpers/credentials';
import { cardOf, docShot, openDocsSession, theme } from './capture';

// website/docs/shared-access.md.
//
// Showcase data, created through the API the first time and left alone after
// that (every test runs once per theme):
//  - Jordan Lee, a full Monize user of their own (registered, with one account
//    of their own), with whom the demo user shares Vacation Fund jointly,
//    Mastercard read-only, and the Bills, Budgets and Reports
//    sections.
//  - Priya Shah, an owner-managed delegate (created from Shared Access with a
//    password), with read-only access to a few accounts and Reports.
// The pictures open dialogs and close them again; nothing is saved from the UI.

const JORDAN = {
  email: 'jordan.lee@monize.example',
  password: E2E_DEFAULT_PASSWORD,
  firstName: 'Jordan',
  lastName: 'Lee',
};
const JORDAN_ACCOUNT = "Jordan's Chequing";
const PRIYA = {
  email: 'priya.shah@monize.example',
  password: E2E_DEFAULT_PASSWORD,
  firstName: 'Priya',
  lastName: 'Shah',
};

interface Named {
  id: string;
  name: string;
}
interface Delegate {
  id: string;
  delegate: { email: string };
}
interface Grant {
  account: string;
  canCreate?: boolean;
  canEdit?: boolean;
  canDelete?: boolean;
  isJoint?: boolean;
}

const JORDAN_GRANTS: Grant[] = [
  // Vacation Fund only: a joint share marks the account Joint on every screen
  // that shows it, and Primary Chequing is in most of the other pictures.
  { account: 'Vacation Fund', canCreate: true, canEdit: true, isJoint: true },
  { account: 'Mastercard' },
];
const PRIYA_GRANTS: Grant[] = [
  { account: 'Primary Chequing' },
  { account: 'Emergency Fund' },
  { account: 'Visa Rewards' },
  { account: 'Home Mortgage' },
];

function baseUrl(): string {
  const url = test.info().project.use.baseURL;
  if (!url) throw new Error('BASE_URL is not set');
  return url;
}

/** Jordan's own API session, registering the account on the first run. */
async function jordanRequest(owner: ApiClient): Promise<APIRequestContext> {
  const request = await playwrightRequest.newContext({ baseURL: baseUrl() });
  const lookup = await owner.get<{ exists: boolean }>(
    `/delegation/delegates/lookup?email=${encodeURIComponent(JORDAN.email)}`,
  );
  if (!lookup.exists) {
    const res = await request.post('/api/v1/auth/register', { data: JORDAN });
    expect(res.ok(), `register Jordan: ${res.status()} ${await res.text()}`).toBeTruthy();
  }
  await loginViaApi(request, JORDAN.email, JORDAN.password);
  return request;
}

async function ensureSharingShowcase(owner: ApiClient): Promise<void> {
  // Jordan has an account of their own, which is what makes them a "full
  // account" that joint sharing can be offered to.
  const jordanRequestContext = await jordanRequest(owner);
  try {
    const jordan = createApiClient(jordanRequestContext);
    const own = await jordan.get<Named[]>('/accounts');
    if (!own.some((a) => a.name === JORDAN_ACCOUNT)) {
      await jordan.patch('/users/preferences', { defaultCurrency: 'CAD' });
      await jordan.post('/accounts', {
        name: JORDAN_ACCOUNT,
        accountType: 'CHEQUING',
        currencyCode: 'CAD',
        openingBalance: 2450,
      });
    }
    // Jordan stays in their own context, whatever an earlier run left.
    const me = await jordan.get<{ id: string }>('/auth/profile');
    await jordan.post('/auth/switch-context', { targetUserId: me.id }).catch(() => undefined);
  } finally {
    await jordanRequestContext.dispose();
  }

  const accounts = new Map(
    (await owner.get<Named[]>('/accounts')).map((a) => [a.name, a.id] as const),
  );
  const grantsFor = (grants: Grant[]) =>
    grants.map(({ account, ...flags }) => {
      const accountId = accounts.get(account);
      if (!accountId) throw new Error(`The demo data has no account named ${account}`);
      return { accountId, canRead: true, ...flags };
    });

  const delegateId = async (person: typeof JORDAN, withPassword: boolean) => {
    const find = async () =>
      (await owner.get<Delegate[]>('/delegation/delegates')).find(
        (d) => d.delegate.email === person.email,
      );
    const existing = await find();
    if (existing) return existing.id;
    await owner.post('/delegation/delegates', {
      email: person.email,
      firstName: person.firstName,
      lastName: person.lastName,
      ...(withPassword ? { password: person.password } : {}),
    });
    const created = await find();
    if (!created) throw new Error(`Could not add ${person.email} as a delegate`);
    return created.id;
  };

  const jordanId = await delegateId(JORDAN, false);
  await owner.put(`/delegation/delegates/${jordanId}/grants`, {
    grants: grantsFor(JORDAN_GRANTS),
  });
  await owner.put(`/delegation/delegates/${jordanId}/sections`, {
    billsCanRead: true,
    budgetsCanRead: true,
    reportsCanRead: true,
  });
  await owner.put(`/delegation/delegates/${jordanId}/capabilities`, {
    payeesCanCreate: true,
    tagsCanCreate: true,
  });

  const priyaId = await delegateId(PRIYA, true);
  await owner.put(`/delegation/delegates/${priyaId}/grants`, {
    grants: grantsFor(PRIYA_GRANTS),
  });
  await owner.put(`/delegation/delegates/${priyaId}/sections`, { reportsCanRead: true });
}

/** A browser context signed in as Jordan, in the current project's theme. */
async function openJordanSession(browser: Browser): Promise<BrowserContext> {
  const context = await browser.newContext({ ...DESKTOP_CONTEXT, colorScheme: theme() });
  const page = await context.newPage();
  await loginUser(page, JORDAN.email, JORDAN.password);
  await dismissNotificationPrompt(page);
  await page.close();
  return context;
}

let context: BrowserContext;
let page: Page;

test.beforeAll(async ({ browser }) => {
  context = await openDocsSession(browser);
  page = await context.newPage();
  await page.goto('/dashboard');
  await ensureSharingShowcase(apiFor(page));
});

test.afterAll(async () => {
  await context.close();
});

async function openSharedAccess(): Promise<void> {
  await open(page, '/settings/shared-access');
  await expect(page.getByText(JORDAN.email)).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText(PRIYA.email)).toBeVisible();
}

async function closeDialog(dialog: Locator): Promise<void> {
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog).toBeHidden();
}

test('shared-access-list', async () => {
  await openSharedAccess();
  await docShot(
    page,
    'shared-access-list',
    cardOf(page.getByRole('button', { name: 'Add delegate' })),
  );
});

test('shared-access-add', async () => {
  await openSharedAccess();
  await page.getByRole('button', { name: 'Add delegate' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByPlaceholder('Delegate email').fill('alex.kim@monize.example');
  await dialog.getByPlaceholder('First name (optional)').fill('Alex');
  await dialog.getByPlaceholder('Last name (optional)').fill('Kim');
  await expect(dialog.getByPlaceholder('Set a password')).toBeVisible({ timeout: 15_000 });
  await expect(dialog.getByText('Checking this email')).toHaveCount(0);
  await docShot(page, 'shared-access-add', dialog);
  await closeDialog(dialog);
});

test('shared-access-add-existing', async () => {
  await openSharedAccess();
  await page.getByRole('button', { name: 'Add delegate' }).click();
  const dialog = page.getByRole('dialog');
  // Sam Taylor, the instance administrator, already has a Monize login.
  await dialog.getByPlaceholder('Delegate email').fill('sam.taylor@monize.example');
  await expect(dialog.getByText('This person already has a Monize login')).toBeVisible({
    timeout: 15_000,
  });
  await docShot(page, 'shared-access-add-existing', dialog);
  await closeDialog(dialog);
});

test.describe('the Edit access dialog', () => {
  test.describe.configure({ mode: 'serial' });

  const editDialog = () => page.getByRole('dialog');

  test('shared-access-edit', async () => {
    await openSharedAccess();
    const row = page.getByRole('listitem').filter({ hasText: JORDAN.email });
    await row.getByRole('button', { name: 'Edit access' }).click();
    await expect(editDialog().getByRole('heading', { name: 'Edit access' })).toBeVisible();
    await expect(editDialog().getByText('Vacation Fund').first()).toBeVisible();
    await docShot(page, 'shared-access-edit', editDialog());
  });

  test('shared-access-edit-sections', async () => {
    await editDialog().getByRole('tab', { name: 'Sections' }).click();
    await expect(editDialog().getByText('Bills & Deposits')).toBeVisible();
    await docShot(page, 'shared-access-edit-sections', editDialog());
  });

  test('shared-access-edit-shared-data', async () => {
    await editDialog().getByRole('tab', { name: 'Shared data' }).click();
    await expect(editDialog().getByText('READ of payees')).toBeVisible();
    await docShot(page, 'shared-access-edit-shared-data', editDialog());
    await closeDialog(editDialog());
  });
});

test('shared-access-joint-owner', async () => {
  await open(page, '/accounts');
  // Narrowed to the two savings accounts: one shared jointly, one not.
  const search = page.getByPlaceholder('Search accounts...');
  await search.fill('Fund');
  const table = cardOf(page.getByRole('columnheader', { name: /Account Name/i }));
  await expect(table.getByText('Shared with 1 person')).toBeVisible({ timeout: 30_000 });
  await expect(table.getByText('Emergency Fund')).toBeVisible();
  await docShot(page, 'shared-access-joint-owner', table);
  await search.fill('');
});

test.describe('what Jordan sees', () => {
  test.describe.configure({ mode: 'serial' });

  let jordanContext: BrowserContext;
  let jordanPage: Page;

  test.beforeAll(async ({ browser }) => {
    jordanContext = await openJordanSession(browser);
    jordanPage = await jordanContext.newPage();
  });

  test.afterAll(async () => {
    // Back to Jordan's own context, so the next run starts from it.
    const jordan = apiFor(jordanPage);
    const me = await jordan.get<{ id: string }>('/auth/profile');
    await jordan.post('/auth/switch-context', { targetUserId: me.id }).catch(() => undefined);
    await jordanContext.close();
  });

  test('shared-access-joint-grantee', async () => {
    await open(jordanPage, '/accounts');
    await expect(jordanPage.getByText('Shared by Demo User').first()).toBeVisible({
      timeout: 30_000,
    });
    await expect(jordanPage.getByText(JORDAN_ACCOUNT)).toBeVisible();
    await docShot(jordanPage, 'shared-access-joint-grantee');
  });

  test('shared-access-viewing-banner', async () => {
    await open(jordanPage, '/dashboard');
    const switcher = jordanPage.getByRole('combobox', { name: 'Switch account' });
    await expect(switcher).toBeVisible({ timeout: 30_000 });
    await switcher.selectOption({ label: 'Demo User' });
    // The switch reloads the page into the demo user's context, where the
    // navigation holds only what was shared (no Investments section).
    await expect(
      jordanPage.getByRole('banner').getByRole('button', { name: 'Investments' }),
    ).toHaveCount(0, { timeout: 30_000 });
    await expect(
      jordanPage.getByRole('combobox', { name: 'Switch account' }).locator('option:checked'),
    ).toHaveText('Demo User', { timeout: 30_000 });
    await waitForReady(jordanPage);
    await docShot(jordanPage, 'shared-access-viewing-banner');
  });
});
